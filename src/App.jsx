import { useEffect, useMemo, useRef, useState } from "react";
import {
  Home as HomeIcon, Library as LibraryIcon,
  ArrowLeft, Pencil, Trash2, Plus, Users, RefreshCw,
} from "lucide-react";
import { supabase, callFn } from "./lib/supabase";

// ─── Game card image flow ────────────────────────────────────────────────
// 1. Library is stored in Supabase (table: public.games). useGameLibrary
//    reads on mount and writes through addOrUpdate / remove.
// 2. EditGameScreen.handleSave builds the next record. If title, category,
//    or notes changed (or this is a new card) it calls
//    onSave(next, { fetchImage: true }).
// 3. addOrUpdate upserts the row immediately with imgLoading: true and
//    image fields cleared, then fires resolveGameCardImage in the
//    background. Save is never blocked by the network.
// 4. resolveGameCardImage builds a search query from title + category +
//    notes summary, then calls the `/amazon-search` Supabase Edge
//    Function (which proxies Firecrawl to scrape Amazon search results).
//    On miss/error it falls through to a local SVG dice fallback.
// 5. When the chain resolves, addOrUpdate patches the row by id with
//    imageUrl, imageSource ("amazon" | "fallback"), imageAttribution,
//    and clears imgLoading.
// 6. GameCard reads imageUrl + imageAttribution + imageSource and renders
//    the photo (with PhotoCredit overlay), the FallbackImage SVG, or the
//    shimmer skeleton while loading.
// 7. On first render, useGameLibrary backfills any card with image_source
//    not equal to "amazon" — these get re-resolved through the chain so
//    pre-existing rows (or rows seeded without images) pick up real
//    Amazon product images automatically.

// ─── Tokens ──────────────────────────────────────────────────────────────
const C = {
  background: "#f5f1e8",
  primary: "#e67136",
  primaryShadow: "rgba(227,84,29,0.45)",
  primaryBorder: "rgba(230,113,54,0.12)",
  primarySoft: "#f4b294",
  textDark: "#3f5d3d",
  textPurple: "#3a2d6b",
  textNearBlack: "#0a0a0a",
  white: "#ffffff",
  cardBg: "#ffffff",
  borderSoft: "#e8dcc8",
  shadow: "rgba(63,93,61,0.08)",
};

const F = {
  display: "'Playpen Sans', cursive",
  reel: "'Nunito', sans-serif",
  body: "'Open Sans', sans-serif",
  nav: "'Poppins', sans-serif",
};

// ─── Categories + emoji map ──────────────────────────────────────────────
const CATEGORIES = [
  "Board Game", "Card Game", "Puzzle", "Toy",
  "Outside", "Video Game", "Other",
];

const CATEGORY_EMOJI = {
  "Board Game": "♟️",
  "Card Game": "🃏",
  "Puzzle": "🧩",
  "Toy": "🧸",
  "Outside": "🌳",
  "Video Game": "🎮",
  "Other": "🎯",
};

// ─── Image resolution: Firecrawl (Amazon) via Supabase Edge Function ────
// All image lookups go through the `/amazon-search` route on our
// Supabase Edge Function, which proxies the Firecrawl API server-side
// to scrape Amazon search results. On miss / error, we fall through
// to a local SVG dice fallback.

// Sentinel for the local inline-SVG fallback. We render a neutral SVG
// (see FallbackImage component) instead of loading an external URL.
const FALLBACK_IMG = "__fallback__";

function FallbackImage() {
  return (
    <svg
      viewBox="0 0 400 400"
      preserveAspectRatio="xMidYMid slice"
      style={{
        position: "absolute", inset: 0,
        width: "100%", height: "100%",
      }}
    >
      <defs>
        <linearGradient id="pwmFallbackBg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#f4ebd9" />
          <stop offset="100%" stopColor="#e0d2b8" />
        </linearGradient>
      </defs>
      <rect width="400" height="400" fill="url(#pwmFallbackBg)" />
      <g transform="translate(140 140)">
        <rect x="0" y="0" width="120" height="120" rx="20" fill="#fff" stroke="#e67136" strokeWidth="3" />
        <circle cx="35" cy="35" r="9" fill="#3f5d3d" />
        <circle cx="85" cy="35" r="9" fill="#3f5d3d" />
        <circle cx="60" cy="60" r="9" fill="#3f5d3d" />
        <circle cx="35" cy="85" r="9" fill="#3f5d3d" />
        <circle cx="85" cy="85" r="9" fill="#3f5d3d" />
      </g>
    </svg>
  );
}

// Calls the Supabase Edge Function which proxies Amazon search results.
// Upstream is Firecrawl (https://firecrawl.dev) — was previously Bright
// Data Web Unlocker and Rainforest before that. The route name and JSON
// response shape stay identical so this client doesn't care which
// provider is behind it. Returns { source, url, attribution } on hit
// or null on miss / failure.
// Optional `excludeUrls` — when set, each URL is sent as a repeated
// `exclude=` query param so the server skips them and returns the first
// parsed search result not in the list. Used by the refresh button so
// every click cycles to a new product image.
async function searchAmazonViaFirecrawl(query, excludeUrls) {
  const params = new URLSearchParams();
  params.set("q", query);
  if (Array.isArray(excludeUrls)) {
    for (const u of excludeUrls) if (u) params.append("exclude", u);
  } else if (typeof excludeUrls === "string" && excludeUrls) {
    params.append("exclude", excludeUrls);
  }
  const data = await callFn(`/amazon-search?${params.toString()}`);
  if (!data || !data.imageUrl) {
    // Even with no hit, surface the raw results so the caller can cache
    // them — useful for refreshes when the chosen URL is excluded.
    return data && Array.isArray(data.results)
      ? { source: "fallback", url: null, attribution: null, players: null, ages: null, rawResults: data.results }
      : null;
  }
  return {
    source: "amazon",
    url: data.imageUrl,
    attribution: {
      // No photographer credit for Amazon product imagery; we attribute
      // the source ("Amazon") and link to the product page if available.
      name: data.title || "Amazon",
      profileUrl: data.link || "https://www.amazon.com",
    },
    // Optional metadata pulled out of the product card. May be null if
    // the search result didn't include the pattern.
    players: data.players || null,
    ages: data.ages || null,
    // Full parsed list from the server — refreshImage caches this so
    // subsequent clicks on the same card skip the server entirely.
    rawResults: Array.isArray(data.results) ? data.results : null,
  };
}

