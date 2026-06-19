import { useEffect, useMemo, useRef, useState } from "react";
import {
  Home as HomeIcon, Library as LibraryIcon,
  ArrowLeft, Pencil, Trash2, Plus, Users, RefreshCw,
  Lock, LockOpen, ChevronDown, Eye, EyeOff,
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
  "Board Games", "Card Games", "Puzzles", "Toys",
  "Active", "Video Games", "Creativity", "Buy Suggestions", "Other",
];

const CATEGORY_EMOJI = {
  "Board Games": "♟️",
  "Card Games": "🃏",
  "Puzzles": "🧩",
  "Toys": "🧸",
  "Active": "🌳",
  "Video Games": "🎮",
  "Creativity": "🎨",
  "Buy Suggestions": "🛒",
  "Other": "🎯",
};

// Legacy DB category values → current labels, normalized on load so existing
// rows keep matching their (now-pluralized) category button.
const LEGACY_CATEGORY = {
  "Puzzle": "Puzzles",
  "Board Game": "Board Games",
  "Card Game": "Card Games",
  "Video Game": "Video Games",
  "Toy": "Toys",
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
// `isCatalog` rows come from the read-only default_catalog (guest view) — they
// have no user_id / from_default columns, so flag them from-default.
function rowToGame(r, isCatalog = false) {
  return {
    id: r.id,
    name: r.name,
    // Normalize legacy category values (e.g. "Puzzle" → "Puzzles",
    // "Board Game" → "Board Games") so old rows match the current buttons.
    category: LEGACY_CATEGORY[r.category] || r.category,
    emoji: r.emoji,
    notes: r.notes || "",
    players: r.players,
    ages: r.ages,
    imageUrl: r.img,
    imageSource: r.image_source,
    imageAttribution: r.attribution,
    createdAt: r.created_at,
    favorite: r.favorite || false,
    userId: r.user_id ?? null,
    // Cards copied from the default catalog have a locked image.
    fromDefault: isCatalog ? true : !!r.from_default,
    // imgLoading is purely client-side UI state, never persisted.
    imgLoading: false,
  };
}

function gameToRow(g) {
  return {
    id: g.id,
    user_id: g.userId ?? null,
    from_default: g.fromDefault ?? false,
    name: g.name,
    category: g.category,
    emoji: g.emoji ?? null,
    notes: g.notes ?? "",
    players: g.players ?? "- Players",
    ages: g.ages ?? "Ages -",
    img: g.imageUrl ?? null,
    image_source: g.imageSource ?? null,
    attribution: g.imageAttribution ?? null,
    favorite: g.favorite || false,
  };
}

function useGameLibrary(user) {
  const userId = user?.id ?? null;
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

  // Load the right source for who's looking, and reload when that changes:
  //   signed in  → this account's own per-account library (RLS-isolated)
  //   signed out → the global read-only default catalog (the starting set)
  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    backfilledRef.current = new Set();
    (async () => {
      // Newest cards first — Add-to-Library lands at the top of the list.
      const { data, error } = userId
        ? await supabase.from("games").select("*").eq("user_id", userId)
            .order("created_at", { ascending: false })
        : await supabase.from("default_catalog").select("*")
            .order("created_at", { ascending: false });
      if (cancelled) return;
      if (error) {
        // eslint-disable-next-line no-console
        console.error("[library] load failed:", error.message);
        setGames([]);
        setLoaded(true);
        return;
      }
      setGames((data || []).map(r => rowToGame(r, !userId)));
      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [userId]);

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
    if ("favorite" in patch) dbPatch.favorite = patch.favorite;
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
    // Every owned card is stamped with the current account; new cards are
    // not from the default catalog (so their image is fully editable).
    const owned = { ...game, userId: game.userId ?? userId, fromDefault: game.fromDefault ?? false };
    const next = fetchImage
      ? { ...owned, imgLoading: true, imageUrl: null, imageSource: null, imageAttribution: null }
      : owned;

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

  // Inline-edit the card title. Trims, no-ops if empty / unchanged.
  // Does NOT re-fetch the image — that's an explicit refresh-button
  // action, so renaming preserves whatever's currently on the card
  // (matters especially for image_source = "local" cards).
  const rename = async (id, nextName) => {
    const clean = (nextName ?? "").trim();
    if (!clean) return;
    let prev;
    setGames(state => {
      prev = state.find(g => g.id === id);
      if (!prev || prev.name === clean) return state;
      return state.map(g => g.id === id ? { ...g, name: clean } : g);
    });
    if (!prev || prev.name === clean) return;
    const { error } = await supabase
      .from("games")
      .update({ name: clean })
      .eq("id", id);
    if (error) {
      // eslint-disable-next-line no-console
      console.error(`[library] rename ${id} failed:`, error.message);
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
    // Guests view the read-only catalog (can't write), and default-origin
    // cards have a locked image — neither gets backfilled.
    if (!loaded || !userId) return;
    for (const g of games) {
      if (g.fromDefault) continue;
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
  }, [loaded, games.length, userId]);

  const setFavorite = (id, value) => patchById(id, { favorite: value });

  return { games, loaded, addOrUpdate, remove, refreshImage, rename, setFavorite };
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

const ITEM_HEIGHT = 107;

function SlotReel({ items, spinning, targetIndex, delay, onClick }) {
  // Build a long strip by repeating the items 6x for smooth spin
  const strip = useMemo(() => {
    const out = [];
    for (let i = 0; i < 6; i++) out.push(...items);
    return out;
  }, [items]);

  // Resting position is driven by targetIndex so that — even after the reel
  // unmounts (when a game is selected) and remounts (on "Done") — it shows the
  // game that targets[i] points at, keeping it in sync with the click handler.
  const [offset, setOffset] = useState(-ITEM_HEIGHT * (targetIndex % items.length));
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
    <div onClick={onClick} style={{
      position: "relative", width: 107, height: ITEM_HEIGHT,
      background: C.white, borderRadius: 12,
      overflow: "hidden",
      cursor: onClick ? "pointer" : "default",
    }}>
      <div
        style={{
          transform: `translateY(${offset}px)`,
          transition,
          display: "flex", flexDirection: "column",
        }}
      >
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

function RecentCarousel({ recent }) {
  // Always rendered — the section stays visible even before the first pick,
  // and persists the last 10 reel selections (never clears).
  return (
    <div style={{ padding: "24px 0 0 24px" }}>
      <span style={{
        fontFamily: F.display, fontWeight: 700, fontSize: 20,
        color: C.primary, display: "block", marginBottom: 12,
      }}>Recent</span>
      <div
        className="hide-scrollbar"
        style={{ display: "flex", gap: 14, overflowX: "auto", paddingRight: 24, paddingBottom: 4 }}
      >
        {recent.length === 0 ? (
          <div style={{
            flexShrink: 0, height: 107, display: "flex", alignItems: "center",
            color: "#9b938a", fontFamily: F.body, fontSize: 13,
          }}>
            Pick a game from the reels and it&rsquo;ll show up here.
          </div>
        ) : recent.map((g, i) => (
          <div key={i} style={{
            flexShrink: 0, width: 170, height: 107, borderRadius: 12,
            position: "relative", overflow: "hidden",
            backgroundColor: C.borderSoft,
          }}>
            {g.imageUrl && g.imageUrl !== FALLBACK_IMG && (
              <div style={{
                position: "absolute", inset: 0,
                backgroundImage: `url("${g.imageUrl}")`,
                backgroundSize: "cover", backgroundPosition: "center",
              }} />
            )}
            <div style={{
              position: "absolute", inset: 0,
              background: "linear-gradient(to top, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0) 62%)",
            }} />
            <span style={{
              position: "absolute", bottom: 8, left: 0, right: 0,
              textAlign: "center", fontFamily: "'Helvetica', sans-serif",
              fontSize: 10, fontWeight: 400, color: "#fff",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              padding: "0 8px",
            }}>{g.name}</span>
          </div>
        ))}
      </div>
    </div>
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

// ─── Filled lock icons (matching Figma "Action / lock" #858C94) ──────────
function FilledLock({ color = "#858C94", size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} xmlns="http://www.w3.org/2000/svg">
      <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/>
    </svg>
  );
}

function FilledLockOpen({ color = "#858C94", size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} xmlns="http://www.w3.org/2000/svg">
      <path d="M12 1C9.24 1 7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2H9V6c0-1.66 1.34-3 3-3s3 1.34 3 3h2c0-2.76-2.24-5-5-5zm0 16c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/>
    </svg>
  );
}

// ─── HOME ────────────────────────────────────────────────────────────────
const authLink = {
  background: "none", border: "none", padding: "4px 2px", cursor: "pointer",
  fontFamily: F.nav, fontWeight: 700, fontSize: 13, color: C.primary,
};

function HomeScreen({ library, user, gate, onSpin, onSignUp, onLogIn, onLogOut }) {
  const [spinning, setSpinning] = useState(false);
  const [targets, setTargets] = useState([0, 1, 2]);
  const [pulse, setPulse] = useState(false);
  const [locked, setLocked] = useState([false, false, false]);
  const [recent, setRecent] = useState(() => {
    // Restore the last 10 picks so the Recent section survives reloads / tab switches.
    try {
      const raw = localStorage.getItem("pwm:recent");
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.slice(0, 10) : [];
    } catch {
      return [];
    }
  });
  const [error, setError] = useState("");
  const [selectedGame, setSelectedGame] = useState(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterCategories, setFilterCategories] = useState(["All"]);
  const [favoritesOnly, setFavoritesOnly] = useState(false);

  // Per-account filter preferences: load on login, persist on change. Guests
  // keep ephemeral, in-memory filters (and are gated from changing them anyway).
  const prefsReadyRef = useRef(false);
  useEffect(() => {
    prefsReadyRef.current = false;
    if (!user) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("user_preferences").select("filters").eq("user_id", user.id).maybeSingle();
      if (cancelled) return;
      const f = data?.filters;
      if (f) {
        if (Array.isArray(f.categories)) setFilterCategories(f.categories.length ? f.categories : ["All"]);
        if (typeof f.favoritesOnly === "boolean") setFavoritesOnly(f.favoritesOnly);
      }
      prefsReadyRef.current = true; // only persist changes made after the load
    })();
    return () => { cancelled = true; };
  }, [user?.id]);
  useEffect(() => {
    if (!user || !prefsReadyRef.current) return;
    const t = setTimeout(() => {
      supabase.from("user_preferences").upsert({
        user_id: user.id,
        filters: { categories: filterCategories, favoritesOnly },
        updated_at: new Date().toISOString(),
      });
    }, 300);
    return () => clearTimeout(t);
  }, [filterCategories, favoritesOnly, user]);

  const filteredGames = useMemo(() => {
    let src = library;
    if (!filterCategories.includes("All")) {
      src = src.filter(g => filterCategories.includes(g.category));
    }
    if (favoritesOnly) {
      src = src.filter(g => g.favorite);
    }
    return src;
  }, [library, filterCategories, favoritesOnly]);

  const pool = useMemo(() => {
    const src = filteredGames.length >= 3 ? filteredGames : library;
    if (src.length >= 3) {
      return src.map(g => ({
        name: g.name,
        emoji: g.emoji || CATEGORY_EMOJI[g.category] || "🎲",
        imageUrl: (g.imageUrl && g.imageUrl !== FALLBACK_IMG) ? g.imageUrl : null,
      }));
    }
    return REEL_POOL;
  }, [filteredGames, library]);

  // Persist the Recent list so the last 10 picks don't disappear on reload.
  useEffect(() => {
    try {
      localStorage.setItem("pwm:recent", JSON.stringify(recent));
    } catch {
      // Ignore storage failures (private mode / quota) — Recent just won't persist.
    }
  }, [recent]);

  const toggleCategory = (cat) => {
    if (gate && gate()) return;
    setFilterCategories(prev => {
      if (cat === "All") return ["All"];
      const withoutAll = prev.filter(c => c !== "All");
      if (withoutAll.includes(cat)) {
        const next = withoutAll.filter(c => c !== cat);
        return next.length === 0 ? ["All"] : next;
      }
      return [...withoutAll, cat];
    });
  };

  const handleSpin = () => {
    const activeGames = filteredGames.length > 0 ? filteredGames : library;
    if (activeGames.length === 0) { setError("Add some games first!"); return; }
    setError("");
    setPulse(true);
    setTimeout(() => setPulse(false), 400);

    const t = [0, 1, 2].map(i => locked[i] ? targets[i] : Math.floor(Math.random() * pool.length));
    setSpinning(false);
    requestAnimationFrame(() => { setTargets(t); setSpinning(true); });

    setTimeout(() => {
      setSpinning(false);
      onSpin?.(); // counts the spin; nudges signup every 5th while signed out
    }, 1500 + 300 + 200);
  };

  // Record a reel selection: open its detail view and log it to Recent (latest 10).
  const pickFromReel = (game) => {
    setSelectedGame(game);
    setRecent(prev => [game, ...prev].slice(0, 10));
  };

  const toggleLock = (i) => setLocked(prev => {
    const n = [...prev]; n[i] = !n[i]; return n;
  });

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", background: C.background, overflow: "auto" }}>

      {/* "Play With Me" banner (Figma 136:5288) — offset 24px from the top.
          Replaces the old hero photo + status bar + overlaid title. */}
      <div style={{
        position: "relative", flexShrink: 0,
        marginTop: 24, height: 128,
        display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
      }}>
        {/* Auth controls — upper right */}
        <div style={{
          position: "absolute", top: -8, right: 14, zIndex: 6,
          display: "flex", alignItems: "center", gap: 12,
        }}>
          {user ? (
            <>
              <span style={{
                fontFamily: F.nav, fontWeight: 600, fontSize: 12, color: C.textDark,
                maxWidth: 96, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>
                {user.user_metadata?.full_name?.split(" ")[0] || user.email}
              </span>
              <button style={authLink} onClick={onLogOut}>Log Out</button>
            </>
          ) : (
            <>
              <button style={authLink} onClick={onLogIn}>Log In</button>
              <button style={authLink} onClick={onSignUp}>Sign Up</button>
            </>
          )}
        </div>
        {/* Left: "Girl w Kite" — exact Figma composition (142:5314).
            Mirrored (scaleX(-1) ≡ Figma's -scale-y-100 rotate-180) with the
            Figma crop offsets so the kite sits at the upper-right. */}
        <div style={{
          position: "absolute", left: 14, top: 0,
          width: 92.4, height: 153.6, overflow: "hidden",
          transform: "scaleX(-1)", pointerEvents: "none",
        }}>
          <img src="/header-girl-kite.png" alt="" style={{
            position: "absolute", left: "-5.47%", top: "-2.17%",
            width: "116.39%", height: "122.83%", maxWidth: "none",
          }} />
        </div>
        {/* Right: "Boy w Soccer Ball" — exact Figma composition (142:5321).
            75.61×96 unit, bottom-aligned, boy upper-right + ball/shadow lower-left. */}
        <div style={{
          position: "absolute", right: 24, top: 57,
          width: 75.61, height: 96.02, pointerEvents: "none",
        }}>
          {/* Boy (cropped to box, matching Figma object positioning) */}
          <div style={{
            position: "absolute", left: 14.44, top: 0,
            width: 61.17, height: 88.36, overflow: "hidden",
          }}>
            <img src="/header-boy.png" alt="" style={{
              position: "absolute", left: "-1.14%", top: 0,
              width: "102.29%", height: "125%", maxWidth: "none",
            }} />
          </div>
          {/* Ball shadow */}
          <img src="/header-ball-shadow.svg" alt="" style={{
            position: "absolute", left: 4.25, top: 85.81,
            width: 20.39, height: 10.21, transform: "rotate(-7.74deg)",
          }} />
          {/* Soccer ball */}
          <img src="/header-ball.png" alt="" style={{
            position: "absolute", left: 0, top: 73.91,
            width: 22.09, height: 22.09, objectFit: "cover",
          }} />
        </div>
        {/* Title + tagline, centered */}
        <span style={{
          fontFamily: F.display, fontWeight: 800, fontSize: 32,
          color: "#392d13", lineHeight: 1.1, textAlign: "center",
        }}>Play With Me</span>
        <span style={{
          fontFamily: F.display, fontWeight: 600, fontSize: 12,
          color: C.primary, textAlign: "center", marginTop: 6, lineHeight: 1.35,
        }}>The Right Activity<br />At The Right Time</span>
      </div>

      {selectedGame ? (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "24px 24px 0" }}>
          <p style={{
            fontFamily: F.display, fontWeight: 700, fontSize: 20,
            color: C.primary, textAlign: "center", margin: "0 0 24px",
          }}>Its Time For - {selectedGame.name}!</p>
          <div style={{
            width: 380, height: 380, borderRadius: 50,
            overflow: "hidden", position: "relative", background: C.borderSoft, flexShrink: 0,
          }}>
            {selectedGame.imageUrl ? (
              <div style={{
                position: "absolute", inset: 0,
                backgroundImage: `url("${selectedGame.imageUrl}")`,
                backgroundSize: "cover", backgroundPosition: "center",
              }} />
            ) : (
              <div style={{
                position: "absolute", inset: 0,
                display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center",
              }}>
                <span style={{ fontSize: 80 }}>{selectedGame.emoji}</span>
                <span style={{ fontFamily: F.display, fontWeight: 700, fontSize: 20, color: C.textDark, marginTop: 8 }}>
                  {selectedGame.name}
                </span>
              </div>
            )}
          </div>
          <button
            onClick={() => setSelectedGame(null)}
            style={{
              marginTop: 24, marginBottom: 24,
              width: 380, height: 48, borderRadius: 45,
              background: "none", border: `1px solid ${C.primary}`,
              cursor: "pointer", fontFamily: F.display, fontWeight: 800,
              fontSize: 16, color: C.primary,
            }}
          >Done</button>
        </div>
      ) : (
        <>
          {/* Pick a Game card */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "24px 0 0" }}>
            <div style={{
              width: 380, borderRadius: 24,
          background: "#f7f5f0",
          boxShadow: "0 0 33.5px rgba(230,113,54,0.4)",
          position: "relative",
          overflow: "hidden",
        }}>
          {!filterOpen && (
          <>
          {/* Card header row */}
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "0 16px", height: 60,
          }}>
            <span style={{
              fontFamily: F.display, fontWeight: 700, fontSize: 20, color: C.primary,
            }}>Pick a Game</span>
            <button
              onClick={() => setFilterOpen(true)}
              style={{
                display: "flex", alignItems: "center", gap: 4,
                background: "none", border: "none", cursor: "pointer",
                padding: 8, margin: -8,
              }}
            >
              <span style={{
                fontFamily: F.display, fontWeight: 700, fontSize: 12, color: C.primary,
              }}>Filter Options</span>
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M10 0C15.52 0 20 4.48 20 10C20 15.52 15.52 20 10 20C4.48 20 0 15.52 0 10C0 4.48 4.48 0 10 0ZM7.20996 9C6.76001 9.00006 6.54037 9.54037 6.86035 9.86035L9.65039 12.6504C9.84044 12.84 10.1605 12.8395 10.3604 12.6396L13.1504 9.84961C13.4698 9.53955 13.2496 9 12.7998 9H7.20996Z" fill="#E67136"/>
              </svg>
            </button>
          </div>

          {/* Divider */}
          <div style={{ height: 1, background: "rgba(0,0,0,0.08)", margin: "0 16px" }} />

          {/* Three reel windows + lock toggles */}
          <div style={{
            display: "flex", justifyContent: "space-between",
            padding: "24px 16px 0",
          }}>
            {[0, 1, 2].map(i => (
              <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
                <SlotReel
                  items={pool}
                  spinning={spinning && !locked[i]}
                  targetIndex={targets[i]}
                  delay={i * 150}
                  onClick={() => { if (!spinning) pickFromReel(pool[targets[i] % pool.length]); }}
                />
                {/* Lock / unlock toggle */}
                <button
                  type="button"
                  onClick={() => toggleLock(i)}
                  style={{
                    background: "none", border: "none", cursor: "pointer",
                    padding: 0, display: "flex", alignItems: "center", justifyContent: "center",
                    width: 24, height: 24,
                  }}
                  aria-label={locked[i] ? "Unlock reel" : "Lock reel"}
                >
                  {locked[i]
                    ? <FilledLock size={20} color="#858C94" />
                    : <LockOpen size={20} color="#858C94" strokeWidth={2} />
                  }
                </button>
              </div>
            ))}
          </div>

          {/* Spin button */}
          <div style={{ display: "flex", justifyContent: "center", padding: "24px 32px 32px" }}>
            <button onClick={handleSpin} style={{
              width: "100%", height: 48, borderRadius: 45,
              background: C.primary, border: "none", cursor: "pointer",
              fontFamily: F.display, fontWeight: 800, fontSize: 16,
              color: "#faf9f7", letterSpacing: "0.01em",
              transform: pulse ? "scale(0.97)" : "scale(1)",
              transition: "transform 0.2s cubic-bezier(.4,1.5,.5,1)",
            }}>Spin</button>
          </div>
          </>
          )}

          {/* Filter panel — rendered in normal flow so the card grows to fit
              its content instead of scrolling internally. */}
          {filterOpen && (
            <div style={{
              display: "flex", flexDirection: "column",
            }}>
              {/* Header */}
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "0 16px", height: 60, flexShrink: 0,
              }}>
                <span style={{ fontFamily: F.display, fontWeight: 700, fontSize: 20, color: C.primary }}>
                  Pick a Game
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontFamily: F.display, fontWeight: 700, fontSize: 12, color: C.primary }}>
                    Filter Options
                  </span>
                  <button
                    onClick={() => setFilterOpen(false)}
                    style={{
                      width: 24, height: 24, borderRadius: 12,
                      background: C.primary, border: "none", cursor: "pointer",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      padding: 0, flexShrink: 0,
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path d="M1 1L11 11M11 1L1 11" stroke="white" strokeWidth="2" strokeLinecap="round"/>
                    </svg>
                  </button>
                </div>
              </div>

              {/* Divider */}
              <div style={{ height: 1, background: "rgba(0,0,0,0.08)", margin: "0 16px", flexShrink: 0 }} />

              {/* Subtitle */}
              <div style={{ padding: "14px 16px 0", flexShrink: 0 }}>
                <span style={{ fontFamily: F.display, fontWeight: 500, fontSize: 14, color: C.primary }}>
                  Pick what you want to see in the windows
                </span>
              </div>

              {/* Favorites toggle row */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px", flexShrink: 0 }}>
                {/* Heart-thumb toggle — matches Figma 80:4251/4252 exactly */}
                <svg
                  width="46" height="23" viewBox="0 0 46 23" fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  onClick={() => { if (gate && gate()) return; setFavoritesOnly(prev => !prev); }}
                  style={{ cursor: "pointer", flexShrink: 0 }}
                >
                  {/* Track — gray pill, shifts 10px when thumb slides right */}
                  <rect x={favoritesOnly ? 0 : 10} y="4" width="36" height="16" rx="8" fill="#DADEE3"/>
                  {/* Heart thumb — slides left→right, gray→orange */}
                  <path
                    d="M14.754 22.3271C13.7663 23.2264 12.2459 23.2264 11.2583 22.3141L11.1154 22.1838C4.29299 15.9929 -0.164294 11.9395 0.00464059 6.88251C0.0826106 4.66682 1.21318 2.54237 3.04547 1.29116C6.47615 -1.05486 10.7125 0.039953 12.9996 2.72484C15.2868 0.039953 19.5231 -1.06789 22.9538 1.29116C24.7861 2.54237 25.9167 4.66682 25.9946 6.88251C26.1766 11.9395 21.7063 15.9929 14.8839 22.2098L14.754 22.3271Z"
                    fill={favoritesOnly ? "#E67136" : "#A2A2A2"}
                    style={{
                      transform: favoritesOnly ? "translateX(20px)" : "translateX(0px)",
                      transition: "transform 0.2s ease, fill 0.2s ease",
                    }}
                  />
                </svg>
                <span style={{ fontFamily: F.display, fontWeight: 500, fontSize: 14, color: C.primary }}>
                  Only Show Favorites
                </span>
              </div>

              {/* Category buttons */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: "12px 12px", padding: "0 16px 24px" }}>
                {["All", ...CATEGORIES].map(cat => {
                  const isActive = filterCategories.includes(cat);
                  return (
                    <button
                      key={cat}
                      onClick={() => toggleCategory(cat)}
                      style={{
                        height: 40, padding: "0 17px", borderRadius: 14,
                        border: "1px solid #e67136",
                        background: isActive ? C.primary : "rgba(255,255,255,0.4)",
                        color: isActive ? "#fff" : C.primary,
                        fontFamily: F.nav, fontWeight: 700, fontSize: 13,
                        cursor: "pointer", whiteSpace: "nowrap",
                        boxShadow: isActive
                          ? "0 2px 4px rgba(0,0,0,0.05)"
                          : "0 2px 8px rgba(0,0,0,0.05)",
                        transition: "all 0.15s",
                      }}
                    >
                      {cat}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {error && (
          <div style={{ marginTop: 10, fontFamily: F.body, fontSize: 13, color: C.primary }}>{error}</div>
        )}
      </div>

          {/* Recent carousel */}
          <RecentCarousel recent={recent} />
        </>
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

function GameCard({ game, onEdit, onDelete, onRefresh, onRename, onFavorite }) {
  // Inline title editing state. Click the title to start editing;
  // Enter or blur commits, Escape cancels. Falls back to a plain
  // <h3> when onRename isn't provided (keeps the card usable in
  // any context that doesn't wire up renaming).
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(game.name);
  const titleInputRef = useRef(null);
  useEffect(() => {
    if (editing && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [editing]);
  useEffect(() => {
    // Keep draft in sync with prop changes when not editing
    // (e.g. when an external rename / replace updates the row).
    if (!editing) setDraft(game.name);
  }, [game.name, editing]);
  const commit = () => {
    const next = (draft ?? "").trim();
    if (next && next !== game.name && onRename) {
      onRename(game.id, next);
    } else {
      setDraft(game.name);
    }
    setEditing(false);
  };
  const cancel = () => {
    setDraft(game.name);
    setEditing(false);
  };
  const titleStyle = {
    margin: 0, fontFamily: F.display, fontWeight: 700, fontSize: 20,
    color: C.primary, lineHeight: "28px",
    position: "absolute", top: 1, left: 0,
  };
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
        {onRefresh && !game.fromDefault && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (game.imgLoading) return;
              if (game.imageSource === "local") {
                if (!window.confirm("This card uses a custom image. Replace it with one from Amazon?")) return;
              }
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
            on the meta row below, per Figma — the title sits alone.
            Tap the title to inline-edit; commit on Enter or blur,
            cancel on Escape. */}
        <div style={{ position: "relative", height: 31 }}>
          {editing && onRename ? (
            <input
              ref={titleInputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); commit(); }
                if (e.key === "Escape") { e.preventDefault(); cancel(); }
              }}
              maxLength={100}
              aria-label="Game title"
              style={{
                ...titleStyle,
                right: 0, width: "100%",
                background: "rgba(230,113,54,0.06)",
                border: `1px solid ${C.primarySoft}`,
                borderRadius: 6,
                padding: "0 6px",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          ) : (
            <h3
              onClick={() => onRename && setEditing(true)}
              title={onRename ? "Tap to rename" : undefined}
              style={{
                ...titleStyle,
                cursor: onRename ? "text" : "default",
              }}
            >{game.name}</h3>
          )}
        </div>
        {/* Favorite row */}
        <button
          onClick={() => onFavorite && onFavorite(game.id, !game.favorite)}
          style={{
            marginTop: 6,
            display: "flex", alignItems: "center", gap: 10,
            background: "none", border: "none", cursor: "pointer", padding: 0,
          }}
          aria-label={game.favorite ? "Remove from favorites" : "Select as Favorite"}
        >
          <svg width="20" height="18" viewBox="0 0 20 18" fill={game.favorite ? "#E67136" : "none"} xmlns="http://www.w3.org/2000/svg">
            <path d="M10.3828 2.45313C12.0046 0.516285 14.9788 -0.252934 17.3701 1.41992L17.3711 1.4209C18.6445 2.3056 19.4412 3.81898 19.4961 5.40332V5.4043C19.5601 7.21643 18.8118 8.88423 17.3506 10.7334C16.249 12.1275 14.771 13.59 12.9893 15.2646L11.1094 17.0146L11.0107 17.1055L11.0098 17.1064C10.4422 17.6323 9.57056 17.6321 9.00293 17.0986L9 17.0967L8.89063 16.9951L8.88965 16.9941L7.00977 15.25C5.22912 13.5816 3.75274 12.1223 2.65234 10.7305C1.19282 8.88431 0.443586 7.21613 0.50293 5.40332C0.557812 3.81897 1.35449 2.30561 2.62793 1.4209C5.02077 -0.243868 7.99545 0.517662 9.61621 2.45313L10 2.91113L10.3828 2.45313Z" stroke={game.favorite ? "#E67136" : "#5A5E5A"} strokeWidth="1"/>
          </svg>
          <span style={{ fontFamily: F.display, fontWeight: 500, fontSize: 14, color: "#5a5e5a" }}>
            Favorite
          </span>
        </button>

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

function LibraryScreen({ library, isGuest, onRequireAccount, onAdd, onEdit, onDelete, onRefresh, onRename, onFavorite }) {
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
          <div key={g.id} style={{ position: "relative", flexShrink: 0 }}>
            <GameCard game={g} onEdit={onEdit} onDelete={onDelete} onRefresh={onRefresh} onRename={onRename} onFavorite={onFavorite} />
            {/* Signed-out guests: any tap on a card prompts account creation. */}
            {isGuest && (
              <div
                onClick={onRequireAccount}
                aria-label="Create an account to manage games"
                style={{ position: "absolute", inset: 0, zIndex: 2, cursor: "pointer" }}
              />
            )}
          </div>
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
function EditGameScreen({ game, gate, onSave, onCancel }) {
  // For signed-out guests, any attempt to fill the form prompts account
  // creation (and blocks the interaction).
  const guard = () => gate ? gate() : false;
  const [name, setName] = useState(game?.name || "");
  const [category, setCategory] = useState(game?.category || "Board Games");
  const [notes, setNotes] = useState(game?.notes || "");
  const [error, setError] = useState("");

  const handleSave = () => {
    if (!name.trim()) { setError("Game name is required"); return; }
    const trimmedName = name.trim();
    const trimmedNotes = notes.trim();
    const isEditing = !!game;
    const fromDefault = game?.fromDefault || false;
    // Re-fetch the image when this is a new card OR any of the three
    // query-driving fields (title, category, notes) have changed — but NEVER
    // for a default-origin card: its image is locked, so edits keep it.
    const fetchImage = !fromDefault && (
      !isEditing
      || game.name !== trimmedName
      || game.category !== category
      || (game.notes || "") !== trimmedNotes
    );

    const next = {
      id: game?.id || (crypto?.randomUUID ? crypto.randomUUID() : `g-${Date.now()}`),
      userId: game?.userId,
      fromDefault,
      name: trimmedName,
      category,
      emoji: CATEGORY_EMOJI[category],
      notes: trimmedNotes,
      favorite: game?.favorite || false,
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
  const isDirty = !game
    ? isValid
    : (name.trim() !== (game.name || "").trim()
      || category !== (game.category || "Board Games")
      || notes.trim() !== (game.notes || "").trim());

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
          onFocus={e => { if (guard()) e.target.blur(); }}
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
        <label style={{ ...fieldLabel, marginTop: 24 }}>Category</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 12 }}>
          {CATEGORIES.map(cat => {
            const active = category === cat;
            return (
              <button key={cat} onClick={() => { if (guard()) return; setCategory(cat); }} style={{
                padding: "10px 17px", borderRadius: 14, height: 40,
                background: active ? C.primary : "rgba(255,255,255,0.22)",
                border: active ? "none" : "1px solid #ffffff",
                color: active ? C.white : C.primary,
                fontFamily: F.reel, fontWeight: 700, fontSize: 13,
                cursor: "pointer", display: "flex", alignItems: "center", gap: 4,
                boxShadow: active
                  ? `0 2px 4px rgba(0,0,0,0.05)`
                  : "0 2px 8px rgba(0,0,0,0.05)",
                transition: "all 0.15s",
              }}>
                {cat}
              </button>
            );
          })}
        </div>

        {/* Notes */}
        <label style={{ ...fieldLabel, marginTop: 22 }}>Notes</label>
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          onFocus={e => { if (guard()) e.target.blur(); }}
          placeholder="Any tips or notes..."
          rows={4}
          style={{
            ...textInput, minHeight: 92, resize: "vertical",
            paddingTop: 14, paddingBottom: 14,
            border: "2px solid #fae1d5",
            fontFamily: F.body,
          }}
        />

        {/* Submit */}
        <button onClick={handleSave} disabled={!isValid} style={{
          marginTop: 26, width: "100%", height: 58, borderRadius: 16,
          background: (isValid && isDirty) ? C.primary : "#fac2a7",
          border: "none",
          cursor: (isValid && isDirty) ? "pointer" : isValid ? "default" : "not-allowed",
          color: C.white,
          fontFamily: F.body, fontWeight: 700, fontSize: 16,
          textAlign: "center",
          transition: "all 0.2s",
        }}>{game ? "Save Changes" : "Add to Library"}</button>
      </div>
    </div>
  );
}

const fieldLabel = {
  display: "block", marginBottom: 6,
  fontFamily: F.body, fontWeight: 700, fontSize: 13,
  color: C.textDark,
};
const textInput = {
  width: "100%", padding: "14px 16px",
  borderRadius: 14, border: `2px solid rgba(230,113,54,0.21)`,
  background: C.white,
  fontFamily: F.body, fontSize: 14, color: C.textDark,
  outline: "none", boxSizing: "border-box",
};

// ─── Auth modal (Supabase email/password) ────────────────────────────────
const authOverlay = {
  position: "absolute", inset: 0, zIndex: 100,
  background: "rgba(0,0,0,0.6)",
  display: "flex", alignItems: "center", justifyContent: "center",
  padding: 20,
};
const authModalBox = {
  position: "relative", width: "100%", maxWidth: 360,
  background: "#2c2c2e", borderRadius: 16, padding: "28px 24px 22px",
  boxShadow: "0 24px 64px rgba(0,0,0,0.55)",
};
const authCloseX = {
  position: "absolute", top: 14, right: 14,
  background: "none", border: "none", color: "#8a8a8e",
  fontSize: 18, lineHeight: 1, cursor: "pointer", padding: 4,
};
const authTitle = { margin: "0 0 6px", fontFamily: F.body, fontWeight: 800, fontSize: 24, color: "#fff" };
const authSubtitle = { margin: "0 0 22px", fontFamily: F.body, fontSize: 14, color: "#9a9a9e" };
const authInput = {
  width: "100%", padding: "14px 16px", borderRadius: 12,
  border: "1px solid rgba(255,255,255,0.14)", background: "rgba(255,255,255,0.03)",
  color: "#fff", fontFamily: F.body, fontSize: 14, outline: "none", boxSizing: "border-box",
};
const authPrimaryBtn = {
  width: "100%", padding: "14px", marginTop: 2, borderRadius: 12, border: "none",
  background: "#ededed", color: "#1a1a1a", fontFamily: F.body, fontWeight: 700,
  fontSize: 15, cursor: "pointer",
};
const authFooter = { margin: "18px 0 0", textAlign: "center", fontFamily: F.body, fontSize: 13, color: "#9a9a9e" };
const authFooterLink = {
  background: "none", border: "none", padding: 0, cursor: "pointer",
  color: "#fff", fontWeight: 700, fontSize: 13, textDecoration: "underline", fontFamily: F.body,
};

// "Remember Me": persist the login email + password on this device so the user
// can be auto-logged-in after signing out. SECURITY NOTE: this stores the
// password in plaintext in the browser's localStorage — only acceptable for a
// prototype. A real app should never store a raw password client-side.
const REMEMBER_KEY = "pwm:remember";
function loadRemembered() {
  try { const r = localStorage.getItem(REMEMBER_KEY); return r ? JSON.parse(r) : null; }
  catch { return null; }
}
function saveRemembered(email, password) {
  try { localStorage.setItem(REMEMBER_KEY, JSON.stringify({ email, password })); } catch { /* ignore */ }
}
function clearRemembered() {
  try { localStorage.removeItem(REMEMBER_KEY); } catch { /* ignore */ }
}

function AuthModal({ mode, onClose, onSwitch, onAuthed }) {
  const isSignup = mode === "signup";
  const remembered = isSignup ? null : loadRemembered();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState(remembered?.email || "");
  const [password, setPassword] = useState(remembered?.password || "");
  const [remember, setRemember] = useState(!!remembered);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError(""); setInfo("");
    if (!email.trim() || !password || (isSignup && !fullName.trim())) {
      setError("Please fill in all fields.");
      return;
    }
    setLoading(true);
    try {
      if (isSignup) {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { data: { full_name: fullName.trim() } },
        });
        if (error) setError(error.message);
        else if (!data.session) setInfo("Account created! Check your email to confirm, then log in.");
        else onAuthed();
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) setError(error.message);
        else {
          if (remember) saveRemembered(email.trim(), password);
          else clearRemembered();
          onAuthed();
        }
      }
    } catch (err) {
      setError(err?.message || "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={authOverlay} onClick={onClose}>
      <div style={authModalBox} onClick={(e) => e.stopPropagation()}>
        <button style={authCloseX} onClick={onClose} aria-label="Close">✕</button>
        <h2 style={authTitle}>{isSignup ? "Create Account" : "Welcome Back"}</h2>
        <p style={authSubtitle}>
          {isSignup ? "Sign up to save your game library" : "Log in to your account"}
        </p>
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {isSignup && (
            <input
              style={authInput} placeholder="Full name" autoComplete="name"
              value={fullName} onChange={(e) => setFullName(e.target.value)}
            />
          )}
          <input
            style={authInput} type="email" placeholder="Email address" autoComplete="email"
            value={email} onChange={(e) => setEmail(e.target.value)}
          />
          <div style={{ position: "relative" }}>
            <input
              style={{ ...authInput, paddingRight: 44 }}
              type={showPassword ? "text" : "password"} placeholder="Password"
              autoComplete={isSignup ? "new-password" : "current-password"}
              value={password} onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              onClick={() => setShowPassword((s) => !s)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              style={{
                position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)",
                background: "none", border: "none", cursor: "pointer", padding: 4,
                display: "flex", color: "#9a9a9e",
              }}
            >
              {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
          {!isSignup && (
            <label style={{
              display: "flex", alignItems: "center", gap: 8,
              cursor: "pointer", userSelect: "none", marginTop: -2,
            }}>
              <input
                type="checkbox" checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                style={{ width: 16, height: 16, accentColor: C.primary, cursor: "pointer" }}
              />
              <span style={{ fontFamily: F.body, fontSize: 13, color: "#cfcfd3" }}>Remember Me</span>
            </label>
          )}
          {error && <p style={{ margin: 0, color: "#ff6b6b", fontFamily: F.body, fontSize: 13 }}>{error}</p>}
          {info && <p style={{ margin: 0, color: "#7bd88f", fontFamily: F.body, fontSize: 13 }}>{info}</p>}
          <button type="submit" style={{ ...authPrimaryBtn, opacity: loading ? 0.7 : 1 }} disabled={loading}>
            {loading ? "Please wait…" : isSignup ? "Create Account" : "Log In"}
          </button>
        </form>
        <p style={authFooter}>
          {isSignup ? "Already have an account? " : "Don't have an account? "}
          <button style={authFooterLink} onClick={() => onSwitch(isSignup ? "login" : "signup")}>
            {isSignup ? "Log In" : "Sign Up"}
          </button>
        </p>
      </div>
    </div>
  );
}

// ─── ROOT ────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("home"); // 'home' | 'library'
  const [editing, setEditing] = useState(null); // null | 'new' | game object
  const [user, setUser] = useState(null);
  const [authMode, setAuthMode] = useState(null); // null | 'signup' | 'login'
  const { games, addOrUpdate, remove, refreshImage, rename, setFavorite } = useGameLibrary(user);

  // Track the Supabase auth session. The moment a user is signed in (via
  // signup, login, or a restored session), drop all gating: every gate is
  // keyed off `user`, and we also close any open auth modal here so the
  // first-time restrictions lift immediately and completely.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setUser(data.session?.user ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      const u = session?.user ?? null;
      setUser(u);
      if (u) setAuthMode(null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // First-time gating: signed-out users get the Create Account modal when they
  // try to manage the library. Spinning, locking, and picking reels stay free.
  const spinCountRef = useRef(0);
  const requireAccount = () => {
    if (!user) { setAuthMode("signup"); return true; }
    return false;
  };
  // Nudge with the signup modal after every 5 spins while signed out.
  const registerSpin = () => {
    if (user) return;
    spinCountRef.current += 1;
    if (spinCountRef.current % 5 === 0) setAuthMode("signup");
  };
  // Header "Log In" always opens the Welcome Back modal. If "Remember Me" was
  // used, the modal pre-fills email + password (password masked, with a
  // show/hide toggle) — the user still confirms by tapping Log In.
  const handleLogIn = () => setAuthMode("login");

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
          gate={requireAccount}
          onSave={onSave}
          onCancel={() => setEditing(null)}
        />
        {authMode && (
          <AuthModal
            key={authMode}
            mode={authMode}
            onClose={() => setAuthMode(null)}
            onSwitch={setAuthMode}
            onAuthed={() => setAuthMode(null)}
          />
        )}
      </div>
    );
  }

  return (
    <div style={phoneFrame}>
      <style>{styles}</style>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {tab === "home"
          ? <HomeScreen
              library={games}
              user={user}
              gate={requireAccount}
              onSpin={registerSpin}
              onSignUp={() => setAuthMode("signup")}
              onLogIn={handleLogIn}
              onLogOut={() => supabase.auth.signOut()}
            />
          : <LibraryScreen
              library={games}
              isGuest={!user}
              onRequireAccount={() => setAuthMode("signup")}
              onAdd={() => setEditing("new")}
              onEdit={(g) => setEditing(g)}
              onDelete={remove}
              onRefresh={refreshImage}
              onRename={rename}
              onFavorite={setFavorite}
            />
        }
      </div>
      <TabBar tab={tab} onChange={setTab} />
      {authMode && (
        <AuthModal
          mode={authMode}
          onClose={() => setAuthMode(null)}
          onSwitch={setAuthMode}
          onAuthed={() => setAuthMode(null)}
        />
      )}
    </div>
  );
}
