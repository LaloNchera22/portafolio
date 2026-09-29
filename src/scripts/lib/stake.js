/* ============================================================================
 * Runinback — stake rules for challenges and tables (whole USD only).
 * Mirrors the server: 1–1000 USD per stake (100–100000 cents).
 * ========================================================================== */

export const STAKE_MIN_USD = 1;
export const STAKE_MAX_USD = 1000;
export const STAKE_PRESETS_USD = Object.freeze([1, 5, 10, 25, 50]);

/**
 * Validate a typed stake. Returns { USD, cents } when valid, or { error }
 * with a message the form can show next to the input.
 */
export function parseStake(value, availableCents) {
  const text = String(value == null ? "" : value).trim();
  if (text === "") return { error: "Enter an entry fee." };
  if (!/^\d+$/.test(text)) return { error: "Use whole USD, no decimals." };
  const USD = parseInt(text, 10);
  if (USD < STAKE_MIN_USD) return { error: "The minimum entry fee is " + STAKE_MIN_USD + " USD." };
  if (USD > STAKE_MAX_USD) return { error: "The maximum entry fee is " + STAKE_MAX_USD.toLocaleString("en") + " USD." };
  const cents = USD * 100;
  if (typeof availableCents === "number" && cents > availableCents) {
    return { error: "You have " + Math.floor(availableCents / 100) + " USD available.", USD: USD, cents: cents, short: true };
  }
  return { USD: USD, cents: cents };
}

/** Step a stake up or down by one, clamped to the allowed range. */
export function stepStake(USD, delta) {
  const base = Number.isFinite(USD) ? USD : STAKE_MIN_USD;
  return Math.min(STAKE_MAX_USD, Math.max(STAKE_MIN_USD, base + delta));
}

/** Both players stake the same; the winner takes both stakes (no rake). */
export function potFor(USD) {
  return USD * 2;
}
