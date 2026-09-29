/* ============================================================================
 * Runinback — console tournaments: create, join, and (organizer) finish.
 * ========================================================================== */
import { byId as $, escapeHtml as esc, setVisible, showMessage } from "../lib/dom.js";
import { formatRcoin } from "../lib/format.js";
import { errorText, fetchUsernames, playerLabel, session } from "./context.js";
import { selectedChipAmount } from "./navigation.js";
import { refreshWallet } from "./wallet.js";

const STATUS_LABELS = {
  open: "Registration open", full: "Full", active: "In progress", payout_pending: "Prize under review",
  disputed: "Disputed: prize on hold", finished: "Finished", cancelled: "Cancelled",
};
// Mirrors rib_tournament_min_entrants() and rib_tournament_review_hours() (0019).
const MIN_ENTRANTS = 3;
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
          // Without entries we can't show who joined; don't render a wrong state.
          if (er.error) { list.innerHTML = '<p class="muted">Couldn\'t load tournament entries. Try again in a moment.</p>'; return; }
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
  if (t.status === "payout_pending") {
    const hours = Math.max(0, Math.ceil((new Date(t.payout_at).getTime() - Date.now()) / 3600000));
    let pending = '<span class="tag">' + esc(playerLabel(t.winner_id)) + " wins · paid in " + hours + " h</span>";
    if (joined && t.winner_id !== session.uid) pending += ' <button type="button" class="btn btn--sm" data-dispute="' + esc(t.id) + '">Dispute</button>';
    return pending;
  }
  if (t.status === "disputed") return '<span class="tag revoked">prize on hold for review</span>';
  let html = "";
  // Organizers can't enter their own paid tournament (enforced by the RPC too).
  const canJoin = t.status === "open" && !joined && !(isOrganizer && t.entry_fee_cents > 0);
  if (canJoin) html = '<button type="button" class="btn btn--cta btn--sm" data-join="' + esc(t.id) + '">Join ' + feeLabel(t) + "</button>";
  else if (joined) html = JOINED_TAG;
  // The organizer can't award the pool to themself (enforced by the RPC too).
  const candidates = entries.filter(function (e) { return e.user_id !== t.creator_id; });
  if (isOrganizer && (t.status === "open" || t.status === "full")) {
    html += ' <button type="button" class="btn btn--sm btn--danger" data-tcancel="' + esc(t.id) + '">Cancel</button>';
  }
  if (isOrganizer && (t.status === "open" || t.status === "full" || t.status === "active") && candidates.length) {
    if (entries.length < MIN_ENTRANTS) {
      html += ' <span class="tag">needs ' + (MIN_ENTRANTS - entries.length) + " more to finish</span>";
    } else {
      html += ' <select class="mini-sel" data-winner-select="' + esc(t.id) + '" aria-label="Winner"><option value="">Winner…</option>' +
        candidates.map(function (e) { return '<option value="' + esc(e.user_id) + '">' + esc(playerLabel(e.user_id)) + "</option>"; }).join("") +
        '</select><button type="button" class="btn btn--sm" data-finish="' + esc(t.id) + '">Finish</button>';
    }
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
  box.querySelectorAll("[data-dispute]").forEach(function (b) {
    b.addEventListener("click", function () {
      const reason = window.prompt("Why are you disputing this result? The prize is held while we review it.");
      if (reason === null) return;
      callTournamentRpc("rib_tournament_dispute", { p_tournament_id: b.getAttribute("data-dispute"), p_reason: reason }, b);
    });
  });
  box.querySelectorAll("[data-tcancel]").forEach(function (b) {
    b.addEventListener("click", function () {
      if (!window.confirm("Cancel this tournament? Every entry fee is refunded to its player.")) return;
      callTournamentRpc("rib_tournament_cancel", { p_tournament_id: b.getAttribute("data-tcancel") }, b);
    });
  });
  box.querySelectorAll("[data-finish]").forEach(function (b) {
    b.addEventListener("click", function () {
      const id = b.getAttribute("data-finish");
      const select = box.querySelector('[data-winner-select="' + id + '"]');
      const winner = select ? select.value : "";
      if (!winner) { showError("Pick a winner."); return; }
      if (!window.confirm("Declare this winner? The prize is paid after a 24-hour review window in which entrants can dispute it.")) return;
      callTournamentRpc("rib_tournament_finish", { p_tournament_id: id, p_winner_id: winner }, b);
    });
  });
}

function callTournamentRpc(fn, args, btn) {
  if (btn) btn.disabled = true;
  session.client.rpc(fn, args).then(function (r) {
    if (r.error) { showError(errorText(r.error, "Couldn't complete the action.")); if (btn) btn.disabled = false; loadTournaments(); return; }
    $("tournament-msg").hidden = true;
    loadTournaments();
    refreshWallet();
  }).catch(function () { if (btn) btn.disabled = false; showError("Network error. Check your connection and try again."); });
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
