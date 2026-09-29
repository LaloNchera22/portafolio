/* ============================================================================
 * Runinback — user-facing errors & notifications.
 *
 * One place that turns backend/RPC failures into clear, professional messages,
 * and a minimalist toast for transient notices. The console and the games run
 * money moves through SECURITY DEFINER RPCs; those raise short technical
 * strings (some in Spanish, from the earlier arena migration) that must never
 * reach a player as-is. This maps the known ones to calm, actionable English
 * and hides anything unknown behind a safe fallback, so we never leak database
 * internals into the UI.
 *
 * Resolution order: stable error hint (set by the RPCs with
 * `raise ... using hint = '<code>'`, see migration 0009) → known message
 * substrings (legacy, kept while older RPC versions are deployed) → SQLSTATE →
 * caller fallback. GoTrue auth errors are mapped in auth/auth-forms.js.
 * ========================================================================== */

// Stable, language-independent codes raised by the database (error.hint).
const HINTS = {
  not_authenticated: "Your session has expired. Please sign in again.",
  wallet_not_found: "We couldn't find your wallet. Refresh the page and try again.",
  insufficient_balance: "You don't have enough rcoin for that. Top up your wallet and try again.",
  invalid_amount: "That amount isn't valid. Please check it and try again.",
  invalid_stake: "Pick an entry fee between 1 and 1,000 rcoin.",
  invalid_entry_fee: "The entry fee is free or between 1 and 500 rcoin.",
  deposit_cap_reached: "You've reached the test balance limit. Withdraw or play before adding more.",
  too_many_open: "You have too many open tables or challenges. Finish or cancel some first.",
  test_payments_disabled: "Test purchases are turned off. Use card or crypto checkout.",
  cannot_challenge_self: "You can't challenge yourself.",
  cannot_accept_own: "You can't accept your own challenge.",
  user_not_found: "We couldn't find a player with that username.",
  challenge_not_for_you: "This challenge is meant for another player.",
  challenge_unavailable: "This challenge is no longer available.",
  challenge_not_active: "This challenge isn't in play right now.",
  not_a_participant: "You're not part of this challenge.",
  challenge_not_found: "We couldn't find that challenge.",
  only_creator_can_cancel: "Only the player who created it can cancel this challenge.",
  cannot_cancel: "This can no longer be cancelled.",
  game_required: "Please choose a game first.",
  tournament_name_required: "Please give the tournament a name.",
  invalid_max_players: "Max players must be between 2 and 128.",
  tournament_not_found: "We couldn't find that tournament.",
  registration_closed: "Registration for this tournament is closed.",
  already_registered: "You're already registered for this tournament.",
  tournament_finished: "This tournament has already ended.",
  only_organizer_can_finish: "Only the organizer can finish this tournament.",
  organizer_cannot_win: "The organizer can't be the winner of their own tournament.",
  winner_not_registered: "The winner must be a registered player.",
  invalid_winner: "That winner isn't valid.",
  unknown_game: "That game isn't available right now.",
  match_not_found: "This table no longer exists.",
  cannot_join_own_match: "You can't join your own table.",
  match_not_open: "This table is no longer open.",
  match_not_in_progress: "This match isn't in progress.",
  not_in_match: "You're not part of this match.",
  not_your_turn: "It's not your turn yet.",
  only_host_can_cancel: "Only the host can cancel this table.",
  state_too_large: "That move couldn't be sent. Please try again.",
  void_too_soon: "A match can only be voided after 2 hours without progress.",
  key_already_revoked: "That API key is already revoked.",
  stale_move: "The board changed before your move arrived. It has been refreshed — try again.",
  illegal_move: "That move isn't allowed. The board has been refreshed.",
  rate_limited: "You're doing that too often. Please wait a moment and try again.",
  game_account_required: "Link your account for this game's network in Profile first.",
  game_account_in_use: "That account is used by a live tournament or friendly. Finish it first.",
  invalid_tournament_size: "Tournaments have 4 or 8 players.",
  invalid_network: "Pick a network from the list.",
  invalid_handle: "Enter the name you use in the game (2 to 64 characters).",
  new_account_limit: "New accounts can enter up to 25 rcoin until they finish 3 matches.",
  account_restricted: "Paid tournaments are paused on this account. Contact support@runinback.com.",
  room_not_waiting: "This room isn't waiting for players anymore.",
  ready_expired: "The ready check expired and both entry fees were refunded.",
  challenge_not_started: "Both players need to press Ready first.",
  already_reported: "You already reported this result.",
  use_dispute: "Your opponent reported a different result. Open a dispute instead.",
  dispute_reason_required: "Explain what happened (10 to 500 characters).",
  room_closed: "This room is closed.",
  invalid_message: "Messages are 1 to 500 characters.",
  evidence_token_invalid: "That capture expired. Take it again.",
  evidence_invalid: "That file can't be used as evidence.",
  evidence_limit: "You can add up to 10 captures per match.",
  not_operator: "Only the Runinback team can do that.",
  not_disputed: "This challenge isn't in dispute.",
  invalid_action: "That action isn't available.",
  too_many_keys: "You have the maximum number of active API keys. Revoke one first.",
  email_reserved: "That e-mail address can't be used. Please use another.",
  turn_timed_out: "Your time for this move ran out.",
  not_timed_out: "Your opponent still has time to move.",
  use_timeout_claim: "Timed matches are decided by the turn clock.",
  organizer_cannot_join: "Organizers can't enter their own paid tournament.",
  not_enough_entrants: "A tournament needs at least 3 entrants before you can finish it.",
  not_an_entrant: "Only other entrants can dispute this result.",
  dispute_window_closed: "The review window for this prize has closed.",
  live_keys_unavailable: "Live keys become available when real-money play launches. Use a test key for now.",
  close_account_blocked: "Finish or cancel your open games, challenges and tournaments before closing your account.",
  wallet_frozen: "Your wallet is on hold after a reversed payment. Contact support to restore it.",
};

