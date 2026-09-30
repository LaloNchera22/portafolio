/* ============================================================================
 * Runinback — Play: Wild Rift sit & go brackets of 4 or 8 players.
 *
 * Quick Play is the front door: a grid of tiers (entry fee × size) with how
 * many players are waiting in each. One tap joins the oldest open event of
 * that tier (rib_quick_join); the server creates one when none is free. While
 * the event fills, a waiting card shows the seats and offers Leave (full
 * refund); when it fills, the live watcher sees the first room and the player
 * goes straight into it.
 *
 * Secondary: My tournaments (progress and brackets) and Hosted (public
 * hosted tournaments to browse, an invite-code box, and "Host a tournament":
 * rib_hosted_create, then the Hosting page with the share link). Game and
 * network are fixed: Wild Rift, Riot ID. Seeding, advancement and payouts
 * happen in the database; Quick Play prizes are 90% of the pool, split
 * 70/30; hosted ones 85% winner, 5% host commission, 10% platform.
 *
 * What blocks a join is solved in place: no Riot ID links it and comes back
 * to the same tier, a short balance offers exactly the missing rcoin.
 *
 * Reads are cheap on purpose: counts refresh on page show and every 20 s only
 * while Play is on screen and the tab is visible; a value younger than 15 s is
 * reused instead of refetched.
 * ========================================================================== */
import { byId as $, escapeHtml as esc, setVisible, showMessage } from "../lib/dom.js";
import { toast } from "../lib/errors.js";
import { formatRcoin } from "../lib/format.js";
import { announce } from "../lib/announce.js";
import { prefersReducedMotion, tweenNumber } from "../lib/motion.js";
import { prizeSplit, roundName } from "../lib/tournament.js";
import { QUICK_FEES, QUICK_TIERS, RIOT_NETWORK, WILD_RIFT, findTier, playReturn, tierKey } from "../lib/wild-rift.js";
import {
  HOST_FEE_PERCENT, RULES_MAX, hostedSplit, normalizeBracket, normalizeHostInfo, parseEntryFee, parseInviteInput, validateHostedForm,
} from "../lib/hosted.js";
import { renderBracket } from "./bracket-view.js";
import { confirmAction } from "./confirm.js";
import { errorText, session } from "./context.js";
import { clearRouteArg, currentRouteArg, goToPage, selectedChipAmount } from "./navigation.js";
import { loadGameAccounts } from "./profile.js";
import { peakArt } from "./art.js";
import { openRoom } from "./room.js";
import { skelCards, skelRows } from "./skeleton.js";
import { refreshWallet } from "./wallet.js";

const POLL_MS = 20000;
const FRESH_MS = 15000;
const COALESCE_MS = 300;
const READY_MINUTES = 5; // rib_ready_window()

const play = {
  tiers: null, tiersAt: 0, tiersRequest: 0,   // rib_quick_tiers by tier key
  mine: null, mineAt: 0, mineRequest: 0,      // rib_my_tournaments
  waiting: [],                                 // my events still filling
  joining: false, timer: 0, channel: null, watched: "", pending: 0,
  started: {},                                 // events joined here: open their first room
  seats: {}, size: null, lobbyRequest: 0,
  tierSeen: {},                                // waiting count last drawn per tier (seat fill animation)
  joiningKey: null, fresh: null,               // the tier being joined; the event just joined (entrance)
};
const openBrackets = {}; // tournament id -> bracket expanded

function feeText(cents) { return cents ? formatRcoin(cents) : "Free"; }

function prizeLine(feeCents, size, hosted) {
  if (!feeCents) return '<span class="tcard__free">Free · no prize</span>';
  if (hosted) return '<span class="tcard__prize">Winner ' + formatRcoin(hostedSplit(feeCents, size).winner) + " when full</span>";
  const s = prizeSplit(feeCents, size);
  return '<span class="tcard__prize">Champion ' + formatRcoin(s.first) + " · runner-up " + formatRcoin(s.second) + "</span>";
}

function isHosted(t) { return !!t && t.mode === "hosted"; }

/** Invite link for a tournament (opens it straight on Play). */
function inviteUrl(id) {
  return location.origin + location.pathname + "#page-compete/t/" + id;
}

function pageShown() {
  const page = $("page-compete");
  return !!page && !page.hidden;
}

function activeSeg() {
  const on = document.querySelector('#compete-seg [aria-pressed="true"]');
  return on ? on.getAttribute("data-seg") : "play";
}

function showSeg(name) {
  const b = document.querySelector('#compete-seg [data-seg="' + name + '"]');
  if (b && b.getAttribute("aria-pressed") !== "true") b.click();
}

// true / false once the accounts are read; null when they couldn't be (the
// server still checks, so an unknown state lets the join through).
function riotLinked() {
  return loadGameAccounts({ cached: true }).then(function (rows) {
    if (!rows) return null;
    return rows.some(function (a) { return a.network === RIOT_NETWORK; });
  }).catch(function () { return null; });
}

/* ---- page ----------------------------------------------------------------- */

/** Page loader for Play: what the route asks for, then the visible tab. */
export function loadTournaments() {
  startPolling();
  const arg = currentRouteArg() || "";
  if (arg.indexOf("q/") === 0 || arg === "new") {
    const target = playReturn(arg);
    clearRouteArg();
    if (target === "new") openForm();
    else if (target) { showSeg("play"); joinTier(findTier(target.split("/").slice(1).join(":"))); }
  }
  loadInvite();
  return refreshSeg(activeSeg());
}

function refreshSeg(which, force) {
  if (which === "custom") return loadLobby();
  if (which === "mine") return loadMine(force);
  return Promise.all([loadTiers(force), loadMine(force)]);
}

