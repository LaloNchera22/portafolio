/* ============================================================================
 * Runinback — dispute queue for the Runinback team (operators allow-list,
 * migration 0022). Shows each disputed match with both reports, the reason,
 * the room chat and the captures, and resolves it: award one player (the
 * bracket advances) or void the match (both are eliminated).
 *
 * Hosted tournaments (migration 0027, rib_ops_hosted_queue): open appeals
 * (uphold / overturn to a player / refund all, rib_appeal_resolve) and live
 * hosted matches the host left undecided past the 60-minute window (decide
 * or void them like the host would: rib_host_decide / rib_host_void_room).
 * ========================================================================== */
import { byId as $, escapeHtml as esc, showMessage } from "../lib/dom.js";
import { formatDate, formatRcoin } from "../lib/format.js";
import { peakArt } from "./art.js";
import { confirmAction } from "./confirm.js";
import { errorText, session } from "./context.js";
import { normalizeBracket, roundLabel } from "../lib/hosted.js";
import { openRoom } from "./room.js";

const EVIDENCE_BUCKET = "room-evidence";

const CHECK_LABEL = {
  verified: ["Verified", "chip--good"], contradicts: ["Doesn't match", "chip--escrow"], unreadable: ["Couldn't read it", ""],
  duplicate: ["Used in another match", "chip--escrow"], skipped: ["Not checked", ""], pending: ["Not checked", ""],
};

