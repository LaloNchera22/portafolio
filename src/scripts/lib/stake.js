/* ============================================================================
 * Runinback — stake rules for challenges and tables (whole rcoin only).
 * Mirrors the server: 1–1000 rcoin per stake (100–100000 cents).
 * ========================================================================== */

export const STAKE_MIN_RCOIN = 1;
export const STAKE_MAX_RCOIN = 1000;
export const STAKE_PRESETS_RCOIN = Object.freeze([1, 5, 10, 25, 50]);

/**
 * Validate a typed stake. Returns { rcoin, cents } when valid, or { error }
 * with a message the form can show next to the input.
 */
export function parseStake(value, availableCents) {
  const text = String(value == null ? "" : value).trim();
  if (text === "") return { error: "Enter an entry fee." };
  if (!/^\d+$/.test(text)) return { error: "Use whole rcoin, no decimals." };
  const rcoin = parseInt(text, 10);
  if (rcoin < STAKE_MIN_RCOIN) return { error: "The minimum entry fee is " + STAKE_MIN_RCOIN + " rcoin." };
  if (rcoin > STAKE_MAX_RCOIN) return { error: "The maximum entry fee is " + STAKE_MAX_RCOIN.toLocaleString("en") + " rcoin." };
  const cents = rcoin * 100;
  if (typeof availableCents === "number" && cents > availableCents) {
    return { error: "You have " + Math.floor(availableCents / 100) + " rcoin available.", rcoin: rcoin, cents: cents, short: true };
  }
  return { rcoin: rcoin, cents: cents };
}

/** Step a stake up or down by one, clamped to the allowed range. */
export function stepStake(rcoin, delta) {
  const base = Number.isFinite(rcoin) ? rcoin : STAKE_MIN_RCOIN;
  return Math.min(STAKE_MAX_RCOIN, Math.max(STAKE_MIN_RCOIN, base + delta));
}

/** Both players stake the same; the winner takes both stakes (no rake). */
export function potFor(rcoin) {
  return rcoin * 2;
}
