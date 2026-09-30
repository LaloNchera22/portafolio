/* ============================================================================
 * Runinback — public runtime config.
 *
 * Values are injected at build time by Vite (see vite.config.js) from the
 * environment variables configured in Vercel. Every value here is PUBLIC by
 * design: the anon key is protected by Row Level Security, not by secrecy. The
 * service-role key and every payment secret live only in Supabase Edge
 * Function secrets and never reach the browser.
 * ========================================================================== */

const injected = typeof __RUNINBACK_CONFIG__ === "object" && __RUNINBACK_CONFIG__ ? __RUNINBACK_CONFIG__ : {};

export const config = Object.freeze({
  supabaseUrl: injected.supabaseUrl || "",
  supabaseAnonKey: injected.supabaseAnonKey || "",
  stripeEnabled: !!injected.stripeEnabled,
  StripeEnabled: !!injected.StripeEnabled,
  consoleUrl: "console.html",
});

export function isBackendConfigured() {
  return config.supabaseUrl.indexOf("http") === 0 && config.supabaseAnonKey.length > 0;
}
