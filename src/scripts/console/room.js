/* ============================================================================
 * Runinback — match room: where two players who may not know each other meet
 * for a bracket match or a friendly. They set up a private lobby in their
 * game, confirm they're ready, report the result and, if they disagree,
 * dispute it with captures taken in the app.
 *
 * The database decides everything (migrations 0022–0023): ready and
 * confirmation deadlines, silence-confirms, walkovers, deposits, advancement
 * and payouts. This module renders the state and stays live through Realtime.
 *
 * Structure: the room's shell (stepper, state card, lobby, players, captures,
 * chat) is built once per room; Realtime updates only patch the parts that
 * change, so a message being typed, an open dispute form or an error message
 * survive the opponent's actions. Events are delegated on the root.
 * ========================================================================== */
import { byId as $, escapeHtml as esc, showMessage } from "../lib/dom.js";
import { formatRcoin } from "../lib/format.js";
import { replayClass, tweenNumber } from "../lib/motion.js";
import { prizeSplit, roundName } from "../lib/tournament.js";
import { errorText, session } from "./context.js";
import { refreshLive } from "./live.js";
import { currentRouteArg, goToPage } from "./navigation.js";
import { networkLabel } from "./networks.js";
import { refreshWallet } from "./wallet.js";

const LAST_ROOM_KEY = "rib-last-room";
const EVIDENCE_BUCKET = "room-evidence";
const WINDOW_SECONDS = 900; // both the ready check and the confirmation window
const STEPS = ["Lobby", "Ready", "Playing", "Report", "Result"];

const room = {
  id: null, r: null, info: null, messages: [], evidence: [], channel: null, timer: 0,
  busy: false, shellFor: null, lastStatus: null, celebrated: {},
};

function rememberRoom(id) {
  try { sessionStorage.setItem(LAST_ROOM_KEY, id); } catch (e) { /* storage blocked */ }
}
function lastRoom() {
  try { return sessionStorage.getItem(LAST_ROOM_KEY); } catch (e) { return null; }
}

/** Open a match room page (deep-linkable as #page-room/<id>). */
export function openRoom(id) {
  if (!id) return;
  if (room.id !== id) closeRoom();
  room.id = id;
  rememberRoom(id);
  goToPage("page-room", { arg: id });
}

/** Stop Realtime and timers (when another page opens). */
export function closeRoom() {
  if (room.channel) { try { session.client.removeChannel(room.channel); } catch (e) { /* already gone */ } }
  room.channel = null;
  room.shellFor = null;
  clearInterval(room.timer);
  room.timer = 0;
}

/** Page loader for #page-room. */
export function loadRoom() {
  const id = currentRouteArg() || room.id || lastRoom();
  if (!id) {
    $("room-title").textContent = "Match room.";
    $("room-root").innerHTML = emptyState("No room open", "Rooms open from your tournaments and friendlies once a match is ready.", "Find a tournament");
    return Promise.resolve();
  }
  if (room.id !== id) closeRoom();
  room.id = id;
  rememberRoom(id);
  subscribe(id);
  return fetchRoom();
}

function emptyState(title, text, cta) {
  return '<div class="empty">' + peakArt("match") + "<h3>" + esc(title) + "</h3><p>" + esc(text) + "</p>" +
    (cta ? '<p><button type="button" class="btn btn--cta btn--sm" data-go="page-compete">' + esc(cta) + "</button></p>" : "") + "</div>";
}

/** The brand's peak mark, drawn in (empty states). */
export function peakArt(tone) {
  return '<svg class="empty__art empty__art--' + tone + '" viewBox="0 0 72 40" aria-hidden="true">' +
    '<path class="empty__peak" pathLength="1" d="M2 38 L22 12 L32 24 L46 4 L70 38"/>' +
    '<path class="empty__spark" pathLength="1" d="M54 2 L50 10 L56 10 L52 18"/></svg>';
}

function fetchRoom() {
  const id = room.id;
  return Promise.all([
    session.client.from("match_rooms").select("*").eq("id", id).single(),
    session.client.rpc("rib_room_info", { p_room_id: id }),
    session.client.from("room_messages").select("id, user_id, body, created_at").eq("room_id", id).order("id", { ascending: true }).limit(200),
    session.client.from("room_evidence").select("id, user_id, storage_path, source, created_at").eq("room_id", id).order("id", { ascending: true }),
  ]).then(function (res) {
    if (id !== room.id) return;
    if (res[0].error || !res[0].data) {
      $("room-title").textContent = "Match room.";
      $("room-root").innerHTML = emptyState("Room not found", "This room doesn't exist or isn't yours.", "Back to Compete");
      room.shellFor = null;
      return;
    }
    room.r = res[0].data;
    room.info = (Array.isArray(res[1].data) && res[1].data[0]) || {};
    room.messages = Array.isArray(res[2].data) ? res[2].data : [];
    room.evidence = Array.isArray(res[3].data) ? res[3].data : [];
    if (room.shellFor !== id) renderShell();
    update();
    renderChat();
  }).catch(function () {
    $("room-root").innerHTML = '<p class="muted">Couldn\'t load the room. Check your connection and try again.</p>';
    room.shellFor = null;
  });
}

