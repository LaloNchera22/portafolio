/* ============================================================================
 * Runinback — Hosting: the tournaments I run (docs/hosted-tournaments.md).
 *
 * #page-hosting             my hosted tournaments (rib_host_dashboard)
 * #page-hosting/<id>        one of them: the share link front and center
 *                           (copy, native share, a new link), seats and the
 *                           prize breakdown, Start now / Cancel, the matches
 *                           that need me on top (Post lobby → Pick winner),
 *                           open appeals, the bracket.
 *
 * A match in `setup` waits for the lobby: the code, an optional password and
 * an optional screenshot (private bucket room-lobby, <room_id>/<uuid>.<ext>,
 * PNG/JPEG/WebP up to 5 MB, checked here first). Posting it moves the match
 * to `live`. A live match shows both players' reports and their end screens
 * with the automatic check; the host picks A or B, a walkover, or voids it
 * (neither showed) with a note. The host can open any match room's chat.
 *
 * One Realtime channel while the page is on screen: my tournaments' rows
 * (creator_id) and, on a detail, that tournament's match rooms. Bursts
 * collapse into one read; leaving the page removes the channel. A refresh
 * that lands while the host is typing, has a screenshot chosen or is in a
 * form waits until they're done, so nothing they entered is wiped; open
 * "Someone didn't show up?" panels stay open across refreshes.
 * ========================================================================== */
import { announce } from "../lib/announce.js";
import { byId as $, escapeHtml as esc, showMessage } from "../lib/dom.js";
import { toast } from "../lib/errors.js";
import { formatDate, formatRcoin } from "../lib/format.js";
import {
  HOST_FEE_PERCENT, HOST_NOTE_MAX, HOST_NOTE_MIN, LOBBY_BUCKET, LOBBY_CODE_MAX, LOBBY_PASSWORD_MAX, MIN_ENTRANTS,
  bracketSizeFor, byesFor, formatCountdown, formatInviteCode, hostedSplit, lobbyImagePath, normalizeBracket,
  normalizeDashboard, normalizeHostInfo, roundLabel, shareUrl, validateLobbyImage,
} from "../lib/hosted.js";
import { replayClass } from "../lib/motion.js";
import { roundsFor } from "../lib/tournament.js";
import { peakArt } from "./art.js";
import { renderBracket } from "./bracket-view.js";
import { confirmAction } from "./confirm.js";
import { errorText, session } from "./context.js";
import { goToPage } from "./navigation.js";
import { openRoom } from "./room.js";

const EVIDENCE_BUCKET = "room-evidence";
const COALESCE_MS = 400;
const LIST_LIMIT = 20;
const DETAIL_LIMIT = 100; // a detail must find its tournament even past the first page
const BUSY_TEXT = "Working… try again in a moment.";
const HOSTS_KEY = "rib:hosts";

const STATUS = {
  open: ["Open", "chip--match"], full: ["Starting", "chip--match"], active: ["In progress", "chip--match"],
  payout_pending: ["Appeal window", "chip--settle"], disputed: ["Appeal in review", "chip--escrow"],
  finished: ["Finished", ""], cancelled: ["Cancelled", ""],
};
const CHECK = {
  verified: ["Verified", "chip--good"], contradicts: ["Doesn't match", "chip--escrow"], unreadable: ["Couldn't read it", ""],
  duplicate: ["Used in another match", "chip--escrow"], skipped: ["Not checked", ""], pending: ["Checking…", ""],
};

const host = {
  list: null, info: null, id: null, fresh: false, request: 0, channel: null, channelKey: "", pending: 0,
  busy: false, bracket: null, drafts: {}, deferred: false,
};

function pageShown() {
  const page = $("page-hosting");
  return !!page && !page.hidden;
}

function rememberHosting() {
  try { window.localStorage.setItem(HOSTS_KEY, "1"); } catch (e) { /* storage blocked */ }
}

function current() {
  return host.id && host.list ? host.list.find(function (t) { return t.id === host.id; }) || null : null;
}

function isLive(t) { return t.status !== "finished" && t.status !== "cancelled"; }

/** The console page's own URL: share links point back at it. */
function consoleUrl() { return location.origin + location.pathname; }

/* ---- badge: matches waiting for me ---------------------------------------- */
function setBadge(list) {
  const n = (list || []).filter(isLive).reduce(function (sum, t) { return sum + t.rooms.length; }, 0);
  document.querySelectorAll("[data-host-badge]").forEach(function (el) {
    el.textContent = String(n);
    el.hidden = n === 0;
    el.setAttribute("aria-label", n + (n === 1 ? " match needs you as host" : " matches need you as host"));
  });
}

/** Re-read my hosted tournaments just for the Hosting badge. */
export function refreshHostBadge() {
  if (!session.client) return Promise.resolve();
  return Promise.resolve(session.client.rpc("rib_host_dashboard", { p_limit: LIST_LIMIT })).then(function (r) {
    if (r && !r.error) setBadge(normalizeDashboard(r.data));
  }).catch(function () { /* keep the badge */ });
}