function startPolling() {
  if (play.timer) return;
  play.timer = setInterval(function () {
    if (document.visibilityState !== "visible" || !pageShown() || activeSeg() !== "play") return;
    loadTiers(true);
    if (play.waiting.length) loadMine(true);
  }, POLL_MS);
}

function stopPolling() {
  clearInterval(play.timer);
  play.timer = 0;
  watchWaiting([]);
}

/* ---- Quick Play tiers ------------------------------------------------------ */
// The Quick Play tier of one of my events (null for custom events).
function tierOf(t) {
  return t.tier_key || null;
}

function queuedIn(tier) {
  return play.waiting.some(function (t) { return tierOf(t) === tier.key; });
}

// The fee is the headline: the number large, the unit small.
function feeHtml(cents) {
  if (!cents) return "Free";
  const text = formatRcoin(cents);
  return text.replace(/ rcoin$/, "") + "<small> rcoin</small>";
}

// Seats of the next bracket, filled by the players waiting (capped one short
// of full: a full bracket has already started). Decorative; the label says it.
function tierSeats(tier, waiting) {
  const filled = Math.min(Math.max(0, waiting || 0), tier.size - 1);
  const before = play.tierSeen[tier.key];
  play.tierSeen[tier.key] = filled;
  let html = '<span class="tier__seats" aria-hidden="true">';
  for (let i = 0; i < tier.size; i++) {
    const on = i < filled;
    const isNew = on && before !== undefined && i >= before;
    html += '<span class="tseat' + (on ? " is-on" : "") + (isNew ? " is-new" : "") + '"' + (isNew ? ' style="--d:' + (i - before) * 60 + 'ms"' : "") + "></span>";
  }
  return html + "</span>";
}

// Entry fees warm up down the grid: Free is cool, 50 rcoin runs hot (CSS --heat).
function tierHeat(fee) {
  const i = QUICK_FEES.indexOf(fee);
  return i <= 0 ? 0 : i / (QUICK_FEES.length - 1);
}

function tierButton(tier, index) {
  const info = play.tiers && play.tiers[tier.key];
  const queued = queuedIn(tier);
  const waiting = info ? info.waiting : null;
  const split = prizeSplit(tier.fee, tier.size);
  const joiningThis = play.joining && play.joiningKey === tier.key;
  let wait = "";
  if (joiningThis) wait = '<span class="tier__wait is-joining">Joining…</span>';
  else if (queued) wait = '<span class="tier__wait is-in">You\'re in</span>';
  else if (waiting) wait = '<span class="tier__wait is-live">' + waiting + " waiting</span>";
  else if (waiting === 0) wait = '<span class="tier__wait">Start one</span>';
  else if (!play.tiers && !play.tiersFailed) wait ='<span class="tier__wait is-pending" aria-hidden="true"></span>';
  const label = (tier.fee ? formatRcoin(tier.fee) + " entry" : "Free") + ", " + tier.size + " players" +
    (tier.fee ? ", champion wins " + formatRcoin(split.first) : "") +
    (queued ? ", you're in" : waiting ? ", " + waiting + " waiting" : "");
  return '<button type="button" class="tier' + (tier.fee ? "" : " is-free") + (queued ? " is-queued" : "") + (joiningThis ? " is-joining" : "") +
    '" data-tier="' + tier.key + '" style="--heat:' + tierHeat(tier.fee).toFixed(2) + ";--n:" + (index || 0) + '" aria-label="' + esc(label) + '"' + (joiningThis ? ' aria-busy="true"' : "") +
    (play.joining ? " disabled" : "") + ">" +
    '<span class="tier__fee">' + feeHtml(tier.fee) + "</span>" +
    '<span class="tier__size">' + tier.size + " players</span>" +
    '<span class="tier__prize">' + (tier.fee ? "Champion " + formatRcoin(split.first) : "No prize, for fun") + "</span>" +
    tierSeats(tier, waiting) + wait + "</button>";
}

function renderTiers() {
  const box = $("play-tiers");
  if (!box) return;
  const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest("#play-tiers [data-tier]");
  const keep = focused ? focused.getAttribute("data-tier") : null;
  // A fee × size matrix: fees run down, the two sizes across.
  box.innerHTML = '<div class="tiers' + (box.dataset.settled ? "" : " is-first") + '" role="group" aria-label="Pick an entry fee and size">' +
    '<span class="tiers__col" aria-hidden="true">4 players</span><span class="tiers__col" aria-hidden="true">8 players</span>' +
    QUICK_TIERS.map(tierButton).join("") + "</div>";
  if (play.tiers) settle(box);
  box.setAttribute("aria-busy", play.tiers ? "false" : "true");
  if (keep) { const again = box.querySelector('[data-tier="' + keep + '"]'); if (again) again.focus(); }
  const status = $("play-status");
  if (status && play.tiers) {
    const total = Object.keys(play.tiers).reduce(function (sum, k) { return sum + play.tiers[k].waiting; }, 0);
    status.textContent = total ? total + (total === 1 ? " player waiting" : " players waiting") : "Be the first in any tier";
  }
}

function loadTiers(force) {
  renderTiers();
  if (!force && play.tiersAt && Date.now() - play.tiersAt < FRESH_MS) return Promise.resolve();
  const request = ++play.tiersRequest;
  return Promise.resolve(session.client.rpc("rib_quick_tiers")).then(function (r) {
    if (request !== play.tiersRequest) return;
    if (!r || r.error || !Array.isArray(r.data)) {
      if (!play.tiers && $("play-status")) $("play-status").textContent = "Live counts are unavailable right now.";
      if (!play.tiers && !play.tiersFailed) { play.tiersFailed = true; renderTiers(); }
      return;
    }
    const map = {};
    r.data.forEach(function (row) {
      map[tierKey(Number(row.entry_fee_cents), Number(row.size))] = { waiting: Number(row.waiting) || 0, events: Number(row.open_events) || 0 };
    });
    QUICK_TIERS.forEach(function (t) { if (!map[t.key]) map[t.key] = { waiting: 0, events: 0 }; });
    play.tiers = map;
    play.tiersAt = Date.now();
    renderTiers();
  }).catch(function () { /* offline: keep what's on screen */ });
}

