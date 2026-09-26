/* ============================================================================
 * Runinback — public runtime config, served from Vercel environment variables.
 *
 * The static pages load this endpoint instead of a committed config file, so
 * the Supabase URL + anon key live only in Vercel (Settings → Environment
 * Variables) and never in the repo. Both values are PUBLIC by design — Row
 * Level Security is what protects data, not the secrecy of the anon key. The
 * service-role key is NEVER exposed here; it lives only in Edge Function
 * secrets on the server.
 *
 * Set in Vercel (Production + Preview):
 *   SUPABASE_URL       = https://<your-ref>.supabase.co
 *   SUPABASE_ANON_KEY  = <your anon / public key>
 *
 * Output is JavaScript that defines window.RUNINBACK_CONFIG, so it drops in
 * exactly where the old supabase-config.js did — no client refactor needed.
 * If the variables are missing, it still returns a valid (empty) config and
 * the auth UI degrades to a "backend not connected yet" message.
 * ========================================================================== */
module.exports = function handler(req, res) {
  var url = process.env.SUPABASE_URL || "";
  var anon = process.env.SUPABASE_ANON_KEY || "";
  // Public flag: when Stripe is set up on the server, the console routes rcoin
  // top-ups through Stripe Checkout instead of the instant test RPC. This is
  // just a UI switch — no Stripe secret is ever exposed here.
  var stripeEnabled = /^(1|true|yes|on)$/i.test(String(process.env.STRIPE_ENABLED || ""));

  var body =
    "window.RUNINBACK_CONFIG = {" +
      "SUPABASE_URL: " + JSON.stringify(url) + "," +
      "SUPABASE_ANON_KEY: " + JSON.stringify(anon) + "," +
      "STRIPE_ENABLED: " + JSON.stringify(stripeEnabled) + "," +
      "CONSOLE_URL: \"console.html\"" +
    "};" +
    "window.RUNINBACK_CONFIG.isConfigured = function () {" +
      "var c = window.RUNINBACK_CONFIG;" +
      "return typeof c.SUPABASE_URL === 'string' && " +
             "c.SUPABASE_URL.indexOf('http') === 0 && " +
             "typeof c.SUPABASE_ANON_KEY === 'string' && c.SUPABASE_ANON_KEY.length > 0;" +
    "};";

  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  // Public, but short-lived at the edge so a key rotation propagates quickly.
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=300, stale-while-revalidate=60");
  res.status(200).send(body);
};
