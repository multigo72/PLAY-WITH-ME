import { createClient } from "@supabase/supabase-js";

const URL = import.meta.env.VITE_SUPABASE_URL;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const FN_NAME = import.meta.env.VITE_SUPABASE_FN_NAME || "make-server-b57bea30";

if (!URL || !ANON_KEY) {
  // Surface a clear error in the console rather than silently failing later.
  // eslint-disable-next-line no-console
  console.error(
    "[supabase] Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in .env"
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