function joinTier(tier) {
  if (!tier || play.joining) return Promise.resolve();
  if (queuedIn(tier)) { toast("You're already waiting in this tier. It starts when it fills.", "ok"); return Promise.resolve(); }
  const back = "q/" + tier.fee + "/" + tier.size;
  return riotLinked().then(function (linked) {
    if (linked === false) {
      toast("Link your Riot ID first. You'll come right back to this tier.", "ok");
      goToPage("page-profile", { arg: "link/" + RIOT_NETWORK + "/" + back });
      return;
    }
    if (tier.fee && session.balanceCents != null && tier.fee > session.balanceCents) {
      goToPage("page-wallet", { arg: "buy/" + (tier.fee - session.balanceCents) + "/" + back });
      return;
    }
    if (!tier.fee) return sendJoin(tier, back);
    const split = prizeSplit(tier.fee, tier.size);
    return confirmAction({
      title: "Enter for " + formatRcoin(tier.fee) + "?",
      body: "A " + tier.size + "-player " + WILD_RIFT + " bracket. The champion wins " + formatRcoin(split.first) + ", the runner-up " + formatRcoin(split.second) +
        ". You can leave for a full refund until it fills. When it fills, you have " + READY_MINUTES + " minutes to get ready for your first match.",
      ok: "Pay " + formatRcoin(tier.fee) + " and join",
    }).then(function (ok) { if (ok) return sendJoin(tier, back); });
  });
}

function sendJoin(tier, back) {
  if (play.joining) return Promise.resolve();
  play.joining = true;
  play.joiningKey = tier.key;
  renderTiers();
  return session.client.rpc("rib_quick_join", { p_entry_fee_cents: tier.fee, p_size: tier.size }).then(function (r) {
    if (r.error) {
      const hint = r.error.hint;
      if (hint === "riot_account_required") { goToPage("page-profile", { arg: "link/" + RIOT_NETWORK + "/" + back }); return; }
      toast(errorText(r.error, "Couldn't join. Try again."), "err");
      if (hint === "already_queued") loadMine(true);
      return;
    }
    const t = Array.isArray(r.data) ? r.data[0] : r.data;
    if (t && t.id) {
      play.started[t.id] = true;
      play.fresh = { id: t.id, until: Date.now() + 800 };
      if (t.status === "open") {
        addWaiting(t, tier);
        // The tier grid is long on a phone: bring the new waiting card into view.
        const card = document.querySelector('#play-waiting [data-tid="' + String(t.id).replace(/"/g, "") + '"]');
        if (card && card.scrollIntoView) card.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
      }
    }
    if (t && t.status === "active") toast("It just filled. Your first match is ready.", "match");
    else toast("You're in. It starts the moment the last seat fills.", "ok");
    refreshWallet();
    loadMine(true);
    loadTiers(true);
  }).catch(function () {
    toast("Network error. Check your connection and try again.", "err");
  }).finally(function () {
    play.joining = false;
    play.joiningKey = null;
    renderTiers();
  });
}

// Show the waiting card at once; the next read fills in the exact count.
function addWaiting(t, tier) {
  if (play.waiting.some(function (w) { return w.id === t.id; })) return;
  play.waiting.unshift({
    id: t.id, name: t.name || WILD_RIFT + " " + tier.size, tier_key: tier.key, status: "open",
    entry_fee_cents: tier.fee, size: tier.size, entrants: Math.max(1, Number(t.entrants) || 1),
  });
  renderWaiting();
  renderTiers();
}

/* ---- waiting for the last seat -------------------------------------------- */
function seats(t, big) {
  const fresh = play.seats[t.id];
  play.seats[t.id] = t.entrants;
  let html = '<div class="seats' + (big ? " seats--big" : "") + '" style="--n:' + t.size + '" role="img" aria-label="' + t.entrants + " of " + t.size + ' seats taken">';
  for (let i = 0; i < t.size; i++) {
    const taken = i < t.entrants;
    const isNew = taken && fresh !== undefined && i >= fresh;
    const next = big && i === t.entrants;
    html += '<span class="seat' + (taken ? " is-taken" : "") + (isNew ? " is-new" : "") + (next ? " is-next" : "") + '"' +
      (isNew ? ' style="--d:' + (i - fresh) * 80 + 'ms"' : "") + "></span>";
  }
  if (big && fresh !== undefined && t.entrants > fresh) {
    const need = t.size - t.entrants;
    announce(t.entrants + " of " + t.size + " seats taken" + (need > 0 ? ", " + need + " to go." : "."));
  }
  return html + "</div>";
}

function waitingCard(t) {
  const need = Math.max(0, t.size - t.entrants);
  const fresh = !!play.fresh && play.fresh.id === t.id && Date.now() < play.fresh.until;
  return '<article class="tcard is-waiting' + (fresh ? " is-fresh" : "") + '" data-tid="' + esc(t.id) + '" data-sig="' + esc(waitingSig(t)) + '">' +
    '<div class="tcard__top"><div><p class="tcard__eyebrow"><span class="chip chip--match is-live">Filling</span></p>' +
      '<h3 class="tcard__name">' + esc(t.name) + "</h3></div>" +
      '<div class="tcard__pool"><span class="k">entry</span><span class="v' + (t.entry_fee_cents ? "" : " is-free") + '">' + feeText(t.entry_fee_cents) + "</span></div></div>" +
    seats(t, true) +
    '<div class="tcard__mid"><span>' + t.entrants + "/" + t.size + " players · " + (need === 1 ? '<span class="tcard__last">1 to go</span>' : need + " to go") + "</span>" +
      prizeLine(t.entry_fee_cents, t.size) + "</div>" +
    '<p class="tcard__note">Stay on this page: when the last seat fills, your match room opens by itself and you have ' + READY_MINUTES + " minutes to get ready.</p>" +
    '<div class="tcard__act"><button type="button" class="btn btn--sm" data-invite="' + esc(t.id) + '">Copy invite link</button>' +
      '<button type="button" class="btn btn--sm" data-leave="' + esc(t.id) + '">Leave</button></div></article>';
}

function waitingSig(t) {
  return [t.entrants, t.size, t.name, t.entry_fee_cents].join("|");
}

// Cards that didn't change stay the same nodes: no replayed entrance, and a
// focused Leave or Copy button keeps focus while seats fill around it.
function renderWaiting() {
  const box = $("play-waiting");
  if (!box) return;
  if (!play.waiting.length) { box.innerHTML = ""; return; }
  const grid = box.querySelector(".tgrid");
  const old = grid ? Array.prototype.slice.call(grid.children) : [];
  const sameOrder = old.length === play.waiting.length && old.every(function (el, i) { return el.getAttribute("data-tid") === play.waiting[i].id; });
  if (!sameOrder) {
    box.innerHTML = '<div class="tgrid">' + play.waiting.map(waitingCard).join("") + "</div>";
    return;
  }
  play.waiting.forEach(function (t, i) {
    if (old[i].getAttribute("data-sig") === waitingSig(t)) return;
    const tpl = document.createElement("template");
    tpl.innerHTML = waitingCard(t);
    old[i].replaceWith(tpl.content.firstElementChild);
  });
}

// Seats fill in real time: an update to an event I'm waiting in re-reads my
// list (bursts collapse into one read). Only while Play is on screen.
function watchWaiting(rows) {
  const ids = rows.map(function (t) { return t.id; }).sort().join(",");
  if (ids === play.watched) return;
  if (play.channel) { try { session.client.removeChannel(play.channel); } catch (e) { /* already gone */ } }
  play.channel = null;
  play.watched = ids;
  if (!ids || !session.client.channel) return;
  play.channel = session.client.channel("play-waiting")
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "tournaments", filter: "id=in.(" + ids + ")" }, function () {
      clearTimeout(play.pending);
      play.pending = setTimeout(function () { loadMine(true); }, COALESCE_MS);
    })
    .subscribe();
}

