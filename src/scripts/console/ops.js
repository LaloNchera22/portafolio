/* ============================================================================
 * Runinback — dispute queue for the Runinback team (operators allow-list,
 * migration 0022). Shows each disputed match with both reports, the reason,
 * the room chat and the captures, and resolves it: award one player (the
 * bracket advances) or void the match (both are eliminated).
 * ========================================================================== */
import { byId as $, escapeHtml as esc, showMessage } from "../lib/dom.js";
import { formatDate, formatRcoin } from "../lib/format.js";
import { errorText, session } from "./context.js";

const EVIDENCE_BUCKET = "room-evidence";

/** Show the "Dispute queue" menu entry only to operators. */
export function initOps() {
  session.client.rpc("rib_is_operator").then(function (r) {
    const link = $("acct-ops");
    if (link) link.hidden = !(r && r.data === true);
  });
}

export function loadOps() {
  const root = $("ops-root");
  session.client.rpc("rib_ops_room_disputes").then(function (r) {
    if (r.error) { root.innerHTML = '<p class="muted">' + esc(errorText(r.error, "Couldn't load the queue.")) + "</p>"; return; }
    const rows = Array.isArray(r.data) ? r.data : [];
    if (!rows.length) { root.innerHTML = '<div class="empty"><h3>No disputes</h3><p>Every match result has been agreed.</p></div>'; return; }
    root.innerHTML = rows.map(function (d) {
      const name = function (uid) { return uid === d.player_a ? "@" + (d.a_username || "player A") : "@" + (d.b_username || "player B"); };
      const claim = function (uid, report) { return name(uid) + " says " + (report ? name(report) + " won" : "nothing yet"); };
      return '<article class="ops-case" data-case="' + esc(d.id) + '">' +
        "<header><h2>" + esc(d.game) + (d.tournament_name ? " · " + esc(d.tournament_name) + " round " + d.round : " · friendly") + "</h2>" +
        '<span class="row__meta">' + esc(d.room_code || "") + " · disputed " + esc(formatDate(d.disputed_at)) +
        (d.entry_fee_cents ? " · entry " + formatRcoin(d.entry_fee_cents) + " · deposit " + formatRcoin(d.dispute_deposit_cents) : "") + "</span></header>" +
        "<ul><li>" + esc(claim(d.player_a, d.a_report)) + "</li><li>" + esc(claim(d.player_b, d.b_report)) + "</li></ul>" +
        '<p class="ops-case__reason"><strong>' + esc(name(d.disputed_by)) + ":</strong> " + esc(d.dispute_reason || "") + "</p>" +
        '<div class="ops-case__evidence" data-evidence-for="' + esc(d.id) + '">' + (d.evidence_count ? "Loading captures…" : "No captures.") + "</div>" +
        '<details class="ops-case__chat" data-chat-for="' + esc(d.id) + '"><summary>Room chat</summary><ol></ol></details>' +
        '<div class="field"><label for="note-' + esc(d.id) + '">Note for the players</label><input id="note-' + esc(d.id) + '" type="text" maxlength="200" placeholder="What decided it" /></div>' +
        '<div class="room-actions">' +
          '<button type="button" class="btn btn--sm" data-award="' + esc(d.player_a) + '">Award ' + esc(name(d.player_a)) + "</button>" +
          '<button type="button" class="btn btn--sm" data-award="' + esc(d.player_b) + '">Award ' + esc(name(d.player_b)) + "</button>" +
          '<button type="button" class="btn btn--sm btn--danger" data-void>Void match</button>' +
        '</div><p class="msg" hidden></p></article>';
    }).join("");
    rows.forEach(function (d) { loadCaseDetails(d.id); });
    root.querySelectorAll(".ops-case").forEach(wireCase);
  });
}

function loadCaseDetails(id) {
  session.client.from("room_evidence").select("storage_path, user_id, source").eq("room_id", id).then(function (r) {
    const box = document.querySelector('[data-evidence-for="' + id + '"]');
    const rows = Array.isArray(r && r.data) ? r.data : [];
    if (!box || !rows.length) return;
    session.client.storage.from(EVIDENCE_BUCKET).createSignedUrls(rows.map(function (e) { return e.storage_path; }), 900).then(function (s) {
      box.innerHTML = (s.data || []).map(function (item) {
        return item && item.signedUrl ? '<a href="' + esc(item.signedUrl) + '" target="_blank" rel="noopener"><img src="' + esc(item.signedUrl) + '" alt="Capture" /></a>' : "";
      }).join("");
    });
  });
  session.client.from("room_messages").select("user_id, body").eq("room_id", id).order("id").limit(200).then(function (r) {
    const list = document.querySelector('[data-chat-for="' + id + '"] ol');
    if (list) list.innerHTML = ((r && r.data) || []).map(function (m) { return "<li>" + esc(m.body) + "</li>"; }).join("") || "<li>No messages.</li>";
  });
}

function wireCase(card) {
  const id = card.getAttribute("data-case");
  const out = card.querySelector(".msg");
  const resolve = function (action, winner, btn) {
    const note = (card.querySelector("#note-" + id).value || "").trim();
    if (!window.confirm(action === "void" ? "Void this match? Both players are eliminated and any deposit is returned." : "Award this match? The bracket advances and a rejected dispute's deposit goes to the other player.")) return;
    btn.disabled = true;
    session.client.rpc("rib_room_resolve", { p_room_id: id, p_action: action, p_winner_id: winner || null, p_note: note || null }).then(function (r) {
      if (r.error) { btn.disabled = false; showMessage(out, errorText(r.error, "Couldn't resolve it."), false); return; }
      showMessage(out, "Resolved.", true);
      setTimeout(loadOps, 600);
    });
  };
  card.querySelectorAll("[data-award]").forEach(function (b) {
    b.addEventListener("click", function () { resolve("award", b.getAttribute("data-award"), b); });
  });
  const v = card.querySelector("[data-void]");
  if (v) v.addEventListener("click", function () { resolve("void", null, v); });
}