function subscribe(id) {
  if (room.channel || !session.client.channel) return;
  room.channel = session.client.channel("room-" + id)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "match_rooms", filter: "id=eq." + id }, function (payload) {
      if (id !== room.id || !payload.new) return;
      const was = room.r && room.r.status;
      room.r = Object.assign({}, room.r, payload.new);
      if (was !== room.r.status) refreshWallet();
      if (room.shellFor === id) update();
    })
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "room_messages", filter: "room_id=eq." + id }, function (payload) {
      if (id !== room.id || !payload.new) return;
      appendMessage(payload.new);
    })
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "room_evidence", filter: "room_id=eq." + id }, function (payload) {
      if (id !== room.id || !payload.new) return;
      if (room.evidence.some(function (e) { return e.id === payload.new.id; })) return;
      room.evidence.push(payload.new);
      renderEvidence();
    })
    .subscribe();
}

/* ---- derived state -------------------------------------------------------- */
function me() { return session.uid; }
function amA() { return room.r.player_a === me(); }
function opponentId() { return amA() ? room.r.player_b : room.r.player_a; }
function nameOf(uid) {
  if (uid === me()) return "you";
  const i = room.info || {};
  const n = uid === room.r.player_a ? i.a_username : i.b_username;
  return n ? "@" + n : "your opponent";
}
function myReport() { return amA() ? room.r.a_report : room.r.b_report; }
function theirReport() { return amA() ? room.r.b_report : room.r.a_report; }
function myReady() { return amA() ? room.r.a_ready_at : room.r.b_ready_at; }
function theirReady() { return amA() ? room.r.b_ready_at : room.r.a_ready_at; }
function isPaid() { return room.r.kind === "tournament" && (room.info.entry_fee_cents || 0) > 0; }
function depositCents() { return Math.max(100, Math.floor((room.info.entry_fee_cents || 0) / 10)); }
function isFinal() { return room.r.kind === "tournament" && !!room.info.rounds && room.r.round === room.info.rounds; }

function stepIndex(r) {
  if (r.status === "waiting") return 0;
  if (r.status === "ready_check") return 1;
  if (r.status === "live") return r.a_report || r.b_report ? 3 : 2;
  if (r.status === "disputed") return 3;
  return 4;
}

