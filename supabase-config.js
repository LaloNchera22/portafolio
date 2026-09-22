/* ============================================================================
 * Runinback — public Supabase config for the static site.
 *
 * Fill these two values from your Supabase project (Settings → API):
 *   - SUPABASE_URL      : your project URL, e.g. https://abcd1234.supabase.co
 *   - SUPABASE_ANON_KEY : the "anon" / public key
 *
 * Both are PUBLIC by design — they only allow what Row Level Security permits.
 * The service-role key must NEVER appear here; it lives only in Edge Function
 * secrets on the server. Until these are filled in, the auth UI shows a
 * "backend not configured yet" message instead of failing silently.
 * ========================================================================== */
window.RUNINBACK_CONFIG = {
  SUPABASE_URL: "__SUPABASE_URL__",
  SUPABASE_ANON_KEY: "__SUPABASE_ANON_KEY__",
  // Where to send a user once they are signed in.
  CONSOLE_URL: "console.html",
};

window.RUNINBACK_CONFIG.isConfigured = function () {
  var c = window.RUNINBACK_CONFIG;
  return (
    typeof c.SUPABASE_URL === "string" &&
    c.SUPABASE_URL.indexOf("http") === 0 &&
    c.SUPABASE_ANON_KEY.indexOf("__") !== 0
  );
};
