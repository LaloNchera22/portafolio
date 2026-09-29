/* ============================================================================
 * Runinback — console tournaments: sit & go events of 4 or 8 players.
 * Browse the ones waiting for players, create one (you're the first entrant),
 * join or leave before it starts, follow the bracket, and jump into your
 * match room. Seeding, advancement and payouts happen in the database
 * (migration 0022); prizes are 90% of the pool, split 70/30.
 * ========================================================================== */
import { byId as $, escapeHtml as esc, setVisible, showMessage } from "../lib/dom.js";
import { formatRcoin } from "../lib/format.js";
import { prizeSplit, roundName, roundsFor } from "../lib/tournament.js";
import { errorText, session } from "./context.js";
import { selectedChipAmount } from "./navigation.js";
import { networkLabel } from "./networks.js";
import { openRoom } from "./room.js";
import { refreshWallet } from "./wallet.js";

const STATUS_LABELS = { open: "Waiting for players", active: "In progress", finished: "Finished", cancelled: "Cancelled" };
const lobby = { game: "", size: null, request: 0 };
const openBrackets = {}; // tournament id -> bracket expanded

function msg(text, ok) { showMessage($("challenge-msg"), text, ok); }

function feeText(cents) { return cents ? formatRcoin(cents) : "Free"; }

function prizeLine(feeCents, size) {
  if (!feeCents) return "Free · no prize";
  const s = prizeSplit(feeCents, size);
  return "Champion " + formatRcoin(s.first) + " · runner-up " + formatRcoin(s.second);
}

/* ---- lobby ---------------------------------------------------------------- */
export function loadTournaments() {
  loadLiveRooms();
  loadLobby();
  loadMine();
}

function loadLobby() {
  const request = ++lobby.request;
  const box = $("tournament-list");
  box.setAttribute("aria-busy", "true");
  session.client.rpc("rib_open_tournaments", { p_game: lobby.game || null, p_size: lobby.size, p_limit: 30 }).then(function (r) {
    if (request !== lobby.request) return;
    box.setAttribute("aria-busy", "false");
    if (r.error) { box.innerHTML = '<p class="muted">Couldn\'t load tournaments. Try again in a moment.</p>'; return; }
    const rows = Array.isArray(r.data) ? r.data : [];
    if (!rows.length) {
      box.innerHTML = '<div class="empty"><h3>' + (lobby.game || lobby.size ? "No tournaments match" : "No tournaments waiting") +
        '</h3><p>Create one: pick the game, 4 or 8 players and the entry fee. It starts the moment it fills.</p>' +
        '<p><button type="button" class="btn btn--cta btn--sm" data-create>New tournament</button></p></div>';
      const b = box.querySelector("[data-create]");
      if (b) b.addEventListener("click", function () { $("tournament-new").click(); });
      return;
    }
    box.innerHTML = '<div class="tgrid">' + rows.map(function (t) {
      const pct = Math.round((t.entrants / t.size) * 100);
      const need = t.size - t.entrants;
      const action = t.joined
        ? '<span class="tag tag--good">joined</span><button type="button" class="btn btn--sm" data-leave="' + esc(t.id) + '">Leave</button>'
        : '<button type="button" class="btn btn--cta btn--sm" data-join="' + esc(t.id) + '" data-fee="' + esc(t.entry_fee_cents) + '">Join · ' + feeText(t.entry_fee_cents) + "</button>";
      return '<article class="tcard">' +
        '<div class="tcard__top"><div><h3 class="tcard__name">' + esc(t.name) + "</h3>" +
          '<div class="row__meta">' + esc(t.game) + (t.network ? " · " + esc(networkLabel(t.network)) : "") + " · by @" + esc(t.creator_username || "player") + "</div></div>" +
          '<div class="tcard__pool"><span class="k">entry</span><span class="v">' + feeText(t.entry_fee_cents) + "</span></div></div>" +
        '<div class="tcard__fill" role="progressbar" aria-label="Players joined" aria-valuemin="0" aria-valuemax="' + t.size + '" aria-valuenow="' + t.entrants + '">' +
          '<span style="width:' + pct + '%"></span></div>' +
        '<div class="tcard__mid"><span>' + t.entrants + "/" + t.size + " players" + (need > 0 ? " · " + need + " to start" : "") + "</span><span>" + prizeLine(t.entry_fee_cents, t.size) + "</span></div>" +
        '<div class="tcard__act">' + action + "</div></article>";
    }).join("") + "</div>";
    wireLobby(box);
  }).catch(function () {
    if (request !== lobby.request) return;
    box.setAttribute("aria-busy", "false");
    box.innerHTML = '<p class="muted">You\'re offline. Tournaments load when you reconnect.</p>';
  });
}

