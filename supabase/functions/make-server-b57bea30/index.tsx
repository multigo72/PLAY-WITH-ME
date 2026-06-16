// Supabase Edge Function for the Play With Me app.
//
// Responsible for:
//   - GET /amazon-search?q=<query>&exclude=<url>&exclude=<url>...
//       Scrapes an Amazon search results page via Firecrawl and returns
//       the first product whose image URL is not in the exclude list.
//       Falls back to null when every result is excluded.
//   - GET /key-fingerprint  — diagnostic
//   - GET /fc-probe         — diagnostic (raw upstream response)
//   - GET /health           — liveness check
//
// Upstream scraping is now done via Firecrawl (https://firecrawl.dev),
// replacing the previous Bright Data Web Unlocker integration. The
// Firecrawl API token is read from the Supabase Edge Function secret
// `Firecrawl API 1` (additional fallback names are tried in case the
// secret is renamed later).

import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { logger } from "npm:hono/logger";
import { request as undiciRequest } from "npm:undici@^6";
import * as kv from "./kv_store.tsx";

const app = new Hono();

app.use("*", logger(console.log));
app.use("/*", cors({
  origin: "*",
  allowHeaders: ["Content-Type", "Authorization"],
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  exposeHeaders: ["Content-Length"],
  maxAge: 600,
}));

app.get("/make-server-b57bea30/health", (c) => c.json({ status: "ok" }));

// ─── Firecrawl credential lookup ────────────────────────────────────────
// Tried in order — first non-empty wins. "Firecrawl API 1" is the
// user-provisioned secret in the Supabase dashboard.
const FIRECRAWL_TOKEN_NAMES = [
  "Firecrawl API 1",
  "FIRECRAWL_API_KEY",
  "FIRECRAWL_TOKEN",
];

function findFirecrawlToken(): { value?: string; name?: string } {
  for (const n of FIRECRAWL_TOKEN_NAMES) {
    const v = Deno.env.get(n);
    if (v) return { value: v, name: n };
  }
  return {};
}

function fp(s: string | undefined): string {
  if (!s) return "(none)";
  return `${s.slice(0, 4)}… len=${s.length}`;
}

// ─── HTML → text helpers, used by the parser ────────────────────────────
function toText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#?\w+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePlayers(text: string): string | null {
  let m = text.match(/(\d+)\s*(?:[–\-]|to)\s*(\d+)\s*players?/i);
  if (m) return `${m[1]}-${m[2]} Players`;
  m = text.match(/(\d+)\s*\+\s*players?/i);
  if (m) return `${m[1]}+ Players`;
  m = text.match(/\b(\d+)\s+players?\b/i);
  if (m) return `${m[1]} Players`;
  return null;
}

function parseAges(text: string): string | null {
  let m = text.match(/ages?\s*(\d+)\s*[–\-]\s*(\d+)/i);
  if (m) return `Ages ${m[1]}-${m[2]}`;
  m = text.match(/ages?\s*(\d+)\s*(?:\+|&\s*up|and\s+up)/i);
  if (m) return `Ages ${m[1]}+`;
  m = text.match(/ages?\s*(\d+)\b/i);
  if (m) return `Ages ${m[1]}+`;
  return null;
}

type AmazonResult = {
  imageUrl: string | null;
  title: string | null;
  link: string | null;
  asin: string | null;
  players: string | null;
  ages: string | null;
};