// The event I'm waiting in just started: straight into my first room.
document.addEventListener("rib:live", function (e) {
  const rows = e.detail || [];
  const room = rows.find(function (m) { return m.tournament_id && play.started[m.tournament_id] && m.status === "ready_check"; });
  if (!room) return;
  delete play.started[room.tournament_id];
  play.waiting = play.waiting.filter(function (t) { return t.id !== room.tournament_id; });
  renderWaiting();
  if (pageShown()) openRoom(room.id);
});

/* ---- invite links: #page-compete/t/<id> ----------------------------------- */
function loadInvite() {
  const box = $("tournament-invite");
  if (!box) return;
  const arg = currentRouteArg() || "";
  const id = arg.indexOf("t/") === 0 ? arg.slice(2) : null;
  if (!id) { box.hidden = true; box.innerHTML = ""; return; }
  showSeg("play");
  Promise.all([session.client.rpc("rib_tournament_summary", { p_tournament_id: id }), riotLinked()]).then(function (res) {
    const t = Array.isArray(res[0] && res[0].data) ? res[0].data[0] : null;
    if (!t) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = '<p class="eyebrow">You\'re invited</p>' +
      (t.status === "open" ? card(t, res[1], " is-invite") : '<div class="empty"><h3>' + esc(t.name) + "</h3><p>This tournament has " + (t.status === "active" ? "already started." : "ended.") + "</p></div>");
  }).catch(function () { box.hidden = true; });
}

/* ---- custom tournaments ----------------------------------------------------- */
function cardAction(t, linked) {
  if (t.is_host) return '<span class="chip chip--settle">You host</span><button type="button" class="btn btn--sm" data-manage="' + esc(t.id) + '">Manage</button>';
  if (t.joined && isHosted(t)) {
    return '<span class="chip chip--match">Joined</span><button type="button" class="btn btn--sm" data-event="' + esc(t.id) + '">View</button>' +
      '<button type="button" class="btn btn--sm" data-leave="' + esc(t.id) + '">Leave</button>';
  }
  if (t.joined) {
    return '<span class="chip chip--match">Joined</span>' +
      '<button type="button" class="btn btn--sm" data-invite="' + esc(t.id) + '">Copy invite link</button>' +
      '<button type="button" class="btn btn--sm" data-leave="' + esc(t.id) + '">Leave</button>';
  }
  if (linked === false) {
    return '<button type="button" class="btn btn--sm" data-link="' + esc(t.id) + '">Link Riot ID to join</button>';
  }
  const short = t.entry_fee_cents && session.balanceCents != null && t.entry_fee_cents > session.balanceCents;
  if (short) {
    return '<button type="button" class="btn btn--sm" data-topup="' + (t.entry_fee_cents - session.balanceCents) + '" data-for="' + esc(t.id) + '">Add rcoin to join</button>' +
      '<span class="tcard__note">You need ' + formatRcoin(t.entry_fee_cents) + ", you have " + formatRcoin(session.balanceCents) + ".</span>";
  }
  return '<button type="button" class="btn btn--cta btn--sm" data-join="' + esc(t.id) + '" data-fee="' + esc(t.entry_fee_cents) + '" data-name="' + esc(t.name) + '"' +
    (isHosted(t) ? ' data-hosted="' + esc(t.size) + '"' : "") + ">Join · " + feeText(t.entry_fee_cents) + "</button>";
}

