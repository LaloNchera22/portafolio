/* ============================================================================
 * Runinback — money and date formatting.
 *
 * USD: 1 USD = 1 USD = 100 cents. Wallets store integer cents; the UI
 * shows USD. All arithmetic stays in integer cents.
 * ========================================================================== */

/** Purchase fee charged once when buying USD (5%). Mirrors the backend. */
export const PURCHASE_FEE_PERCENT = 5;

export function formatUsd(cents) {
  return "$" + ((Number(cents) || 0) / 100).toFixed(2);
}

/** Cents → USD as a number with at most two decimals. */
export function centsToUSD(cents) {
  const n = (Number(cents) || 0) / 100;
  return parseFloat(n.toFixed(2));
}

export function formatUSD(cents) {
  return centsToUSD(cents) + " USD";
}

/** Parse a user-typed dollar amount ("12.5" or "12,5") into cents. NaN when invalid. */
export function parseDollarsToCents(value) {
  const n = parseFloat(String(value).replace(",", "."));
  return isFinite(n) ? Math.round(n * 100) : NaN;
}

/** Parse a user-typed USD amount into cents, rounded to whole USD. NaN when invalid. */
export function parseUSDToCents(value) {
  const n = parseFloat(String(value).replace(",", "."));
  return isFinite(n) ? Math.round(n) * 100 : NaN;
}

/**
 * Split a purchase into what the buyer receives and the fee, using the exact
 * integer math of the backend (floor of 95/100) so the preview always matches
 * what gets credited.
 */
export function quotePurchase(payCents) {
  const pay = isFinite(payCents) && payCents > 0 ? payCents : 0;
  const receiveCents = Math.floor(pay * (100 - PURCHASE_FEE_PERCENT) / 100);
  return { payCents: pay, receiveCents: receiveCents, feeCents: pay - receiveCents };
}

export function formatDate(value) {
  if (!value) return "—";
  try { return new Date(value).toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric" }); }
  catch (e) { return "—"; }
}

/** "just now", "5 min ago", "3 h ago", "2 d ago" — for lobby and activity rows. */
export function formatTimeAgo(value, now) {
  const then = new Date(value).getTime();
  if (!isFinite(then)) return "";
  const seconds = Math.max(0, Math.round(((now || Date.now()) - then) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return Math.floor(seconds / 60) + " min ago";
  if (seconds < 86400) return Math.floor(seconds / 3600) + " h ago";
  return Math.floor(seconds / 86400) + " d ago";
}
