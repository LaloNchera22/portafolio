/* ============================================================================
 * Runinback — console tournaments: sit & go events of 4 or 8 players.
 * Browse the ones waiting for players (fullest first), create one (you're the
 * first entrant), join or leave before it starts, follow your own progress
 * and the bracket, and jump into your match room. Seeding, advancement and
 * payouts happen in the database (migrations 0022–0023); prizes are 90% of
 * the pool, split 70/30.
 *
 * What blocks a join is solved in place: a missing game account links from
 * the card and comes back, a short balance offers "Add USD" for exactly
 * what's missing.
 * ========================================================================== */
import { byId as $, escapeHtml as esc, setVisible, showMessage } from "../lib/dom.js";
import { toast } from "../lib/errors.js";
import { formatUSD } from "../lib/format.js";
import { tweenNumber } from "../lib/motion.js";
import { prizeSplit, roundName, roundsFor } from "../lib/tournament.js";
import { errorText, session } from "./context.js";
import { refreshLive } from "./live.js";
import { currentRouteArg, goToPage, selectedChipAmount } from "./navigation.js";
import { networkLabel } from "./networks.js";
import { openRoom, peakArt } from "./room.js";
import { refreshWallet } from "./wallet.js";

const lobby = { game: "", size: null, request: 0, seats: {}, linked: null };
const openBrackets = {}; // tournament id -> bracket expanded

function feeText(cents) { return cents ? formatUSD(cents) : "Free"; }

function prizeLine(feeCents, size) {
  if (!feeCents) return '<span class="tcard__free">Free · no prize</span>';
  const s = prizeSplit(feeCents, size);
  return '<span class="tcard__prize">Champion ' + formatUSD(s.first) + " · runner-up " + formatUSD(s.second) + "</span>";
}

/** Invite link for a tournament (opens it straight in the lobby). */
function inviteUrl(id) {
  return location.origin + location.pathname + "#page-compete/t/" + id;
}

/* ---- lobby ---------------------------------------------------------------- */
export function loadTournaments() {
  refreshLive();
  return loadLinked().then(function () {
    loadInvite();
    loadLobby();
    loadMine();
  });
}

// The networks this player has linked (to offer "Link X to join" in place).
function loadLinked() {
  return Promise.resolve(session.client.from("game_accounts").select("network")).then(function (r) {
    lobby.linked = Array.isArray(r && r.data) ? r.data.map(function (a) { return a.network; }) : [];
  }).catch(function () { lobby.linked = []; });
}

function seats(t) {
  const fresh = lobby.seats[t.id];
  lobby.seats[t.id] = t.entrants;
  let html = '<div class="seats" style="--n:' + t.size + '" role="img" aria-label="' + t.entrants + " of " + t.size + ' seats taken">';
  for (let i = 0; i < t.size; i++) {
    const taken = i < t.entrants;
    const isNew = taken && fresh !== undefined && i >= fresh;
    html += '<span class="seat' + (taken ? " is-taken" : "") + (isNew ? " is-new" : "") + '"></span>';
  }
  return html + "</div>";
}

function cardAction(t) {
  if (t.joined) {
    return '<span class="chip chip--match">Joined</span>' +
      '<button type="button" class="btn btn--sm" data-invite="' + esc(t.id) + '">Copy invite link</button>' +
      '<button type="button" class="btn btn--sm" data-leave="' + esc(t.id) + '">Leave</button>';
  }
  if (t.network && lobby.linked && lobby.linked.indexOf(t.network) === -1) {
    return '<button type="button" class="btn btn--sm" data-link="' + esc(t.network) + '" data-for="' + esc(t.id) + '">Link ' + esc(networkLabel(t.network)) + " to join</button>";
  }
  const short = t.entry_fee_cents && session.balanceCents != null && t.entry_fee_cents > session.balanceCents;
  if (short) {
    return '<button type="button" class="btn btn--sm" data-topup="' + (t.entry_fee_cents - session.balanceCents) + '" data-for="' + esc(t.id) + '">Add USD to join</button>' +
      '<span class="tcard__note">You need ' + formatUSD(t.entry_fee_cents) + ", you have " + formatUSD(session.balanceCents) + ".</span>";
  }
  return '<button type="button" class="btn btn--cta btn--sm" data-join="' + esc(t.id) + '" data-fee="' + esc(t.entry_fee_cents) + '" data-name="' + esc(t.name) + '">Join · ' + feeText(t.entry_fee_cents) + "</button>";
}