// Ordered rules (legacy fallback): the first substring that matches the (normalized) backend
// message wins. Substrings are lowercase; the incoming message is lowercased
// before testing, so English and Spanish variants are both caught.
const RULES = [
  // --- session / auth --------------------------------------------------
  ["no autenticado", "Your session has expired. Please sign in again."],
  ["not signed in", "Your session has expired. Please sign in again."],
  ["missing session", "Your session has expired. Please sign in again."],
  ["missing user", "Your session has expired. Please sign in again."],
  ["wallet no encontrada", "We couldn't find your wallet. Refresh the page and try again."],

  // --- balance / funds -------------------------------------------------
  ["saldo insuficiente", "You don't have enough rcoin for that. Top up your wallet and try again."],
  ["not enough balance", "You don't have enough rcoin for that. Top up your wallet and try again."],

  // --- amounts / stakes / fees ----------------------------------------
  ["invalid amount (between $1 and $2000)", "Enter an amount between $1 and $2,000."],
  ["monto de prueba", "Enter an amount between $1 and $1,000."],
  ["apuesta inválida", "Pick an entry fee between 1 and 1,000 rcoin."],
  ["invalid stake", "Pick an entry fee between 1 and 1,000 rcoin."],
  ["cuota inválida", "The entry fee must be between 0 and 500 rcoin."],
  ["monto inválido", "That amount isn't valid. Please check it and try again."],
  ["invalid amount", "That amount isn't valid. Please check it and try again."],

  // --- challenges (retos) ---------------------------------------------
  ["no puedes retarte a ti mismo", "You can't challenge yourself."],
  ["no puedes aceptar tu propio reto", "You can't accept your own challenge."],
  ["no existe el usuario", "We couldn't find a player with that username."],
  ["este reto es para otro jugador", "This challenge is meant for another player."],
  ["este reto ya no está disponible", "This challenge is no longer available."],
  ["el reto no está en juego", "This challenge isn't in play right now."],
  ["no participas en este reto", "You're not part of this challenge."],
  ["reto no encontrado", "We couldn't find that challenge."],
  ["solo el creador puede cancelar", "Only the player who created it can cancel this challenge."],
  ["ya no se puede cancelar", "This challenge can no longer be cancelled."],
  ["indica el juego", "Please choose a game first."],

  // --- tournaments (torneos) ------------------------------------------
  ["ponle nombre al torneo", "Please give the tournament a name."],
  ["jugadores máximos", "Max players must be between 2 and 128."],
  ["torneo no encontrado", "We couldn't find that tournament."],
  ["las inscripciones están cerradas", "Registration for this tournament is closed."],
  ["ya estás inscrito", "You're already registered for this tournament."],
  ["el torneo ya terminó", "This tournament has already ended."],
  ["solo el organizador puede finalizar", "Only the organizer can finish this tournament."],
  ["el ganador debe estar inscrito", "The winner must be a registered player."],
  ["ganador inválido", "That winner isn't valid."],

  // --- live matches ----------------------------------------------------
  ["unknown game", "That game isn't available right now."],
  ["match not found", "This table no longer exists."],
  ["you cannot join your own match", "You can't join your own table."],
  ["this match is no longer open", "This table is no longer open."],
  ["match is not in progress", "This match isn't in progress."],
  ["you are not in this match", "You're not part of this match."],
  ["not your turn", "It's not your turn yet."],
  ["board state too large", "That move couldn't be sent. Please try again."],
  ["invalid next turn", "That move couldn't be applied. The board will resync in a moment."],
  ["invalid winner", "We couldn't record that result. The board will resync in a moment."],
  ["only the host can cancel", "Only the host can cancel this table."],
  ["this match can no longer be cancelled", "This table can no longer be cancelled."]
];

