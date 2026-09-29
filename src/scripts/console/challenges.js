/* ============================================================================
 * Runinback — console 1v1 challenges: the public lobby, my challenges, and the
 * new-challenge form with a custom entry fee. Every balance move runs in SECURITY
 * DEFINER RPCs (atomic escrow); the UI only validates to help the player.
 * ========================================================================== */
import { byId as $, escapeHtml as esc, setVisible, showMessage } from "../lib/dom.js";
import { formatRcoin, formatTimeAgo } from "../lib/format.js";
import { replayClass } from "../lib/motion.js";
import { STAKE_PRESETS_RCOIN, parseStake, potFor, stepStake } from "../lib/stake.js";
import { errorText, fetchUsernames, playerLabel, session } from "./context.js";
import { USERNAME_PATTERN } from "./profile.js";
import { refreshWallet } from "./wallet.js";

const STATUS_LABELS = {
  open: "Open", pending: "Invite", active: "In play", settled: "Finished", disputed: "In dispute", cancelled: "Cancelled",
};
const WON_TAG = '<span class="tag" style="color:var(--c-good);border-color:rgba(53,208,127,.4)">won</span>';
// Newest first; older rows stay reachable through the ledger.
const MINE_PAGE_SIZE = 50;
const LOBBY_PAGE_SIZE = 30;
// A match can be voided (both stakes refunded) after this long without a result.
const VOID_AFTER_MS = 2 * 60 * 60 * 1000;
const STAKE_RANGES = {
  any: [null, null],
  low: [null, 500],
  mid: [500, 2500],
  high: [2500, null],
};

const lobby = { game: "", range: "any", cursor: null, cursorId: null, rows: [], request: 0, loading: false };

function statusLabel(challenge) {
  return STATUS_LABELS[challenge.status] || challenge.status;
}