function card(t, extraClass) {
  const need = t.size - t.entrants;
  const needText = need === 1 ? '<span class="tcard__last">1 seat left</span>' : need > 0 ? need + " seats left" : "Full";
  return '<article class="tcard' + (t.joined ? " is-joined" : "") + (need === 1 ? " is-last-seat" : "") + (extraClass || "") + '" data-tid="' + esc(t.id) + '">' +
    '<div class="tcard__top"><div><h3 class="tcard__name">' + esc(t.name) + "</h3>" +
      '<div class="row__meta">' + esc(t.game) + " · by @" + esc(t.creator_username || "player") + "</div>" +
      (t.network ? '<div class="tcard__req">' + esc(networkLabel(t.network)) + " required</div>" : "") + "</div>" +
      '<div class="tcard__pool"><span class="k">entry</span><span class="v' + (t.entry_fee_cents ? "" : " is-free") + '">' + feeText(t.entry_fee_cents) + "</span></div></div>" +
    seats(t) +
    '<div class="tcard__mid"><span>' + t.entrants + "/" + t.size + " players · " + needText + "</span>" + prizeLine(t.entry_fee_cents, t.size) + "</div>" +
    '<div class="tcard__act">' + cardAction(t) + "</div></article>";
}

export function skeletonCards(n) {
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
  const request = ++lobby.request;
  const box = $("tournament-list");
  box.setAttribute("aria-busy", "true");
  if (!box.querySelector(".tcard")) box.innerHTML = skeletonCards(3);
  session.client.rpc("rib_open_tournaments", { p_game: lobby.game || null, p_size: lobby.size, p_limit: 30 }).then(function (r) {
    if (request !== lobby.request) return;
    box.setAttribute("aria-busy", "false");
    if (r.error) { box.innerHTML = '<p class="muted">Couldn\'t load tournaments. Try again in a moment.</p>'; return; }
    const rows = Array.isArray(r.data) ? r.data : [];
    if (!rows.length) {
      box.innerHTML = '<div class="empty">' + peakArt("match") + "<h3>" + (lobby.game || lobby.size ? "No tournaments match" : "No tournaments waiting") +
        '</h3><p>Create one: pick the game, 4 or 8 players and the entry fee. It starts the moment it fills.</p>' +
        '<p><button type="button" class="btn btn--cta btn--sm" data-create>New tournament</button></p></div>';
      return;
    }
    box.innerHTML = '<div class="tgrid">' + rows.map(function (t) { return card(t); }).join("") + "</div>";
    settle(box);
  }).catch(function () {
    if (request !== lobby.request) return;
    box.setAttribute("aria-busy", "false");
    box.innerHTML = '<p class="muted">You\'re offline. Tournaments load when you reconnect.</p>';
  });
}

/* ---- invite links: #page-compete/t/<id> ----------------------------------- */
function loadInvite() {
  const box = $("tournament-invite");
  if (!box) return;
  const arg = currentRouteArg() || "";
  const id = arg.indexOf("t/") === 0 ? arg.slice(2) : null;
  if (!id) { box.hidden = true; box.innerHTML = ""; return; }
  session.client.rpc("rib_tournament_summary", { p_tournament_id: id }).then(function (r) {
    const t = Array.isArray(r && r.data) ? r.data[0] : null;
    if (!t) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = '<p class="eyebrow">You\'re invited</p>' +
      (t.status === "open" ? card(t, " is-invite") : '<div class="empty"><h3>' + esc(t.name) + "</h3><p>This tournament has " + (t.status === "active" ? "already started." : "ended.") + "</p></div>");
  });
}

