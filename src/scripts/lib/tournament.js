/* ============================================================================
 * Runinback — tournament rules shared by the console UI. Mirrors the integer
 * math of rib_tournament_complete() (migration 0022) so the preview a player
 * sees is exactly what gets paid.
 * ========================================================================== */
export const TOURNAMENT_SIZES = [4, 8];
export const PLATFORM_FEE_PERCENT = 10;
export const CHAMPION_PERCENT = 70;

/**
 * Split a full tournament's pool.
 * @param {number} feeCents entry fee per player, in cents
 * @param {number} size number of players (4 or 8)
 */
export function prizeSplit(feeCents, size) {
  const fee = Number.isFinite(feeCents) && feeCents > 0 ? Math.floor(feeCents) : 0;
  const players = TOURNAMENT_SIZES.includes(size) ? size : 0;
  const pool = fee * players;
  const platform = Math.floor((pool * PLATFORM_FEE_PERCENT) / 100);
  const prizes = pool - platform;
  const first = Math.floor((prizes * CHAMPION_PERCENT) / 100);
  return { pool, platform, prizes, first, second: prizes - first };
}

/** Rounds in a single-elimination bracket of this size (4 → 2, 8 → 3, 16 → 4, 32 → 5). */
export function roundsFor(size) {
  return size === 32 ? 5 : size === 16 ? 4 : size === 8 ? 3 : size === 4 ? 2 : 0;
}

/** Human name of a bracket round, counted from the final. */
export function roundName(round, rounds) {
  const fromEnd = rounds - round;
  if (fromEnd === 0) return "Final";
  if (fromEnd === 1) return "Semifinals";
  if (fromEnd === 2) return "Quarterfinals";
  if (fromEnd > 2) return "Round of " + Math.pow(2, fromEnd + 1);
  return "Round " + round;
}
