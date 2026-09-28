/* ============================================================================
 * Runinback — console 1v1 challenges: create, accept, cancel, report result.
 * Every balance move runs in SECURITY DEFINER RPCs (atomic escrow).
 * ========================================================================== */
import { byId as $, escapeHtml as esc, setVisible, showMessage } from "../lib/dom.js";
import { formatRcoin } from "../lib/format.js";
import { errorText, fetchUsernames, playerLabel, session } from "./context.js";
import { selectedChipAmount } from "./navigation.js";
import { refreshWallet } from "./wallet.js";

const STATUS_LABELS = {
  open: "Open", pending: "Invite", active: "In play", settled: "Finished", disputed: "In dispute", cancelled: "Cancelled",
};
// Newest first; older rows stay reachable through the ledger.
const CHALLENGE_PAGE_SIZE = 50;
const WON_TAG = '<span class="tag" style="color:var(--c-good);border-color:rgba(53,208,127,.4)">won</span>';

function statusLabel(challenge) {
  return STATUS_LABELS[challenge.status] || challenge.status;
}

export function loadChallenges() {
  const uid = session.uid;
  session.client.from("challenges").select("*")
    .or("creator_id.eq." + uid + ",opponent_id.eq." + uid + ",target_id.eq." + uid)
    .order("created_at", { ascending: false })
    .limit(CHALLENGE_PAGE_SIZE)
    .then(function (r) {
      const rows = r.data || [];
      const ids = [];
      rows.forEach(function (c) { ids.push(c.creator_id, c.opponent_id, c.target_id); });
      fetchUsernames(ids).then(function () { renderMine(rows); });
    });
  session.client.from("challenges").select("*").eq("status", "open").neq("creator_id", uid)
    .order("created_at", { ascending: false })
    .limit(CHALLENGE_PAGE_SIZE)
    .then(function (r) {
      const rows = r.data || [];
      fetchUsernames(rows.map(function (c) { return c.creator_id; })).then(function () { renderOpen(rows); });
    });
}

function renderMine(rows) {
  const box = $("challenge-mine");
  if (!rows.length) {
    box.innerHTML = '<div class="empty"><h3>No challenges yet</h3><p>Create one above: set the game and the stake, and leave it open or challenge someone by username.</p></div>';
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

function renderOpen(rows) {
  const box = $("challenge-open");
  if (!rows.length) {
    box.innerHTML = '<div class="empty"><h3>No open challenges right now</h3><p>Create yours and wait for someone to accept.</p></div>';
    return;
  }
  box.innerHTML = '<div class="panel">' + rows.map(function (c) {
    return '<div class="row row--challenge"><div><div class="row__name">' + esc(c.game) + " · " + formatRcoin(c.stake_cents) +
      '</div><div class="row__meta">' + esc(c.mode) + " · from " + esc(playerLabel(c.creator_id)) + "</div></div>" +
      '<div class="row__act"><button type="button" class="btn btn--cta btn--sm" data-accept="' + esc(c.id) + '">Accept ' + formatRcoin(c.stake_cents) + "</button></div></div>";
  }).join("") + "</div>";
  wireRowActions(box);
}

function actionsFor(c) {
  const isCreator = c.creator_id === session.uid;
  const myReport = isCreator ? c.creator_report : c.opponent_report;
  if (c.status === "open" || c.status === "pending") {
    if (isCreator) return '<button type="button" class="btn btn--sm btn--danger" data-cancel="' + esc(c.id) + '">Cancel</button>';
    if (c.target_id === session.uid) return '<button type="button" class="btn btn--cta btn--sm" data-accept="' + esc(c.id) + '">Accept ' + formatRcoin(c.stake_cents) + "</button>";
    return '<span class="tag">pending</span>';
  }
  if (c.status === "active") {
    if (myReport) return '<span class="tag">waiting for opponent</span>';
    return '<button type="button" class="btn btn--sm" data-won="' + esc(c.id) + '">I won</button>' +
      '<button type="button" class="btn btn--sm" data-lost="' + esc(c.id) + '">I lost</button>';
  }
  if (c.status === "settled") return c.winner_id === session.uid ? WON_TAG : '<span class="tag revoked">lost</span>';
  if (c.status === "disputed") return '<span class="tag revoked">in dispute</span>';
  return '<span class="tag">' + statusLabel(c) + "</span>";
}

function callChallengeRpc(fn, args, btn) {
  if (btn) btn.disabled = true;
  session.client.rpc(fn, args).then(function (r) {
    if (r.error) {
      showMessage($("challenge-msg"), errorText(r.error, "Couldn't complete the action."), false);
      if (btn) btn.disabled = false;
      return;
    }
    $("challenge-msg").hidden = true;
    loadChallenges();
    refreshWallet();
  }).catch(function () { if (btn) btn.disabled = false; });
}

function reportResult(id, winnerId, btn) {
  callChallengeRpc("rib_challenge_report", { p_challenge_id: id, p_winner_id: winnerId }, btn);
}

function wireRowActions(box) {
  box.querySelectorAll("[data-accept]").forEach(function (b) {
    b.addEventListener("click", function () { callChallengeRpc("rib_challenge_accept", { p_challenge_id: b.getAttribute("data-accept") }, b); });
  });
  box.querySelectorAll("[data-cancel]").forEach(function (b) {
    b.addEventListener("click", function () { callChallengeRpc("rib_challenge_cancel", { p_challenge_id: b.getAttribute("data-cancel") }, b); });
  });
  box.querySelectorAll("[data-won]").forEach(function (b) {
    b.addEventListener("click", function () { reportResult(b.getAttribute("data-won"), session.uid, b); });
  });
  box.querySelectorAll("[data-lost]").forEach(function (b) {
    b.addEventListener("click", function () {
      const id = b.getAttribute("data-lost");
      session.client.from("challenges").select("creator_id, opponent_id").eq("id", id).single().then(function (r) {
        if (r.error || !r.data) return;
        const other = r.data.creator_id === session.uid ? r.data.opponent_id : r.data.creator_id;
        reportResult(id, other, b);
      });
    });
  });
}

export function initChallenges() {
  const form = $("challenge-form");
  $("challenge-new").addEventListener("click", function () { setVisible(form, true); $("challenge-game").focus(); });
  $("challenge-cancel").addEventListener("click", function () { setVisible(form, false); $("challenge-msg").hidden = true; });
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    const game = ($("challenge-game").value || "").trim();
    const mode = ($("challenge-mode").value || "1v1").trim();
    const stake = selectedChipAmount("challenge-stake");
    const target = ($("challenge-target").value || "").trim();
    if (!game) { showMessage($("challenge-msg"), "Enter the game.", false); return; }
    if (!isFinite(stake)) { showMessage($("challenge-msg"), "Pick a stake.", false); return; }
    const btn = $("challenge-save");
    btn.disabled = true;
    session.client.rpc("rib_challenge_create", { p_game: game, p_mode: mode, p_stake_cents: stake, p_target_username: target || null })
      .then(function (r) {
        if (r.error) { showMessage($("challenge-msg"), errorText(r.error, "Couldn't create the challenge."), false); return; }
        setVisible(form, false);
        $("challenge-game").value = "";
        $("challenge-target").value = "";
        loadChallenges();
        refreshWallet();
      })
      .catch(function () { showMessage($("challenge-msg"), "Network error.", false); })
      .finally(function () { btn.disabled = false; });
  });
}