/* ---- actions (delegated on the Compete page) ------------------------------ */
function call(fn, args, btn, onOk) {
  if (btn) btn.disabled = true;
  return session.client.rpc(fn, args).then(function (r) {
    if (btn) btn.disabled = false;
    if (r.error) { toast(errorText(r.error, "Couldn't complete the action."), "err"); loadTournaments(); return; }
    if (onOk) onOk(r.data);
    loadTournaments();
    refreshWallet();
  }).catch(function () {
    if (btn) btn.disabled = false;
    toast("Network error. Check your connection and try again.", "err");
  });
}

function onClick(e) {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.hasAttribute("data-create")) { $("tournament-new").click(); return; }
  if (b.hasAttribute("data-join")) {
    const fee = parseInt(b.getAttribute("data-fee"), 10) || 0;
    const name = b.getAttribute("data-name") || "this tournament";
    if (fee && !window.confirm("Join " + name + " for " + formatUSD(fee) + "? You can leave for a full refund until it fills, and you're refunded if it doesn't fill in 24 hours. When it fills, you'll have 15 minutes to get ready for your first match.")) return;
    call("rib_tournament_join", { p_tournament_id: b.getAttribute("data-join") }, b, function (t) {
      if (t && t.status === "active") toast(name + " just started. Your first match is ready.", "match");
      else toast("You're in. It starts as soon as it fills.", "ok");
    });
    return;
  }
  if (b.hasAttribute("data-leave")) {
    if (!window.confirm("Leave this tournament? Your entry fee comes back to your wallet.")) return;
    call("rib_tournament_leave", { p_tournament_id: b.getAttribute("data-leave") }, b, function () { toast("You left the tournament. Your entry fee is back.", "ok"); });
    return;
  }
  if (b.hasAttribute("data-invite")) {
    const url = inviteUrl(b.getAttribute("data-invite"));
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { b.textContent = "Link copied"; setTimeout(function () { b.textContent = "Copy invite link"; }, 1600); });
    return;
  }
  if (b.hasAttribute("data-link")) {
    goToPage("page-profile", { arg: "link/" + b.getAttribute("data-link") + "/" + b.getAttribute("data-for") });
    return;
  }
  if (b.hasAttribute("data-topup")) {
    goToPage("page-wallet", { arg: "buy/" + b.getAttribute("data-topup") + "/" + b.getAttribute("data-for") });
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
    if (t.placement === 1) return { chip: '<span class="chip chip--settle">Champion</span>', text: t.prize_cents ? "Won " + formatUSD(t.prize_cents) : "Won" };
    if (t.placement === 2) return { chip: '<span class="chip chip--settle">Runner-up</span>', text: t.prize_cents ? "Won " + formatUSD(t.prize_cents) : "Final" };
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

function loadMine() {
  const box = $("tournament-mine");
  if (!box.querySelector(".row")) box.innerHTML = '<div class="skel skel--rows" aria-hidden="true"><span class="skel__l"></span><span class="skel__l"></span><span class="skel__l"></span></div>';
  session.client.rpc("rib_my_tournaments", { p_limit: 30 }).then(function (r) {
    if (r.error) { box.innerHTML = '<p class="muted">Couldn\'t load your tournaments.</p>'; return; }
    const rows = Array.isArray(r.data) ? r.data : [];
    if (!rows.length) {
      box.innerHTML = '<div class="empty">' + peakArt("settle") + '<h3>No tournaments yet</h3><p>Join one from the Tournaments tab, or create your own.</p>' +
        '<p><button type="button" class="btn btn--cta btn--sm" data-browse>Browse tournaments</button></p></div>';
      return;
    }
    box.innerHTML = '<div class="panel">' + rows.map(function (t) {
      const line = myLine(t);
      const canBracket = t.status === "active" || t.status === "finished";
      return '<div class="row row--tmine"><div class="row--tmine__main"><div class="row__name">' + esc(t.name) + " " + line.chip + "</div>" +
        '<div class="row__meta">' + esc(t.game) + " · " + t.size + " players · " + feeText(t.entry_fee_cents) + " · " + esc(line.text) + "</div></div>" +
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
  });
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
    (prize ? '<span class="k">' + formatUSD(final && final.walkover ? prize.prizes : prize.first) + "</span>" : "") + "</div></div></div>";
  return html + "</div>";
}

/* ---- create --------------------------------------------------------------- */
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
    tweenNumber(el, preview[k], s[k], function (v) { el.textContent = formatUSD(Math.round(v)); }, 300);
    preview[k] = s[k];
  });
}