const FALLBACK_RESULT = {
  source: "fallback",
  url: FALLBACK_IMG,
  attribution: null,
};

// Common English filler words skipped when summarizing notes for the query.
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "is", "are", "was", "were",
  "be", "been", "being", "to", "of", "in", "on", "at", "for", "with",
  "by", "from", "as", "it", "its", "this", "that", "these", "those",
  "i", "you", "he", "she", "we", "they", "them", "your", "our",
  "do", "does", "did", "have", "has", "had", "will", "can", "just",
]);

// Build the API query string from the card's title + category + a short
// notes summary. Returns "" if there's no usable title — the chain skips
// every API call in that case and goes straight to the local fallback.
function buildSearchQuery({ name, category, notes }) {
  const title = (name || "").trim();
  if (!title) return "";
  const cat = (category || "").trim();
  const notesSummary = (notes || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w))
    .slice(0, 10)
    .join(" ");
  return [title, cat, notesSummary].filter(Boolean).join(" ").trim();
}

// Single entry point for image resolution. Accepts the whole card so the
// query can be enriched with category and notes. Calls the Firecrawl /
// Amazon route on our edge function; on miss falls through to the local
// SVG dice. Returns FALLBACK_RESULT immediately if title is empty.
async function resolveGameCardImage(card, { excludeUrls } = {}) {
  const query = buildSearchQuery(card);
  if (!query) return FALLBACK_RESULT;
  const result = await searchAmazonViaFirecrawl(query, excludeUrls);
  return result || FALLBACK_RESULT;
}

// ─── Supabase-backed library hook ────────────────────────────────────────
// Library lives in the public.games table. We map the snake_case DB row
// to the camelCase shape used throughout the React tree.
function rowToGame(r) {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    emoji: r.emoji,
    notes: r.notes || "",
    players: r.players,
    ages: r.ages,
    imageUrl: r.img,
    imageSource: r.image_source,
    imageAttribution: r.attribution,
    createdAt: r.created_at,
    // imgLoading is purely client-side UI state, never persisted.
    imgLoading: false,
  };
}

function gameToRow(g) {
  return {
    id: g.id,
    name: g.name,
    category: g.category,
    emoji: g.emoji ?? null,
    notes: g.notes ?? "",
    players: g.players ?? "- Players",
    ages: g.ages ?? "Ages -",
    img: g.imageUrl ?? null,
    image_source: g.imageSource ?? null,
    attribution: g.imageAttribution ?? null,
  };
}