/* ---- lobby ---------------------------------------------------------------- */
function loadLobby(append) {
  if (!append) { lobby.cursor = null; lobby.cursorId = null; lobby.rows = []; }
  const range = STAKE_RANGES[lobby.range] || STAKE_RANGES.any;
  const request = ++lobby.request; // a newer filter change supersedes this response
  lobby.loading = true;
  $("lobby-more").disabled = true;
  $("challenge-open").setAttribute("aria-busy", "true");
  session.client.rpc("rib_open_challenges", {
    p_game: lobby.game || null,
    p_min_cents: range[0],
    p_max_cents: range[1],
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
    const rows = r.data || [];
    lobby.rows = lobby.rows.concat(rows);
    if (rows.length) {
      lobby.cursor = rows[rows.length - 1].created_at;
      lobby.cursorId = rows[rows.length - 1].id;
    }
    renderLobby(rows.length === LOBBY_PAGE_SIZE);
    $("lobby-status").textContent = lobby.rows.length === 1 ? "1 open challenge" : lobby.rows.length + " open challenges";
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
    const filtered = lobby.game || lobby.range !== "any";
    box.innerHTML = filtered
      ? '<div class="empty"><h3>No challenges match</h3><p>Try another game or entry fee, or post your own challenge.</p></div>'
      : '<div class="empty"><h3>The lobby is empty</h3><p>Post a challenge and it shows up here for everyone.</p></div>';
    return;
  }
  box.innerHTML = '<div class="panel lobby">' + lobby.rows.map(function (c) {
    return '<div class="row row--lobby">' +
      '<div><div class="row__name">' + esc(c.game) + ' <span class="row__mode">' + esc(c.mode) + "</span></div>" +
      '<div class="row__meta">@' + esc(c.creator_username) + " · " + esc(formatTimeAgo(c.created_at)) + "</div></div>" +
      '<div class="lobby__stake"><span class="lobby__num">' + formatRcoin(c.stake_cents) + '</span><span class="lobby__pot">prize ' + formatRcoin(c.stake_cents * 2) + "</span></div>" +
      '<button type="button" class="btn btn--cta btn--sm" data-accept="' + esc(c.id) + '" data-stake="' + esc(c.stake_cents) + '">Accept</button>' +
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
  document.querySelectorAll("[data-lobby-range] button").forEach(function (b) {
    b.addEventListener("click", function () {
      document.querySelectorAll("[data-lobby-range] button").forEach(function (x) {
        x.classList.toggle("on", x === b);
        x.setAttribute("aria-pressed", String(x === b));
      });
      lobby.range = b.getAttribute("data-range");
      loadLobby(false);
    });
  });
  $("lobby-more").addEventListener("click", function () { if (!lobby.loading) loadLobby(true); });
}

/* ---- my challenges -------------------------------------------------------- */
function loadMine() {
  const uid = session.uid;
  session.client.from("challenges").select("*")
    .or("creator_id.eq." + uid + ",opponent_id.eq." + uid + ",target_id.eq." + uid)
    .order("created_at", { ascending: false })
    .limit(MINE_PAGE_SIZE)
    .then(function (r) {
      if (r.error) { $("challenge-mine").innerHTML = '<p class="muted">Couldn\'t load your challenges. Try again in a moment.</p>'; return; }
      const rows = r.data || [];
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
    box.innerHTML = '<div class="empty"><h3>No challenges yet</h3><p>Accept one from the lobby, or post your own with “New challenge”.</p></div>';
    return;
  }
  box.innerHTML = '<div class="panel">' + rows.map(function (c) {
    const versus = c.opponent_id ? playerLabel(c.opponent_id === session.uid ? c.creator_id : c.opponent_id)
      : (c.target_id ? playerLabel(c.target_id) + " (invited)" : "open");
    return '<div class="row row--challenge"><div><div class="row__name">' + esc(c.game) + " · " + formatRcoin(c.stake_cents) +
      '</div><div class="row__meta">' + esc(c.mode) + " · vs " + esc(versus) + " · " + statusLabel(c) + "</div></div>" +
      '<div class="row__act">' + actionsFor(c) + "</div></div>";
  }).join("") + "</div>";
  wireRowActions(box);
}

function canVoid(c) {
  return (c.status === "active" || c.status === "disputed") && c.matched_at &&
    Date.now() - new Date(c.matched_at).getTime() > VOID_AFTER_MS;
}

function actionsFor(c) {
  const isCreator = c.creator_id === session.uid;
  const myReport = isCreator ? c.creator_report : c.opponent_report;
  const voidBtn = canVoid(c) ? '<button type="button" class="btn btn--sm" data-void="' + esc(c.id) + '">Void and refund</button>' : "";
  if (c.status === "open" || c.status === "pending") {
    if (isCreator) return '<button type="button" class="btn btn--sm btn--danger" data-cancel="' + esc(c.id) + '">Cancel</button>';
    if (c.target_id === session.uid) return '<button type="button" class="btn btn--cta btn--sm" data-accept="' + esc(c.id) + '" data-stake="' + esc(c.stake_cents) + '">Accept ' + formatRcoin(c.stake_cents) + "</button>";
    return '<span class="tag">pending</span>';
  }
  if (c.status === "active") {
    if (myReport) return '<span class="tag">waiting for opponent</span>' + voidBtn;
    const opponent = isCreator ? c.opponent_id : c.creator_id;
    return '<button type="button" class="btn btn--sm" data-won="' + esc(c.id) + '">I won</button>' +
      '<button type="button" class="btn btn--sm" data-lost="' + esc(c.id) + '" data-opponent="' + esc(opponent) + '">I lost</button>' + voidBtn;
  }
  if (c.status === "settled") return c.winner_id === session.uid ? WON_TAG : '<span class="tag revoked">lost</span>';
  if (c.status === "disputed") return '<span class="tag revoked">in dispute</span>' + voidBtn;
  return '<span class="tag">' + statusLabel(c) + "</span>";
}

function callChallengeRpc(fn, args, btn, okText) {
  if (btn) btn.disabled = true;
  session.client.rpc(fn, args).then(function (r) {
    if (r.error) {
      showMessage($("challenge-msg"), errorText(r.error, "Couldn't complete the action."), false);
      if (btn) btn.disabled = false;
      loadChallenges(); // someone else may have accepted or cancelled it
      return;
    }
    if (okText) showMessage($("challenge-msg"), okText, true);
    else $("challenge-msg").hidden = true;
    loadChallenges();
    refreshWallet();
  }).catch(function () {
    if (btn) btn.disabled = false;
    showMessage($("challenge-msg"), "Network error. Check your connection and try again.", false);
  });
}

// Results are final once both players agree, so confirm before sending.
function reportResult(id, winnerId, btn, won) {
  const text = won ? "Report that you won? If your opponent reports the same, you take the prize."
    : "Report that you lost? If your opponent reports the same, they take the prize.";
  if (!window.confirm(text)) return;
  callChallengeRpc("rib_challenge_report", { p_challenge_id: id, p_winner_id: winnerId }, btn, "Result sent. The prize is paid when both reports match.");
}

function acceptChallenge(btn) {
  const stake = parseInt(btn.getAttribute("data-stake"), 10);
  if (session.balanceCents != null && stake > session.balanceCents) {
    showMessage($("challenge-msg"), "You need " + formatRcoin(stake) + " to accept. Top up your wallet first.", false);
    return;
  }
  const ok = window.confirm("Accept for " + formatRcoin(stake) + "? Your entry fee is held in escrow and the winner takes " + formatRcoin(stake * 2) + ".");
  if (!ok) return;
  callChallengeRpc("rib_challenge_accept", { p_challenge_id: btn.getAttribute("data-accept") }, btn, "Challenge accepted. Play it, then report the result under My challenges.");
}

function wireRowActions(box) {
  box.querySelectorAll("[data-accept]").forEach(function (b) {
    b.addEventListener("click", function () { acceptChallenge(b); });
  });
  box.querySelectorAll("[data-cancel]").forEach(function (b) {
    b.addEventListener("click", function () { callChallengeRpc("rib_challenge_cancel", { p_challenge_id: b.getAttribute("data-cancel") }, b, "Challenge cancelled. Your stake is back in your wallet."); });
  });
  box.querySelectorAll("[data-void]").forEach(function (b) {
    b.addEventListener("click", function () {
      if (!window.confirm("Void this challenge? Both entry fees go back to their owners and nobody wins.")) return;
      callChallengeRpc("rib_challenge_void", { p_challenge_id: b.getAttribute("data-void") }, b, "Challenge voided. Your entry fee is back in your wallet.");
    });
  });
  box.querySelectorAll("[data-won]").forEach(function (b) {
    b.addEventListener("click", function () { reportResult(b.getAttribute("data-won"), session.uid, b, true); });
  });
  box.querySelectorAll("[data-lost]").forEach(function (b) {
    b.addEventListener("click", function () { reportResult(b.getAttribute("data-lost"), b.getAttribute("data-opponent"), b, false); });
  });
}

/* ---- stake composer ------------------------------------------------------- */
function initStakeComposer() {
  const input = $("challenge-stake-input");
  const summary = $("challenge-stake-help");
  const presets = document.querySelector("[data-stake-presets]");
  const save = $("challenge-save");

  presets.innerHTML = STAKE_PRESETS_RCOIN.map(function (r) {
    return '<button type="button" data-preset="' + r + '" aria-pressed="false">' + r + "</button>";
  }).join("");

  function update() {
    const parsed = parseStake(input.value, session.balanceCents == null ? undefined : session.balanceCents);
    presets.querySelectorAll("button").forEach(function (b) {
      const on = parsed.rcoin === parseInt(b.getAttribute("data-preset"), 10);
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    });
    $("challenge-stake").classList.toggle("is-invalid", !!parsed.error);
    input.setAttribute("aria-invalid", String(!!parsed.error));
    // Errors go to the alert region; the running summary stays silent.
    const errorBox = $("challenge-stake-error");
    if (errorBox.textContent !== (parsed.error ? "Error: " + parsed.error : "")) errorBox.textContent = parsed.error ? "Error: " + parsed.error : "";
    if (parsed.error) {
      summary.textContent = "";
    } else {
      const avail = session.balanceCents == null ? "" : " " + formatRcoin(session.balanceCents) + " available.";
      summary.textContent = "Both players pay " + parsed.rcoin + " rcoin. Winner takes " + potFor(parsed.rcoin) + " rcoin." + avail;
    }
    save.disabled = !!parsed.error;
    return parsed;
  }

  // Validate what was typed (stripping characters would turn "1.5" into 15).
  input.addEventListener("input", update);
  document.querySelectorAll("#challenge-stake [data-step]").forEach(function (b) {
    b.addEventListener("click", function () {
      input.value = String(stepStake(parseInt(input.value, 10), parseInt(b.getAttribute("data-step"), 10)));
      update();
      replayClass(input, "is-bumped");
    });
  });
  presets.addEventListener("click", function (e) {
    const b = e.target.closest("button[data-preset]");
    if (!b) return;
    input.value = b.getAttribute("data-preset");
    update();
  });
  document.addEventListener("rib:balance", update);
  update();
  return update;
}

export function initChallenges() {
  const form = $("challenge-form");
  const readStake = initStakeComposer();
  initLobbyFilters();

  $("challenge-new").addEventListener("click", function () {
    const open = form.hidden;
    setVisible(form, open);
    $("challenge-msg").hidden = true;
    if (open) $("challenge-game").focus();
  });
  $("challenge-cancel").addEventListener("click", function () { setVisible(form, false); $("challenge-msg").hidden = true; });
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    const game = ($("challenge-game").value || "").trim();
    const mode = ($("challenge-mode").value || "1v1").trim();
    const target = ($("challenge-target").value || "").trim().replace(/^@/, "");
    const stake = readStake();
    if (!game) { showMessage($("challenge-msg"), "Name the game you'll play.", false); $("challenge-game").focus(); return; }
    if (stake.error) { showMessage($("challenge-msg"), stake.error, false); $("challenge-stake-input").focus(); return; }
    if (target && !USERNAME_PATTERN.test(target)) { showMessage($("challenge-msg"), "Opponent: 3–24 characters, letters, numbers or underscore.", false); $("challenge-target").focus(); return; }
    const btn = $("challenge-save");
    btn.disabled = true;
    session.client.rpc("rib_challenge_create", { p_game: game, p_mode: mode, p_stake_cents: stake.cents, p_target_username: target || null })
      .then(function (r) {
        if (r.error) { showMessage($("challenge-msg"), errorText(r.error, "Couldn't post the challenge."), false); return; }
        setVisible(form, false);
        $("challenge-game").value = "";
        $("challenge-target").value = "";
        showMessage($("challenge-msg"), target ? "Challenge sent to @" + target + "." : "Challenge posted to the lobby.", true);
        loadChallenges();
        refreshWallet();
      })
      .catch(function () { showMessage($("challenge-msg"), "Network error. Check your connection and try again.", false); })
      .finally(function () { btn.disabled = false; readStake(); });
  });
}
