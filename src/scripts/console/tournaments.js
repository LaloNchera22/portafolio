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
 * Secondary: My tournaments (progress and brackets) and Custom (named events
 * to share, browse the open ones). Game and network are fixed: Wild Rift,
 * Riot ID. Seeding, advancement and payouts happen in the database; prizes
 * are 90% of the pool, split 70/30.
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
import { tweenNumber } from "../lib/motion.js";
import { prizeSplit, roundName, roundsFor } from "../lib/tournament.js";
import { QUICK_TIERS, RIOT_NETWORK, WILD_RIFT, findTier, playReturn, tierKey } from "../lib/wild-rift.js";
import { errorText, session } from "./context.js";
import { clearRouteArg, currentRouteArg, goToPage, selectedChipAmount } from "./navigation.js";
import { loadGameAccounts } from "./profile.js";
import { openRoom, peakArt } from "./room.js";
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
};
const openBrackets = {}; // tournament id -> bracket expanded

function feeText(cents) { return cents ? formatRcoin(cents) : "Free"; }

function prizeLine(feeCents, size) {
  if (!feeCents) return '<span class="tcard__free">Free · no prize</span>';
  const s = prizeSplit(feeCents, size);
  return '<span class="tcard__prize">Champion ' + formatRcoin(s.first) + " · runner-up " + formatRcoin(s.second) + "</span>";
}

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

function tierButton(tier) {
  const info = play.tiers && play.tiers[tier.key];
  const queued = queuedIn(tier);
  const waiting = info ? info.waiting : null;
  const split = prizeSplit(tier.fee, tier.size);
  let wait = "";
  if (queued) wait = '<span class="tier__wait is-in">You\'re in</span>';
  else if (waiting) wait = '<span class="tier__wait is-live">' + waiting + " waiting</span>";
  else if (waiting === 0) wait = '<span class="tier__wait">Start one</span>';
  const label = (tier.fee ? formatRcoin(tier.fee) + " entry" : "Free") + ", " + tier.size + " players" +
    (tier.fee ? ", champion wins " + formatRcoin(split.first) : "") +
    (queued ? ", you're in" : waiting ? ", " + waiting + " waiting" : "");
  return '<button type="button" class="tier' + (tier.fee ? "" : " is-free") + (queued ? " is-queued" : "") + '" data-tier="' + tier.key + '" aria-label="' + esc(label) + '"' +
    (play.joining ? " disabled" : "") + ">" +
    '<span class="tier__fee">' + feeText(tier.fee) + "</span>" +
    '<span class="tier__size">' + tier.size + " players</span>" +
    '<span class="tier__prize">' + (tier.fee ? "Champion " + formatRcoin(split.first) : "No prize, for fun") + "</span>" +
    wait + "</button>";
}

function renderTiers() {
  const box = $("play-tiers");
  if (!box) return;
  const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest("#play-tiers [data-tier]");
  const keep = focused ? focused.getAttribute("data-tier") : null;
  box.innerHTML = '<div class="tiers" role="group" aria-label="Pick an entry fee and size">' + QUICK_TIERS.map(tierButton).join("") + "</div>";
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
    if (tier.fee && !window.confirm("Enter a " + tier.size + "-player " + WILD_RIFT + " bracket for " + formatRcoin(tier.fee) +
      "? You can leave for a full refund until it fills. When it fills, you have " + READY_MINUTES + " minutes to get ready for your first match.")) return;
    play.joining = true;
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
        if (t.status === "open") addWaiting(t, tier);
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
      renderTiers();
    });
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
function seats(t) {
  const fresh = play.seats[t.id];
  play.seats[t.id] = t.entrants;
  let html = '<div class="seats" style="--n:' + t.size + '" role="img" aria-label="' + t.entrants + " of " + t.size + ' seats taken">';
  for (let i = 0; i < t.size; i++) {
    const taken = i < t.entrants;
    const isNew = taken && fresh !== undefined && i >= fresh;
    html += '<span class="seat' + (taken ? " is-taken" : "") + (isNew ? " is-new" : "") + '"></span>';
  }
  return html + "</div>";
}

