/* ============================================================================
 * Runinback — console friendlies: free 1v1 challenges. The public lobby, my
 * friendlies, and the new-friendly form. Accepting one opens a match room
 * (room.js) where both players set up the lobby and report the result.
 * No money moves: paid competition lives in tournaments (tournaments.js).
 * ========================================================================== */
import { byId as $, escapeHtml as esc, setVisible, showMessage } from "../lib/dom.js";
import { formatTimeAgo } from "../lib/format.js";
import { errorText, fetchUsernames, playerLabel, session } from "./context.js";
import { NETWORKS, networkLabel } from "./networks.js";
import { USERNAME_PATTERN } from "./profile.js";
import { openRoom } from "./room.js";

const STATUS_LABELS = {
  open: "Open", pending: "Invite", active: "In the room", settled: "Finished", cancelled: "Closed",
};
const MINE_PAGE_SIZE = 50;
const LOBBY_PAGE_SIZE = 30;

const lobby = { game: "", cursor: null, cursorId: null, rows: [], request: 0, loading: false };

/* ---- lobby ---------------------------------------------------------------- */
function loadLobby(append) {
  if (!append) { lobby.cursor = null; lobby.cursorId = null; lobby.rows = []; }
  const request = ++lobby.request; // a newer search supersedes this response
  lobby.loading = true;
  $("lobby-more").disabled = true;
  $("challenge-open").setAttribute("aria-busy", "true");
  session.client.rpc("rib_open_challenges", {
    p_game: lobby.game || null,
    p_min_cents: null,
    p_max_cents: null,
    p_before: lobby.cursor,
    p_before_id: lobby.cursorId,
    p_limit: LOBBY_PAGE_SIZE,
  }).then(function (r) {
    if (request !== lobby.request) return;
    lobby.loading = false;
    $("lobby-more").disabled = false;
    const box = $("challenge-open");
    box.setAttribute("aria-busy", "false");
    if (r.error) {
      setVisible($("lobby-more"), false);
      if (!append) box.innerHTML = '<p class="muted">Couldn\'t load the lobby. Try again in a moment.</p>';
      $("lobby-status").textContent = "Couldn't load the lobby.";
      return;
    }
    const rows = Array.isArray(r.data) ? r.data : [];
    lobby.rows = lobby.rows.concat(rows);
    if (rows.length) {
      lobby.cursor = rows[rows.length - 1].created_at;
      lobby.cursorId = rows[rows.length - 1].id;
    }
    renderLobby(rows.length === LOBBY_PAGE_SIZE);
    $("lobby-status").textContent = lobby.rows.length === 1 ? "1 open friendly" : lobby.rows.length + " open friendlies";
  }).catch(function () {
    if (request !== lobby.request) return;
    lobby.loading = false;
    $("lobby-more").disabled = false;
    $("challenge-open").setAttribute("aria-busy", "false");
    if (!append) $("challenge-open").innerHTML = '<p class="muted">You\'re offline. The lobby loads when you reconnect.</p>';
  });
}

function renderLobby(hasMore) {
  const box = $("challenge-open");
  setVisible($("lobby-more"), hasMore);
  if (!lobby.rows.length) {
    box.innerHTML = lobby.game
      ? '<div class="empty"><h3>No friendlies match</h3><p>Try another game, or post your own friendly.</p></div>'
      : '<div class="empty"><h3>No open friendlies</h3><p>Post one and it shows up here for everyone. Friendlies are free.</p></div>';
    return;
  }
  box.innerHTML = '<div class="panel lobby">' + lobby.rows.map(function (c) {
    const account = c.network ? " · " + esc(networkLabel(c.network)) + " required" : "";
    return '<div class="row row--lobby">' +
      '<div><div class="row__name">' + esc(c.game) + ' <span class="row__mode">' + esc(c.mode) + "</span></div>" +
      '<div class="row__meta">@' + esc(c.creator_username) + " · " + esc(formatTimeAgo(c.created_at)) + account + "</div></div>" +
      '<span class="tag">free</span>' +
      '<button type="button" class="btn btn--cta btn--sm" data-accept="' + esc(c.id) + '">Accept</button>' +
      "</div>";
  }).join("") + "</div>";
  wireRowActions(box);
}