function countdown(deadline) {
  const ms = new Date(deadline).getTime() - Date.now();
  if (!(ms > 0)) return "0:00";
  const s = Math.ceil(ms / 1000);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

function clock(deadline, note, kind) {
  return '<div class="room-clock room-clock--' + kind + '" data-deadline="' + esc(deadline) + '" data-total="' + WINDOW_SECONDS + '">' +
    '<svg viewBox="0 0 40 40" aria-hidden="true"><circle class="room-clock__track" cx="20" cy="20" r="18"/>' +
    '<circle class="room-clock__arc" cx="20" cy="20" r="18" pathLength="100"/></svg>' +
    '<strong class="room-clock__t">' + countdown(deadline) + '</strong><span class="room-clock__k">' + note + "</span></div>";
}

/* ---- rendering ------------------------------------------------------------ */
function renderShell() {
  room.shellFor = room.id;
  room.lastStatus = null;
  $("room-root").innerHTML =
    '<p class="room-context" id="room-context"></p>' +
    '<ol class="room-steps" id="room-steps" aria-label="Match progress">' +
      STEPS.map(function (s) { return "<li><span>" + s + "</span></li>"; }).join("") + "</ol>" +
    '<div class="room">' +
      '<div class="room__main">' +
        '<div class="room-state" id="room-state" aria-live="polite"></div>' +
        '<p class="msg" id="room-msg" hidden></p>' +
        '<div id="room-lobby"></div>' +
        '<div class="room-players" id="room-players"></div>' +
        '<section class="room-evidence" id="room-evidence" hidden></section>' +
      "</div>" +
      '<aside class="room__chat" aria-label="Room chat">' +
        '<h2 class="room__h">Chat</h2>' +
        '<ol class="room-chat" id="room-chat"></ol>' +
        '<button type="button" class="chip chip--match room-chat__new" id="room-chat-new" hidden>New message</button>' +
        '<form class="room-chat__form" id="room-chat-form"><label for="room-chat-input" class="visually-hidden">Message</label>' +
          '<input id="room-chat-input" type="text" maxlength="500" autocomplete="off" placeholder="Message your opponent" />' +
          '<button type="submit" class="btn btn--sm">Send</button></form>' +
        '<p class="muted room-chat__closed" id="room-chat-closed" hidden>This room is closed.</p>' +
      "</aside>" +
    "</div>" +
    '<input type="file" accept="image/*" capture="environment" id="room-camera" hidden />';
  wireShell();
}

function update() {
  const r = room.r;
  const i = room.info || {};
  const live = r.status === "ready_check" || r.status === "live" || r.status === "disputed";
  $("room-title").textContent = r.game + ".";
  $("room-context").innerHTML = contextLine(r, i);
  renderSteps(r);
  renderPlayers(r, i);
  $("room-lobby").innerHTML = live && r.room_code ? lobbyBox(r) : "";
  renderState(r);
  renderEvidence();
  $("room-chat-form").hidden = !live;
  $("room-chat-closed").hidden = live;

  clearInterval(room.timer);
  room.timer = (r.status === "ready_check" || r.status === "live") ? setInterval(tick, 1000) : 0;
  tick();
  room.lastStatus = r.status;
}

function contextLine(r, i) {
  if (r.kind === "friendly") return "Friendly · free";
  const round = i.rounds ? roundName(r.round, i.rounds) : "Round " + r.round;
  return esc(i.tournament_name || "Tournament") + " · " + round + " · " + (i.entry_fee_cents ? formatRcoin(i.entry_fee_cents) + " entry" : "free");
}

function renderSteps(r) {
  const cur = stepIndex(r);
  const steps = $("room-steps");
  steps.classList.toggle("is-disputed", r.status === "disputed");
  steps.classList.toggle("is-won", r.status === "done" && r.winner_id === me());
  steps.querySelectorAll("li").forEach(function (li, idx) {
    const s = idx < cur || (cur === 4 && idx === 4) ? "done" : idx === cur ? "current" : "todo";
    li.setAttribute("data-s", s);
    if (idx === cur) li.setAttribute("aria-current", "step");
    else li.removeAttribute("aria-current");
  });
  steps.querySelector("li:nth-child(4) span").textContent = r.status === "disputed" ? "In review" : "Report";
}

function playerChip(r, uid) {
  if (!uid) return "";
  const isA = uid === r.player_a;
  if (r.status === "ready_check") {
    const ready = isA ? r.a_ready_at : r.b_ready_at;
    return '<span class="chip' + (ready ? " chip--match" : "") + '" data-chip="' + (ready ? "ready" : "wait") + '">' + (ready ? "Ready" : "Not ready") + "</span>";
  }
  if (r.status === "live" || r.status === "disputed") {
    const rep = isA ? r.a_report : r.b_report;
    if (!rep) return '<span class="chip" data-chip="playing">Playing</span>';
    const who = rep === uid ? "they won" : (nameOf(rep) === "you" ? "you won" : nameOf(rep) + " won");
    return '<span class="chip ' + (r.status === "disputed" && r.disputed_by === uid ? "chip--escrow" : "chip--match") + '" data-chip="rep-' + esc(rep) + '">Says ' + esc(who) + "</span>";
  }
  if (r.status === "done" && r.winner_id === uid) return '<span class="chip chip--settle" data-chip="won">Won</span>';
  return "";
}

function renderPlayers(r, i) {
  const network = r.network ? networkLabel(r.network) : "";
  const box = $("room-players");
  const prev = {};
  box.querySelectorAll("[data-seat]").forEach(function (el) {
    const c = el.querySelector(".chip");
    prev[el.getAttribute("data-seat")] = c ? c.getAttribute("data-chip") : "";
  });
  const card = function (seat, uid, username, handle, matches, lost, noShows) {
    return '<div class="room-player' + (uid === me() ? " is-me" : "") + '" data-seat="' + seat + '">' +
      '<div class="room-player__top"><span class="room-player__name">' + esc(username ? "@" + username : "—") + "</span>" +
      (uid === me() ? '<span class="tag">you</span>' : "") + playerChip(r, uid) + "</div>" +
      (network ? '<div class="room-player__handle">' + esc(network) + ": " + (handle ? "<strong>" + esc(handle) + "</strong>" : "not linked") + "</div>" : "") +
      '<div class="room-player__rec">' + matches + " matches · " + lost + " disputes lost · " + noShows + " no-shows</div></div>";
  };
  box.innerHTML =
    card("a", r.player_a, i.a_username, i.a_handle, i.a_matches || 0, i.a_disputes_lost || 0, i.a_no_shows || 0) +
    '<span class="room-players__vs" aria-hidden="true">vs</span>' +
    card("b", r.player_b, i.b_username, i.b_handle, i.b_matches || 0, i.b_disputes_lost || 0, i.b_no_shows || 0);
  // A chip that changed confirms itself once (someone got ready, reported).
  box.querySelectorAll("[data-seat]").forEach(function (el) {
    const c = el.querySelector(".chip");
    const seat = el.getAttribute("data-seat");
    if (c && seat in prev && prev[seat] !== c.getAttribute("data-chip")) replayClass(c, "is-bumped");
  });
}

function lobbyBox(r) {
  const copy = function (value, label) {
    return '<button type="button" class="btn btn--sm room-copy" data-copy="' + esc(value) + '" aria-label="Copy ' + label + '">Copy</button>';
  };
  return '<div class="room-lobby">' +
    '<div class="room-lobby__code"><span class="k">Match code</span><span class="v">' + esc(r.room_code) + "</span></div>" +
    '<dl class="room-lobby__creds">' +
      "<div><dt>Lobby name</dt><dd><code>" + esc(r.lobby_name) + "</code>" + copy(r.lobby_name, "lobby name") + "</dd></div>" +
      "<div><dt>Password</dt><dd><code>" + esc(r.lobby_password) + "</code>" + copy(r.lobby_password, "password") + "</dd></div>" +
    "</dl>" +
    '<p class="muted room-lobby__how">One of you creates a private or custom match with this name and password; the other joins it. Keep the match code in the lobby name: it ties your captures to this match.</p>' +
  "</div>";
}

function renderState(r) {
  const box = $("room-state");
  // Keep an open dispute form (and what's typed in it) across updates.
  const form = $("room-dispute");
  const keep = form && !form.hidden && r.status === "live" ? $("room-dispute-reason").value : null;
  const wasStatus = room.lastStatus;
  box.innerHTML = stateHtml(r);
  if (keep !== null && $("room-dispute")) {
    $("room-dispute").hidden = false;
    $("room-dispute-reason").value = keep;
  }
  if (wasStatus && wasStatus !== r.status) replayClass(box, "is-changed");
  celebrate(r, wasStatus);
}

// Win moments: the headline reveals; a champion's prize counts up.
function celebrate(r, wasStatus) {
  if (r.status !== "done" || r.winner_id !== me() || room.celebrated[r.id]) return;
  room.celebrated[r.id] = true;
  const h = $("room-state").querySelector("h2");
  if (h && wasStatus && wasStatus !== "done") replayClass(h, "is-reveal");
  const prize = $("room-prize");
  if (prize) {
    const cents = parseInt(prize.getAttribute("data-cents"), 10) || 0;
    tweenNumber(prize, 0, cents, function (v) { prize.textContent = formatRcoin(Math.round(v)); }, 900);
  }
}

function prizeLine(won) {
  const i = room.info || {};
  if (!isPaid() || !isFinal()) return "";
  const split = prizeSplit(i.entry_fee_cents, i.tournament_size);
  const cents = won ? (room.r.walkover ? split.prizes : split.first) : room.r.walkover ? 0 : split.second;
  if (!cents) return "";
  return '<p class="room-prize"><span class="room-prize__v" id="room-prize" data-cents="' + cents + '">' + formatRcoin(cents) +
    "</span> was added to your wallet.</p>";
}

function nextActions(buttons) {
  return '<div class="room-actions">' + buttons.join("") + "</div>";
}

function stateHtml(r) {
  const opp = esc(nameOf(opponentId()));
  const i = room.info || {};
  if (r.status === "waiting") return "<h2>Waiting for your opponent</h2><p>This match opens when the previous round decides who you play.</p>";
  if (r.status === "void") {
    return "<h2>No result</h2><p>" + esc(r.resolution_note || "This match ended without a winner.") + "</p>" +
      nextActions(['<button type="button" class="btn btn--sm" data-go="page-compete">Back to Compete</button>']);
  }
  if (r.status === "done") {
    const won = r.winner_id === me();
    const how = r.walkover ? (won ? "Your opponent didn't show up. " : "You didn't get ready in time. ") : "";
    const review = r.resolution_note ? "Review: " + esc(r.resolution_note) + ". " : "";
    if (r.kind === "friendly") {
      return '<h2 class="' + (won ? "is-win" : "is-loss") + '">' + (won ? "You won." : opp + " won.") + "</h2><p>" + how + review + "Good game.</p>" +
        nextActions(['<button type="button" class="btn btn--cta btn--sm" data-go="page-compete">Find a tournament</button>']);
    }
    if (isFinal()) {
      return '<h2 class="' + (won ? "is-win" : "is-loss") + '">' + (won ? "You're the champion." : "Runner-up.") + "</h2>" +
        "<p>" + how + review + (won ? "You won " + esc(i.tournament_name || "the tournament") + "." : opp + " won " + esc(i.tournament_name || "the tournament") + ". Well played.") + "</p>" +
        prizeLine(won) +
        nextActions(['<button type="button" class="btn btn--sm" data-go="mine">See bracket</button>', '<button type="button" class="btn btn--cta btn--sm" data-go="page-compete">Find another tournament</button>']);
    }
    if (won) {
      return '<h2 class="is-win">You won.</h2><p>' + how + review + "You're through to the " + roundName(r.round + 1, i.rounds || r.round + 1).toLowerCase() +
        ". It opens as soon as your next opponent is known.</p>" +
        '<div class="room-next" id="room-next"></div>' +
        nextActions(['<button type="button" class="btn btn--sm" data-go="mine">See bracket</button>']);
    }
    return '<h2 class="is-loss">' + opp + " won.</h2><p>" + how + review + "You're out in the " + roundName(r.round, i.rounds || r.round).toLowerCase() + ".</p>" +
      nextActions(['<button type="button" class="btn btn--sm" data-go="mine">See bracket</button>', '<button type="button" class="btn btn--cta btn--sm" data-go="page-compete">Find a tournament</button>']);
  }
  if (r.status === "disputed") {
    const byMe = r.disputed_by === me();
    return "<h2>In review</h2><p>" + (byMe ? "You disputed " + opp + "'s report." : opp + " disputed your report.") +
      " The Runinback team will check the chat and the captures and decide." +
      (r.dispute_deposit_cents ? " The " + formatRcoin(r.dispute_deposit_cents) + " deposit comes back if the dispute holds and goes to the other player if it doesn't." : "") +
      "</p><p>Add captures of the final score below.</p>";
  }
  if (r.status === "ready_check") {
    const mine = myReady(); const theirs = theirReady();
    const rule = r.kind === "tournament"
      ? "If only one of you is ready, that player advances. If neither is, you're both out."
      : "If it runs out, the friendly closes.";
    return "<h2>Get into the lobby</h2>" +
      "<p>Set up the private match with the details below, then press Ready. The match starts when both of you are ready.</p>" +
      clock(r.ready_deadline, (mine ? "You're ready. " + (theirs ? "" : "Waiting for " + opp + ". ") : "") + rule, "ready") +
      (mine ? "" : nextActions(['<button type="button" class="btn btn--cta" data-act="ready">I\'m in the lobby, ready</button>']));
  }
  // live
  const mineR = myReport(); const theirsR = theirReport();
  if (!mineR && !theirsR) {
    return "<h2>Match on</h2><p>Play the match. When it ends, report the result: if " + opp +
      " reports the same, it's settled right away.</p>" +
      nextActions(['<button type="button" class="btn btn--cta" data-act="won">I won</button>', '<button type="button" class="btn" data-act="lost">I lost</button>']);
  }
  if (mineR && !theirsR) {
    return "<h2>Waiting for " + opp + "</h2><p>You reported that " + (mineR === me() ? "you" : opp) + " won.</p>" +
      clock(r.confirm_deadline, opp + " can confirm or dispute it. If they don't respond, your result stands.", "confirm");
  }
  const theySayIWon = theirsR === me();
  const disputeNote = isPaid()
    ? "Disputing holds a deposit of " + formatRcoin(depositCents()) + ". You get it back if the team agrees with you; otherwise it goes to " + opp + "."
    : r.kind === "friendly" ? "A disputed friendly ends with no result." : "The Runinback team reviews disputed matches.";
  return "<h2>" + opp + " reported " + (theySayIWon ? "that you won" : "that they won") + "</h2>" +
    clock(r.confirm_deadline, "to respond. After that, their result stands.", "confirm") +
    (theySayIWon
      ? nextActions(['<button type="button" class="btn btn--cta" data-act="confirm-me">Confirm my win</button>'])
      : nextActions(['<button type="button" class="btn" data-act="confirm-them">Confirm they won</button>', '<button type="button" class="btn btn--danger" data-act="dispute-open">Dispute</button>']) +
        '<form class="room-dispute" id="room-dispute" hidden novalidate>' +
          '<label for="room-dispute-reason">What happened?</label>' +
          '<textarea id="room-dispute-reason" maxlength="500" rows="3" placeholder="For example: I won 13-9, the final scoreboard is in my capture."></textarea>' +
          '<p class="field__hint">' + disputeNote + "</p>" +
          nextActions(['<button type="submit" class="btn btn--danger">Open dispute</button>', '<button type="button" class="btn" data-act="dispute-cancel">Cancel</button>']) +
        "</form>");
}

function renderEvidence() {
  const box = $("room-evidence");
  if (!box || !room.r) return;
  const r = room.r;
  const canAdd = r.status === "live" || r.status === "disputed";
  box.hidden = !canAdd && !room.evidence.length;
  if (box.hidden) return;
  const hasScreen = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  box.innerHTML = '<h2 class="room__h">Captures</h2>' +
    '<p class="muted">Captures are taken in the app and stamped with the match code, a one-time token and the server time, so an image made elsewhere can\'t pass as one.</p>' +
    (canAdd ? '<div class="room-actions">' +
      (hasScreen ? '<button type="button" class="btn btn--sm" data-act="capture-screen">Capture my screen</button>' : "") +
      '<button type="button" class="btn btn--sm" data-act="capture-camera">Take a photo</button></div>' : "") +
    '<ul class="room-evidence__list" id="room-evidence-list">' + room.evidence.map(function (e) {
      return '<li><a data-evidence="' + esc(e.storage_path) + '" target="_blank" rel="noopener">' +
        '<img alt="Capture by ' + esc(nameOf(e.user_id)) + '" /></a><span>' + esc(nameOf(e.user_id)) + " · " + (e.source === "screen" ? "screen" : "photo") + "</span></li>";
    }).join("") + "</ul>";
  loadEvidenceThumbs();
}

function messageHtml(m) {
  const mine = m.user_id === me();
  return '<li class="' + (mine ? "is-me" : "") + '"><span class="room-chat__who">' + esc(mine ? "You" : nameOf(m.user_id)) +
    '</span><span class="room-chat__body">' + esc(m.body) + "</span></li>";
}

function renderChat() {
  const list = $("room-chat");
  if (!list) return;
  list.innerHTML = room.messages.length
    ? room.messages.map(messageHtml).join("")
    : '<li class="room-chat__empty">Say hi and agree who creates the lobby.</li>';
  list.scrollTop = list.scrollHeight;
}

// New messages are appended (the list isn't rebuilt); the view follows them
// only if the reader was already at the bottom.
function appendMessage(m) {
  if (room.messages.some(function (x) { return x.id === m.id; })) return;
  room.messages.push(m);
  const list = $("room-chat");
  if (!list) return;
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  const empty = list.querySelector(".room-chat__empty");
  if (empty) empty.remove();
  list.insertAdjacentHTML("beforeend", messageHtml(m));
  if (list.lastElementChild) list.lastElementChild.classList.add("is-new");
  if (atBottom || m.user_id === me()) list.scrollTop = list.scrollHeight;
  else $("room-chat-new").hidden = false;
}

function loadEvidenceThumbs() {
  const links = document.querySelectorAll("#room-evidence-list [data-evidence]");
  if (!links.length || !session.client.storage) return;
  const paths = Array.prototype.map.call(links, function (a) { return a.getAttribute("data-evidence"); });
  session.client.storage.from(EVIDENCE_BUCKET).createSignedUrls(paths, 600).then(function (r) {
    (Array.isArray(r.data) ? r.data : []).forEach(function (item, i) {
      if (!item || !item.signedUrl || !links[i]) return;
      links[i].href = item.signedUrl;
      links[i].querySelector("img").src = item.signedUrl;
    });
  });
}

// Clocks: the ring empties as time runs out; under a minute it turns red,
// and at zero it says the result is being settled (the sweep runs each minute).
function tick() {
  document.querySelectorAll("#room-state .room-clock").forEach(function (el) {
    const ms = new Date(el.getAttribute("data-deadline")).getTime() - Date.now();
    const total = (parseInt(el.getAttribute("data-total"), 10) || WINDOW_SECONDS) * 1000;
    el.style.setProperty("--p", String(Math.max(0, Math.min(1, ms / total))));
    el.classList.toggle("is-low", ms > 0 && ms < 60000);
    el.querySelector(".room-clock__t").textContent = countdown(el.getAttribute("data-deadline"));
    if (!(ms > 0) && !el.classList.contains("is-over")) {
      el.classList.add("is-over");
      el.querySelector(".room-clock__k").textContent = "Time's up. Settling…";
    }
  });
}

// "You won, next round": link to the next room as soon as it opens.
document.addEventListener("rib:live", function (e) {
  const box = $("room-next");
  if (!box || !room.r || room.r.kind !== "tournament") return;
  const next = (e.detail || []).find(function (m) { return m.tournament_id === room.r.tournament_id && m.round > room.r.round; });
  box.innerHTML = next ? '<button type="button" class="btn btn--cta btn--sm" data-room="' + esc(next.id) + '">Open your next match</button>' : "";
});

/* ---- actions -------------------------------------------------------------- */
function flash(text, ok) { showMessage($("room-msg"), text, ok); }

function act(fn, args, okText) {
  if (room.busy) return Promise.resolve();
  room.busy = true;
  document.querySelectorAll("#room-state button").forEach(function (b) { b.disabled = true; });
  return session.client.rpc(fn, args).then(function (res) {
    room.busy = false;
    if (res.error) {
      flash(errorText(res.error, "Couldn't complete the action."), false);
      return fetchRoom();
    }
    if (res.data && res.data.id) room.r = Object.assign({}, room.r, res.data);
    update();
    if (okText) flash(okText, true);
    refreshWallet();
    refreshLive();
  }).catch(function () {
    room.busy = false;
    flash("Network error. Check your connection and try again.", false);
    update();
  });
}

function onAction(name) {
  const r = room.r;
  if (name === "ready") return act("rib_room_ready", { p_room_id: r.id }, "You're ready.");
  if (name === "won") {
    if (!window.confirm("Report that you won? If your opponent confirms, or doesn't respond in 15 minutes, the win is yours.")) return;
    return act("rib_room_report", { p_room_id: r.id, p_winner_id: me() }, "Result sent.");
  }
  if (name === "lost") {
    if (!window.confirm("Report that you lost? Your opponent takes the match.")) return;
    return act("rib_room_report", { p_room_id: r.id, p_winner_id: opponentId() }, "Result sent. Good game.");
  }
  if (name === "confirm-me") return act("rib_room_report", { p_room_id: r.id, p_winner_id: me() }, "Confirmed.");
  if (name === "confirm-them") {
    if (!window.confirm("Confirm that your opponent won?")) return;
    return act("rib_room_report", { p_room_id: r.id, p_winner_id: opponentId() }, "Confirmed. Good game.");
  }
  if (name === "dispute-open") { $("room-dispute").hidden = false; $("room-dispute-reason").focus(); return; }
  if (name === "dispute-cancel") { $("room-dispute").hidden = true; return; }
  if (name === "capture-screen") return captureScreen();
  if (name === "capture-camera") return $("room-camera").click();
}

function wireShell() {
  const root = $("room-root");
  if (root.dataset.wired) return; // delegated once; the shell's children change, the root doesn't
  root.dataset.wired = "1";
  root.addEventListener("click", function (e) {
    const actBtn = e.target.closest("[data-act]");
    if (actBtn) { onAction(actBtn.getAttribute("data-act")); return; }
    const copyBtn = e.target.closest("[data-copy]");
    if (copyBtn) {
      if (!navigator.clipboard) return;
      navigator.clipboard.writeText(copyBtn.getAttribute("data-copy")).then(function () {
        copyBtn.textContent = "Copied";
        copyBtn.classList.add("is-done");
        setTimeout(function () { copyBtn.textContent = "Copy"; copyBtn.classList.remove("is-done"); }, 1600);
      });
      return;
    }
    const roomBtn = e.target.closest("[data-room]");
    if (roomBtn) { openRoom(roomBtn.getAttribute("data-room")); return; }
    const go = e.target.closest("[data-go]");
    if (go) {
      const target = go.getAttribute("data-go");
      if (target === "mine") {
        goToPage("page-compete");
        const tab = document.querySelector('#compete-seg [data-seg="mine"]');
        if (tab) tab.click();
      } else {
        goToPage(target);
      }
      return;
    }
    if (e.target.closest("#room-chat-new")) {
      $("room-chat").scrollTop = $("room-chat").scrollHeight;
      $("room-chat-new").hidden = true;
    }
  });
  root.addEventListener("submit", function (e) {
    if (e.target.id === "room-dispute") {
      e.preventDefault();
      const reason = ($("room-dispute-reason").value || "").trim();
      if (reason.length < 10) { flash("Explain what happened (10 to 500 characters).", false); $("room-dispute-reason").focus(); return; }
      act("rib_room_dispute", { p_room_id: room.r.id, p_reason: reason }, room.r.kind === "friendly" ? "The friendly closed with no result." : "Dispute opened. Add your captures below.");
    } else if (e.target.id === "room-chat-form") {
      e.preventDefault();
      const input = $("room-chat-input");
      const body = (input.value || "").trim();
      if (!body) return;
      input.value = "";
      session.client.rpc("rib_room_message", { p_room_id: room.r.id, p_body: body }).then(function (res) {
        if (res.error) { input.value = body; flash(errorText(res.error, "Couldn't send the message."), false); return; }
        if (res.data && res.data.id) appendMessage(res.data);
      });
    }
  });
  root.addEventListener("change", function (e) {
    if (e.target.id !== "room-camera") return;
    const camera = e.target;
    if (camera.files && camera.files[0]) capturePhoto(camera.files[0]);
    camera.value = "";
  });
  root.addEventListener("scroll", function (e) {
    if (e.target.id !== "room-chat") return;
    const list = e.target;
    if (list.scrollHeight - list.scrollTop - list.clientHeight < 40) $("room-chat-new").hidden = true;
  }, true);
}

/* ---- captures --------------------------------------------------------------
 * The image comes from the screen or the camera at capture time, gets a
 * server token stamped into its pixels, is hashed, stored under
 * <room>/<user>/ and registered with that token (single use, 15 minutes).
 * -------------------------------------------------------------------------- */
function captureScreen() {
  navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }).then(function (stream) {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    return video.play().then(function () {
      return new Promise(function (resolve) { requestAnimationFrame(resolve); });
    }).then(function () {
      return stampAndUpload({ image: video, width: video.videoWidth, height: video.videoHeight }, "screen")
        .finally(function () { stream.getTracks().forEach(function (t) { t.stop(); }); });
    });
  }).catch(function (err) {
    if (err && err.name === "NotAllowedError") return; // the player cancelled the picker
    flash("Couldn't capture the screen. Try the photo option instead.", false);
  });
}