function wireLobby(box) {
  box.querySelectorAll("[data-join]").forEach(function (b) {
    b.addEventListener("click", function () {
      const fee = parseInt(b.getAttribute("data-fee"), 10) || 0;
      if (fee && session.balanceCents != null && fee > session.balanceCents) {
        msg("You need " + formatRcoin(fee) + " to join. Top up your wallet first.", false);
        return;
      }
      if (fee && !window.confirm("Join for " + formatRcoin(fee) + "? You can leave and get it back until the tournament fills.")) return;
      call("rib_tournament_join", { p_tournament_id: b.getAttribute("data-join") }, b, function (t) {
        msg(t && t.status === "active" ? "You're in, and the tournament just started. Your first match is ready." : "You're in. It starts as soon as it fills.", true);
      });
    });
  });
  box.querySelectorAll("[data-leave]").forEach(function (b) {
    b.addEventListener("click", function () {
      call("rib_tournament_leave", { p_tournament_id: b.getAttribute("data-leave") }, b, function () { msg("You left the tournament. Your entry fee is back.", true); });
    });
  });
}

function call(fn, args, btn, onOk) {
  if (btn) btn.disabled = true;
  return session.client.rpc(fn, args).then(function (r) {
    if (btn) btn.disabled = false;
    if (r.error) { msg(errorText(r.error, "Couldn't complete the action."), false); loadTournaments(); return; }
    if (onOk) onOk(r.data);
    loadTournaments();
    refreshWallet();
  }).catch(function () {
    if (btn) btn.disabled = false;
    msg("Network error. Check your connection and try again.", false);
  });
}

/* ---- live rooms: "your match is ready" ------------------------------------ */
function loadLiveRooms() {
  const box = $("live-rooms");
  if (!box) return;
  session.client.rpc("rib_my_rooms").then(function (r) {
    const rows = Array.isArray(r && r.data) ? r.data : [];
    setVisible(box, rows.length > 0);
    box.innerHTML = rows.map(function (m) {
      const where = m.kind === "tournament" ? esc(m.tournament_name || "Tournament") : "Friendly";
      const state = m.status === "ready_check" ? "Ready check open" : m.status === "live" ? (m.confirm_deadline ? "Result waiting for confirmation" : "Match on") : "In review";
      return '<div class="live-room"><div><span class="live-room__dot" aria-hidden="true"></span><strong>' + where + "</strong> · " + esc(m.game) +
        " vs @" + esc(m.opponent_username || "opponent") + '<div class="row__meta">' + state + "</div></div>" +
        '<button type="button" class="btn btn--cta btn--sm" data-room="' + esc(m.id) + '">Open room</button></div>';
    }).join("");
    box.querySelectorAll("[data-room]").forEach(function (b) {
      b.addEventListener("click", function () { openRoom(b.getAttribute("data-room")); });
    });
  });
}

/* ---- my tournaments ------------------------------------------------------- */
function loadMine() {
  const box = $("tournament-mine");
  session.client.rpc("rib_my_tournaments", { p_limit: 30 }).then(function (r) {
    if (r.error) { box.innerHTML = '<p class="muted">Couldn\'t load your tournaments.</p>'; return; }
    const rows = Array.isArray(r.data) ? r.data : [];
    if (!rows.length) {
      box.innerHTML = '<div class="empty"><h3>No tournaments yet</h3><p>Join one from the Tournaments tab, or create your own.</p></div>';
      return;
    }
    box.innerHTML = '<div class="panel">' + rows.map(function (t) {
      let result = STATUS_LABELS[t.status] || t.status;
      if (t.status === "finished") {
        result = t.placement === 1 ? "Champion" : t.placement === 2 ? "Runner-up" : "Won by @" + (t.winner_username || "player");
      }
      const canBracket = t.status === "active" || t.status === "finished";
      return '<div class="row row--tmine"><div><div class="row__name">' + esc(t.name) + '</div><div class="row__meta">' + esc(t.game) + " · " +
        t.entrants + "/" + t.size + " players · " + feeText(t.entry_fee_cents) + " · " + esc(result) + "</div>" +
        '<div class="bracket" id="bracket-' + esc(t.id) + '" hidden></div></div>' +
        '<div class="row__act">' + (canBracket ? '<button type="button" class="btn btn--sm" data-bracket="' + esc(t.id) + '" data-size="' + t.size + '" aria-expanded="false">Bracket</button>' : "") +
        (t.status === "open" ? '<button type="button" class="btn btn--sm" data-leave="' + esc(t.id) + '">Leave</button>' : "") + "</div></div>";
    }).join("") + "</div>";
    box.querySelectorAll("[data-bracket]").forEach(function (b) {
      const id = b.getAttribute("data-bracket");
      b.addEventListener("click", function () { toggleBracket(id, parseInt(b.getAttribute("data-size"), 10), b); });
      if (openBrackets[id]) toggleBracket(id, parseInt(b.getAttribute("data-size"), 10), b, true);
    });
    wireLobby(box);
  });
}

