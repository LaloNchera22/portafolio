/* ============================================================================
 * Runinback — hosted tournaments: pure rules shared by the console
 * (docs/hosted-tournaments.md). The database enforces every one of them;
 * these mirror the integer math and the input rules so a host or a player
 * sees exactly what the server will do before a round trip.
 *
 * Also the normalizers for the jsonb RPCs (rib_tournament_preview,
 * rib_host_dashboard, rib_tournament_bracket): the UI reads one stable shape
 * whatever spelling the server uses for a field.
 * ========================================================================== */
import { PLATFORM_FEE_PERCENT, roundName } from "./tournament.js";

export const HOSTED_SIZES = Object.freeze([4, 8, 16, 32]);
export const HOST_FEE_PERCENT = 5;            // rib_host_fee_percent()
export const MIN_ENTRANTS = 4;                // rib_tournament_min_entrants()
export const MAX_ENTRY_FEE_CENTS = 50000;     // 500 rcoin
export const NEW_HOST_FEE_LIMIT_CENTS = 2500; // hosts with < 3 completed matches
export const NAME_MAX = 80;
export const RULES_MAX = 1000;
export const APPEAL_MIN = 10;
export const APPEAL_MAX = 500;
export const LOBBY_CODE_MAX = 40;
export const LOBBY_PASSWORD_MAX = 40;
export const HOST_NOTE_MAX = 300;
export const HOST_NOTE_MIN = 3;               // walkover / void need a note
export const APPEAL_WINDOW_HOURS = 24;        // rib_appeal_window()
export const DECIDE_WINDOW_MINUTES = 60;      // rib_host_decide_window()
export const LOBBY_BUCKET = "room-lobby";
export const LOBBY_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const LOBBY_IMAGE_TYPES = Object.freeze({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" });
export const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const INVITE_LENGTH = 10;
/** "Sign in to join" remembers the code here (localStorage) for an hour. */
export const PENDING_JOIN_KEY = "rib:pending-join";
export const PENDING_JOIN_TTL_MS = 60 * 60 * 1000;

const INVITE_PATTERN = new RegExp("^[" + INVITE_ALPHABET + "]{" + INVITE_LENGTH + "}$");

function cents(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/* ---- money ---------------------------------------------------------------- */

/**
 * Split a hosted tournament's prize pool, exactly as the payout job does:
 * pool = fee × entrants, platform = ⌊pool·10/100⌋, host = ⌊pool·5/100⌋,
 * the winner takes the rest (so rounding never loses a cent).
 */
export function hostedSplit(feeCents, entrants) {
  const pool = cents(feeCents) * count(entrants);
  const platform = Math.floor((pool * PLATFORM_FEE_PERCENT) / 100);
  const host = Math.floor((pool * HOST_FEE_PERCENT) / 100);
  return { pool: pool, platform: platform, host: host, winner: pool - platform - host };
}

/** Appeal deposit on a paid tournament: 10% of the entry fee, at least 1 rcoin. Free: none. */
export function appealDepositCents(feeCents) {
  const fee = cents(feeCents);
  return fee ? Math.max(100, Math.floor(fee / 10)) : 0;
}

/**
 * Parse the entry fee a host typed (whole rcoin, 0–500) into cents.
 * Returns { cents } or { error } with the sentence the form shows.
 */
export function parseEntryFee(value) {
  const text = String(value == null ? "" : value).trim();
  if (!text) return { cents: 0 };
  if (!/^\d+$/.test(text)) return { error: "The entry fee is a whole number of rcoin, like 5." };
  const rcoin = parseInt(text, 10);
  if (rcoin * 100 > MAX_ENTRY_FEE_CENTS) return { error: "The entry fee is free or up to 500 rcoin." };
  return { cents: rcoin * 100 };
}

/**
 * Check the create form before it's sent. Returns { value } ready for
 * rib_hosted_create's arguments, or { error, field } naming the input to fix.
 */
export function validateHostedForm(input) {
  const f = input || {};
  const name = String(f.name == null ? "" : f.name).trim();
  if (!name) return { error: "Give the tournament a name.", field: "name" };
  if (name.length > NAME_MAX) return { error: "Keep the name under " + NAME_MAX + " characters.", field: "name" };
  const size = Number(f.size);
  if (!HOSTED_SIZES.includes(size)) return { error: "Pick 4, 8, 16 or 32 players.", field: "size" };
  const fee = parseEntryFee(f.fee);
  if (fee.error) return { error: fee.error, field: "fee" };
  const visibility = f.visibility === "private" ? "private" : f.visibility === "public" ? "public" : null;
  if (!visibility) return { error: "Choose public or private.", field: "visibility" };
  const rules = String(f.rules == null ? "" : f.rules).trim();
  if (rules.length > RULES_MAX) return { error: "Keep the rules under " + RULES_MAX + " characters.", field: "rules" };
  return { value: { p_name: name, p_size: size, p_entry_fee_cents: fee.cents, p_visibility: visibility, p_rules: rules || null } };
}

/* ---- invite codes ----------------------------------------------------------- */

/** Upper-case a typed code and drop spaces and dashes ("abcd-efgh" → "ABCDEFGH"). */
export function normalizeInviteCode(value) {
  return String(value == null ? "" : value).toUpperCase().replace(/[\s\-‐-―]+/g, "");
}

/** True for a well-formed invite code (10 characters of the invite alphabet). */
export function isInviteCode(value) {
  return INVITE_PATTERN.test(normalizeInviteCode(value));
}

/**
 * The code in whatever a player pasted: a bare code, or a whole share link
 * (…/console.html#join/<CODE>). null when there's no valid code in it.
 */
export function parseInviteInput(value) {
  const text = String(value == null ? "" : value).trim();
  const link = /#join\/([^/?#\s]+)/i.exec(text);
  let raw = link ? link[1] : text;
  try { raw = decodeURIComponent(raw); } catch (e) { /* keep it raw */ }
  const code = normalizeInviteCode(raw);
  return INVITE_PATTERN.test(code) ? code : null;
}

/** "ABCDEFGHJK" → "ABCDE-FGHJK", easier to read aloud. The dash is ignored on input. */
export function formatInviteCode(code) {
  const c = normalizeInviteCode(code);
  const half = INVITE_LENGTH / 2;
  return c.length === INVITE_LENGTH ? c.slice(0, half) + "-" + c.slice(half) : c;
}

/**
 * The link a host shares: the console page's URL (origin + path, e.g.
 * https://runinback.com/console.html) with #join/<CODE>. Any hash or query
 * on the page URL is dropped.
 */
export function shareUrl(pageUrl, code) {
  return String(pageUrl || "").split("#")[0].split("?")[0] + "#join/" + normalizeInviteCode(code);
}

/* ---- brackets ----------------------------------------------------------------- */

/** Rounds in a single-elimination bracket of this size (4 → 2 … 32 → 5); 0 if not a power of two. */
export function bracketRounds(size) {
  const n = count(size);
  if (n < 2 || (n & (n - 1)) !== 0) return 0;
  return Math.round(Math.log2(n));
}

/** The bracket a hosted event plays: the next power of two ≥ entrants (at least 4). */
export function bracketSizeFor(entrants) {
  const n = Math.max(MIN_ENTRANTS, count(entrants));
  let size = 4;
  while (size < n) size *= 2;
  return size;
}

/** Byes the top seeds get when a bracket starts short. */
export function byesFor(entrants) {
  const n = count(entrants);
  return n ? bracketSizeFor(n) - n : 0;
}

/** Final, Semifinals, Quarterfinals, Round of 16, Round of 32. */
export function roundLabel(round, rounds) {
  return roundName(round, rounds);
}

function pick(obj, keys) {
  for (let i = 0; i < keys.length; i++) {
    if (obj && obj[keys[i]] !== undefined && obj[keys[i]] !== null) return obj[keys[i]];
  }
  return null;
}

function normalizeRoom(m) {
  const pa = m.player_a && typeof m.player_a === "object" ? m.player_a : null;
  const pb = m.player_b && typeof m.player_b === "object" ? m.player_b : null;
  return {
    room_id: pick(m, ["room_id", "id"]),
    round: count(m.round) || 1,
    slot: count(m.slot),
    player_a: pa ? pick(pa, ["id", "user_id"]) : pick(m, ["player_a", "a_id"]),
    player_b: pb ? pick(pb, ["id", "user_id"]) : pick(m, ["player_b", "b_id"]),
    a_username: pa ? pick(pa, ["username"]) : pick(m, ["a_username", "player_a_username"]),
    b_username: pb ? pick(pb, ["username"]) : pick(m, ["b_username", "player_b_username"]),
    status: pick(m, ["status"]) || "waiting",
    winner_id: pick(m, ["winner_id", "winner"]),
    walkover: !!m.walkover,
    a_report: pick(m, ["a_report"]),
    b_report: pick(m, ["b_report"]),
    review_flag: !!m.review_flag,
    host_note: pick(m, ["host_note"]),
  };
}

/**
 * rib_tournament_bracket answers a table (rows) or jsonb ({ rooms, size,
 * rounds, … }). Returns { rows, size, rounds } with rows sorted by round
 * then slot; size/rounds are null when the server didn't say.
 */
export function normalizeBracket(data) {
  let list = [];
  let meta = {};
  if (Array.isArray(data)) list = data;
  else if (data && typeof data === "object") {
    meta = data;
    list = Array.isArray(data.rooms) ? data.rooms : Array.isArray(data.matches) ? data.matches : [];
  }
  const rows = list.filter(function (m) { return m && typeof m === "object"; }).map(normalizeRoom)
    .sort(function (x, y) { return x.round - y.round || x.slot - y.slot; });
  const size = count(pick(meta, ["bracket_size", "size", "max_players"])) || null;
  const rounds = count(meta.rounds) || null;
  return { rows: rows, size: size, rounds: rounds };
}

/**
 * Group bracket rows into rounds for drawing: [{ round, label, matches }].
 * `rounds` wins; else it comes from the size, else from the rows themselves.
 */
export function shapeBracket(rows, opts) {
  const o = opts || {};
  const list = Array.isArray(rows) ? rows : [];
  const seen = list.reduce(function (max, m) { return Math.max(max, count(m.round)); }, 0);
  const rounds = count(o.rounds) || bracketRounds(o.size) || seen;
  const out = [];
  for (let r = 1; r <= rounds; r++) {
    out.push({
      round: r,
      label: roundLabel(r, rounds),
      matches: list.filter(function (m) { return count(m.round) === r; }).sort(function (x, y) { return count(x.slot) - count(y.slot); }),
    });
  }
  return out;
}

/** The final's winner id, once it's decided. */
export function championOf(rows, rounds) {
  const final = (rows || []).filter(function (m) { return m.round === rounds; })[0];
  return final && final.status === "done" && final.winner_id ? final.winner_id : null;
}

/**
 * Where a player stands in a bracket: { current, eliminated, champion,
 * outIn } — current is their newest undecided room, outIn the round they
 * lost (null while alive).
 */
export function playerStanding(rows, uid, rounds) {
  const mine = (rows || []).filter(function (m) { return uid && (m.player_a === uid || m.player_b === uid); });
  const lost = mine.find(function (m) { return (m.status === "done" || m.status === "void") && m.winner_id !== uid; }) || null;
  const open = mine.filter(function (m) { return m.status !== "done" && m.status !== "void"; })
    .sort(function (x, y) { return y.round - x.round; })[0] || null;
  return {
    entrant: mine.length > 0,
    current: lost ? null : open,
    eliminated: !!lost,
    outIn: lost ? lost.round : null,
    champion: !!uid && championOf(rows, rounds) === uid,
  };
}

/* ---- jsonb shapes --------------------------------------------------------------- */

function bool(v) { return v === true || v === "true" || v === 1; }

/**
 * rib_tournament_preview → one stable shape. Prizes are recomputed from the
 * fee and entrants with the payout math (they can't disagree with the server).
 */
export function normalizePreview(data) {
  const d = Array.isArray(data) ? data[0] : data;
  if (!d || typeof d !== "object" || !pick(d, ["id", "tournament_id"])) return null;
  const size = count(pick(d, ["size", "max_players"]));
  const entrants = count(d.entrants);
  const fee = cents(pick(d, ["entry_fee_cents", "fee_cents"]));
  return {
    id: pick(d, ["id", "tournament_id"]),
    name: String(pick(d, ["name"]) || "Tournament"),
    host: pick(d, ["host_username", "host"]) || null,
    mode: pick(d, ["mode"]) || "hosted",
    visibility: pick(d, ["visibility"]) === "private" ? "private" : "public",
    size: size,
    entrants: entrants,
    feeCents: fee,
    status: pick(d, ["status"]) || "open",
    rules: pick(d, ["rules"]) || "",
    isHost: bool(pick(d, ["is_host", "caller_is_host"])),
    joined: bool(pick(d, ["joined", "is_entrant", "already_joined", "caller_joined"])),
    now: hostedSplit(fee, entrants),
    full: hostedSplit(fee, size),
  };
}

function normalizeActionRoom(m) {
  const room = normalizeRoom(m);
  room.created_at = pick(m, ["created_at", "opened_at"]);
  room.started_at = pick(m, ["started_at"]);
  room.room_code = pick(m, ["room_code"]);
  room.lobby_code = pick(m, ["lobby_code", "lobby_name"]);
  room.lobby_password = pick(m, ["lobby_password"]);
  room.a_riot_id = pick(m, ["a_riot_id"]);
  room.b_riot_id = pick(m, ["b_riot_id"]);
  room.evidence = Array.isArray(m.evidence) ? m.evidence.filter(function (e) { return e && typeof e === "object"; }) : [];
  return room;
}

/** The host's standing from rib_host_dashboard ({ host: { … } }): limits for the create form. */
export function normalizeHostInfo(data) {
  const h = data && typeof data === "object" && !Array.isArray(data) && data.host && typeof data.host === "object" ? data.host : null;
  if (!h) return null;
  return {
    completed: count(h.hosted_completed),
    strikes: count(h.host_strikes),
    paidAllowed: h.paid_allowed !== false,
    maxFeeCents: h.max_entry_fee_cents == null ? MAX_ENTRY_FEE_CENTS : Math.max(0, Math.floor(Number(h.max_entry_fee_cents) || 0)),
  };
}

/** rib_host_dashboard → [{ id, name, status, size, entrants, feeCents, visibility, inviteCode, openAppeals, rooms }]. */
export function normalizeDashboard(data) {
  let list = [];
  if (Array.isArray(data)) list = data;
  else if (data && typeof data === "object") list = Array.isArray(data.tournaments) ? data.tournaments : [];
  return list.filter(function (t) { return t && typeof t === "object" && pick(t, ["id", "tournament_id"]); }).map(function (t) {
    const rooms = pick(t, ["rooms", "rooms_needing_action", "action_rooms", "actions"]);
    return {
      id: pick(t, ["id", "tournament_id"]),
      name: String(pick(t, ["name"]) || "Tournament"),
      status: pick(t, ["status"]) || "open",
      size: count(pick(t, ["size", "max_players"])),
      entrants: count(t.entrants),
      feeCents: cents(pick(t, ["entry_fee_cents", "fee_cents"])),
      visibility: pick(t, ["visibility"]) === "private" ? "private" : "public",
      inviteCode: pick(t, ["invite_code", "code"]),
      openAppeals: count(pick(t, ["open_appeals", "open_appeals_count", "appeals_open", "appeals"])),
      payoutAt: pick(t, ["payout_at"]),
      startedAt: pick(t, ["started_at"]),
      winnerUsername: pick(t, ["winner_username"]),
      createdAt: pick(t, ["created_at"]),
      rules: pick(t, ["rules"]) || "",
      rooms: Array.isArray(rooms) ? rooms.filter(function (m) { return m && typeof m === "object"; }).map(normalizeActionRoom) : [],
      actionCount: Array.isArray(rooms) ? rooms.length : count(pick(t, ["rooms_needing_action", "action_count"])),
    };
  });
}

/** Check a lobby screenshot before uploading it. Returns { ext } or { error }. */
export function validateLobbyImage(file) {
  if (!file) return { error: "Choose a screenshot of the lobby." };
  const ext = LOBBY_IMAGE_TYPES[file.type];
  if (!ext) return { error: "The lobby screenshot must be a PNG, JPEG or WebP image." };
  if (!(file.size > 0)) return { error: "That file is empty. Choose another screenshot." };
  if (file.size > LOBBY_IMAGE_MAX_BYTES) return { error: "The lobby screenshot must be 5 MB or smaller." };
  return { ext: ext };
}

/** Storage path of a lobby screenshot: <room_id>/<uuid>.<ext>. */
export function lobbyImagePath(roomId, uuid, ext) {
  return String(roomId) + "/" + String(uuid) + "." + String(ext);
}

/** "23 h 05 min", "12 min", "under a minute" until a deadline (or "" once passed). */
export function formatCountdown(deadline, now) {
  const ms = new Date(deadline).getTime() - (now == null ? Date.now() : now);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "under a minute";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? h + " h " + String(m).padStart(2, "0") + " min" : m + " min";
}