export function loadOps() {
  loadHostedQueue();
  const root = $("ops-root");
  root.setAttribute("aria-busy", "true");
  session.client.rpc("rib_ops_room_disputes").then(function (r) {
    root.setAttribute("aria-busy", "false");
    if (r.error) { root.innerHTML = '<p class="muted">' + esc(errorText(r.error, "Couldn't load the queue.")) + "</p>"; return; }
    const rows = Array.isArray(r.data) ? r.data : [];
    if (!rows.length) { root.innerHTML = '<div class="empty">' + peakArt("settle") + "<h3>No disputes</h3><p>Every match result has been agreed. New disputes show up here, oldest first.</p></div>"; return; }
    root.innerHTML = rows.map(function (d) {
      const name = function (uid) { return uid === d.player_a ? "@" + (d.a_username || "player A") : "@" + (d.b_username || "player B"); };
      const claim = function (uid, report) { return name(uid) + " says " + (report ? name(report) + " won" : "nothing yet"); };
      return '<article class="ops-case' + (d.review_flag ? " is-flagged" : "") + '" data-case="' + esc(d.id) + '">' +
        "<header><h2>" + esc(d.tournament_name || "Tournament") + " · round " + esc(d.round) + "</h2>" +
        (d.review_flag ? '<span class="chip chip--escrow">Flagged by the end-screen check</span> ' : "") +
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
    rows.forEach(function (d) { loadCaseDetails(d); });
    root.querySelectorAll(".ops-case").forEach(wireCase);
  });
}

// Oldest dispute first (the RPC orders by disputed_at). Captures and chat
// lines carry who posted them so the reviewer can tell the players apart.
function loadCaseDetails(d) {
  const id = d.id;
  const who = function (uid) {
    if (uid === d.player_a) return "@" + (d.a_username || "player A");
    if (uid === d.player_b) return "@" + (d.b_username || "player B");
    return "Runinback";
  };
  const time = function (iso) {
    try { return new Date(iso).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; }
  };
  session.client.from("room_evidence").select("storage_path, user_id, source, check_status").eq("room_id", id).then(function (r) {
    const box = document.querySelector('[data-evidence-for="' + id + '"]');
    const rows = Array.isArray(r && r.data) ? r.data : [];
    if (!box || !rows.length) return;
    session.client.storage.from(EVIDENCE_BUCKET).createSignedUrls(rows.map(function (e) { return e.storage_path; }), 900).then(function (s) {
      box.innerHTML = (s.data || []).map(function (item, i) {
        if (!item || !item.signedUrl) return "";
        const label = who(rows[i].user_id) + " · " + (rows[i].source || "capture");
        const check = CHECK_LABEL[rows[i].check_status];
        return '<figure><a href="' + esc(item.signedUrl) + '" target="_blank" rel="noopener"><img src="' + esc(item.signedUrl) + '" alt="Capture from ' + esc(label) + '" /></a>' +
          "<figcaption>" + esc(label) + (check ? ' <span class="chip ' + check[1] + '">' + check[0] + "</span>" : "") + "</figcaption></figure>";
      }).join("");
    });
  });
  session.client.from("room_messages").select("user_id, body, created_at").eq("room_id", id).order("id").limit(200).then(function (r) {
    const list = document.querySelector('[data-chat-for="' + id + '"] ol');
    if (list) list.innerHTML = ((r && r.data) || []).map(function (m) {
      return '<li><span class="ops-case__who">' + esc(who(m.user_id)) + '</span> <span class="ops-case__at">' + esc(time(m.created_at)) + "</span> " + esc(m.body) + "</li>";
    }).join("") || "<li>No messages.</li>";
  });
}

function wireCase(card) {
  const id = card.getAttribute("data-case");
  const out = card.querySelector(".msg");
  const resolve = function (action, winner, btn) {
    const note = (card.querySelector("#note-" + id).value || "").trim();
    confirmAction(action === "void"
      ? { title: "Void this match?", body: "Both players are eliminated and any deposit is returned.", ok: "Void match", danger: true }
      : { title: "Award this match to " + btn.textContent.replace(/^Award /, "") + "?", body: "The bracket advances and a rejected dispute's deposit goes to the other player.", ok: "Award match" },
    ).then(function (ok) {
      if (!ok) return;
      btn.disabled = true;
      session.client.rpc("rib_room_resolve", { p_room_id: id, p_action: action, p_winner_id: winner || null, p_note: note || null }).then(function (r) {
        if (r.error) { btn.disabled = false; showMessage(out, errorText(r.error, "Couldn't resolve it."), false); return; }
        showMessage(out, "Resolved.", true);
        setTimeout(loadOps, 600);
      }).catch(function () { btn.disabled = false; showMessage(out, "Network error. Try again.", false); });
    });
  };
  card.querySelectorAll("[data-award]").forEach(function (b) {
    b.addEventListener("click", function () { resolve("award", b.getAttribute("data-award"), b); });
  });
  const v = card.querySelector("[data-void]");
  if (v) v.addEventListener("click", function () { resolve("void", null, v); });
}

/* ---- hosted tournaments: appeals and flagged matches ------------------------ */
function loadHostedQueue() {
  const appeals = $("ops-appeals");
  const flagged = $("ops-flagged");
  if (!appeals || !flagged) return;
  appeals.setAttribute("aria-busy", "true");
  flagged.setAttribute("aria-busy", "true");
  Promise.resolve(session.client.rpc("rib_ops_hosted_queue")).then(function (r) {
    appeals.setAttribute("aria-busy", "false");
    flagged.setAttribute("aria-busy", "false");
    if (!r || r.error) {
      const text = '<p class="muted">' + esc(errorText(r && r.error, "Couldn't load the hosted queue.")) + "</p>";
      appeals.innerHTML = text;
      flagged.innerHTML = "";
      return;
    }
    const data = r.data && typeof r.data === "object" ? r.data : {};
    renderAppeals(appeals, Array.isArray(data.appeals) ? data.appeals : []);
    renderFlagged(flagged, Array.isArray(data.flagged_rooms) ? data.flagged_rooms : []);
  }).catch(function () {
    appeals.setAttribute("aria-busy", "false");
    flagged.setAttribute("aria-busy", "false");
    appeals.innerHTML = '<p class="muted">Network error. Reload to try again.</p>';
  });
}

function setCount(id, n, one, many) {
  const el = $(id);
  if (el) el.textContent = n ? n + " " + (n === 1 ? one : many) : "";
}

function renderAppeals(box, rows) {
  setCount("ops-appeals-count", rows.length, "tournament", "tournaments");
  if (!rows.length) { box.innerHTML = '<p class="muted">No open appeals.</p>'; return; }
  box.innerHTML = rows.map(function (a) {
    const id = esc(a.tournament_id);
    const list = Array.isArray(a.appeals) ? a.appeals : [];
    const prize = a.prize && typeof a.prize === "object" ? a.prize : null;
    return '<article class="ops-case" data-appeal="' + id + '">' +
      "<header><h2>" + esc(a.name || "Tournament") + "</h2>" +
      '<span class="row__meta">hosted by @' + esc(a.host_username || "host") + " · won by @" + esc(a.winner_username || "—") +
        " · " + esc(a.entrants || 0) + " entrants" + (a.entry_fee_cents ? " · entry " + formatRcoin(a.entry_fee_cents) : " · free") +
        (prize && prize.winner_cents != null ? " · prize " + formatRcoin(prize.winner_cents) : "") + "</span></header>" +
      "<ul>" + list.map(function (d) {
        return "<li><strong>@" + esc(d.username || "player") + "</strong>" + (d.deposit_cents ? " (deposit " + formatRcoin(d.deposit_cents) + ")" : "") +
          (d.room_id ? ' <button type="button" class="linkbtn" data-open-room="' + esc(d.room_id) + '">about one match</button>' : "") + ": " + esc(d.reason || "") + "</li>";
      }).join("") + "</ul>" +
      '<div class="bracket ops-case__bracket" data-bracket-for="' + id + '">Loading the bracket…</div>' +
      '<div class="field--row"><div class="field"><label for="appeal-winner-' + id + '">New winner (for Overturn)</label><select id="appeal-winner-' + id + '" data-winner><option value="">Pick a player</option></select></div>' +
      '<div class="field"><label for="appeal-note-' + id + '">Note for the entrants</label><input id="appeal-note-' + id + '" type="text" maxlength="300" placeholder="What decided it" /></div></div>' +
      '<div class="room-actions">' +
        '<button type="button" class="btn btn--sm" data-resolve="uphold">Uphold the result</button>' +
        '<button type="button" class="btn btn--sm" data-resolve="overturn">Overturn</button>' +
        '<button type="button" class="btn btn--sm btn--danger" data-resolve="refund_all">Refund all</button>' +
      '</div><p class="msg" hidden></p></article>';
  }).join("");
  rows.forEach(function (a) { loadAppealBracket(a); });
  box.querySelectorAll("[data-appeal]").forEach(function (card) { wireAppeal(card, rows.find(function (a) { return a.tournament_id === card.getAttribute("data-appeal"); })); });
}

function loadAppealBracket(a) {
  Promise.resolve(session.client.rpc("rib_tournament_bracket", { p_tournament_id: a.tournament_id })).then(function (r) {
    const box = document.querySelector('[data-bracket-for="' + a.tournament_id + '"]');
    const card = document.querySelector('[data-appeal="' + a.tournament_id + '"]');
    if (!box || !card) return;
    const b = normalizeBracket(r && r.data);
    const rounds = b.rounds || b.rows.reduce(function (m, x) { return Math.max(m, x.round); }, 0);
    const players = {};
    b.rows.forEach(function (m) {
      if (m.player_a) players[m.player_a] = m.a_username;
      if (m.player_b) players[m.player_b] = m.b_username;
    });
    const select = card.querySelector("[data-winner]");
    Object.keys(players).filter(function (uid) { return uid !== a.winner_id; }).forEach(function (uid) {
      const o = document.createElement("option");
      o.value = uid;
      o.textContent = "@" + (players[uid] || "player");
      select.appendChild(o);
    });
    box.innerHTML = b.rows.length ? '<ol class="ops-case__matches">' + b.rows.map(function (m) {
      const w = m.winner_id ? (m.winner_id === m.player_a ? m.a_username : m.b_username) : null;
      return "<li>" + esc(roundLabel(m.round, rounds)) + ": @" + esc(m.a_username || "—") + " vs @" + esc(m.b_username || "—") +
        (w ? " → <strong>@" + esc(w) + "</strong>" : m.status === "void" ? " → no result" : "") + (m.walkover ? " (walkover)" : "") +
        ' <button type="button" class="linkbtn" data-open-room="' + esc(m.room_id) + '">room</button></li>';
    }).join("") + "</ol>" : "No matches.";
  }).catch(function () { /* the appeal can still be resolved */ });
}

function wireAppeal(card, a) {
  if (!a) return;
  const out = card.querySelector(".msg");
  const id = a.tournament_id;
  card.addEventListener("click", function (e) {
    const room = e.target.closest("[data-open-room]");
    if (room) { openRoom(room.getAttribute("data-open-room")); return; }
    const b = e.target.closest("[data-resolve]");
    if (!b || b.disabled) return;
    const action = b.getAttribute("data-resolve");
    const select = card.querySelector("[data-winner]");
    const winner = select.value || null;
    const note = (card.querySelector("#appeal-note-" + id).value || "").trim();
    if (action === "overturn" && !winner) { showMessage(out, "Pick the player who should have won.", false); select.focus(); return; }
    const who = winner ? select.options[select.selectedIndex].textContent : "";
    const ask = action === "uphold"
      ? { title: "Uphold the result?", body: "Prizes and the host commission are paid as the host decided. Appeal deposits go to the platform.", ok: "Uphold" }
      : action === "overturn"
        ? { title: "Overturn and pay " + who + "?", body: who + " gets the prize plus the host commission (90%). The host gets a strike; appeal deposits are returned.", ok: "Overturn", danger: true }
        : { title: "Refund every entry fee?", body: "Nobody earns anything, the host gets a strike and appeal deposits are returned.", ok: "Refund all", danger: true };
    confirmAction(ask).then(function (ok) {
      if (!ok) return;
      b.disabled = true;
      Promise.resolve(session.client.rpc("rib_appeal_resolve", { p_tournament_id: id, p_action: action, p_winner_id: action === "overturn" ? winner : null, p_note: note || null })).then(function (r) {
        if (r.error) { b.disabled = false; showMessage(out, errorText(r.error, "Couldn't resolve it."), false); return; }
        showMessage(out, "Resolved.", true);
        setTimeout(loadHostedQueue, 600);
      }).catch(function () { b.disabled = false; showMessage(out, "Network error. Try again.", false); });
    });
  });
}

function renderFlagged(box, rows) {
  setCount("ops-flagged-count", rows.length, "match", "matches");
  if (!rows.length) { box.innerHTML = '<p class="muted">No hosted match is past the decision window.</p>'; return; }
  box.innerHTML = rows.map(function (m) {
    const id = esc(m.room_id);
    const claim = function (name, report) { return "@" + esc(name || "player") + (report ? " reported a result" : " hasn't reported"); };
    const live = m.status === "live" && m.player_a && m.player_b;
    return '<article class="ops-case is-flagged" data-flag="' + id + '" data-a="' + esc(m.player_a || "") + '" data-b="' + esc(m.player_b || "") + '">' +
      "<header><h2>" + esc(m.tournament_name || "Tournament") + " · round " + esc(m.round) + "</h2>" +
      '<span class="row__meta">hosted by @' + esc(m.host_username || "host") + " · " + esc(m.status) + (m.started_at ? " since " + esc(formatDate(m.started_at)) : "") + "</span></header>" +
      "<ul><li>" + claim(m.a_username, m.a_report) + "</li><li>" + claim(m.b_username, m.b_report) + "</li></ul>" +
      '<div class="field"><label for="flag-note-' + id + '">Note for the players</label><input id="flag-note-' + id + '" type="text" maxlength="300" placeholder="What decided it" /></div>' +
      '<div class="room-actions">' +
        '<button type="button" class="btn btn--sm" data-open-room="' + id + '">Open room</button>' +
        '<button type="button" class="btn btn--sm" data-flag-award="a"' + (live ? "" : " disabled") + ">Award @" + esc(m.a_username || "player A") + "</button>" +
        '<button type="button" class="btn btn--sm" data-flag-award="b"' + (live ? "" : " disabled") + ">Award @" + esc(m.b_username || "player B") + "</button>" +
        '<button type="button" class="btn btn--sm btn--danger" data-flag-void>Void match</button>' +
        '<button type="button" class="btn btn--sm btn--danger" data-flag-cancel="' + esc(m.tournament_id) + '">Cancel the tournament</button>' +
      '</div><p class="msg" hidden></p></article>';
  }).join("");
  box.querySelectorAll("[data-flag]").forEach(wireFlagged);
}

function wireFlagged(card) {
  const id = card.getAttribute("data-flag");
  const out = card.querySelector(".msg");
  card.addEventListener("click", function (e) {
    const b = e.target.closest("button");
    if (!b || b.disabled) return;
    if (b.hasAttribute("data-open-room")) { openRoom(id); return; }
    const note = (card.querySelector("#flag-note-" + id).value || "").trim();
    let fn; let args; let ask;
    if (b.hasAttribute("data-flag-award")) {
      const winner = card.getAttribute("data-" + b.getAttribute("data-flag-award"));
      if (!winner) return;
      fn = "rib_host_decide";
      args = { p_room_id: id, p_winner_id: winner, p_walkover: false, p_note: note || null };
      ask = { title: b.textContent + "?", body: "The bracket advances as if the host had decided.", ok: b.textContent };
    } else if (b.hasAttribute("data-flag-void")) {
      if (note.length < 3) { showMessage(out, "Add a note (at least 3 characters) before voiding the match.", false); return; }
      fn = "rib_host_void_room";
      args = { p_room_id: id, p_note: note };
      ask = { title: "Void this match?", body: "Both players are out and each gets a no-show.", ok: "Void match", danger: true };
    } else if (b.hasAttribute("data-flag-cancel")) {
      fn = "rib_host_cancel";
      args = { p_tournament_id: b.getAttribute("data-flag-cancel") };
      ask = { title: "Cancel the whole tournament?", body: "Every entry fee is refunded and nobody earns anything. Use it when the host has abandoned it.", ok: "Cancel and refund", danger: true };
    } else return;
    confirmAction(ask).then(function (ok) {
      if (!ok) return;
      b.disabled = true;
      Promise.resolve(session.client.rpc(fn, args)).then(function (r) {
        if (r.error) { b.disabled = false; showMessage(out, errorText(r.error, "Couldn't decide it."), false); return; }
        showMessage(out, "Done.", true);
        setTimeout(loadHostedQueue, 600);
      }).catch(function () { b.disabled = false; showMessage(out, "Network error. Try again.", false); });
    });
  });
}