function waitingCard(t) {
  const need = Math.max(0, t.size - t.entrants);
  return '<article class="tcard is-waiting" data-tid="' + esc(t.id) + '">' +
    '<div class="tcard__top"><div><p class="tcard__eyebrow"><span class="chip chip--match is-live">Filling</span></p>' +
      '<h3 class="tcard__name">' + esc(t.name) + "</h3></div>" +
      '<div class="tcard__pool"><span class="k">entry</span><span class="v' + (t.entry_fee_cents ? "" : " is-free") + '">' + feeText(t.entry_fee_cents) + "</span></div></div>" +
    seats(t) +
    '<div class="tcard__mid"><span>' + t.entrants + "/" + t.size + " players · " + (need === 1 ? '<span class="tcard__last">1 to go</span>' : need + " to go") + "</span>" +
      prizeLine(t.entry_fee_cents, t.size) + "</div>" +
    '<p class="tcard__note">Stay close: when the last seat fills your match room opens here, and you have ' + READY_MINUTES + " minutes to get ready.</p>" +
    '<div class="tcard__act"><button type="button" class="btn btn--sm" data-invite="' + esc(t.id) + '">Copy invite link</button>' +
      '<button type="button" class="btn btn--sm" data-leave="' + esc(t.id) + '">Leave</button></div></article>';
}

function renderWaiting() {
  const box = $("play-waiting");
  if (!box) return;
  box.innerHTML = play.waiting.length ? '<div class="tgrid">' + play.waiting.map(waitingCard).join("") + "</div>" : "";
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
  return '<button type="button" class="btn btn--cta btn--sm" data-join="' + esc(t.id) + '" data-fee="' + esc(t.entry_fee_cents) + '" data-name="' + esc(t.name) + '">Join · ' + feeText(t.entry_fee_cents) + "</button>";
}

function card(t, linked, extraClass) {
  const need = t.size - t.entrants;
  const needText = need === 1 ? '<span class="tcard__last">1 seat left</span>' : need > 0 ? need + " seats left" : "Full";
  return '<article class="tcard' + (t.joined ? " is-joined" : "") + (need === 1 ? " is-last-seat" : "") + (extraClass || "") + '" data-tid="' + esc(t.id) + '">' +
    '<div class="tcard__top"><div><h3 class="tcard__name">' + esc(t.name) + "</h3>" +
      '<div class="row__meta">by @' + esc(t.creator_username || "player") + "</div></div>" +
      '<div class="tcard__pool"><span class="k">entry</span><span class="v' + (t.entry_fee_cents ? "" : " is-free") + '">' + feeText(t.entry_fee_cents) + "</span></div></div>" +
    seats(t) +
    '<div class="tcard__mid"><span>' + t.entrants + "/" + t.size + " players · " + needText + "</span>" + prizeLine(t.entry_fee_cents, t.size) + "</div>" +
    '<div class="tcard__act">' + cardAction(t, linked) + "</div></article>";
}