/* ---- realtime -------------------------------------------------------------- */
function unsubscribe() {
  if (host.channel) { try { session.client.removeChannel(host.channel); } catch (e) { /* already gone */ } }
  host.channel = null;
  host.channelKey = "";
  clearTimeout(host.pending);
}

function scheduleReload() {
  clearTimeout(host.pending);
  host.pending = setTimeout(function () { if (pageShown()) fetchAll(false); }, COALESCE_MS);
}

function subscribe() {
  const key = host.id || "list";
  if (host.channelKey === key || !session.client.channel) return;
  unsubscribe();
  host.channelKey = key;
  let ch = session.client.channel("hosting-" + key)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "tournaments", filter: "creator_id=eq." + session.uid }, scheduleReload);
  if (host.id) {
    ch = ch
      .on("postgres_changes", { event: "*", schema: "public", table: "match_rooms", filter: "tournament_id=eq." + host.id }, scheduleReload)
      .on("postgres_changes", { event: "*", schema: "public", table: "room_evidence" }, function (payload) {
        const row = payload && payload.new;
        const t = current();
        if (row && t && t.rooms.some(function (m) { return m.room_id === row.room_id; })) scheduleReload();
      });
  }
  host.channel = ch.subscribe();
}

/* ---- page ------------------------------------------------------------------ */

/** Page loader for #page-hosting[/<tournament id>[/new]]. */
export function loadHosting(arg) {
  const parts = String(arg || "").split("/");
  const id = parts[0] || null;
  if (id !== host.id) host.drafts = {};
  host.id = id;
  host.fresh = parts[1] === "new";
  if (host.fresh) {
    rememberHosting();
    // Emphasize the link once; a reload shouldn't replay it.
    try { history.replaceState({ page: "page-hosting", arg: id }, "", "#page-hosting/" + encodeURIComponent(id)); } catch (e) { /* ignore */ }
  }
  const root = $("hosting-root");
  if (!root.querySelector(".hcard, .hdetail")) {
    root.innerHTML = '<div class="skel skel--rows" aria-hidden="true"><span class="skel__l"></span><span class="skel__l"></span></div>';
  }
  subscribe();
  return fetchAll(true);
}

