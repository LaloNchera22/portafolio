/* ============================================================================
 * Runinback — money and date formatting.
 *
 * rcoin: 1 rcoin = 1 USD = 100 cents. Wallets store integer cents; the UI
 * shows rcoin. All arithmetic stays in integer cents.
 * ========================================================================== */

/** Entry commission charged once when buying rcoin (5%). Mirrors the backend. */
export const PURCHASE_FEE_PERCENT = 5;

export function formatUsd(cents) {
  return "$" + ((Number(cents) || 0) / 100).toFixed(2);
}

/** Cents → rcoin as a number with at most two decimals. */
export function centsToRcoin(cents) {
  const n = (Number(cents) || 0) / 100;
  return parseFloat(n.toFixed(2));
}

export function formatRcoin(cents) {
  return centsToRcoin(cents) + " rcoin";
}

/** Parse a user-typed dollar amount ("12.5" or "12,5") into cents. NaN when invalid. */
export function parseDollarsToCents(value) {
  const n = parseFloat(String(value).replace(",", "."));
  return isFinite(n) ? Math.round(n * 100) : NaN;
}

/** Parse a user-typed rcoin amount into cents, rounded to whole rcoin. NaN when invalid. */
export function parseRcoinToCents(value) {
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
