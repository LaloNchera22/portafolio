/* ============================================================================
 * Runinback — preferences other console modules read at boot (e.g. whether
 * match pop-ups show). Mirrored in this browser so boot needs no request;
 * Settings (loaded on demand) refreshes and saves them.
 * ========================================================================== */
const PREFS_KEY = "rib:prefs";

export const prefs = { match_toasts: true };

try {
  const saved = JSON.parse(window.localStorage.getItem(PREFS_KEY) || "null");
  if (saved && typeof saved.match_toasts === "boolean") prefs.match_toasts = saved.match_toasts;
} catch (e) { /* storage blocked or corrupt: keep defaults */ }

/** Update the mirror from the server's settings row. */
export function rememberPrefs(settings) {
  prefs.match_toasts = settings.match_toasts !== false;
  try { window.localStorage.setItem(PREFS_KEY, JSON.stringify({ match_toasts: prefs.match_toasts })); } catch (e) { /* ignore */ }
}
