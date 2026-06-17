import { createClient } from "@supabase/supabase-js";

// Hardcoded fallbacks so the deployed app never white-screens when build-time
// env vars are absent (e.g. a host without VITE_SUPABASE_* configured).
// These are the *publishable* anon values — designed to ship in the client
// bundle and guarded server-side by Row Level Security. (Prefer real env vars
// via .env locally / host settings; they override these defaults.)
const FALLBACK_URL = "https://pleedpllybistmxjiqfv.supabase.co";
const FALLBACK_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBsZWVkcGxseWJpc3RteGppcWZ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxNjY2NDYsImV4cCI6MjA5Mzc0MjY0Nn0.U8EtDOF8xONTJ1XKm3a7dtBYMwUf4VSBLVV8M8n768o";

const URL = import.meta.env.VITE_SUPABASE_URL || FALLBACK_URL;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || FALLBACK_ANON_KEY;
const FN_NAME = import.meta.env.VITE_SUPABASE_FN_NAME || "make-server-b57bea30";

if (!import.meta.env.VITE_SUPABASE_URL || !import.meta.env.VITE_SUPABASE_ANON_KEY) {
  // Not fatal — we fall back to the baked-in publishable values above.
  // eslint-disable-next-line no-console
  console.warn(
    "[supabase] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY not set; using built-in fallbacks"
  );
}

export const supabase = createClient(URL, ANON_KEY, {
  auth: { persistSession: false },
});

// URL of the deployed Hono edge function. Routes hang off this prefix.
export const FN_BASE = `${URL}/functions/v1/${FN_NAME}`;

// Helper for calling a route on the edge function with the anon JWT.
// Returns parsed JSON, or null on any network / non-2xx / parse error
// (callers should treat null as "missed; use fallback").
export async function callFn(path, { signal } = {}) {
  try {
    const res = await fetch(`${FN_BASE}${path}`, {
      headers: { Authorization: `Bearer ${ANON_KEY}` },
      signal,
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[supabase fn] ${path} → ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[supabase fn] ${path} threw: ${err}`);
    return null;
  }
}