function parseBlock(block: string): AmazonResult {
  const asinMatch = block.match(/data-asin="([A-Z0-9]{10})"/);
  const asin = asinMatch?.[1] ?? null;

  let imageUrl: string | null = null;
  const sImage = block.match(/<img[^>]*class="[^"]*s-image[^"]*"[^>]*src="(https:\/\/m\.media-amazon\.com\/images\/I\/[A-Za-z0-9._+-]+\.(?:jpg|jpeg|png))"/i);
  if (sImage) {
    imageUrl = sImage[1];
  } else {
    const anyImg = block.match(/https:\/\/m\.media-amazon\.com\/images\/I\/[A-Za-z0-9._+-]+\.(?:jpg|jpeg|png)/);
    imageUrl = anyImg?.[0] ?? null;
  }

  let title: string | null = null;
  const titleMatch = block.match(/<h2[^>]*>\s*<a[^>]*class="[^"]*a-link-normal[^"]*"[^>]*>[\s\S]*?<span[^>]*>([^<]{5,300})<\/span>[\s\S]*?<\/a>\s*<\/h2>/i);
  if (titleMatch) title = titleMatch[1].trim().replace(/\s+/g, " ");

  const blockText = toText(block.slice(0, 8000));
  const players = parsePlayers(blockText);
  const ages = parseAges(blockText);
  const link = asin ? `https://www.amazon.com/dp/${asin}` : null;
  return { imageUrl, title, link, asin, players, ages };
}

function findPositions(html: string, re: RegExp, max: number): number[] {
  const positions: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && positions.length < max + 1) {
    positions.push(m.index);
  }
  return positions;
}

function parseAmazonResults(html: string, max = 3): AmazonResult[] {
  const patterns: RegExp[] = [
    /<div[^>]*data-asin="[A-Z0-9]{10}"[^>]*data-component-type="s-search-result"/gi,
    /<div[^>]*data-component-type="s-search-result"[^>]*data-asin="[A-Z0-9]{10}"/gi,
    /<div[^>]*data-asin="[A-Z0-9]{10}"/gi,
  ];
  for (const re of patterns) {
    const positions = findPositions(html, re, max);
    if (positions.length === 0) continue;
    const results: AmazonResult[] = [];
    const seenAsins = new Set<string>();
    for (let i = 0; i < positions.length; i++) {
      const start = positions[i];
      const end = i + 1 < positions.length ? positions[i + 1] : Math.min(start + 30000, html.length);
      const block = html.slice(start, end);
      const parsed = parseBlock(block);
      if (!parsed.imageUrl) continue;
      if (parsed.asin && seenAsins.has(parsed.asin)) continue;
      if (parsed.asin) seenAsins.add(parsed.asin);
      results.push(parsed);
      if (results.length >= max) break;
    }
    if (results.length > 0) return results;
  }
  return [];
}

// ─── Firecrawl call ─────────────────────────────────────────────────────
// Returns the raw HTML body of the Amazon search results page. Throws on
// any non-200 response or empty body so the caller can decide what to do.
async function firecrawlScrapeHtml(token: string, url: string): Promise<{ html: string; status: number; rawBody: string }> {
  // undici keeps us on HTTP/1.1 — Deno's native fetch has had HTTP/2
  // negotiation issues with some upstream APIs in this environment.
  const r = await undiciRequest("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
      "accept": "application/json",
      "user-agent": "play-with-me-edge/1.0",
    },
    body: JSON.stringify({
      url,
      formats: ["html"],
      onlyMainContent: false,
      // Lowered from 2500ms — Amazon's search grid renders fast enough
      // that 800ms still captures everything our parser needs, and it
      // shaves ~1.5s off every refresh.
      waitFor: 800,
      timeout: 30000,
    }),
  });
  const status = r.statusCode;
  const rawBody = await r.body.text();
  if (status < 200 || status >= 300) {
    return { html: "", status, rawBody };
  }
  try {
    const json = JSON.parse(rawBody);
    const html: string = json?.data?.html ?? "";
    return { html, status, rawBody };
  } catch {
    // Firecrawl normally wraps in JSON; if it didn't, treat the raw body
    // as HTML directly.
    return { html: rawBody, status, rawBody };
  }
}

// ─── Diagnostic endpoints ───────────────────────────────────────────────
app.get("/make-server-b57bea30/key-fingerprint", (c) => {
  const { value, name } = findFirecrawlToken();
  return c.json({
    secret_name_resolved: name ?? null,
    key_fingerprint: fp(value),
    available_secret_names_checked: FIRECRAWL_TOKEN_NAMES,
    provider: "firecrawl",
  });
});

