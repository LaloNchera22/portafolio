/* ============================================================================
 * Runinback — console tournaments: create, join, and (organizer) finish.
 * ========================================================================== */
import { byId as $, escapeHtml as esc, setVisible, showMessage } from "../lib/dom.js";
import { formatRcoin } from "../lib/format.js";
import { errorText, fetchUsernames, playerLabel, session } from "./context.js";
import { selectedChipAmount } from "./navigation.js";
import { refreshWallet } from "./wallet.js";

const STATUS_LABELS = {
  open: "Registration open", full: "Full", active: "In progress", finished: "Finished", cancelled: "Cancelled",
};
const JOINED_TAG = '<span class="tag" style="color:var(--c-good);border-color:rgba(53,208,127,.4)">joined</span>';

function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

function showError(text) {
  showMessage($("tournament-msg"), text, false);
}

function feeLabel(t) {
  return t.entry_fee_cents ? formatRcoin(t.entry_fee_cents) : "free";
}

export function loadTournaments() {
  session.client.from("tournaments").select("*").order("created_at", { ascending: false }).limit(50)
    .then(function (r) {
      const list = $("tournament-list");
      const tournaments = r.data || [];
      if (r.error) { list.innerHTML = '<p class="muted">Couldn\'t load tournaments.</p>'; return; }
      if (!tournaments.length) {
        list.innerHTML = '<div class="empty"><h3>No tournaments yet</h3><p>Create the first one: set the fee and the slots, and the pool builds from entries.</p></div>';
        return;
      }
      const ids = tournaments.map(function (t) { return t.id; });
      session.client.from("tournament_entries").select("tournament_id, user_id, placement").in("tournament_id", ids)
        .then(function (er) {
          const entries = er.data || [];
          const byTournament = {};
          entries.forEach(function (e) { (byTournament[e.tournament_id] = byTournament[e.tournament_id] || []).push(e); });
          const userIds = tournaments.map(function (t) { return t.creator_id; }).concat(entries.map(function (e) { return e.user_id; }));
          fetchUsernames(userIds).then(function () { render(tournaments, byTournament); });
        });
    });
}

function actionsFor(t, entries) {
  const joined = entries.some(function (e) { return e.user_id === session.uid; });
  const isOrganizer = t.creator_id === session.uid;
  if (t.status === "finished") {
    const winner = entries.filter(function (e) { return e.placement === 1; })[0];
    return '<span class="tag">won by ' + esc(winner ? playerLabel(winner.user_id) : "—") + "</span>";
  }
  let html = "";
  if (t.status === "open" && !joined) html = '<button type="button" class="btn btn--cta btn--sm" data-join="' + esc(t.id) + '">Join ' + feeLabel(t) + "</button>";
  else if (joined) html = JOINED_TAG;
  // The organizer can't award the pool to themself (enforced by the RPC too).
  const candidates = entries.filter(function (e) { return e.user_id !== t.creator_id; });
  if (isOrganizer && (t.status === "open" || t.status === "full" || t.status === "active") && candidates.length) {
    html += ' <select class="mini-sel" data-winner-select="' + esc(t.id) + '"><option value="">Winner…</option>' +
      candidates.map(function (e) { return '<option value="' + esc(e.user_id) + '">' + esc(playerLabel(e.user_id)) + "</option>"; }).join("") +
      '</select><button type="button" class="btn btn--sm" data-finish="' + esc(t.id) + '">Finish</button>';
  }
  return html;
}

function render(tournaments, byTournament) {
  const box = $("tournament-list");
  box.innerHTML = tournaments.map(function (t) {
    const entries = byTournament[t.id] || [];
    return '<div class="tcard"><div class="tcard__top"><div><div class="tcard__name">' + esc(t.name) + "</div>" +
      '<div class="row__meta">' + esc(t.game) + " · " + statusLabel(t.status) + "</div></div>" +
      '<div class="tcard__pool"><span class="k">pool</span><span class="v">' + formatRcoin(t.prize_pool_cents) + "</span></div></div>" +
      '<div class="tcard__mid"><span>Fee ' + feeLabel(t) + "</span>" +
      "<span>" + entries.length + "/" + t.max_players + " players</span></div>" +
      '<div class="tcard__act">' + actionsFor(t, entries) + "</div></div>";
  }).join("");

  box.querySelectorAll("[data-join]").forEach(function (b) {
    b.addEventListener("click", function () { callTournamentRpc("rib_tournament_join", { p_tournament_id: b.getAttribute("data-join") }, b); });
  });
  box.querySelectorAll("[data-finish]").forEach(function (b) {
    b.addEventListener("click", function () {
      const id = b.getAttribute("data-finish");
      const select = box.querySelector('[data-winner-select="' + id + '"]');
      const winner = select ? select.value : "";
      if (!winner) { showError("Pick a winner."); return; }
      callTournamentRpc("rib_tournament_finish", { p_tournament_id: id, p_winner_id: winner }, b);
    });
  });
}

function callTournamentRpc(fn, args, btn) {
  if (btn) btn.disabled = true;
  session.client.rpc(fn, args).then(function (r) {
    if (r.error) { showError(errorText(r.error, "Couldn't complete the action.")); if (btn) btn.disabled = false; return; }
    $("tournament-msg").hidden = true;
    loadTournaments();
    refreshWallet();
  }).catch(function () { if (btn) btn.disabled = false; });
}

export function initTournaments() {
  const form = $("tournament-form");
  $("tournament-new").addEventListener("click", function () { setVisible(form, true); $("tournament-name").focus(); });
  $("tournament-cancel").addEventListener("click", function () { setVisible(form, false); $("tournament-msg").hidden = true; });
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    const name = ($("tournament-name").value || "").trim();
    const game = ($("tournament-game").value || "").trim();
    let fee = selectedChipAmount("tournament-fee");
    const maxPlayers = parseInt($("tournament-max").value, 10);
    if (!name) { showError("Give the tournament a name."); return; }
    if (!game) { showError("Enter the game."); return; }
    if (!isFinite(fee)) fee = 0;
    const btn = $("tournament-save");
    btn.disabled = true;
    session.client.rpc("rib_tournament_create", { p_name: name, p_game: game, p_entry_fee_cents: fee, p_max_players: maxPlayers, p_starts_at: null })
      .then(function (r) {
        if (r.error) { showError(errorText(r.error, "Couldn't create.")); return; }
        setVisible(form, false);
        $("tournament-name").value = "";
        $("tournament-game").value = "";
        loadTournaments();
      })
      .catch(function () { showError("Network error."); })
      .finally(function () { btn.disabled = false; });
  });
}