function card(t, linked, extraClass) {
  const need = t.size - t.entrants;
  const needText = need === 1 ? '<span class="tcard__last">1 seat left</span>' : need > 0 ? need + " seats left" : "Full";
  return '<article class="tcard' + (t.joined ? " is-joined" : "") + (need === 1 ? " is-last-seat" : "") + (extraClass || "") + '" data-tid="' + esc(t.id) + '">' +
    '<div class="tcard__top"><div>' + (isHosted(t) ? '<p class="tcard__eyebrow"><span class="chip chip--settle">Hosted</span>' +
        (t.visibility === "private" ? ' <span class="chip">Private</span>' : "") + "</p>" : "") +
      '<h3 class="tcard__name">' + esc(t.name) + "</h3>" +
      '<div class="row__meta">' + (isHosted(t) ? "hosted by @" : "by @") + esc(t.host_username || t.creator_username || "player") + "</div></div>" +
      '<div class="tcard__pool"><span class="k">entry</span><span class="v' + (t.entry_fee_cents ? "" : " is-free") + '">' + feeText(t.entry_fee_cents) + "</span></div></div>" +
    seats(t) +
    '<div class="tcard__mid"><span>' + t.entrants + "/" + t.size + " players · " + needText + "</span>" + prizeLine(t.entry_fee_cents, t.size, isHosted(t)) + "</div>" +
    '<div class="tcard__act">' + cardAction(t, linked) + "</div></article>";
}

// Lists cascade in on their first render only; refreshes don't replay it.
function settle(box) {
  if (box.dataset.settled) return;
  setTimeout(function () { box.dataset.settled = "1"; }, 400);
}

function loadLobby() {
  const request = ++play.lobbyRequest;
  const box = $("tournament-list");
  box.setAttribute("aria-busy", "true");
  if (!box.querySelector(".tcard")) box.innerHTML = skelCards(3);
  return Promise.all([session.client.rpc("rib_open_tournaments", { p_game: null, p_size: play.size, p_limit: 30 }), riotLinked()]).then(function (res) {
    if (request !== play.lobbyRequest) return;
    const r = res[0];
    box.setAttribute("aria-busy", "false");
    if (r.error) { box.innerHTML = '<p class="muted">Couldn\'t load tournaments. Try again in a moment.</p>'; return; }
    const rows = Array.isArray(r.data) ? r.data : [];
    if (!rows.length) {
      box.innerHTML = '<div class="empty">' + peakArt("match") + "<h3>" + (play.size ? "No tournaments match" : "No public tournaments waiting") +
        "</h3><p>Host one: name it, pick the size and the entry fee, and share the link. You post each match's lobby and pick the winners.</p>" +
        '<p><button type="button" class="btn btn--cta btn--sm" data-create>Host a tournament</button></p></div>';
      return;
    }
    box.innerHTML = '<div class="tgrid">' + rows.map(function (t) { return card(t, res[1]); }).join("") + "</div>";
    settle(box);
  }).catch(function () {
    if (request !== play.lobbyRequest) return;
    box.setAttribute("aria-busy", "false");
    box.innerHTML = '<p class="muted">You\'re offline. Tournaments load when you reconnect.</p>';
  });
}

/* ---- actions (delegated on the Play page) --------------------------------- */
function call(fn, args, btn, onOk) {
  if (btn) btn.disabled = true;
  return session.client.rpc(fn, args).then(function (r) {
    if (btn) btn.disabled = false;
    if (r.error) { toast(errorText(r.error, "Couldn't complete the action."), "err"); refreshSeg(activeSeg(), true); return; }
    if (onOk) onOk(r.data);
    play.mineAt = 0;
    play.tiersAt = 0;
    refreshSeg(activeSeg(), true);
    loadInvite();
    refreshWallet();
  }).catch(function () {
    if (btn) btn.disabled = false;
    toast("Network error. Check your connection and try again.", "err");
  });
}

function copyInvite(b) {
  if (!navigator.clipboard) return;
  navigator.clipboard.writeText(inviteUrl(b.getAttribute("data-invite"))).then(function () {
    b.textContent = "Link copied";
    setTimeout(function () { b.textContent = "Copy invite link"; }, 1600);
  });
}