function skeletonCards(n) {
  let html = '<div class="tgrid" aria-hidden="true">';
  for (let i = 0; i < n; i++) {
    html += '<div class="skel skel--card"><span class="skel__l" style="width:55%"></span><span class="skel__l" style="width:35%"></span>' +
      '<span class="skel__l skel__l--bar"></span><span class="skel__l skel__l--pill"></span></div>';
  }
  return html + "</div>";
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
  if (!box.querySelector(".tcard")) box.innerHTML = skeletonCards(3);
  return Promise.all([session.client.rpc("rib_open_tournaments", { p_game: null, p_size: play.size, p_limit: 30 }), riotLinked()]).then(function (res) {
    if (request !== play.lobbyRequest) return;
    const r = res[0];
    box.setAttribute("aria-busy", "false");
    if (r.error) { box.innerHTML = '<p class="muted">Couldn\'t load tournaments. Try again in a moment.</p>'; return; }
    const rows = Array.isArray(r.data) ? r.data : [];
    if (!rows.length) {
      box.innerHTML = '<div class="empty">' + peakArt("match") + "<h3>" + (play.size ? "No tournaments match" : "No custom tournaments waiting") +
        "</h3><p>Create one: name it, pick 4 or 8 players and the entry fee, and share the link. It starts the moment it fills.</p>" +
        '<p><button type="button" class="btn btn--cta btn--sm" data-create>New tournament</button></p></div>';
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
    if (fee && !window.confirm("Join " + name + " for " + formatRcoin(fee) + "? You can leave for a full refund until it fills, and you're refunded if it doesn't fill in 24 hours. When it fills, you'll have " + READY_MINUTES + " minutes to get ready for your first match.")) return;
    call("rib_tournament_join", { p_tournament_id: id }, b, function (t) {
      play.started[id] = true;
      if (t && t.status === "active") toast(name + " just started. Your first match is ready.", "match");
      else toast("You're in. It starts as soon as it fills.", "ok");
    });
    return;
  }
  if (b.hasAttribute("data-leave")) {
    if (!window.confirm("Leave this tournament? Your entry fee comes back to your wallet.")) return;
    const id = b.getAttribute("data-leave");
    call("rib_tournament_leave", { p_tournament_id: id }, b, function () {
      delete play.started[id];
      play.waiting = play.waiting.filter(function (t) { return t.id !== id; });
      renderWaiting();
      toast("You left the tournament. Your entry fee is back.", "ok");
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
  if (b.hasAttribute("data-bracket")) toggleBracket(b.getAttribute("data-bracket"), b);
}

/* ---- my tournaments ------------------------------------------------------- */
function myLine(t) {
  if (t.status === "open") {
    const hoursLeft = Math.max(0, Math.ceil((new Date(t.created_at).getTime() + 24 * 3600e3 - Date.now()) / 3600e3));
    return { chip: '<span class="chip chip--match">Waiting</span>', text: t.entrants + "/" + t.size + " joined · refunded in " + hoursLeft + " h if it doesn't fill" };
  }
  if (t.status === "cancelled") return { chip: '<span class="chip">Cancelled</span>', text: "Entry fee refunded" };
  if (t.status === "finished") {
    if (t.placement === 1) return { chip: '<span class="chip chip--settle">Champion</span>', text: t.prize_cents ? "Won " + formatRcoin(t.prize_cents) : "Won" };
    if (t.placement === 2) return { chip: '<span class="chip chip--settle">Runner-up</span>', text: t.prize_cents ? "Won " + formatRcoin(t.prize_cents) : "Final" };
    return { chip: '<span class="chip">Finished</span>', text: "Won by @" + (t.winner_username || "player") };
  }
  const round = t.my_round && t.rounds ? roundName(t.my_round, t.rounds) : "Match";
  if (t.eliminated) return { chip: '<span class="chip">Out</span>', text: "Out in the " + round.toLowerCase() };
  if (t.my_room_status === "ready_check" || t.my_room_status === "live") {
    return { chip: '<span class="chip chip--match is-live">Your ' + esc(round.toLowerCase()) + "</span>", text: t.my_room_status === "ready_check" ? "Ready check open" : "Match on", room: t.my_room_id };
  }
  if (t.my_room_status === "disputed") return { chip: '<span class="chip chip--escrow">In review</span>', text: "Your " + round.toLowerCase() + " is being reviewed", room: t.my_room_id };
  return { chip: '<span class="chip chip--match">Through</span>', text: "Waiting for your next opponent" };
}

function loadMine(force) {
  if (!force && play.mine && Date.now() - play.mineAt < FRESH_MS) {
    renderMine();
    return Promise.resolve();
  }
  const request = ++play.mineRequest;
  const box = $("tournament-mine");
  if (!play.mine && !box.querySelector(".row")) box.innerHTML = '<div class="skel skel--rows" aria-hidden="true"><span class="skel__l"></span><span class="skel__l"></span><span class="skel__l"></span></div>';
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
    box.innerHTML = '<div class="empty">' + peakArt("settle") + "<h3>No tournaments yet</h3><p>Pick a tier in Quick Play and you're in the next bracket.</p>" +
      '<p><button type="button" class="btn btn--cta btn--sm" data-browse>Quick Play</button></p></div>';
    return;
  }
  box.innerHTML = '<div class="panel">' + rows.map(function (t) {
    const line = myLine(t);
    const canBracket = t.status === "active" || t.status === "finished";
    return '<div class="row row--tmine"><div class="row--tmine__main"><div class="row__name">' + esc(t.name) + " " + line.chip + "</div>" +
      '<div class="row__meta">' + t.size + " players · " + feeText(t.entry_fee_cents) + " · " + esc(line.text) + "</div></div>" +
      '<div class="row__act">' +
        (line.room ? '<button type="button" class="btn btn--cta btn--sm" data-room="' + esc(line.room) + '">Open room</button>' : "") +
        (canBracket ? '<button type="button" class="btn btn--sm" data-bracket="' + esc(t.id) + '" aria-expanded="false" aria-controls="bracket-' + esc(t.id) + '">Bracket</button>' : "") +
        (t.status === "open" ? '<button type="button" class="btn btn--sm" data-invite="' + esc(t.id) + '">Copy invite link</button><button type="button" class="btn btn--sm" data-leave="' + esc(t.id) + '">Leave</button>' : "") +
      "</div>" +
      '<div class="bracket" id="bracket-' + esc(t.id) + '" data-size="' + t.size + '" data-fee="' + esc(t.entry_fee_cents) + '" hidden></div></div>';
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
  if (!box.innerHTML) box.innerHTML = '<p class="muted is-loading">Loading…</p>';
  session.client.rpc("rib_tournament_bracket", { p_tournament_id: id }).then(function (r) {
    const rows = Array.isArray(r && r.data) ? r.data : [];
    box.innerHTML = bracketHtml(rows, size, fee);
  });
}

function bracketHtml(rows, size, fee) {
  const rounds = roundsFor(size);
  const player = function (m, uid, name) {
    if (!uid) return '<span class="bracket__p is-tbd">TBD</span>';
    const won = m.winner_id && m.winner_id === uid;
    const lost = m.winner_id && m.winner_id !== uid;
    return '<span class="bracket__p' + (won ? " is-win" : "") + (lost ? " is-out" : "") + (uid === session.uid ? " is-me" : "") + '">@' + esc(name || "player") + "</span>";
  };
  const match = function (m) {
    const mine = m.player_a === session.uid || m.player_b === session.uid;
    const liveMine = mine && (m.status === "ready_check" || m.status === "live" || m.status === "disputed");
    return '<div class="bracket__m' + (mine ? " is-mine" : "") + '">' + player(m, m.player_a, m.a_username) + player(m, m.player_b, m.b_username) +
      (m.walkover ? '<span class="bracket__note">walkover</span>' : m.status === "void" ? '<span class="bracket__note">no result</span>' : "") +
      (liveMine ? '<span class="bracket__act"><button type="button" class="btn btn--cta btn--sm" data-room="' + esc(m.room_id) + '">Open room</button></span>' : "") + "</div>";
  };
  let html = '<div class="bracket__cols">';
  for (let i = 1; i <= rounds; i++) {
    const col = rows.filter(function (m) { return m.round === i; });
    const pairs = [];
    for (let k = 0; k < col.length; k += 2) pairs.push(col.slice(k, k + 2));
    html += '<div class="bracket__col"><h4>' + roundName(i, rounds) + '</h4><div class="bracket__slots">' +
      pairs.map(function (p) {
        const mine = p.some(function (m) { return m.player_a === session.uid || m.player_b === session.uid; });
        return '<div class="bracket__pair' + (p.length > 1 ? " is-pair" : "") + (mine ? " has-me" : "") + '">' + p.map(match).join("") + "</div>";
      }).join("") + "</div></div>";
  }
  const final = rows.filter(function (m) { return m.round === rounds; })[0];
  const champ = final && final.status === "done" && final.winner_id
    ? (final.winner_id === final.player_a ? final.a_username : final.b_username) : null;
  const prize = fee ? prizeSplit(fee, size) : null;
  html += '<div class="bracket__col bracket__col--champ"><h4>Champion</h4><div class="bracket__slots"><div class="bracket__champ' + (champ ? " is-set" : "") + '">' +
    '<span class="' + (champ ? "v" : "muted") + '">' + (champ ? "@" + esc(champ) : "TBD") + "</span>" +
    (prize ? '<span class="k">' + formatRcoin(final && final.walkover ? prize.prizes : prize.first) + "</span>" : "") + "</div></div></div>";
  return html + "</div>";
}

/* ---- create a custom tournament ------------------------------------------- */
const preview = { pool: 0, first: 0, second: 0, platform: 0 };
function updatePrizePreview() {
  const fee = selectedChipAmount("tournament-fee") || 0;
  const size = selectedChipAmount("tournament-size") || 4;
  const box = $("tournament-prize");
  if (!box) return;
  if (!fee) { box.innerHTML = "<div><dt>Prize</dt><dd>Free tournament, no prize</dd></div>"; box.dataset.built = ""; return; }
  const s = prizeSplit(fee, size);
  if (!box.dataset.built) {
    box.innerHTML =
      '<div><dt>Pool</dt><dd data-k="pool"></dd></div>' +
      '<div><dt>Champion</dt><dd data-k="first"></dd></div>' +
      '<div><dt>Runner-up</dt><dd data-k="second"></dd></div>' +
      '<div><dt>Platform (10%)</dt><dd data-k="platform"></dd></div>';
    box.dataset.built = "1";
  }
  ["pool", "first", "second", "platform"].forEach(function (k) {
    const el = box.querySelector('[data-k="' + k + '"]');
    tweenNumber(el, preview[k], s[k], function (v) { el.textContent = formatRcoin(Math.round(v)); }, 300);
    preview[k] = s[k];
  });
}

function openForm() {
  const form = $("tournament-form");
  setVisible(form, true);
  $("tournament-msg").hidden = true;
  $("tournament-name").focus();
}

function createTournament(e) {
  e.preventDefault();
  const msg = $("tournament-msg");
  const name = ($("tournament-name").value || "").trim();
  const fee = selectedChipAmount("tournament-fee");
  const size = selectedChipAmount("tournament-size");
  if (!name) { showMessage(msg, "Give the tournament a name.", false); $("tournament-name").focus(); return; }
  const btn = $("tournament-save");
  btn.disabled = true;
  riotLinked().then(function (linked) {
    if (linked === false) {
      toast("Link your Riot ID first. You'll come right back to your tournament.", "ok");
      goToPage("page-profile", { arg: "link/" + RIOT_NETWORK + "/new" });
      return;
    }
    return session.client.rpc("rib_tournament_create", {
      p_name: name, p_game: WILD_RIFT, p_entry_fee_cents: isFinite(fee) ? fee : 0, p_size: isFinite(size) ? size : 4, p_network: RIOT_NETWORK,
    }).then(function (r) {
      if (r.error) { showMessage(msg, errorText(r.error, "Couldn't create the tournament."), false); return; }
      setVisible($("tournament-form"), false);
      $("tournament-name").value = "";
      const id = r.data && r.data.id;
      if (id) play.started[id] = true;
      toast(name + " is open and you're the first entrant. Share it so it fills.", "ok",
        id && navigator.clipboard ? { label: "Copy invite link", onClick: function () { navigator.clipboard.writeText(inviteUrl(id)); } } : null);
      showSeg("play");
      loadMine(true);
      refreshWallet();
    });
  })
    .catch(function () { showMessage(msg, "Network error. Check your connection and try again.", false); })
    .finally(function () { btn.disabled = false; });
}

export function initTournaments() {
  const page = $("page-compete");
  page.addEventListener("click", function (e) {
    const seg = e.target.closest("#compete-seg [data-seg]");
    if (seg) { refreshSeg(seg.getAttribute("data-seg")); return; }
    if (e.target.closest("#compete-play, #compete-mine, #compete-custom")) onClick(e);
  });
  document.querySelectorAll('[data-chips="tournament-fee"] button, [data-chips="tournament-size"] button').forEach(function (b) {
    b.addEventListener("click", function () { setTimeout(updatePrizePreview, 0); });
  });
  updatePrizePreview();

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