function capturePhoto(file) {
  if (!/^image\//.test(file.type)) { flash("Take a photo of the final score.", false); return; }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = function () {
    stampAndUpload({ image: img, width: img.naturalWidth, height: img.naturalHeight }, "camera").finally(function () { URL.revokeObjectURL(url); });
  };
  img.onerror = function () { URL.revokeObjectURL(url); flash("That photo couldn't be read.", false); };
  img.src = url;
}

function stampAndUpload(source, kind) {
  const r = room.r;
  flash("Uploading your capture…", true);
  return session.client.rpc("rib_room_evidence_token", { p_room_id: r.id }).then(function (res) {
    if (res.error || !Array.isArray(res.data) || !res.data[0]) throw res.error || new Error("no token");
    const t = res.data[0];
    const scale = Math.min(1, 1920 / (source.width || 1920));
    const w = Math.round((source.width || 1280) * scale);
    const h = Math.round((source.height || 720) * scale);
    const bar = Math.max(36, Math.round(h * 0.05));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h + bar;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(source.image, 0, 0, w, h);
    ctx.fillStyle = "#0e100f";
    ctx.fillRect(0, h, w, bar);
    ctx.fillStyle = "#fffce1";
    ctx.font = Math.round(bar * 0.45) + "px ui-monospace, monospace";
    ctx.textBaseline = "middle";
    ctx.fillText(t.room_code + "  ·  token " + t.token + "  ·  " + new Date(t.issued_at).toISOString() + "  ·  " + nameOf(me()), 12, h + bar / 2);
    return new Promise(function (resolve) { canvas.toBlob(resolve, "image/jpeg", 0.9); }).then(function (blob) {
      return blob.arrayBuffer().then(function (buf) { return crypto.subtle.digest("SHA-256", buf); }).then(function (digest) {
        const sha = Array.prototype.map.call(new Uint8Array(digest), function (b) { return b.toString(16).padStart(2, "0"); }).join("");
        const path = r.id + "/" + me() + "/" + t.token + ".jpg";
        return session.client.storage.from(EVIDENCE_BUCKET).upload(path, blob, { contentType: "image/jpeg", upsert: false }).then(function (up) {
          if (up.error) throw up.error;
          return session.client.rpc("rib_room_evidence_add", { p_room_id: r.id, p_token: t.token, p_path: path, p_sha256: sha, p_source: kind });
        });
      });
    });
  }).then(function (res) {
    if (res && res.error) throw res.error;
    if (res && res.data && res.data.id && !room.evidence.some(function (e) { return e.id === res.data.id; })) {
      room.evidence.push(res.data);
      renderEvidence();
    }
    flash("Capture added.", true);
  }).catch(function (err) {
    flash(errorText(err, "Couldn't add the capture. Try again."), false);
  });
}

export function initRoom() {
  const back = $("room-back");
  if (back) back.addEventListener("click", function () { goToPage("page-compete"); });
  document.addEventListener("rib:page", function (e) { if (e.detail !== "page-room") closeRoom(); });
}