function onClick(e) {
  const tier = e.target.closest("[data-tier]");
  if (tier) { joinTier(findTier(tier.getAttribute("data-tier"))); return; }
  const b = e.target.closest("button");
  if (!b) return;
  if (b.hasAttribute("data-create")) { openForm(); return; }
  if (b.hasAttribute("data-browse")) { showSeg("play"); return; }
  if (b.hasAttribute("data-join")) {
    const id = b.getAttribute("data-join");
    const fee = parseInt(b.getAttribute("data-fee"), 10) || 0;
    const name = b.getAttribute("data-name") || "this tournament";
    const hostedSize = parseInt(b.getAttribute("data-hosted"), 10) || 0;
    const join = function () {
      return call("rib_tournament_join", { p_tournament_id: id }, b, function (t) {
        play.started[id] = true;
        if (hostedSize) { toast("You're in " + name + ". The host posts each match's lobby.", "ok"); goToPage("page-event", { arg: id }); return; }
        if (t && t.status === "active") toast(name + " just started. Your first match is ready.", "match");
        else toast("You're in. It starts as soon as it fills.", "ok");
      });
    };
    if (!fee) { join(); return; }
    confirmAction({
      title: "Join " + name + " for " + formatRcoin(fee) + "?",
      body: hostedSize
        ? "The host runs this bracket and decides each match. The winner takes " + formatRcoin(hostedSplit(fee, hostedSize).winner) + " if it fills (85% of the prize pool). You can leave for a full refund until it starts."
        : "You can leave for a full refund until it fills, and you're refunded if it doesn't fill in 24 hours. When it fills, you'll have " + READY_MINUTES + " minutes to get ready for your first match.",
      ok: "Pay " + formatRcoin(fee) + " and join",
    }).then(function (ok) { if (ok) join(); });
    return;
  }
  if (b.hasAttribute("data-leave")) {
    const id = b.getAttribute("data-leave");
    confirmAction({ title: "Leave this tournament?", body: "Your entry fee comes back to your wallet right away.", ok: "Leave" }).then(function (ok) {
      if (!ok) return;
      call("rib_tournament_leave", { p_tournament_id: id }, b, function () {
        delete play.started[id];
        play.waiting = play.waiting.filter(function (t) { return t.id !== id; });
        renderWaiting();
        toast("You left the tournament. Your entry fee is back.", "ok");
      });
    });
    return;
  }
  if (b.hasAttribute("data-invite")) { copyInvite(b); return; }
  if (b.hasAttribute("data-link")) {
    goToPage("page-profile", { arg: "link/" + RIOT_NETWORK + "/t/" + b.getAttribute("data-link") });
    return;
  }
  if (b.hasAttribute("data-topup")) {
    goToPage("page-wallet", { arg: "buy/" + b.getAttribute("data-topup") + "/t/" + b.getAttribute("data-for") });
    return;
  }
  if (b.hasAttribute("data-room")) { openRoom(b.getAttribute("data-room")); return; }
  if (b.hasAttribute("data-event")) { goToPage("page-event", { arg: b.getAttribute("data-event") }); return; }
  if (b.hasAttribute("data-manage")) { goToPage("page-hosting", { arg: b.getAttribute("data-manage") }); return; }
  if (b.hasAttribute("data-bracket")) toggleBracket(b.getAttribute("data-bracket"), b);
}

/* ---- my tournaments ------------------------------------------------------- */
function myLine(t) {
  if (t.status === "open") {
    const hoursLeft = Math.max(0, Math.ceil((new Date(t.created_at).getTime() + 24 * 3600e3 - Date.now()) / 3600e3));
    return { tone: "match", chip: '<span class="chip chip--match">Waiting</span>', text: t.entrants + "/" + t.size + " joined · refunded in " + hoursLeft + " h if it doesn't fill" };
  }
  if (t.status === "cancelled") return { tone: "off", chip: '<span class="chip">Cancelled</span>', text: "Entry fee refunded" };
  if (t.status === "payout_pending") {
    return { tone: "settle", chip: '<span class="chip chip--settle">' + (t.placement === 1 ? "Champion" : "Final played") + "</span>", text: "Prizes are paid when the appeal window closes" };
  }
  if (t.status === "disputed") return { tone: "escrow", chip: '<span class="chip chip--escrow">Appeal in review</span>', text: "Prizes are on hold until the Runinback team decides" };
  if (t.status === "finished") {
    if (t.placement === 1) return { tone: "settle", chip: '<span class="chip chip--settle">Champion</span>', text: t.prize_cents ? "Won " + formatRcoin(t.prize_cents) : "Won" };
    if (t.placement === 2) return { tone: "settle", chip: '<span class="chip chip--settle">Runner-up</span>', text: t.prize_cents ? "Won " + formatRcoin(t.prize_cents) : "Final" };
    return { tone: "off", chip: '<span class="chip">Finished</span>', text: "Won by @" + (t.winner_username || "player") };
  }
  const round = t.my_round && t.rounds ? roundName(t.my_round, t.rounds) : "Match";
  if (t.eliminated) return { tone: "off", chip: '<span class="chip">Out</span>', text: "Out in the " + round.toLowerCase() };
  if (t.my_room_status === "setup") return { tone: "live", chip: '<span class="chip chip--match is-live">Your ' + esc(round.toLowerCase()) + "</span>", text: "Waiting for the host to post the lobby", room: t.my_room_id };
  if (t.my_room_status === "ready_check" || t.my_room_status === "live") {
    return { tone: "live", chip: '<span class="chip chip--match is-live">Your ' + esc(round.toLowerCase()) + "</span>", text: t.my_room_status === "ready_check" ? "Ready check open" : "Match on", room: t.my_room_id };
  }
  if (t.my_room_status === "disputed") return { tone: "escrow", chip: '<span class="chip chip--escrow">In review</span>', text: "Your " + round.toLowerCase() + " is being reviewed", room: t.my_room_id };
  return { tone: "match", chip: '<span class="chip chip--match">Through</span>', text: "Waiting for your next opponent" };
}

function loadMine(force) {
  if (!force && play.mine && Date.now() - play.mineAt < FRESH_MS) {
    renderMine();
    return Promise.resolve();
  }
  const request = ++play.mineRequest;
  const box = $("tournament-mine");
  if (!play.mine && !box.querySelector(".row")) box.innerHTML = skelRows(3);
  return Promise.resolve(session.client.rpc("rib_my_tournaments", { p_limit: 30 })).then(function (r) {
    if (request !== play.mineRequest) return;
    if (r.error) { if (!play.mine) box.innerHTML = '<p class="muted">Couldn\'t load your tournaments.</p>'; return; }
    play.mine = Array.isArray(r.data) ? r.data : [];
    play.mineAt = Date.now();
    document.dispatchEvent(new CustomEvent("rib:mine", { detail: play.mine }));
    play.waiting = play.mine.filter(function (t) { return t.status === "open"; });
    renderWaiting();
    renderTiers();
    renderMine();
    if (pageShown()) watchWaiting(play.waiting);
  }).catch(function () { /* offline: keep what's on screen */ });
}