function toggleBracket(id, size, btn, forceOpen) {
  const box = $("bracket-" + id);
  const open = forceOpen || box.hidden;
  box.hidden = !open;
  btn.setAttribute("aria-expanded", String(open));
  openBrackets[id] = open;
  if (!open) return;
  box.innerHTML = '<p class="muted is-loading">Loading…</p>';
  session.client.rpc("rib_tournament_bracket", { p_tournament_id: id }).then(function (r) {
    const rows = Array.isArray(r && r.data) ? r.data : [];
    const rounds = roundsFor(size);
    const cols = [];
    for (let i = 1; i <= rounds; i++) cols.push(rows.filter(function (m) { return m.round === i; }));
    const player = function (m, uid, name) {
      if (!uid) return '<span class="bracket__p is-tbd">TBD</span>';
      const won = m.winner_id && m.winner_id === uid;
      const lost = m.winner_id && m.winner_id !== uid;
      return '<span class="bracket__p' + (won ? " is-win" : "") + (lost ? " is-out" : "") + (uid === session.uid ? " is-me" : "") + '">@' + esc(name || "player") + "</span>";
    };
    box.innerHTML = '<div class="bracket__cols">' + cols.map(function (col, i) {
      return '<div class="bracket__col"><h4>' + roundName(i + 1, rounds) + "</h4>" + col.map(function (m) {
        const mine = m.player_a === session.uid || m.player_b === session.uid;
        const liveMine = mine && (m.status === "ready_check" || m.status === "live" || m.status === "disputed");
        return '<div class="bracket__m">' + player(m, m.player_a, m.a_username) + player(m, m.player_b, m.b_username) +
          (m.walkover ? '<span class="bracket__note">walkover</span>' : m.status === "void" ? '<span class="bracket__note">no result</span>' : "") +
          (liveMine ? '<button type="button" class="btn btn--cta btn--sm" data-room="' + esc(m.room_id) + '">Open room</button>' : "") + "</div>";
      }).join("") + "</div>";
    }).join("") + "</div>";
    box.querySelectorAll("[data-room]").forEach(function (b) {
      b.addEventListener("click", function () { openRoom(b.getAttribute("data-room")); });
    });
  });
}

/* ---- create --------------------------------------------------------------- */
function updatePrizePreview() {
  const fee = selectedChipAmount("tournament-fee") || 0;
  const size = selectedChipAmount("tournament-size") || 4;
  const box = $("tournament-prize");
  if (!box) return;
  if (!fee) { box.innerHTML = "<div><dt>Prize</dt><dd>Free tournament, no prize</dd></div>"; return; }
  const s = prizeSplit(fee, size);
  box.innerHTML =
    "<div><dt>Pool</dt><dd>" + formatRcoin(s.pool) + "</dd></div>" +
    "<div><dt>Champion</dt><dd>" + formatRcoin(s.first) + "</dd></div>" +
    "<div><dt>Runner-up</dt><dd>" + formatRcoin(s.second) + "</dd></div>" +
    "<div><dt>Platform (10%)</dt><dd>" + formatRcoin(s.platform) + "</dd></div>";
}

export function initTournaments() {
  const form = $("tournament-form");
  document.querySelectorAll('[data-chips="tournament-fee"] button, [data-chips="tournament-size"] button').forEach(function (b) {
    b.addEventListener("click", function () { setTimeout(updatePrizePreview, 0); });
  });
  updatePrizePreview();

  $("tournament-new").addEventListener("click", function () {
    const open = form.hidden;
    setVisible(form, open);
    setVisible($("challenge-form"), false);
    $("challenge-msg").hidden = true;
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
    if (!name) { msg("Give the tournament a name.", false); $("tournament-name").focus(); return; }
    if (!game) { msg("Name the game you'll play.", false); $("tournament-game").focus(); return; }
    const btn = $("tournament-save");
    btn.disabled = true;
    session.client.rpc("rib_tournament_create", {
      p_name: name, p_game: game, p_entry_fee_cents: isFinite(fee) ? fee : 0, p_size: isFinite(size) ? size : 4,
      p_network: $("tournament-network").value || null,
    }).then(function (r) {
      if (r.error) { msg(errorText(r.error, "Couldn't create the tournament."), false); return; }
      setVisible(form, false);
      $("tournament-name").value = "";
      $("tournament-game").value = "";
      msg("Tournament created and you're the first entrant. Share it so it fills.", true);
      loadTournaments();
      refreshWallet();
    })
      .catch(function () { msg("Network error. Check your connection and try again.", false); })
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
