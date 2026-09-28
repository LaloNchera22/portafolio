// Server-authoritative move planning, kept pure (no I/O) so it runs the same
// in the game-move Edge Function and in unit tests.
//
// Given the stored match row, the caller and the requested action, it returns
// either { error, status } or the transition to commit:
//   { state, nextTurnId, over, winnerId, isDraw }
// The caller commits it with optimistic concurrency on match.move_seq.
import { STAKEABLE_RULES } from "./game-rules/index.js";

const sameMove = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function fail(error, status) {
  return { error, status };
}

/** The authoritative current state: the rules' initial position before any move. */
export function currentState(rules, match) {
  const stored = match.state;
  const hasState = stored && typeof stored === "object" && typeof stored.turn === "number";
  return match.move_seq > 0 && hasState ? stored : rules.init();
}

/**
 * @param {object} match   game_matches row
 * @param {string} uid     authenticated caller
 * @param {{ action?: "move" | "resign", move?: unknown, seq?: number }} request
 */
export function planMove(match, uid, request) {
  const rules = STAKEABLE_RULES[match.game];
  if (!rules) return fail("unknown_game", 400);
  if (match.status !== "active" || !match.guest_id) return fail("match_not_in_progress", 409);

  const seat = uid === match.host_id ? 0 : uid === match.guest_id ? 1 : -1;
  if (seat < 0) return fail("not_in_match", 403);
  if (typeof request.seq === "number" && request.seq !== match.move_seq) return fail("stale_move", 409);

  const seatUser = (s) => (s === 0 ? match.host_id : match.guest_id);
  const state = currentState(rules, match);

  if (request.action === "resign") {
    return { state, nextTurnId: null, over: true, winnerId: seatUser(seat ^ 1), isDraw: false };
  }

  if (rules.result(state)) return fail("match_not_in_progress", 409);
  if (state.turn !== seat) return fail("not_your_turn", 409);

  const legal = rules.legal(state);
  const move = legal.find((m) => sameMove(m, request.move));
  if (move === undefined) return fail("illegal_move", 422);

  const next = rules.apply(state, move);
  const result = rules.result(next);
  if (result) {
    const isDraw = result.winner == null;
    return { state: next, nextTurnId: null, over: true, winnerId: isDraw ? null : seatUser(result.winner), isDraw };
  }
  return { state: next, nextTurnId: seatUser(next.turn), over: false, winnerId: null, isDraw: false };
}