function useGameLibrary() {
  const [games, setGames] = useState([]);
  const [loaded, setLoaded] = useState(false);
  // Track ids we've already kicked off a backfill for so we don't loop.
  const backfilledRef = useRef(new Set());
  // Per-card seen image URL sets (session-scoped). Each refresh asks
  // the edge function to exclude every URL we've already shown for that
  // card so the user keeps getting new product images. Reset on
  // page reload — Amazon's results are deterministic, so each session
  // starts fresh against the full result pool.
  const seenUrlsRef = useRef(new Map());
  // Per-query parsed-results cache. Map<queryString, AmazonResult[]>.
  // Populated when the server returns a `results` array; on subsequent
  // refreshes of the same card, we pick from the cache without calling
  // the edge function (or Firecrawl) at all — repeat refreshes go from
  // ~3–4s round-trip to ~50ms local lookup.
  const cachedResultsRef = useRef(new Map());

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Newest cards first — Add-to-Library should land at the top of
      // the list, and the seeded rows fall in below the user's additions.
      const { data, error } = await supabase
        .from("games")
        .select("*")
        .order("created_at", { ascending: false });
      if (cancelled) return;
      if (error) {
        // eslint-disable-next-line no-console
        console.error("[library] initial load failed:", error.message);
        setLoaded(true);
        return;
      }
      setGames((data || []).map(rowToGame));
      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, []);

  // Helper: patch a row in DB + local state.
  const patchById = async (id, patch) => {
    setGames(prev => prev.map(g => g.id === id ? { ...g, ...patch } : g));
    // camelCase client fields → snake_case DB columns. We only mirror the
    // fields the resolver might supply.
    const dbPatch = {};
    if ("imageUrl" in patch) dbPatch.img = patch.imageUrl;
    if ("imageSource" in patch) dbPatch.image_source = patch.imageSource;
    if ("imageAttribution" in patch) dbPatch.attribution = patch.imageAttribution;
    if ("players" in patch) dbPatch.players = patch.players;
    if ("ages" in patch) dbPatch.ages = patch.ages;
    if (Object.keys(dbPatch).length === 0) return;
    const { error } = await supabase.from("games").update(dbPatch).eq("id", id);
    if (error) {
      // eslint-disable-next-line no-console
      console.error(`[library] patch ${id} failed:`, error.message);
    }
  };

  // Runs the image resolution chain for a card and writes the result back
  // through patchById. Used by both addOrUpdate (on save) and the lazy
  // backfill effect (on mount for legacy rows). Players + ages are
  // patched only when the resolver actually extracted them, so we never
  // clobber a user-supplied value with null.
  const resolveAndPatch = async (game, { excludeUrls = [] } = {}) => {
    const result = await resolveGameCardImage(game, { excludeUrls });
    // Refresh-mode guard: if we explicitly asked for an unseen image
    // (excludeUrls non-empty) and the chain couldn't find one — either
    // no hit, a fallback, or a URL already in our seen set — keep the
    // current image and just clear the loading flag. Returns { patched,
    // result } so callers can update their seen-URL tracking only when
    // we actually swapped to a new image.
    const refreshing = excludeUrls.length > 0;
    const excludeSet = new Set(excludeUrls);
    const noNewImage =
      refreshing &&
      (!result.url || result.source === "fallback" || excludeSet.has(result.url));
    if (noNewImage) {
      setGames(prev => prev.map(g => g.id === game.id ? { ...g, imgLoading: false } : g));
      return { patched: false, result };
    }
    const patch = {
      imageUrl: result.url,
      imageSource: result.source,
      imageAttribution: result.attribution,
      imgLoading: false,
    };
    if (result.players) patch.players = result.players;
    if (result.ages) patch.ages = result.ages;
    await patchById(game.id, patch);
    return { patched: true, result };
  };

  // When `fetchImage` is true, the card is upserted immediately with
  // imgLoading: true (image fields cleared) and resolveGameCardImage
  // runs in the background, patching image_url / image_source /
  // attribution when it resolves. The shimmer stays visible for the
  // whole chain. Save is never blocked by the network call.
  const addOrUpdate = async (game, { fetchImage = false } = {}) => {
    const next = fetchImage
      ? { ...game, imgLoading: true, imageUrl: null, imageSource: null, imageAttribution: null }
      : game;

    // Prepend new cards so they land at the top of the list. Existing
    // cards keep their position when re-saved.
    setGames(prev => prev.find(g => g.id === next.id)
      ? prev.map(g => g.id === next.id ? next : g)
      : [next, ...prev]);

    const { error } = await supabase.from("games").upsert(gameToRow(next));
    if (error) {
      // eslint-disable-next-line no-console
      console.error("[library] upsert failed:", error.message);
    }

    if (fetchImage) {
      // Mark this id as already backfilled so the lazy-backfill effect
      // (which fires whenever games.length changes) doesn't race a
      // second Firecrawl call against this one.
      backfilledRef.current.add(next.id);
      // Don't await — chain runs async; UI shows skeleton meanwhile.
      // After it resolves, stash the parsed results in the per-query
      // cache so the first refresh on this card is instant.
      const cacheKey = buildSearchQuery(next);
      resolveAndPatch(next).then(({ result }) => {
        if (cacheKey && Array.isArray(result?.rawResults)) {
          cachedResultsRef.current.set(cacheKey, result.rawResults);
        }
      });
    }
  };

  const remove = async (id) => {
    setGames(prev => prev.filter(g => g.id !== id));
    const { error } = await supabase.from("games").delete().eq("id", id);
    if (error) {
      // eslint-disable-next-line no-console
      console.error(`[library] delete ${id} failed:`, error.message);
    }
  };

  // Re-run the Firecrawl-backed Amazon search for an existing card to
  // swap in a fresh image. Search rules are unchanged (same
  // buildSearchQuery — title + category + notes summary).
  // We send EVERY URL we've shown for this card so far as `exclude=`
  // params, so each click cycles to a previously-unseen product. When
  // the pool is exhausted the server returns null and the card keeps
  // its current image — we never repeat unless absolutely necessary.
  const refreshImage = async (game) => {
    if (!game) return;
    backfilledRef.current.add(game.id);

    // Per-card seen set, seeded with the current image so the next
    // refresh definitely skips it.
    let seen = seenUrlsRef.current.get(game.id);
    if (!seen) {
      seen = new Set();
      seenUrlsRef.current.set(game.id, seen);
    }
    if (game.imageUrl) seen.add(game.imageUrl);
    const excludeUrls = Array.from(seen);

    // ─── FAST PATH ────────────────────────────────────────────────────
    // If we already pulled this card's search results on a previous
    // click, find the first cached URL that isn't in the seen set and
    // patch directly. Skips Firecrawl entirely — ~3–4s call collapses
    // to a local DB write.
    const query = buildSearchQuery(game);
    const cached = query ? cachedResultsRef.current.get(query) : null;
    if (cached && cached.length > 0) {
      const hit = cached.find(r => r.imageUrl && !seen.has(r.imageUrl));
      if (hit) {
        const patch = {
          imageUrl: hit.imageUrl,
          imageSource: "amazon",
          imageAttribution: {
            name: hit.title || "Amazon",
            profileUrl: hit.link || "https://www.amazon.com",
          },
          imgLoading: false,
        };
        if (hit.players) patch.players = hit.players;
        if (hit.ages) patch.ages = hit.ages;
        seen.add(hit.imageUrl);
        await patchById(game.id, patch);
        return;
      }
      // Cache exhausted — fall through to the server. It probably can't
      // find an unseen result either (Amazon's first-page results are
      // deterministic) but trying respects the "do not repeat unless
      // absolutely necessary" rule.
    }

    // ─── SLOW PATH ────────────────────────────────────────────────────
    // Cache miss or exhausted — hit Firecrawl, populate cache for
    // future clicks, patch as usual.
    setGames(prev => prev.map(g => g.id === game.id ? { ...g, imgLoading: true } : g));
    const { patched, result } = await resolveAndPatch(game, { excludeUrls });
    if (patched && result?.url) seen.add(result.url);
    if (query && Array.isArray(result?.rawResults)) {
      cachedResultsRef.current.set(query, result.rawResults);
    }
  };

  // Lazy backfill: any card whose imageSource isn't "amazon" gets
  // re-resolved through the Firecrawl chain. Runs once per id per
  // session (tracked in backfilledRef) so re-renders don't restart it.
  useEffect(() => {
    if (!loaded) return;
    for (const g of games) {
      // Skip cards that already have an image we don't want to clobber:
      //   "amazon" — backfilled successfully from Firecrawl
      //   "local"  — manually set image (e.g. uploaded JPEG in public/)
      if (g.imageSource === "amazon" || g.imageSource === "local") continue;
      if (backfilledRef.current.has(g.id)) continue;
      backfilledRef.current.add(g.id);
      // Flip loading state immediately so the UI shows the shimmer.
      setGames(prev => prev.map(x => x.id === g.id ? { ...x, imgLoading: true } : x));
      // Same cache-populating pattern as addOrUpdate — stash the
      // parsed results for this card's query so the first refresh on
      // the card is instant.
      const cacheKey = buildSearchQuery(g);
      resolveAndPatch(g).then(({ result }) => {
        if (cacheKey && Array.isArray(result?.rawResults)) {
          cachedResultsRef.current.set(cacheKey, result.rawResults);
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, games.length]);

  return { games, loaded, addOrUpdate, remove, refreshImage };
}

// ─── Status bar (cosmetic) ───────────────────────────────────────────────
function StatusBar({ tone = "light" }) {
  const color = tone === "light" ? C.white : C.textDark;
  return (
    <div style={{
      height: 31, padding: "0 24px", flexShrink: 0,
      display: "flex", alignItems: "center", justifyContent: "space-between",
      fontFamily: F.body, fontWeight: 600, fontSize: 15, color,
    }}>
      <span>9:41</span>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, opacity: 0.95 }}>
        <span>•••</span><span>📶</span><span>🔋</span>
      </div>
    </div>
  );
}

// ─── Slot reel ───────────────────────────────────────────────────────────
const REEL_POOL = [
  { name: "Chess", emoji: "♟️" },
  { name: "Uno", emoji: "🃏" },
  { name: "Jigsaw 500pc", emoji: "🧩" },
  { name: "LEGO City", emoji: "🧸" },
  { name: "Charades", emoji: "🎨" },
  { name: "Monopoly", emoji: "♟️" },
  { name: "Go Fish", emoji: "🃏" },
  { name: "Play-Doh", emoji: "🧸" },
  { name: "Simon Says", emoji: "🎨" },
  { name: "Jenga", emoji: "♟️" },
  { name: "Scrabble", emoji: "♟️" },
  { name: "Hide & Seek", emoji: "🌳" },
];

const ITEM_HEIGHT = 90;

function SlotReel({ items, spinning, targetIndex, delay, initialIndex = 0 }) {
  // Build a long strip by repeating the items 6x for smooth spin
  const strip = useMemo(() => {
    const out = [];
    for (let i = 0; i < 6; i++) out.push(...items);
    return out;
  }, [items]);

  const [offset, setOffset] = useState(-ITEM_HEIGHT * (initialIndex % items.length));
  const [transition, setTransition] = useState("none");

  useEffect(() => {
    if (!spinning) return;
    // 1) Reset position instantly to start
    setTransition("none");
    setOffset(-ITEM_HEIGHT * items.length); // start at "second loop" so we have room
    // 2) On next frame, animate to target
    const t1 = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTransition(`transform ${1500 + delay}ms cubic-bezier(0.22, 1, 0.36, 1) ${delay}ms`);
        // Land on the target index in the 5th loop for plenty of spin distance
        const finalLoop = 5;
        const finalOffset = -((finalLoop * items.length + targetIndex) * ITEM_HEIGHT);
        setOffset(finalOffset);
      });
    });
    return () => cancelAnimationFrame(t1);
  }, [spinning, targetIndex, delay, items.length]);

  return (
    <div style={{
      position: "relative", width: 99, height: ITEM_HEIGHT,
      background: C.white, borderRadius: 16,
      border: `3px solid ${C.primaryBorder}`,
      overflow: "hidden",
      boxShadow: "inset 0 2px 6px rgba(0,0,0,0.05)",
    }}>
      <div style={{
        transform: `translateY(${offset}px)`,
        transition,
        display: "flex", flexDirection: "column",
      }}>
        {strip.map((it, i) => (
          <div key={i} style={{
            height: ITEM_HEIGHT, position: "relative", overflow: "hidden",
          }}>
            {it.imageUrl ? (
              <>
                {/* Card photo fills the entire cell. */}
                <div style={{
                  position: "absolute", inset: 0,
                  backgroundImage: `url("${it.imageUrl}")`,
                  backgroundSize: "cover",
                  backgroundPosition: "center",
                  backgroundColor: C.borderSoft,
                }} />
                {/* Dark gradient at the bottom for label legibility. */}
                <div style={{
                  position: "absolute", left: 0, right: 0, bottom: 0,
                  height: "60%",
                  background:
                    "linear-gradient(to top, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.55) 50%, transparent 100%)",
                  pointerEvents: "none",
                }} />
                {/* Title overlaid on the darkened band. */}
                <span style={{
                  position: "absolute", left: 4, right: 4, bottom: 9,
                  fontFamily: F.reel, fontWeight: 700, fontSize: 11,
                  color: "#fff",
                  textAlign: "center", display: "block",
                  textShadow: "0 1px 2px rgba(0,0,0,0.6)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>{it.name}</span>
              </>
            ) : (
              // Emoji fallback when the card hasn't been imaged yet —
              // keep the original centered emoji + label layout.
              <div style={{
                height: "100%", display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center", gap: 2,
              }}>
                <span style={{ fontSize: 28, lineHeight: 1 }}>{it.emoji}</span>
                <span style={{
                  fontFamily: F.reel, fontWeight: 700, fontSize: 10,
                  color: C.textPurple, marginTop: 2,
                  maxWidth: 90, textAlign: "center",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>{it.name}</span>
              </div>
            )}
          </div>
        ))}
      </div>
      {/* Top + bottom fade overlays */}
      <div style={{
        position: "absolute", inset: 0, pointerEvents: "none",
        background: "linear-gradient(to bottom, rgba(255,255,255,0.7) 0%, transparent 30%, transparent 70%, rgba(255,255,255,0.7) 100%)",
      }} />
    </div>
  );
}

function SlotMachine({ library, onResult }) {
  const [spinning, setSpinning] = useState(false);
  const [targets, setTargets] = useState([0, 1, 2]);
  const [pulse, setPulse] = useState(false);

  // Build pool from user's library if there are enough; otherwise use REEL_POOL.
  // imageUrl is included so each reel cell renders a scaled-down version
  // of the game card photo (Amazon CDN URL), with the emoji as a fallback
  // when the card hasn't been imaged yet or is using the local dice fallback.
  const pool = useMemo(() => {
    if (library.length >= 3) {
      return library.map(g => ({
        name: g.name,
        emoji: g.emoji || CATEGORY_EMOJI[g.category] || "🎲",
        imageUrl: (g.imageUrl && g.imageUrl !== FALLBACK_IMG) ? g.imageUrl : null,
      }));
    }
    return REEL_POOL;
  }, [library]);

  const handleSpin = () => {
    if (library.length === 0) {
      onResult(null, "Add some games first!");
      return;
    }
    setPulse(true);
    setTimeout(() => setPulse(false), 500);

    // Pick 3 random target indices in the pool (these drive what each reel lands on)
    const t = [0, 1, 2].map(() => Math.floor(Math.random() * pool.length));
    setSpinning(false);
    requestAnimationFrame(() => {
      setTargets(t);
      setSpinning(true);
    });

    // The "winner" is a random pick from the user's library
    const winner = library[Math.floor(Math.random() * library.length)];
    setTimeout(() => {
      onResult(winner);
      setSpinning(false);
    }, 1500 + 300 + 200);
  };

  return (
    <>
      {/* Slot container */}
      <div style={{
        width: 360, padding: "30px 18px", borderRadius: 24,
        background: C.white,
        boxShadow: `0 0 16.75px ${C.primary}, 0 4px 14px ${C.shadow}`,
        position: "relative",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, position: "relative" }}>
          <SlotReel items={pool} spinning={spinning} targetIndex={targets[0]} delay={0} initialIndex={0} />
          <SlotReel items={pool} spinning={spinning} targetIndex={targets[1]} delay={150} initialIndex={1} />
          <SlotReel items={pool} spinning={spinning} targetIndex={targets[2]} delay={300} initialIndex={2} />
          {/* Selection line across reels */}
          <div style={{
            position: "absolute", left: -18, right: -18, top: "50%",
            height: 3, marginTop: -1.5,
            background: C.primary, opacity: 0.3, pointerEvents: "none",
          }} />
        </div>
      </div>

      {/* Play button */}
      <button onClick={handleSpin} style={{
        marginTop: 28, width: 120, height: 120, borderRadius: "50%",
        background: C.primary, border: "3px solid rgba(255,255,255,0.8)",
        cursor: "pointer", padding: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
        boxShadow: pulse
          ? `0 14px 28px ${C.primaryShadow}, 0 0 0 6px rgba(230,113,54,0.18)`
          : `0 8px 16px ${C.primaryShadow}`,
        transform: pulse ? "scale(0.96)" : "scale(1)",
        transition: "all 0.25s cubic-bezier(.4,1.5,.5,1)",
      }}>
        <span style={{
          fontFamily: F.display, fontWeight: 800, fontSize: 24,
          color: "#faf9f7", letterSpacing: "0.01em",
        }}>Play</span>
      </button>
    </>
  );
}

// ─── Bottom tab bar ──────────────────────────────────────────────────────
function TabBar({ tab, onChange }) {
  const items = [
    { key: "home", Icon: HomeIcon, label: "HOME" },
    { key: "library", Icon: LibraryIcon, label: "LIBRARY" },
  ];
  return (
    <div style={{
      flexShrink: 0, height: 83,
      background: "rgba(255,255,255,0.85)",
      backdropFilter: "blur(6px)",
      WebkitBackdropFilter: "blur(6px)",
      boxShadow: "0 -2px 2px rgba(0,0,0,0.15)",
      display: "flex", alignItems: "center", justifyContent: "center",
      gap: 46, padding: "8px 24px",
    }}>
      {items.map(({ key, Icon, label }) => {
        const active = tab === key;
        if (active) {
          return (
            <button key={key} onClick={() => onChange(key)} style={{
              background: C.primary,
              border: "none", cursor: "pointer",
              width: 75.78, height: 56.5, borderRadius: 16,
              display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center", gap: 4,
              padding: 0,
            }}>
              <Icon size={18} color="#fcfbf8" strokeWidth={2.2} />
              <span style={{
                fontFamily: F.nav, fontWeight: 500, fontSize: 12,
                lineHeight: "15px", letterSpacing: "0.5px",
                textTransform: "uppercase", color: "#fcfbf8",
              }}>{label}</span>
            </button>
          );
        }
        return (
          <button key={key} onClick={() => onChange(key)} style={{
            background: "transparent", border: "none", cursor: "pointer",
            display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            padding: "8px 16px",
          }}>
            <Icon size={18} color={C.textDark} strokeWidth={2} />
            <span style={{
              marginTop: 4,
              fontFamily: "'Plus Jakarta Sans', sans-serif",
              fontWeight: 600, fontSize: 10,
              lineHeight: "15px", letterSpacing: "0.5px",
              textTransform: "uppercase", color: C.textDark,
            }}>{label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── HOME ────────────────────────────────────────────────────────────────
function HomeScreen({ library }) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  const handleResult = (game, errMsg) => {
    if (errMsg) { setError(errMsg); setResult(null); return; }
    setError(""); setResult(game);
  };

  return (
    <div style={{
      flex: 1, display: "flex", flexDirection: "column",
      background: C.background, overflow: "auto",
    }}>
      {/* Orange top header */}
      <div style={{
        flexShrink: 0, background: C.primary,
        boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
      }}>
        <StatusBar tone="light" />
        <div style={{
          height: 54, display: "flex",
          alignItems: "center", justifyContent: "center",
        }}>
          <span style={{
            fontFamily: F.display, fontWeight: 800, fontSize: 24,
            color: C.background, letterSpacing: "0.01em",
          }}>Play With Me</span>
        </div>
      </div>

      {/* Hero image */}
      <div style={{
        width: "100%", height: 308, flexShrink: 0,
        background: `linear-gradient(135deg, #d4c9b0 0%, #b8a88a 100%)`,
        backgroundImage: `url(https://images.unsplash.com/photo-1503454537195-1dcabb73ffb9?w=900&q=80)`,
        backgroundSize: "cover", backgroundPosition: "center 30%",
      }} />

      {/* Section title */}
      <h2 style={{
        margin: "26px 24px 0", textAlign: "center",
        fontFamily: F.display, fontWeight: 800, fontSize: 20,
        color: C.textDark, letterSpacing: "0.01em",
      }}>Lets Find A Game</h2>

      {/* Slot machine + Play button */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginTop: 16 }}>
        <SlotMachine library={library} onResult={handleResult} />
      </div>

      {/* Result toast — error messages only. The "YOUR PICK" success
          card was removed per design; the reels themselves convey the
          chosen game now. */}
      {error && (
        <div style={{
          margin: "20px auto 24px", padding: "14px 22px",
          borderRadius: 18, background: C.white,
          boxShadow: `0 4px 18px ${C.shadow}`,
          maxWidth: 320, animation: "fadeUp 0.4s ease-out",
          textAlign: "center",
        }}>
          <span style={{ fontFamily: F.body, color: C.textDark, fontSize: 14 }}>{error}</span>
        </div>
      )}

      <div style={{ flex: 1 }} />
    </div>
  );
}

// ─── LIBRARY ─────────────────────────────────────────────────────────────
function CategoryChip({ label, active, onClick }) {
  return (
    <button onClick={onClick} style={{
      flexShrink: 0, borderRadius: 14,
      padding: active ? "8px 24px" : "8px 16px",
      border: active ? "none" : "1px solid rgba(255,255,255,0.16)",
      background: active ? C.background : "rgba(255,255,255,0.08)",
      color: active ? C.textDark : C.background,
      fontFamily: F.nav,
      fontWeight: active ? 600 : 400,
      fontSize: active ? 16 : 14,
      lineHeight: "24px",
      cursor: "pointer", whiteSpace: "nowrap",
      transition: "all 0.2s",
    }}>{label}</button>
  );
}

const SOURCE_LABEL = {
  amazon: "Amazon",
  // Legacy labels — retained so cards that pre-date the Amazon migration
  // still render the right credit if they're sitting in the DB.
  pexels: "Pexels",
  unsplash: "Unsplash",
  pixabay: "Pixabay",
};

function PhotoCredit({ source, attribution }) {
  // No credit shown for the local fallback (or unknown sources).
  const label = SOURCE_LABEL[source];
  if (!label || !attribution?.name) return null;
  // Amazon attribution is "Image from Amazon" linked to the product page,
  // not "Photo by [photographer]" — product images don't have a credited
  // photographer.
  const isAmazon = source === "amazon";
  return (
    <a
      href={attribution.profileUrl}
      target="_blank" rel="noopener noreferrer"
      style={{
        position: "absolute", right: 8, bottom: 8,
        padding: "3px 8px", borderRadius: 8,
        background: "rgba(0,0,0,0.45)",
        color: "#fff", textDecoration: "none",
        fontFamily: F.body, fontSize: 10, fontWeight: 500,
        lineHeight: "14px", letterSpacing: "0.01em",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
      }}
    >
      {isAmazon ? `Image from ${label}` : `Photo by ${attribution.name} on ${label}`}
    </a>
  );
}

function GameCard({ game, onEdit, onDelete, onRefresh }) {
  return (
    <div style={{
      flexShrink: 0,
      width: 380, height: 302,
      padding: 17, boxSizing: "border-box",
      border: "1px solid rgba(172,172,172,0.51)",
      borderRadius: 32,
      // "gray-texture 2" from Figma — warm off-white paper-grain pattern,
      // tileable SVG noise. See public/card-texture.svg.
      background: `url("/card-texture.svg") repeat`,
      backgroundColor: "#f7f6f3",
      display: "flex", flexDirection: "column", alignItems: "center",
      overflow: "hidden",
    }}>
      <div style={{
        position: "relative",
        width: "100%", height: 192, borderRadius: 16,
        overflow: "hidden",
        backgroundImage: (game.imageUrl && game.imageUrl !== FALLBACK_IMG) ? `url("${game.imageUrl}")` : "none",
        backgroundSize: "cover", backgroundPosition: "center",
        backgroundColor: C.borderSoft,
      }}>
        {game.imageUrl === FALLBACK_IMG && !game.imgLoading && <FallbackImage />}
        {game.imgLoading && (
          <div className="pwm-shimmer" style={{
            position: "absolute", inset: 0, borderRadius: 16,
          }} />
        )}
        {/* PhotoCredit overlay removed per spec — no source tag shown
            on the card image, regardless of which provider supplied it. */}

        {/* Image-refresh button — re-runs the Firecrawl Amazon search
            using the same query construction (title + category + notes
            summary) and patches the card with the new image. Disabled
            while a fetch is already in flight to prevent double-clicks. */}
        {onRefresh && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (game.imgLoading) return;
              onRefresh(game);
            }}
            disabled={!!game.imgLoading}
            aria-label="Refresh image"
            style={{
              position: "absolute", right: 9, bottom: 9,
              width: 24, height: 24, borderRadius: "50%",
              background: "rgba(255,255,255,0.99)",
              border: "none", padding: 0,
              cursor: game.imgLoading ? "default" : "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: "0 4px 4px rgba(0,0,0,0.46)",
              opacity: game.imgLoading ? 0.6 : 1,
            }}
          >
            <RefreshCw size={14} color="#4f5450" strokeWidth={2.2} />
          </button>
        )}
      </div>
      <div style={{
        width: 326, height: 76,
        paddingRight: 24, paddingTop: 16,
        position: "relative",
      }}>
        {/* Title row (matches Figma node 36:2117). Edit/Trash icons live
            on the meta row below, per Figma — the title sits alone. */}
        <div style={{ position: "relative", height: 31 }}>
          <h3 style={{
            margin: 0, fontFamily: F.display, fontWeight: 700, fontSize: 20,
            color: C.primary, lineHeight: "28px",
            position: "absolute", top: 1, left: 0,
          }}>{game.name}</h3>
        </div>
        {/* Meta row — Players + Ages flow naturally. */}
        <div style={{
          marginTop: 6,
          display: "flex", alignItems: "center", gap: 30,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Users size={16} color="#5a5e5a" strokeWidth={2} />
            <span style={metaText}>{game.players || "- Players"}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 16, lineHeight: 1 }}>😊</span>
            <span style={metaText}>{game.ages || "Ages -"}</span>
          </div>
        </div>

        {/* Edit + Trash icons absolutely positioned to match Figma node
            36:2120 exactly. The Figma coords are left:261, top:25 within
            the title row, which itself sits at y:16 of the bottom
            container. That puts the icon container at top:41 of the
            bottom container, right-aligned to within ~1px of the
            container's right edge (icons extend through the parent's
            right padding to the card edge, per the Figma layout). */}
        <div style={{
          position: "absolute",
          top: 41, right: 1,
          display: "flex", gap: 4, height: 30, alignItems: "flex-start",
        }}>
          <button onClick={() => onEdit(game)} style={iconBtn} aria-label="Edit">
            <Pencil size={18} color={C.textDark} strokeWidth={2} />
          </button>
          <button onClick={() => {
            if (window.confirm(`Delete "${game.name}"?`)) onDelete(game.id);
          }} style={iconBtn} aria-label="Delete">
            <Trash2 size={18} color={C.textDark} strokeWidth={2} />
          </button>
        </div>
      </div>
    </div>
  );
}

const iconBtn = {
  width: 31, height: 31, borderRadius: 8,
  background: "transparent", border: "none", cursor: "pointer",
  display: "flex", alignItems: "center", justifyContent: "center",
  padding: 0,
};

const metaText = {
  fontFamily: F.display, fontWeight: 500, fontSize: 14,
  color: "#5a5e5a", lineHeight: "20px",
  whiteSpace: "nowrap",
};

function LibraryScreen({ library, onAdd, onEdit, onDelete, onRefresh }) {
  const [filter, setFilter] = useState("All");
  const filtered = filter === "All"
    ? library
    : library.filter(g => g.category === filter);

  return (
    <div style={{
      flex: 1, display: "flex", flexDirection: "column",
      background: C.background, overflow: "hidden",
    }}>
      {/* Orange header */}
      <div style={{
        flexShrink: 0,
        background: "rgba(229,106,45,0.95)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        padding: "0 24px",
        boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
        display: "flex", flexDirection: "column", gap: 8,
      }}>
        <StatusBar tone="light" />
        {/* Title row */}
        <div style={{
          padding: "4px 0 8px",
          display: "flex", alignItems: "center", justifyContent: "space-between",
        }}>
          <h1 style={{
            margin: 0, fontFamily: F.display, fontWeight: 800, fontSize: 24,
            color: C.background, lineHeight: 1,
          }}>My Game Library</h1>
          {/* Add-game button (replaces the avatar circle). Same 40x40
              footprint and position so the header layout is unchanged.
              Inline-rendered (circle outline + plus icon) instead of the
              PNG so the previously-baked-in gray interior fill is
              removed — interior is transparent, orange header shows
              through. */}
          <button
            type="button"
            onClick={onAdd}
            aria-label="Add a new game"
            style={{
              width: 40, height: 40, borderRadius: "50%",
              border: "3px solid rgba(255,255,255,0.85)",
              background: "transparent",
              padding: 0, cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            <Plus size={20} color="rgba(255,255,255,0.85)" strokeWidth={2.5} />
          </button>
        </div>
        {/* Category filter row */}
        <div style={{
          paddingBottom: 14,
          display: "flex", gap: 10, overflowX: "auto",
          scrollbarWidth: "none",
        }} className="hide-scrollbar">
          {["All", ...CATEGORIES].map(cat => (
            <CategoryChip
              key={cat} label={cat}
              active={filter === cat}
              onClick={() => setFilter(cat)}
            />
          ))}
        </div>
      </div>

      {/* Card list */}
      <div style={{
        flex: 1, overflow: "auto",
        padding: "20px 24px 24px",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 16,
      }}>
        {filtered.map(g => (
          <GameCard key={g.id} game={g} onEdit={onEdit} onDelete={onDelete} onRefresh={onRefresh} />
        ))}

        {/* Add new card */}
        <button onClick={onAdd} style={{
          flexShrink: 0,
          width: 380, height: 302,
          padding: 50, boxSizing: "border-box",
          borderRadius: 32,
          background: "transparent",
          border: "2px dashed #cac9c7",
          cursor: "pointer",
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center", gap: 15,
        }}>
          <div style={{
            width: 64, height: 64, borderRadius: "50%",
            background: "#cac9c7",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <Plus size={30} color={C.white} strokeWidth={2.4} />
          </div>
          <span style={{
            fontFamily: F.display, fontWeight: 700, fontSize: 20,
            color: C.textDark, lineHeight: "28px",
            whiteSpace: "nowrap",
          }}>New Game or Play Idea</span>
        </button>
      </div>
    </div>
  );
}

// ─── ADD/EDIT ────────────────────────────────────────────────────────────
function EditGameScreen({ game, onSave, onCancel }) {
  const [name, setName] = useState(game?.name || "");
  const [category, setCategory] = useState(game?.category || "Board Game");
  const [notes, setNotes] = useState(game?.notes || "");
  const [error, setError] = useState("");

  const handleSave = () => {
    if (!name.trim()) { setError("Game name is required"); return; }
    const trimmedName = name.trim();
    const trimmedNotes = notes.trim();
    const isEditing = !!game;
    // Re-fetch the image when this is a new card OR any of the three
    // query-driving fields (title, category, notes) have changed.
    const fetchImage = !isEditing
      || game.name !== trimmedName
      || game.category !== category
      || (game.notes || "") !== trimmedNotes;

    const next = {
      id: game?.id || `g-${Date.now()}`,
      name: trimmedName,
      category,
      emoji: CATEGORY_EMOJI[category],
      notes: trimmedNotes,
      // Dash placeholders show through until Firecrawl fills them in
      // via resolveAndPatch. If Amazon's search snippet doesn't include
      // a player count / age range, the dashes stay so the UI signals
      // "unknown" rather than implying a default like "2-10 Players".
      players: game?.players || "- Players",
      ages: game?.ages || "Ages -",
      createdAt: game?.createdAt || new Date().toISOString(),
      // Preserve image + source + attribution when query-fields are unchanged
      imageUrl: fetchImage ? null : (game?.imageUrl || null),
      imageSource: fetchImage ? null : (game?.imageSource || null),
      imageAttribution: fetchImage ? null : (game?.imageAttribution || null),
    };
    onSave(next, { fetchImage });
  };

  const isValid = name.trim().length > 0;

  return (
    <div style={{
      flex: 1, display: "flex", flexDirection: "column",
      background: C.background, overflow: "auto",
    }}>
      {/* Top status bar (orange thin strip) */}
      <div style={{ flexShrink: 0, background: C.primary }}>
        <StatusBar tone="light" />
      </div>

      {/* Header row */}
      <div style={{
        padding: "20px 24px 0",
        display: "flex", alignItems: "center", gap: 16,
      }}>
        <button onClick={onCancel} style={{
          width: 36, height: 36, borderRadius: "50%",
          background: "transparent", border: "none", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <ArrowLeft size={20} color={C.textDark} strokeWidth={2.2} />
        </button>
        <h1 style={{
          margin: 0, flex: 1, textAlign: "center",
          paddingRight: 36,
          fontFamily: F.display, fontWeight: 800, fontSize: 24,
          color: C.primary, letterSpacing: "0.01em",
        }}>Add/Edit Games</h1>
      </div>

      {/* Form */}
      <div style={{ padding: "24px 24px 32px" }}>
        {/* Name */}
        <label style={fieldLabel}>Game / Activity Name *</label>
        <input
          value={name}
          onChange={e => { setName(e.target.value); if (error) setError(""); }}
          placeholder="e.g., Monopoly, Hide & Seek..."
          style={{
            ...textInput,
            border: error
              ? `1.5px solid #d14b2e`
              : `1px solid ${C.borderSoft}`,
          }}
        />
        {error && (
          <div style={{
            marginTop: 6, color: "#d14b2e",
            fontFamily: F.body, fontSize: 12, fontWeight: 600,
          }}>{error}</div>
        )}

        {/* Category */}
        <label style={{ ...fieldLabel, marginTop: 22 }}>Category</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 12 }}>
          {CATEGORIES.map(cat => {
            const active = category === cat;
            return (
              <button key={cat} onClick={() => setCategory(cat)} style={{
                padding: "9px 16px", borderRadius: 999,
                background: active ? C.primary : C.white,
                border: active ? "none" : `1px solid ${C.borderSoft}`,
                color: active ? C.white : C.textDark,
                fontFamily: F.body, fontWeight: 700, fontSize: 14,
                cursor: "pointer", display: "flex", alignItems: "center", gap: 6,
                boxShadow: active ? `0 4px 10px ${C.primaryShadow}` : "none",
                transition: "all 0.15s",
              }}>
                <span>{CATEGORY_EMOJI[cat]}</span>
                <span>{cat}</span>
              </button>
            );
          })}
        </div>

        {/* Notes */}
        <label style={{ ...fieldLabel, marginTop: 22 }}>Notes</label>
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="Any tips or notes..."
          rows={4}
          style={{
            ...textInput, minHeight: 92, resize: "vertical",
            paddingTop: 12, paddingBottom: 12,
            fontFamily: F.body,
          }}
        />

        {/* Submit */}
        <button onClick={handleSave} disabled={!isValid} style={{
          marginTop: 26, width: "100%", height: 58, borderRadius: 14,
          background: isValid ? C.primary : C.primarySoft,
          border: "none", cursor: isValid ? "pointer" : "not-allowed",
          color: C.white,
          fontFamily: F.display, fontWeight: 800, fontSize: 18,
          letterSpacing: "0.01em",
          boxShadow: isValid ? `0 6px 14px ${C.primaryShadow}` : "none",
          transition: "all 0.15s",
        }}>{game ? "Save Changes" : "Add to Library"}</button>
      </div>
    </div>
  );
}

const fieldLabel = {
  display: "block", marginBottom: 10,
  fontFamily: F.body, fontWeight: 700, fontSize: 16,
  color: C.textDark,
};
const textInput = {
  width: "100%", padding: "14px 16px",
  borderRadius: 12, border: `1px solid ${C.borderSoft}`,
  background: C.white,
  fontFamily: F.body, fontSize: 15, color: C.textDark,
  outline: "none", boxSizing: "border-box",
};

// ─── ROOT ────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("home"); // 'home' | 'library'
  const [editing, setEditing] = useState(null); // null | 'new' | game object
  const { games, addOrUpdate, remove, refreshImage } = useGameLibrary();

  const onSave = (g, options) => {
    addOrUpdate(g, options);
    setEditing(null);
    setTab("library");
  };

  const styles = `
    @import url('https://fonts.googleapis.com/css2?family=Playpen+Sans:wght@400;500;700;800&family=Nunito:wght@400;700&family=Open+Sans:wght@400;500;600;700&family=Poppins:wght@400;500;600&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap');
    * { box-sizing: border-box; }
    body { margin: 0; padding: 0; background: #2b2b2b; font-family: 'Open Sans', sans-serif; }
    button:focus-visible { outline: 2px solid ${C.primary}; outline-offset: 2px; }
    input:focus, textarea:focus { border-color: ${C.primary} !important; }
    .hide-scrollbar::-webkit-scrollbar { display: none; }
    @keyframes fadeUp { from { opacity: 0; transform: translateY(12px);} to { opacity: 1; transform: translateY(0);} }
    @keyframes pwmShimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
    .pwm-shimmer {
      background: linear-gradient(90deg, ${C.borderSoft} 0%, #f4ebd9 50%, ${C.borderSoft} 100%);
      background-size: 200% 100%;
      animation: pwmShimmer 1.4s linear infinite;
    }
  `;

  const phoneFrame = {
    width: "100%", maxWidth: 428, height: "100vh", maxHeight: 926,
    margin: "0 auto", position: "relative", overflow: "hidden",
    background: C.background,
    display: "flex", flexDirection: "column",
    boxShadow: "0 0 0 1px rgba(0,0,0,0.04)",
  };

  // Edit screen replaces tabs (no tab bar)
  if (editing !== null) {
    return (
      <div style={phoneFrame}>
        <style>{styles}</style>
        <EditGameScreen
          game={editing === "new" ? null : editing}
          onSave={onSave}
          onCancel={() => setEditing(null)}
        />
      </div>
    );
  }

  return (
    <div style={phoneFrame}>
      <style>{styles}</style>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {tab === "home"
          ? <HomeScreen library={games} />
          : <LibraryScreen
              library={games}
              onAdd={() => setEditing("new")}
              onEdit={(g) => setEditing(g)}
              onDelete={remove}
              onRefresh={refreshImage}
            />
        }
      </div>
      <TabBar tab={tab} onChange={setTab} />
    </div>
  );
}