export function initTournaments() {
  const form = $("tournament-form");
  $("page-compete").addEventListener("click", function (e) {
    if (e.target.closest("[data-browse]")) { const tab = document.querySelector('#compete-seg [data-seg="tournaments"]'); if (tab) tab.click(); return; }
    if (e.target.closest("#tournament-list, #tournament-mine, #tournament-invite")) onClick(e);
  });
  document.querySelectorAll('[data-chips="tournament-fee"] button, [data-chips="tournament-size"] button').forEach(function (b) {
    b.addEventListener("click", function () { setTimeout(updatePrizePreview, 0); });
  });
  updatePrizePreview();

  $("tournament-new").addEventListener("click", function () {
    const open = form.hidden;
    setVisible(form, open);
    if (open) {
      const tab = document.querySelector('#compete-seg [data-seg="tournaments"]');
      if (tab) tab.click();
      $("tournament-name").focus();
    }
  });
  $("tournament-cancel").addEventListener("click", function () { setVisible(form, false); });
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    const name = ($("tournament-name").value || "").trim();
    const game = ($("tournament-game").value || "").trim();
    const fee = selectedChipAmount("tournament-fee");
    const size = selectedChipAmount("tournament-size");
    if (!name) { showMessage($("tournament-msg"), "Give the tournament a name.", false); $("tournament-name").focus(); return; }
    if (!game) { showMessage($("tournament-msg"), "Name the game you'll play.", false); $("tournament-game").focus(); return; }
    const btn = $("tournament-save");
    btn.disabled = true;
    session.client.rpc("rib_tournament_create", {
      p_name: name, p_game: game, p_entry_fee_cents: isFinite(fee) ? fee : 0, p_size: isFinite(size) ? size : 4,
      p_network: $("tournament-network").value || null,
    }).then(function (r) {
      if (r.error) { showMessage($("tournament-msg"), errorText(r.error, "Couldn't create the tournament."), false); return; }
      setVisible(form, false);
      $("tournament-msg").hidden = true;
      $("tournament-name").value = "";
      $("tournament-game").value = "";
      const id = r.data && r.data.id;
      toast(name + " is open and you're the first entrant. Share it so it fills.", "ok",
        id && navigator.clipboard ? { label: "Copy invite link", onClick: function () { navigator.clipboard.writeText(inviteUrl(id)); } } : null);
      loadTournaments();
      refreshWallet();
    })
      .catch(function () { showMessage($("tournament-msg"), "Network error. Check your connection and try again.", false); })
      .finally(function () { btn.disabled = false; });
  });

  let timer = null;
  $("tournament-search").addEventListener("input", function (e) {
    clearTimeout(timer);
    timer = setTimeout(function () { lobby.game = e.target.value.trim(); loadLobby(); }, 250);
  });
  $("tournament-filters").addEventListener("submit", function (e) { e.preventDefault(); });
  document.querySelectorAll("[data-tsize] button").forEach(function (b) {
    b.addEventListener("click", function () {
      document.querySelectorAll("[data-tsize] button").forEach(function (x) {
        x.classList.toggle("on", x === b);
        x.setAttribute("aria-pressed", String(x === b));
      });
      lobby.size = b.getAttribute("data-size") ? parseInt(b.getAttribute("data-size"), 10) : null;
      loadLobby();
    });
  });
}