function initLobbyFilters() {
  let timer = null;
  $("lobby-game").addEventListener("input", function (e) {
    clearTimeout(timer);
    timer = setTimeout(function () { lobby.game = e.target.value.trim(); loadLobby(false); }, 250);
  });
  $("lobby-filters").addEventListener("submit", function (e) { e.preventDefault(); });
  $("lobby-more").addEventListener("click", function () { if (!lobby.loading) loadLobby(true); });
}

/* ---- my friendlies -------------------------------------------------------- */
function loadMine() {
  const uid = session.uid;
  session.client.from("challenges").select("*")
    .or("creator_id.eq." + uid + ",opponent_id.eq." + uid + ",target_id.eq." + uid)
    .order("created_at", { ascending: false })
    .limit(MINE_PAGE_SIZE)
    .then(function (r) {
      if (r.error) { $("challenge-mine").innerHTML = '<p class="muted">Couldn\'t load your friendlies. Try again in a moment.</p>'; return; }
      const rows = Array.isArray(r.data) ? r.data : [];
      const ids = [];
      rows.forEach(function (c) { ids.push(c.creator_id, c.opponent_id, c.target_id); });
      fetchUsernames(ids).then(function () { renderMine(rows); });
    });
}

export function loadChallenges() {
  loadLobby(false);
  loadMine();
}

function renderMine(rows) {
  const box = $("challenge-mine");
  if (!rows.length) {
    box.innerHTML = '<div class="empty"><h3>No friendlies yet</h3><p>Accept one from the lobby, or post your own with “New friendly”.</p></div>';
    return;
  }
  box.innerHTML = '<div class="panel">' + rows.map(function (c) {
    const versus = c.opponent_id ? playerLabel(c.opponent_id === session.uid ? c.creator_id : c.opponent_id)
      : (c.target_id ? playerLabel(c.target_id) + " (invited)" : "open");
    return '<div class="row row--challenge"><div><div class="row__name">' + esc(c.game) +
      '</div><div class="row__meta">' + esc(c.mode) + " · vs " + esc(versus) + " · " + (STATUS_LABELS[c.status] || esc(c.status)) + "</div></div>" +
      '<div class="row__act">' + actionsFor(c) + "</div></div>";
  }).join("") + "</div>";
  wireRowActions(box);
}

function actionsFor(c) {
  const isCreator = c.creator_id === session.uid;
  if (c.status === "open" || c.status === "pending") {
    if (isCreator) return '<button type="button" class="btn btn--sm btn--danger" data-cancel="' + esc(c.id) + '">Cancel</button>';
    if (c.target_id === session.uid) return '<button type="button" class="btn btn--cta btn--sm" data-accept="' + esc(c.id) + '">Accept</button>';
    return '<span class="tag">pending</span>';
  }
  if (c.status === "active" && c.room_id) return '<button type="button" class="btn btn--cta btn--sm" data-room="' + esc(c.room_id) + '">Open room</button>';
  if (c.status === "settled") {
    return c.winner_id === session.uid
      ? '<span class="tag" style="color:var(--c-good);border-color:rgba(53,208,127,.4)">won</span>'
      : '<span class="tag">lost</span>';
  }
  return '<span class="tag">' + (STATUS_LABELS[c.status] || esc(c.status)) + "</span>";
}

function acceptFriendly(btn) {
  btn.disabled = true;
  session.client.rpc("rib_challenge_accept", { p_challenge_id: btn.getAttribute("data-accept") }).then(function (r) {
    if (r.error) {
      btn.disabled = false;
      showMessage($("challenge-msg"), errorText(r.error, "Couldn't accept the friendly."), false);
      loadChallenges(); // someone else may have taken it
      return;
    }
    if (r.data && r.data.room_id) openRoom(r.data.room_id);
    else loadChallenges();
  }).catch(function () {
    btn.disabled = false;
    showMessage($("challenge-msg"), "Network error. Check your connection and try again.", false);
  });
}