function renderMine() {
  const box = $("tournament-mine");
  const rows = play.mine || [];
  if (!rows.length) {
    box.innerHTML = '<div class="empty">' + peakArt("settle") + "<h3>No tournaments yet</h3><p>Pick a tier in Quick Play and you're in the next bracket. Your brackets, results and prizes collect here.</p>" +
      '<p><button type="button" class="btn btn--cta btn--sm" data-browse>Pick a tier</button></p></div>';
    return;
  }
  box.innerHTML = '<div class="panel">' + rows.map(function (t) {
    const line = myLine(t);
    const canBracket = t.status !== "open" && t.status !== "cancelled";
    return '<div class="row row--tmine" data-tone="' + line.tone + '"><div class="row--tmine__main"><div class="row__name">' + esc(t.name) + " " + line.chip + "</div>" +
      '<div class="row__meta">' + t.size + " players · " + feeText(t.entry_fee_cents) + " · " + esc(line.text) + "</div></div>" +
      '<div class="row__act">' +
        (line.room ? '<button type="button" class="btn btn--cta btn--sm" data-room="' + esc(line.room) + '">Open room</button>' : "") +
        (isHosted(t) ? '<button type="button" class="btn btn--sm" data-event="' + esc(t.id) + '">View</button>' : "") +
        (canBracket ? '<button type="button" class="btn btn--sm" data-bracket="' + esc(t.id) + '" aria-expanded="false" aria-controls="bracket-' + esc(t.id) + '">Bracket</button>' : "") +
        (t.status === "open" ? '<button type="button" class="btn btn--sm" data-invite="' + esc(t.id) + '">Copy invite link</button><button type="button" class="btn btn--sm" data-leave="' + esc(t.id) + '">Leave</button>' : "") +
      "</div>" +
      '<div class="bracket" id="bracket-' + esc(t.id) + '" data-size="' + t.size + '" data-fee="' + esc(t.entry_fee_cents) + '" data-entrants="' + esc(t.entrants) + '"' +
        (isHosted(t) ? ' data-hosted="1"' : "") + " hidden></div></div>";
  }).join("") + "</div>";
  Object.keys(openBrackets).forEach(function (id) {
    const b = box.querySelector('[data-bracket="' + id + '"]');
    if (b && openBrackets[id]) toggleBracket(id, b, true);
  });
  settle(box);
}

function toggleBracket(id, btn, forceOpen) {
  const box = $("bracket-" + id);
  if (!box) return;
  const open = forceOpen || box.hidden;
  box.hidden = !open;
  btn.setAttribute("aria-expanded", String(open));
  openBrackets[id] = open;
  if (!open) return;
  const size = parseInt(box.getAttribute("data-size"), 10);
  const fee = parseInt(box.getAttribute("data-fee"), 10) || 0;
  const entrants = parseInt(box.getAttribute("data-entrants"), 10) || size;
  const hosted = box.hasAttribute("data-hosted");
  if (!box.innerHTML) box.innerHTML = skelRows(2);
  session.client.rpc("rib_tournament_bracket", { p_tournament_id: id }).then(function (r) {
    const b = normalizeBracket(r && r.data);
    renderBracket(box, b.rows, {
      size: b.size || size, rounds: b.rounds, uid: session.uid,
      champPrize: function (final) {
        if (!fee) return null;
        if (hosted) return hostedSplit(fee, entrants).winner;
        const prize = prizeSplit(fee, size);
        return final && final.walkover ? prize.prizes : prize.first;
      },
      action: function (m, mine) {
        const live = mine && (m.status === "ready_check" || m.status === "setup" || m.status === "live" || m.status === "disputed");
        return live ? '<button type="button" class="btn btn--cta btn--sm" data-room="' + esc(m.room_id) + '">Open room</button>' : "";
      },
    });
  }).catch(function () { box.innerHTML = '<p class="muted">Couldn\'t load the bracket. Try again in a moment.</p>'; });
}

/* ---- host a tournament ------------------------------------------------------
 * Name, size (4/8/16/32), entry fee (whole rcoin), public or private, rules.
 * The breakdown is what gets paid if it fills: the winner 85%, the host 5%,
 * the platform 10% (lib/hosted.js, the payout job's integer math).
 * -------------------------------------------------------------------------- */
const preview = { pool: 0, winner: 0, host: 0, platform: 0 };

function formVisibility() {
  const on = document.querySelector('#tournament-visibility button[aria-pressed="true"]');
  return on ? on.getAttribute("data-vis") : "public";
}

function updatePrizePreview() {
  const box = $("tournament-prize");
  if (!box) return;
  const fee = parseEntryFee($("tournament-fee") ? $("tournament-fee").value : "");
  const size = selectedChipAmount("tournament-size") || 4;
  if (fee.error || !fee.cents) {
    box.innerHTML = "<div><dt>Prize</dt><dd>" + (fee.error ? "Enter a whole number of rcoin" : "Free tournament, no prize") + "</dd></div>";
    box.dataset.built = "";
    return;
  }
  const s = hostedSplit(fee.cents, size);
  if (!box.dataset.built) {
    box.innerHTML =
      '<div><dt>Prize pool (full)</dt><dd data-k="pool"></dd></div>' +
      '<div><dt>Winner (85%)</dt><dd data-k="winner"></dd></div>' +
      '<div><dt>Host commission (' + HOST_FEE_PERCENT + '%)</dt><dd data-k="host"></dd></div>' +
      '<div><dt>Platform (10%)</dt><dd data-k="platform"></dd></div>';
    box.dataset.built = "1";
  }
  ["pool", "winner", "host", "platform"].forEach(function (k) {
    const el = box.querySelector('[data-k="' + k + '"]');
    tweenNumber(el, preview[k], s[k], function (v) { el.textContent = formatRcoin(Math.round(v)); }, 300);
    preview[k] = s[k];
  });
}