// Returns full upstream Firecrawl response (status + headers + body)
// so we can see exactly what Firecrawl is sending back when something
// looks off. Useful only for troubleshooting.
app.get("/make-server-b57bea30/fc-probe", async (c) => {
  const query = c.req.query("q") || "Scrabble";
  const { value: token, name: tokenName } = findFirecrawlToken();
  if (!token) return c.json({ error: "Server is missing Firecrawl token", checked: FIRECRAWL_TOKEN_NAMES }, 500);
  const amazonUrl = `https://www.amazon.com/s?k=${encodeURIComponent(query)}`;
  try {
    const r = await undiciRequest("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${token}`,
        "content-type": "application/json",
        "accept": "application/json",
      },
      body: JSON.stringify({ url: amazonUrl, formats: ["html"], waitFor: 800 }),
    });
    const status = r.statusCode;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.headers)) headers[k] = String(v);
    const body = await r.body.text();
    return c.json({
      sent: { url: amazonUrl, token_fp: fp(token), token_name: tokenName },
      upstream: {
        status,
        headers,
        body_length: body.length,
        body_first_500: body.slice(0, 500),
        body_last_500: body.slice(-500),
      },
    });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ─── Main endpoint ──────────────────────────────────────────────────────
app.get("/make-server-b57bea30/amazon-search", async (c) => {
  const query = c.req.query("q");
  if (!query) return c.json({ error: "Missing 'q'" }, 400);
  const excludeList: string[] = c.req.queries("exclude") ?? [];
  const excludeSet = new Set(excludeList.filter(Boolean));

  const { value: token, name: tokenName } = findFirecrawlToken();
  if (!token) {
    return c.json({
      error: "Server is missing Firecrawl API token",
      checked: FIRECRAWL_TOKEN_NAMES,
    }, 500);
  }

  const amazonUrl = `https://www.amazon.com/s?k=${encodeURIComponent(query)}`;

  try {
    const { html, status, rawBody } = await firecrawlScrapeHtml(token, amazonUrl);
    if (status < 200 || status >= 300) {
      console.log(`Firecrawl upstream ${status} for "${query}" using ${tokenName} (${fp(token)}): body=${rawBody.slice(0, 500)}`);
      return c.json({
        error: `Firecrawl upstream ${status}`,
        upstream_status: status,
        upstream_body: rawBody.slice(0, 500),
        debug_key_name: tokenName,
        debug_key_fingerprint: fp(token),
      }, 502);
    }
    if (!html) {
      console.log(`Firecrawl returned 200 but no html for "${query}" (rawBody length=${rawBody.length})`);
      return c.json({
        imageUrl: null, title: null, link: null, players: null, ages: null,
        total_results: 0,
        debug_note: "Firecrawl response had no data.html",
      });
    }
    // Parse only the first 3 products — refresh button has a smaller
    // pool to cycle through, but the response payload is smaller and
    // parsing is faster.
    const results = parseAmazonResults(html, 3);
    if (results.length === 0) {
      console.log(`Firecrawl parse returned 0 for "${query}" (html length=${html.length})`);
      return c.json({ imageUrl: null, title: null, link: null, players: null, ages: null, total_results: 0 });
    }
    let chosen: AmazonResult | null = null;
    if (excludeSet.size === 0) {
      chosen = results[0];
    } else {
      chosen = results.find((res) => res.imageUrl && !excludeSet.has(res.imageUrl)) ?? null;
    }
    if (!chosen) {
      return c.json({
        imageUrl: null, title: null, link: null, players: null, ages: null,
        total_results: results.length,
        excluded_count: excludeSet.size,
        // Full parsed list — client can cache it and pick subsequent
        // un-seen results without round-tripping back to Firecrawl.
        results,
      });
    }
    return c.json({
      ...chosen,
      total_results: results.length,
      excluded_count: excludeSet.size,
      // Full parsed list — client can cache it and pick subsequent
      // un-seen results without round-tripping back to Firecrawl.
      results,
    });
  } catch (err) {
    console.log(`Firecrawl proxy threw for "${query}": ${err}`);
    return c.json({ error: `Firecrawl proxy error: ${err}` }, 500);
  }
});

Deno.serve(app.fetch);