function wireRowActions(box) {
  box.querySelectorAll("[data-accept]").forEach(function (b) {
    b.addEventListener("click", function () { acceptFriendly(b); });
  });
  box.querySelectorAll("[data-room]").forEach(function (b) {
    b.addEventListener("click", function () { openRoom(b.getAttribute("data-room")); });
  });
  box.querySelectorAll("[data-cancel]").forEach(function (b) {
    b.addEventListener("click", function () {
      b.disabled = true;
      session.client.rpc("rib_challenge_cancel", { p_challenge_id: b.getAttribute("data-cancel") }).then(function (r) {
        if (r.error) { b.disabled = false; showMessage($("challenge-msg"), errorText(r.error, "Couldn't cancel it."), false); return; }
        showMessage($("challenge-msg"), "Friendly cancelled.", true);
        loadChallenges();
      });
    });
  });
}

/** Fill a network <select> with the accounts this player has linked. */
export function fillNetworkSelect(select, linked) {
  if (!select) return;
  const keep = select.value;
  const have = (linked || []).map(function (a) { return a.network; });
  select.innerHTML = '<option value="">Not required</option>' + NETWORKS.filter(function (n) { return have.indexOf(n.id) !== -1; })
    .map(function (n) { return '<option value="' + n.id + '">' + esc(n.label) + "</option>"; }).join("");
  if (have.indexOf(keep) !== -1) select.value = keep;
}

// Friends are offered as opponents (a <datalist>, filled once per visit).
let friendsOffered = false;
function offerFriends() {
  if (friendsOffered || !session.client) return;
  friendsOffered = true;
  session.client.rpc("rib_friends", { p_limit: 100 }).then(function (r) {
    const list = $("friends-datalist");
    if (!list || r.error || !Array.isArray(r.data)) { friendsOffered = false; return; }
    list.innerHTML = r.data.map(function (f) { return '<option value="' + esc(f.username) + '"></option>'; }).join("");
  }).catch(function () { friendsOffered = false; });
}
document.addEventListener("rib:friends-changed", function () { friendsOffered = false; });

function openForm(target) {
  const form = $("challenge-form");
  setVisible(form, true);
  setVisible($("tournament-form"), false);
  $("challenge-msg").hidden = true;
  const tab = document.querySelector('#compete-seg [data-seg="friendlies"]');
  if (tab) tab.click();
  offerFriends();
  if (target) $("challenge-target").value = target;
  $("challenge-game").focus();
}

/** Open the friendly form addressed to a player (route "friendly/<username>"). */
export function prepareFriendly(arg) {
  const parts = String(arg || "").split("/");
  if (parts[0] !== "friendly" || !USERNAME_PATTERN.test(parts[1] || "")) return;
  openForm(parts[1]);
}

export function initChallenges() {
  const form = $("challenge-form");
  initLobbyFilters();

  $("challenge-new").addEventListener("click", function () {
    if (form.hidden) openForm(null);
    else { setVisible(form, false); $("challenge-msg").hidden = true; }
  });
  $("challenge-cancel").addEventListener("click", function () { setVisible(form, false); $("challenge-msg").hidden = true; });
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    const game = ($("challenge-game").value || "").trim();
    const mode = ($("challenge-mode").value || "1v1").trim();
    const target = ($("challenge-target").value || "").trim().replace(/^@/, "");
    if (!game) { showMessage($("challenge-msg"), "Name the game you'll play.", false); $("challenge-game").focus(); return; }
    if (target && !USERNAME_PATTERN.test(target)) { showMessage($("challenge-msg"), "Opponent: 3–24 characters, letters, numbers or underscore.", false); $("challenge-target").focus(); return; }
    const btn = $("challenge-save");
    btn.disabled = true;
    session.client.rpc("rib_challenge_create", {
      p_game: game, p_mode: mode, p_target_username: target || null, p_network: $("challenge-network").value || null,
    }).then(function (r) {
      if (r.error) { showMessage($("challenge-msg"), errorText(r.error, "Couldn't post the friendly."), false); return; }
      setVisible(form, false);
      $("challenge-game").value = "";
      $("challenge-target").value = "";
      showMessage($("challenge-msg"), target ? "Friendly sent to @" + target + "." : "Friendly posted to the lobby.", true);
      loadChallenges();
    })
      .catch(function () { showMessage($("challenge-msg"), "Network error. Check your connection and try again.", false); })
      .finally(function () { btn.disabled = false; });
  });
}