function updateRulesCount() {
  const input = $("tournament-rules");
  const out = $("tournament-rules-count");
  if (input && out) out.textContent = input.value.length + " / " + RULES_MAX;
}

// The fee a host may set (new hosts up to 25 rcoin, 3 strikes: free only),
// from rib_host_dashboard; read once, when the form first opens.
let hostLimits = null;
function loadHostLimits() {
  if (hostLimits) return;
  hostLimits = Promise.resolve(session.client.rpc("rib_host_dashboard", { p_limit: 1 })).then(function (r) {
    const info = r && !r.error ? normalizeHostInfo(r.data) : null;
    const input = $("tournament-fee");
    if (!info || !input) return;
    const max = info.paidAllowed ? Math.floor(info.maxFeeCents / 100) : 0;
    input.max = String(max);
    $("tournament-fee-hint").textContent = max
      ? "0 for a free tournament. Whole rcoin, up to " + max + "."
      : "Your account can host free tournaments only.";
    if (!max) input.value = "0";
    else if (parseInt(input.value, 10) > max) input.value = String(max);
    updatePrizePreview();
  }).catch(function () { hostLimits = null; });
}

function openForm() {
  const form = $("tournament-form");
  loadHostLimits();
  setVisible(form, true);
  $("tournament-msg").hidden = true;
  $("tournament-name").focus();
}

function createTournament(e) {
  e.preventDefault();
  const msg = $("tournament-msg");
  const check = validateHostedForm({
    name: $("tournament-name").value,
    size: selectedChipAmount("tournament-size"),
    fee: $("tournament-fee").value,
    visibility: formVisibility(),
    rules: $("tournament-rules").value,
  });
  const fields = { name: "tournament-name", fee: "tournament-fee", rules: "tournament-rules" };
  document.querySelectorAll("#tournament-form [aria-invalid]").forEach(function (f) { f.removeAttribute("aria-invalid"); });
  if (check.error) {
    showMessage(msg, check.error, false);
    const field = fields[check.field] && $(fields[check.field]);
    if (field) { field.setAttribute("aria-invalid", "true"); field.focus(); }
    return;
  }
  const btn = $("tournament-save");
  btn.disabled = true;
  Promise.resolve(session.client.rpc("rib_hosted_create", check.value)).then(function (r) {
    if (r.error) {
      showMessage(msg, errorText(r.error, "Couldn't create the tournament."), false);
      if (r.error.hint === "host_fee_limit" || r.error.hint === "host_restricted") $("tournament-fee").focus();
      return;
    }
    const t = Array.isArray(r.data) ? r.data[0] : r.data;
    setVisible($("tournament-form"), false);
    $("tournament-name").value = "";
    $("tournament-rules").value = "";
    updateRulesCount();
    toast(check.value.p_name + " is ready. Share the link so players can join.", "ok");
    if (t && t.id) goToPage("page-hosting", { arg: t.id + "/new" });
  })
    .catch(function () { showMessage(msg, "Network error. Check your connection and try again.", false); })
    .finally(function () { btn.disabled = false; });
}

/* ---- "Have an invite code?" -------------------------------------------------- */
function openInvite(e) {
  e.preventDefault();
  const input = $("invite-code-input");
  const msg = $("invite-code-msg");
  const code = parseInviteInput(input.value);
  if (!code) {
    input.setAttribute("aria-invalid", "true");
    showMessage(msg, "Invite codes are 10 letters and numbers, like ABCDE-FGH23. You can paste the whole link too.", false);
    input.focus();
    return;
  }
  input.removeAttribute("aria-invalid");
  msg.hidden = true;
  input.value = "";
  goToPage("page-join", { arg: code });
}

export function initTournaments() {
  const page = $("page-compete");
  page.addEventListener("click", function (e) {
    const seg = e.target.closest("#compete-seg [data-seg]");
    if (seg) { refreshSeg(seg.getAttribute("data-seg")); return; }
    if (e.target.closest("#compete-play, #compete-mine, #compete-custom")) onClick(e);
  });
  document.querySelectorAll('[data-chips="tournament-size"] button').forEach(function (b) {
    b.addEventListener("click", function () { setTimeout(updatePrizePreview, 0); });
  });
  $("tournament-fee").addEventListener("input", updatePrizePreview);
  $("tournament-rules").addEventListener("input", updateRulesCount);
  $("tournament-visibility").addEventListener("click", function (e) {
    const b = e.target.closest("button[data-vis]");
    if (!b) return;
    this.querySelectorAll("button").forEach(function (x) {
      x.classList.toggle("on", x === b);
      x.setAttribute("aria-pressed", String(x === b));
    });
  });
  updatePrizePreview();
  updateRulesCount();
  $("invite-code-form").addEventListener("submit", openInvite);

  $("tournament-new").addEventListener("click", function () {
    if ($("tournament-form").hidden) openForm();
    else setVisible($("tournament-form"), false);
  });
  $("tournament-cancel").addEventListener("click", function () { setVisible($("tournament-form"), false); });
  $("tournament-form").addEventListener("submit", createTournament);

  $("tournament-filters").addEventListener("submit", function (e) { e.preventDefault(); });
  $("tournament-filters").addEventListener("click", function (e) {
    const b = e.target.closest("[data-tsize] button");
    if (!b) return;
    b.parentNode.querySelectorAll("button").forEach(function (x) {
      x.classList.toggle("on", x === b);
      x.setAttribute("aria-pressed", String(x === b));
    });
    play.size = b.getAttribute("data-size") ? parseInt(b.getAttribute("data-size"), 10) : null;
    loadLobby();
  });

  // Counts poll only while Play is on screen; leaving it stops everything.
  document.addEventListener("rib:page", function (e) { if (e.detail !== "page-compete") stopPolling(); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && pageShown() && activeSeg() === "play") loadTiers();
  });
  renderTiers();
}