// Postgres SQLSTATE codes that can surface on writes.
const CODES = {
  "23505": "That's already taken. Please pick another.",
  "23514": "Something in that request wasn't valid. Please check it and try again.",
  "40001": "The server is busy. Please try again in a moment.",
  "P0001": null // generic RAISE — handled by the message rules above
};

const GENERIC = "Something went wrong. Please try again.";
const NETWORK = "Network error. Please check your connection and try again.";

// Turn a Supabase/Postgres error into a clean, user-facing sentence.
// Never returns the raw database message for an unrecognized error — that
// would leak internals — so unknown failures fall back to `fallback`.
export function friendlyError(e, fallback) {
  if (!e) return fallback || GENERIC;
  if (e.hint && Object.prototype.hasOwnProperty.call(HINTS, e.hint)) return HINTS[e.hint];
  var raw = String((e && e.message) || "");
  var text = raw.toLowerCase();

  // Network / fetch failures (no HTTP response reached the backend).
  if (/failed to fetch|network ?error|networkerror|load failed|typeerror/.test(text)) {
    return NETWORK;
  }

  for (var i = 0; i < RULES.length; i++) {
    if (text.indexOf(RULES[i][0]) !== -1) return RULES[i][1];
  }

  var code = e && (e.code || e.error_code);
  if (code && Object.prototype.hasOwnProperty.call(CODES, code) && CODES[code]) {
    return CODES[code];
  }

  return fallback || GENERIC;
}

/* ---- toast: a small, self-dismissing notice ----------------------------- */
// Used where an inline message slot doesn't fit (e.g. the games board). It
// renders inside .capp so it inherits the console theme, and stacks politely.
let stack = null;
function ensureStack() {
  if (stack && document.body.contains(stack)) return stack;
  var host = document.querySelector(".capp") || document.body;
  stack = document.createElement("div");
  stack.className = "rib-toasts";
  stack.setAttribute("aria-live", "polite");
  host.appendChild(stack);
  return stack;
}

export function toast(text, kind) {
  if (!text) return;
  var s = ensureStack();
  var t = document.createElement("div");
  t.className = "rib-toast" + (kind === "ok" ? " rib-toast--ok" : kind === "info" ? " rib-toast--info" : " rib-toast--err");
  t.setAttribute("role", "status");
  t.textContent = text;
  s.appendChild(t);
  // fade in
  requestAnimationFrame(function () { t.classList.add("is-in"); });
  var life = kind === "ok" || kind === "info" ? 3200 : 4200;
  setTimeout(function () {
    t.classList.remove("is-in");
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 260);
  }, life);
}

/** Surface an error (or notice) as a toast; falls back to alert() for errors. */
export function notify(error, fallback, kind) {
  const text = friendlyError(error, fallback);
  if (typeof document !== "undefined" && document.body) toast(text, kind || "err");
  else if (kind !== "info" && kind !== "ok") alert(text);
}

/**
 * Edge Functions answer errors as JSON `{ error: "<code>" }`. Resolve that code
 * into an error object friendlyError() understands (codes double as hints).
 */
export function functionError(error) {
  const ctx = error && error.context;
  const read = ctx && typeof ctx.json === "function" ? ctx.json().catch(function () { return {}; }) : Promise.resolve({});
  return read.then(function (payload) {
    const code = payload && payload.error;
    return { message: code || (error && error.message) || "", hint: code };
  });
}
