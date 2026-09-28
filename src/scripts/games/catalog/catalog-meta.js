/* ============================================================================
 * Runinback — catalog metadata shared by the games engine.
 * ========================================================================== */

/**
 * Games the backend accepts for staked (rcoin) tables. MUST mirror the
 * allow-list in the `rib_game_create` RPC (supabase/migrations). Every other
 * game is practice-only until its rules are validated server-side.
 */
export const STAKEABLE_GAME_IDS = Object.freeze([
  "tictactoe", "connect4", "reversi", "checkers", "dots", "mancala", "eights",
]);

export function isStakeable(gameId) {
  return STAKEABLE_GAME_IDS.indexOf(gameId) !== -1;
}

/** Teasers from the upcoming line-up (hidden from the lobby, kept for help copy). */
export const COMING_SOON_GAMES = Object.freeze([
  { id: "chess", name: "Chess", tag: "soon", icon: "♞", blurb: "The classic. Ranked matches and stakes.", soon: true },
  { id: "ludo", name: "Ludo", tag: "soon", icon: "⚁", blurb: "Race all four tokens home. 2 to 4 players.", soon: true },
  { id: "backgammon", name: "Backgammon", tag: "soon", icon: "⛃", blurb: "Roll, race and bear off before your rival.", soon: true },
  { id: "spades", name: "Spades", tag: "soon", icon: "♠", blurb: "Bid your tricks and hit your target as a team.", soon: true },
  { id: "hearts", name: "Hearts", tag: "soon", icon: "♥", blurb: "Dodge the hearts and the queen of spades.", soon: true },
  { id: "poker", name: "Poker", tag: "soon", icon: "♣", blurb: "Heads-up hold'em tables.", soon: true },
]);