/* ---- render now, or once the host is done typing ----------------------------- */
function interacting() {
  const root = $("hosting-root");
  const a = document.activeElement;
  if (a && root.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return true;
  return Array.prototype.some.call(root.querySelectorAll('input[type="file"]'), function (f) { return f.files && f.files.length; });
}

function render(force) {
  if (!force && interacting()) { host.deferred = true; return; }
  host.deferred = false;
  if (host.id) renderDetail();
  else renderList();
}

function flushDeferred() {
  if (host.deferred && pageShown() && !interacting()) render(true);
}

function fetchAll(force) {
  const mine = ++host.request;
  const root = $("hosting-root");
  root.setAttribute("aria-busy", "true");
  const id = host.id;
  return Promise.all([
    session.client.rpc("rib_host_dashboard", { p_limit: id ? DETAIL_LIMIT : LIST_LIMIT }),
    id ? session.client.rpc("rib_tournament_bracket", { p_tournament_id: id }) : Promise.resolve(null),
  ]).then(function (res) {
    if (mine !== host.request) return;
    root.setAttribute("aria-busy", "false");
    const r = res[0];
    if (!r || r.error) {
      if (!host.list) root.innerHTML = '<p class="muted">' + esc(errorText(r && r.error, "Couldn't load your hosted tournaments. Try again in a moment.")) + "</p>";
      return;
    }
    host.list = normalizeDashboard(r.data);
    host.info = normalizeHostInfo(r.data);
    host.bracket = res[1] && !res[1].error ? normalizeBracket(res[1].data) : null;
    if (host.list.length) rememberHosting();
    setBadge(host.list);
    render(force);
  }).catch(function () {
    if (mine !== host.request) return;
    root.setAttribute("aria-busy", "false");
    if (!host.list) root.innerHTML = '<p class="muted">You\'re offline. Your tournaments load when you reconnect.</p>';
  });
}

/* ---- list ------------------------------------------------------------------ */
function statusChip(t) {
  const s = STATUS[t.status] || [t.status, ""];
  return '<span class="chip ' + s[1] + '">' + esc(s[0]) + "</span>";
}

function seatsHtml(t) {
  let html = '<div class="seats" style="--n:' + t.size + '" role="img" aria-label="' + t.entrants + " of " + t.size + ' seats taken">';
  for (let i = 0; i < t.size; i++) html += '<span class="seat' + (i < t.entrants ? " is-taken" : "") + '"></span>';
  return html + "</div>";
}

function listCard(t) {
  const need = isLive(t) ? t.rooms.length : 0;
  return '<article class="tcard hcard' + (need ? " is-action" : "") + '" data-host="' + esc(t.id) + '">' +
    '<div class="tcard__top"><div><p class="tcard__eyebrow">' + statusChip(t) +
      (t.visibility === "private" ? ' <span class="chip">Private</span>' : "") +
      (need ? ' <span class="chip chip--match is-live">' + need + (need === 1 ? " match needs you" : " matches need you") + "</span>" : "") +
      (t.openAppeals ? ' <span class="chip chip--escrow">' + t.openAppeals + (t.openAppeals === 1 ? " appeal" : " appeals") + "</span>" : "") + "</p>" +
      '<h2 class="tcard__name">' + esc(t.name) + "</h2></div>" +
      '<div class="tcard__pool"><span class="k">entry</span><span class="v' + (t.feeCents ? "" : " is-free") + '">' + (t.feeCents ? formatRcoin(t.feeCents) : "Free") + "</span></div></div>" +
    seatsHtml(t) +
    '<div class="tcard__mid"><span>' + t.entrants + "/" + t.size + " players</span>" +
      (t.feeCents ? '<span class="tcard__prize">Your commission ' + formatRcoin(hostedSplit(t.feeCents, t.entrants).host) + "</span>" : '<span class="tcard__free">Free</span>') + "</div>" +
    '<div class="tcard__act"><button type="button" class="btn btn--sm' + (need ? " btn--cta" : "") + '" data-open="' + esc(t.id) + '">' + (need ? "Manage matches" : "Manage") + "</button>" +
      (t.status === "open" && t.inviteCode ? '<button type="button" class="btn btn--sm" data-copy-link="' + esc(t.inviteCode) + '">Copy link</button>' : "") +
    "</div></article>";
}

function renderList() {
  const root = $("hosting-root");
  $("hosting-title").textContent = "Hosting.";
  const list = host.list || [];
  const info = host.info;
  const note = info && info.strikes
    ? '<p class="msg msg--err host-note">' + (info.paidAllowed ? "You have " + info.strikes + (info.strikes === 1 ? " strike" : " strikes") + " as a host. At 3, you can only host free tournaments." : "After 3 strikes you can host free tournaments only.") + "</p>"
    : "";
  if (!list.length) {
    root.innerHTML = note + '<div class="empty">' + peakArt("settle") + "<h3>You're not hosting anything yet</h3>" +
      "<p>Create a Wild Rift bracket, share the link, post each match's lobby and pick the winners. You earn a " + HOST_FEE_PERCENT + "% host commission on paid tournaments.</p>" +
      '<p><button type="button" class="btn btn--cta btn--sm" data-host-new>Host a tournament</button></p></div>';
    return;
  }
  root.innerHTML = note + '<div class="tgrid">' + list.map(listCard).join("") + "</div>";
}

/* ---- detail ---------------------------------------------------------------- */
function shareBlock(t) {
  if (!(t.status === "open" || t.status === "full") || !t.inviteCode) return "";
  const url = shareUrl(consoleUrl(), t.inviteCode);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  return '<section class="share' + (host.fresh ? " is-fresh" : "") + '" id="host-share" aria-labelledby="host-share-h">' +
    '<h2 class="share__h" id="host-share-h">' + (host.fresh ? "Your tournament is ready. Share the link." : "Share link") + "</h2>" +
    '<p class="share__url"><code id="host-share-url">' + esc(url) + "</code></p>" +
    '<p class="share__code">Code <strong>' + esc(formatInviteCode(t.inviteCode)) + "</strong></p>" +
    '<div class="room-actions">' +
      '<button type="button" class="btn btn--cta btn--sm" data-copy-link="' + esc(t.inviteCode) + '">Copy link</button>' +
      (canShare ? '<button type="button" class="btn btn--sm" data-share-link="' + esc(t.inviteCode) + '">Share</button>' : "") +
      '<button type="button" class="btn btn--sm" data-rotate>New link</button></div>' +
    '<p class="field__hint">' + (t.visibility === "private"
      ? "Private: only players with this link or code can find it."
      : "Public: it's also listed under Hosted on Play.") + " A new link stops the old one from working.</p></section>";
}

function breakdown(t) {
  if (!t.feeCents) return '<dl class="tprize"><div><dt>Prize</dt><dd>Free tournament, no prize</dd></div></dl>';
  const now = hostedSplit(t.feeCents, t.entrants);
  const full = hostedSplit(t.feeCents, t.size);
  return '<dl class="tprize">' +
    "<div><dt>Prize pool now</dt><dd>" + formatRcoin(now.pool) + "</dd></div>" +
    "<div><dt>Winner now (85%)</dt><dd>" + formatRcoin(now.winner) + "</dd></div>" +
    "<div><dt>Your commission now</dt><dd>" + formatRcoin(now.host) + "</dd></div>" +
    "<div><dt>Winner if full</dt><dd>" + formatRcoin(full.winner) + "</dd></div></dl>";
}

function fillBlock(t) {
  if (t.status !== "open" && t.status !== "full") return "";
  const canStart = t.entrants >= MIN_ENTRANTS;
  const plan = t.entrants && t.entrants < t.size && canStart
    ? "Starting now makes a " + bracketSizeFor(t.entrants) + "-player bracket" + (byesFor(t.entrants) ? "; the top " + byesFor(t.entrants) + (byesFor(t.entrants) === 1 ? " seed gets a bye" : " seeds get byes") : "") + "."
    : canStart ? "" : "You can start early once " + MIN_ENTRANTS + " players have joined.";
  return '<section class="hfill">' + seatsHtml(t) +
    '<p class="hfill__n"><strong>' + t.entrants + "</strong> of " + t.size + " players joined. It starts by itself when it fills.</p>" +
    breakdown(t) +
    (t.status === "open"
      ? '<div class="room-actions">' +
        '<button type="button" class="btn btn--cta btn--sm" data-start' + (canStart ? "" : " disabled") + ">Start now</button>" +
        '<button type="button" class="btn btn--sm btn--danger" data-cancel>Cancel tournament</button></div>' +
        (plan ? '<p class="field__hint">' + esc(plan) + "</p>" : "")
      : '<p class="field__hint">It\'s full and the bracket is being drawn.</p>') + "</section>";
}

function payoutBlock(t) {
  const share = t.feeCents ? hostedSplit(t.feeCents, t.entrants) : null;
  if (t.status === "payout_pending") {
    const left = formatCountdown(t.payoutAt);
    return '<section class="room-state hpay" data-tone="won"><h2>Final decided</h2><p>' +
      (t.winnerUsername ? "@" + esc(t.winnerUsername) + " won. " : "") +
      (left ? "Prizes and your commission are paid in " + esc(left) + ", when the appeal window closes." : "The appeal window has closed; prizes are being paid.") +
      (share ? " Your commission: " + formatRcoin(share.host) + "." : "") + "</p></section>";
  }
  if (t.status === "disputed") {
    return '<section class="room-state hpay" data-tone="review"><h2>Appeal in review</h2><p>' +
      (t.openAppeals ? t.openAppeals + (t.openAppeals === 1 ? " entrant appealed" : " entrants appealed") : "An entrant appealed") +
      " the result. Payouts, including your commission, are on hold until the Runinback team decides. If your decision is overturned, your commission goes to the new winner and you get a strike.</p></section>";
  }
  if (t.status === "finished") {
    return '<section class="room-state hpay" data-tone="lost"><h2>Finished</h2><p>' + (t.winnerUsername ? "@" + esc(t.winnerUsername) + " won. " : "") +
      (share ? "Prizes were paid." : "") + "</p></section>";
  }
  if (t.status === "cancelled") return '<section class="room-state hpay" data-tone="void"><h2>Cancelled</h2><p>Every entry fee was refunded.</p></section>';
  return "";
}

function pname(m, uid) {
  if (!uid) return "—";
  return "@" + (uid === m.player_a ? m.a_username || "player A" : m.b_username || "player B");
}

function reportLine(m, uid, report) {
  return "<li>" + esc(pname(m, uid)) + (report ? " says <strong>" + esc(pname(m, report)) + "</strong> won" : " hasn't reported") + "</li>";
}

function evidenceHtml(m) {
  if (!m.evidence.length) return '<p class="muted hcase__none">No end screens yet.</p>';
  return '<ul class="room-evidence__list hcase__ev">' + m.evidence.map(function (e) {
    const c = CHECK[e.check_status] || ["", ""];
    return '<li><a data-ev-path="' + esc(e.storage_path) + '" target="_blank" rel="noopener"><img alt="End screen from ' + esc(pname(m, e.user_id)) + '" /></a>' +
      "<span>" + esc(pname(m, e.user_id)) + "</span>" + (c[0] ? '<span class="chip ' + c[1] + '">' + c[0] + "</span>" : "") + "</li>";
  }).join("") + "</ul>";
}

function lobbyForm(m, update) {
  const d = host.drafts[m.room_id] || {};
  const id = esc(m.room_id);
  return '<form class="hlobby" data-lobby-form="' + id + '" novalidate>' +
    '<div class="field--row">' +
      '<div class="field"><label for="lobby-code-' + id + '">Lobby code</label><input id="lobby-code-' + id + '" name="code" type="text" maxlength="' + LOBBY_CODE_MAX + '" autocomplete="off" spellcheck="false" value="' + esc(d.code || (update ? m.lobby_code || "" : "")) + '" /></div>' +
      '<div class="field"><label for="lobby-pass-' + id + '">Password (optional)</label><input id="lobby-pass-' + id + '" name="password" type="text" maxlength="' + LOBBY_PASSWORD_MAX + '" autocomplete="off" spellcheck="false" value="' + esc(d.password || (update ? m.lobby_password || "" : "")) + '" /></div>' +
    "</div>" +
    '<div class="field"><label for="lobby-img-' + id + '">Lobby screenshot (optional)</label>' +
      '<input id="lobby-img-' + id + '" name="image" type="file" accept="image/png,image/jpeg,image/webp" aria-describedby="lobby-img-h-' + id + '" />' +
      '<p class="field__hint" id="lobby-img-h-' + id + '">PNG, JPEG or WebP, up to 5 MB. Only the two players and the Runinback team can see it.</p></div>' +
    '<div class="room-actions"><button type="submit" class="btn ' + (update ? "btn--sm" : "btn--cta btn--sm") + '">' + (update ? "Update lobby" : "Post lobby") + "</button></div></form>";
}

function noShow(m) {
  const id = esc(m.room_id);
  return '<details class="hcase__more"><summary>Someone didn\'t show up?</summary>' +
    '<div class="room-actions">' +
      '<button type="button" class="btn btn--sm" data-walkover="' + esc(m.player_a) + '">Walkover to ' + esc(pname(m, m.player_a)) + "</button>" +
      '<button type="button" class="btn btn--sm" data-walkover="' + esc(m.player_b) + '">Walkover to ' + esc(pname(m, m.player_b)) + "</button>" +
      '<button type="button" class="btn btn--sm btn--danger" data-void-room>Void: neither showed</button></div>' +
    '<p class="field__hint">Allowed 10 minutes after the match opened, with a note saying what happened. A walkover counts a no-show for the other player; voiding puts both out.</p>' +
    '<input type="hidden" data-room-id="' + id + '" /></details>';
}

function caseHtml(m, rounds) {
  const setup = m.status === "setup";
  const id = esc(m.room_id);
  const d = host.drafts[m.room_id] || {};
  const since = m.started_at ? " · live since " + new Date(m.started_at).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" }) : "";
  return '<article class="hcase' + (m.review_flag ? " is-flagged" : "") + '" data-hroom="' + id + '">' +
    '<header class="hcase__head"><div><h3>' + esc(roundLabel(m.round, rounds)) + ": " + esc(pname(m, m.player_a)) + " vs " + esc(pname(m, m.player_b)) + "</h3>" +
      '<p class="row__meta">' + (m.room_code ? esc(m.room_code) : "") + since + "</p></div>" +
      '<span class="chip ' + (setup ? "chip--match is-live" : "chip--settle") + '">' + (setup ? "Post the lobby" : "Pick the winner") + "</span></header>" +
    (m.review_flag ? '<p class="hcase__flag">This match has been live for over an hour. Decide it now; the Runinback team has been alerted.</p>' : "") +
    '<p class="hcase__ids">Riot IDs: ' + esc(pname(m, m.player_a)) + " <code>" + esc(m.a_riot_id || "—") + "</code> · " + esc(pname(m, m.player_b)) + " <code>" + esc(m.b_riot_id || "—") + "</code></p>" +
    (setup
      ? '<p class="muted">Create the Wild Rift custom game, invite both Riot IDs, then post the lobby here. Posting it starts the match.</p>' + lobbyForm(m, false)
      : '<ul class="hcase__reports">' + reportLine(m, m.player_a, m.a_report) + reportLine(m, m.player_b, m.b_report) + "</ul>" +
        evidenceHtml(m) +
        '<div class="field"><label for="note-' + id + '">Note for the players (required for a walkover or void)</label><input id="note-' + id + '" data-note type="text" maxlength="' + HOST_NOTE_MAX + '" value="' + esc(d.note || "") + '" placeholder="What decided it" /></div>' +
        '<div class="room-actions hcase__pick">' +
          '<button type="button" class="btn btn--cta btn--sm" data-winner="' + esc(m.player_a) + '">' + esc(pname(m, m.player_a)) + " won</button>" +
          '<button type="button" class="btn btn--cta btn--sm" data-winner="' + esc(m.player_b) + '">' + esc(pname(m, m.player_b)) + " won</button></div>" +
        '<details class="hcase__more"><summary>Lobby changed?</summary>' + lobbyForm(m, true) + "</details>") +
    (setup ? '<div class="field"><label for="note-' + id + '">Note for the players (required for a walkover or void)</label><input id="note-' + id + '" data-note type="text" maxlength="' + HOST_NOTE_MAX + '" value="' + esc(d.note || "") + '" /></div>' : "") +
    noShow(m) +
    '<div class="room-actions"><button type="button" class="btn btn--sm" data-room="' + id + '">Open chat</button></div>' +
    '<p class="msg" data-case-msg hidden></p></article>';
}

function renderDetail() {
  const root = $("hosting-root");
  const t = current();
  if (!t) {
    $("hosting-title").textContent = "Hosting.";
    root.innerHTML = '<div class="empty">' + peakArt("settle") + "<h3>Tournament not found</h3><p>It isn't one of the tournaments you host.</p>" +
      '<p><button type="button" class="btn btn--sm" data-host-back>All hosted tournaments</button></p></div>';
    return;
  }
  // Keep what the host typed and which panels are open across refreshes.
  saveDrafts();
  const open = Array.prototype.map.call(root.querySelectorAll("[data-hroom] details[open]"), function (d) {
    const card = d.closest("[data-hroom]");
    return card.getAttribute("data-hroom") + ":" + Array.prototype.indexOf.call(card.querySelectorAll("details"), d);
  });
  const focused = document.activeElement && document.activeElement.id;
  $("hosting-title").textContent = t.name + ".";
  const b = host.bracket;
  const rounds = (b && b.rounds) || roundsFor((b && b.size) || t.size) || 1;
  const cases = isLive(t) ? t.rooms : [];
  root.innerHTML = '<div class="hdetail">' +
    '<p><button type="button" class="linkbtn" data-host-back>All hosted tournaments</button></p>' +
    '<p class="room-context">' + statusChip(t) + (t.visibility === "private" ? ' <span class="chip">Private</span>' : ' <span class="chip">Public</span>') +
      " · " + (t.feeCents ? formatRcoin(t.feeCents) + " entry" : "free") + " · " + t.size + " players · created " + esc(formatDate(t.createdAt)) + "</p>" +
    shareBlock(t) +
    '<p class="msg" id="hosting-msg" hidden></p>' +
    (cases.length ? '<section class="sec hqueue" aria-labelledby="hqueue-h"><div class="sec__head"><h2 id="hqueue-h">Action needed</h2><span class="sec__note">' +
      cases.length + (cases.length === 1 ? " match" : " matches") + "</span></div>" + cases.map(function (m) { return caseHtml(m, rounds); }).join("") + "</section>" : "") +
    (t.status === "active" && !cases.length ? '<p class="muted hqueue__clear">No match needs you right now. New ones show up here as soon as both players are known.</p>' : "") +
    (t.openAppeals && t.status !== "disputed" ? '<p class="msg msg--err">' + t.openAppeals + (t.openAppeals === 1 ? " open appeal" : " open appeals") + " on this tournament.</p>" : "") +
    payoutBlock(t) +
    fillBlock(t) +
    (b ? '<section class="sec"><div class="sec__head"><h2>Bracket</h2></div><div class="bracket" id="host-bracket"></div></section>' : "") +
    (t.rules ? '<details class="join-rules"><summary>Your rules</summary><p>' + esc(t.rules) + "</p></details>" : "") +
    "</div>";
  open.forEach(function (key) {
    const cut = key.lastIndexOf(":");
    const card = root.querySelector('[data-hroom="' + key.slice(0, cut).replace(/"/g, "") + '"]');
    const d = card && card.querySelectorAll("details")[parseInt(key.slice(cut + 1), 10)];
    if (d) d.open = true;
  });
  if (focused && $(focused)) $(focused).focus();
  if (b) {
    renderBracket($("host-bracket"), b.rows, {
      size: b.size || t.size, rounds: rounds, uid: null,
      champPrize: function () { return t.feeCents ? hostedSplit(t.feeCents, t.entrants).winner : null; },
      action: function (m) {
        return m.status === "setup" || m.status === "live" ? '<button type="button" class="btn btn--sm" data-room="' + esc(m.room_id) + '">Open chat</button>' : "";
      },
    });
  }
  if (host.fresh) {
    const share = $("host-share");
    if (share) { replayClass(share, "is-landed"); announce("Your tournament is ready. Share the link so players can join."); }
    host.fresh = false;
  }
  loadEvidenceThumbs();
}

function saveDrafts() {
  document.querySelectorAll("#hosting-root [data-hroom]").forEach(function (card) {
    const id = card.getAttribute("data-hroom");
    const form = card.querySelector("[data-lobby-form]");
    const note = card.querySelector("[data-note]");
    host.drafts[id] = {
      code: form ? form.elements.code.value : "",
      password: form ? form.elements.password.value : "",
      note: note ? note.value : "",
    };
  });
}

function loadEvidenceThumbs() {
  const links = document.querySelectorAll("#hosting-root [data-ev-path]");
  if (!links.length || !session.client.storage) return;
  const paths = Array.prototype.map.call(links, function (a) { return a.getAttribute("data-ev-path"); });
  Promise.resolve(session.client.storage.from(EVIDENCE_BUCKET).createSignedUrls(paths, 600)).then(function (r) {
    (Array.isArray(r && r.data) ? r.data : []).forEach(function (item, i) {
      if (!item || !item.signedUrl || !links[i]) return;
      links[i].href = item.signedUrl;
      links[i].querySelector("img").src = item.signedUrl;
    });
  }).catch(function () { /* thumbnails are optional */ });
}

/* ---- actions ----------------------------------------------------------------- */
function flash(text, ok) { showMessage($("hosting-msg"), text, ok); }

function caseFlash(card, text, ok) {
  const out = card && card.querySelector("[data-case-msg]");
  if (out) showMessage(out, text, ok);
  else flash(text, ok);
}

function rpc(fn, args, btn, onErr) {
  if (host.busy) { (onErr || flash)(BUSY_TEXT, true); return Promise.resolve(null); }
  host.busy = true;
  if (btn) btn.disabled = true;
  return Promise.resolve(session.client.rpc(fn, args)).then(function (r) {
    if (r.error) { (onErr || flash)(errorText(r.error, "Couldn't complete the action."), false); return null; }
    return r;
  }).catch(function () {
    (onErr || flash)("Network error. Check your connection and try again.", false);
    return null;
  }).finally(function () {
    host.busy = false;
    if (btn && btn.isConnected) btn.disabled = false;
  });
}

function copyLink(code, btn) {
  const url = shareUrl(consoleUrl(), code);
  const done = function () {
    const label = btn.textContent;
    btn.textContent = "Copied";
    btn.classList.add("is-done");
    replayClass(btn, "is-copied");
    const share = btn.closest(".share");
    if (share) replayClass(share, "is-copied");
    announce("Link copied.");
    setTimeout(function () { if (btn.isConnected) { btn.textContent = label; btn.classList.remove("is-done"); } }, 1600);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(done, function () { toast("Couldn't copy. Select the link and copy it.", "err"); });
  } else {
    toast("Couldn't copy. Select the link and copy it.", "err");
  }
}

function shareLink(code) {
  const t = current();
  const url = shareUrl(consoleUrl(), code);
  navigator.share({ title: t ? t.name : "Runinback tournament", text: "Join my Wild Rift tournament on Runinback.", url: url })
    .catch(function () { /* the host closed the share sheet */ });
}

function rotate(btn) {
  const t = current();
  confirmAction({
    title: "Make a new link?",
    body: "The current link and code stop working. Players who already joined stay in.",
    ok: "New link",
  }).then(function (ok) {
    if (!ok) return;
    rpc("rib_host_rotate_invite", { p_tournament_id: t.id }, btn).then(function (r) {
      if (!r) return;
      const code = Array.isArray(r.data) ? r.data[0] : r.data;
      if (typeof code === "string" && code) t.inviteCode = code;
      renderDetail();
      const share = $("host-share");
      if (share) replayClass(share, "is-landed");
      flash("New link ready. The old one no longer works.", true);
      fetchAll(true);
    });
  });
}

function start(btn) {
  const t = current();
  const size = bracketSizeFor(t.entrants);
  const byes = byesFor(t.entrants);
  confirmAction({
    title: "Start with " + t.entrants + " players?",
    body: "Registration closes and the bracket is drawn for " + size + " players" + (byes ? "; the top " + byes + (byes === 1 ? " seed gets a bye" : " seeds get byes") : "") +
      ". The prize pool is the entry fees of the players who joined.",
    ok: "Start now",
  }).then(function (ok) {
    if (!ok) return;
    rpc("rib_host_start", { p_tournament_id: t.id }, btn).then(function (r) {
      if (!r) return;
      toast(t.name + " started. Post the lobby for each first-round match.", "ok");
      fetchAll(true);
    });
  });
}

function cancel(btn) {
  const t = current();
  confirmAction({
    title: "Cancel " + t.name + "?",
    body: "Every entry fee is refunded and the link stops working. This can't be undone.",
    ok: "Cancel tournament",
    danger: true,
  }).then(function (ok) {
    if (!ok) return;
    rpc("rib_host_cancel", { p_tournament_id: t.id }, btn).then(function (r) {
      if (!r) return;
      toast(t.name + " was cancelled. Every entry fee was refunded.", "ok");
      fetchAll(true);
    });
  });
}

function uuid() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
  const b = new Uint8Array(16);
  window.crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.prototype.map.call(b, function (x) { return x.toString(16).padStart(2, "0"); }).join("");
  return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
}

function postLobby(form) {
  const roomId = form.getAttribute("data-lobby-form");
  const card = form.closest("[data-hroom]");
  const say = function (text, ok) { caseFlash(card, text, ok); };
  const code = (form.elements.code.value || "").trim();
  const password = (form.elements.password.value || "").trim();
  const file = form.elements.image.files && form.elements.image.files[0];
  if (!code && !file) { say("Add the lobby code or a screenshot of the lobby.", false); form.elements.code.focus(); return; }
  let ext = null;
  if (file) {
    const check = validateLobbyImage(file);
    if (check.error) { say(check.error, false); form.elements.image.focus(); return; }
    ext = check.ext;
  }
  const btn = form.querySelector('[type="submit"]');
  if (host.busy) { say(BUSY_TEXT, true); return; }
  btn.disabled = true;
  let path = null;
  const upload = file
    ? Promise.resolve(session.client.storage.from(LOBBY_BUCKET).upload(lobbyImagePath(roomId, uuid(), ext), file, { contentType: file.type, upsert: false }))
      .then(function (up) {
        if (up.error) throw { message: "upload", friendly: "Couldn't upload the screenshot. Try again, or post the code only." };
        path = (up.data && up.data.path) || null;
        return path;
      })
    : Promise.resolve(null);
  say(file ? "Uploading the lobby screenshot…" : "Posting the lobby…", true);
  upload.then(function (imagePath) {
    btn.disabled = false;
    return rpc("rib_host_room_lobby", { p_room_id: roomId, p_lobby_code: code || null, p_lobby_password: password || null, p_image_path: imagePath }, btn, say);
  }).then(function (r) {
    if (!r) {
      // The lobby wasn't posted: don't leave an orphan screenshot behind.
      if (path) Promise.resolve(session.client.storage.from(LOBBY_BUCKET).remove([path])).catch(function () {});
      return;
    }
    delete host.drafts[roomId];
    toast("Lobby posted. The match is on: both players see it in their room.", "ok");
    fetchAll(true);
  }).catch(function (err) {
    btn.disabled = false;
    say((err && err.friendly) || "Couldn't post the lobby. Try again.", false);
  });
}

function decide(card, winner, walkover, btn) {
  const roomId = card.getAttribute("data-hroom");
  const t = current();
  const m = t && t.rooms.find(function (x) { return x.room_id === roomId; });
  if (!m) return;
  const input = card.querySelector("[data-note]");
  const note = ((input || {}).value || "").trim();
  if (walkover && note.length < HOST_NOTE_MIN) {
    caseFlash(card, "Add a note (at least " + HOST_NOTE_MIN + " characters) saying who didn't show up.", false);
    if (input) input.focus();
    return;
  }
  const name = pname(m, winner);
  confirmAction({
    title: (walkover ? "Walkover to " : "Decide: ") + name + (walkover ? "?" : " won?"),
    body: walkover
      ? "The other player didn't show up: " + name + " advances and the no-show is counted. Players can appeal after the final."
      : name + " advances and the other player is out. Players can appeal your decision after the final, so decide on the end screens and the chat.",
    ok: walkover ? "Give the walkover" : name + " won",
  }).then(function (ok) {
    if (!ok) return;
    rpc("rib_host_decide", { p_room_id: roomId, p_winner_id: winner, p_walkover: !!walkover, p_note: note || null }, btn, function (text, good) { caseFlash(card, text, good); })
      .then(function (r) {
        if (!r) return;
        delete host.drafts[roomId];
        card.classList.add("is-decided");
        toast(name + " advances.", "ok");
        announce(name + " advances.");
        fetchAll(true);
      });
  });
}

function voidRoom(card, btn) {
  const roomId = card.getAttribute("data-hroom");
  const input = card.querySelector("[data-note]");
  const note = ((input || {}).value || "").trim();
  if (note.length < HOST_NOTE_MIN) { caseFlash(card, "Add a note (at least " + HOST_NOTE_MIN + " characters) saying what happened before voiding the match.", false); if (input) input.focus(); return; }
  confirmAction({ title: "Void this match?", body: "Neither player showed up: both are out and each gets a no-show.", ok: "Void match", danger: true }).then(function (ok) {
    if (!ok) return;
    rpc("rib_host_void_room", { p_room_id: roomId, p_note: note }, btn, function (text, good) { caseFlash(card, text, good); }).then(function (r) {
      if (!r) return;
      delete host.drafts[roomId];
      toast("Match voided.", "ok");
      fetchAll(true);
    });
  });
}

export function initHosting() {
  const root = $("hosting-root");
  root.addEventListener("click", function (e) {
    const b = e.target.closest("button");
    if (!b || b.disabled) return;
    const card = b.closest("[data-hroom]");
    if (b.hasAttribute("data-open")) { goToPage("page-hosting", { arg: b.getAttribute("data-open") }); return; }
    if (b.hasAttribute("data-host-back")) { goToPage("page-hosting"); return; }
    if (b.hasAttribute("data-host-new")) { goToPage("page-compete", { arg: "new" }); return; }
    if (b.hasAttribute("data-copy-link")) { copyLink(b.getAttribute("data-copy-link"), b); return; }
    if (b.hasAttribute("data-share-link")) { shareLink(b.getAttribute("data-share-link")); return; }
    if (b.hasAttribute("data-rotate")) { rotate(b); return; }
    if (b.hasAttribute("data-start")) { start(b); return; }
    if (b.hasAttribute("data-cancel")) { cancel(b); return; }
    if (b.hasAttribute("data-room")) { saveDrafts(); openRoom(b.getAttribute("data-room")); return; }
    if (card && b.hasAttribute("data-winner")) { decide(card, b.getAttribute("data-winner"), false, b); return; }
    if (card && b.hasAttribute("data-walkover")) { decide(card, b.getAttribute("data-walkover"), true, b); return; }
    if (card && b.hasAttribute("data-void-room")) voidRoom(card, b);
  });
  // A refresh that waited for the host to finish lands once they're done.
  root.addEventListener("focusout", function () { setTimeout(flushDeferred, 0); });
  root.addEventListener("change", function () { setTimeout(flushDeferred, 0); });
  root.addEventListener("submit", function (e) {
    const form = e.target.closest("[data-lobby-form]");
    if (!form) return;
    e.preventDefault();
    postLobby(form);
  });
  const create = $("hosting-new");
  if (create) create.addEventListener("click", function () { goToPage("page-compete", { arg: "new" }); });
  document.addEventListener("rib:page", function (e) { if (e.detail !== "page-hosting") unsubscribe(); });
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible" && pageShown()) fetchAll(false); });
}
