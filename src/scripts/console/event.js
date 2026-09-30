/* ============================================================================
 * Runinback — a hosted tournament as a player sees it (#page-event/<id>).
 *
 * One state card says where the player stands: waiting for seats, their
 * current match (the host hasn't posted the lobby yet / the lobby is up),
 * out, through, champion. After the final comes the 24-hour appeal window:
 * a countdown to payout_at and, for entrants, Appeal (reason 10–500
 * characters, optionally one match; paid tournaments hold a deposit of 10% of
 * the entry fee, at least 1 rcoin). Then the payout status.
 *
 * Reads: the tournaments row, rib_my_tournaments (my entry, my prize) and
 * rib_tournament_bracket. One Realtime channel on this tournament's row
 * while the page is on screen; it's removed when the page closes.
 * ========================================================================== */
import { announce } from "../lib/announce.js";
import { byId as $, escapeHtml as esc, showMessage } from "../lib/dom.js";
import { formatRcoin } from "../lib/format.js";
import {
  APPEAL_MAX, APPEAL_MIN, appealDepositCents, formatCountdown, hostedSplit, normalizeBracket, playerStanding, roundLabel,
} from "../lib/hosted.js";
import { replayClass } from "../lib/motion.js";
import { roundsFor } from "../lib/tournament.js";
import { peakArt } from "./art.js";
import { renderBracket } from "./bracket-view.js";
import { confirmAction } from "./confirm.js";
import { errorText, fetchUsernames, playerLabel, session } from "./context.js";
import { openRoom } from "./room.js";
import { refreshWallet } from "./wallet.js";

const COLUMNS = "id, name, mode, visibility, status, max_players, entrants, entry_fee_cents, payout_at, creator_id, winner_id, rules, created_at";
const COALESCE_MS = 300;
const TICK_MS = 15000;

const ev = {
  id: null, t: null, mine: null, bracket: null, request: 0, channel: null, pending: 0, timer: 0,
  busy: false, crowned: {}, lastTone: null,
};

function pageShown() {
  const page = $("page-event");
  return !!page && !page.hidden;
}

function unsubscribe() {
  if (ev.channel) { try { session.client.removeChannel(ev.channel); } catch (e) { /* already gone */ } }
  ev.channel = null;
  clearTimeout(ev.pending);
  clearInterval(ev.timer);
  ev.timer = 0;
}

function subscribe(id) {
  if (ev.channel || !session.client.channel) return;
  ev.channel = session.client.channel("event-" + id)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "tournaments", filter: "id=eq." + id }, scheduleReload)
    .subscribe();
}

function scheduleReload() {
  clearTimeout(ev.pending);
  ev.pending = setTimeout(function () { if (pageShown() && ev.id) fetchAll(); }, COALESCE_MS);
}

/** Page loader for #page-event/<tournament id>. */
export function loadEvent(arg) {
  const id = String(arg || "").split("/")[0];
  const root = $("event-root");
  if (!id) {
    $("event-title").textContent = "Tournament.";
    root.innerHTML = '<div class="empty">' + peakArt("match") + "<h3>No tournament open</h3><p>Open one from My tournaments or an invite link.</p></div>";
    root.setAttribute("aria-busy", "false");
    return Promise.resolve();
  }
  if (ev.id !== id) {
    unsubscribe();
    ev.id = id;
    ev.t = null;
    ev.lastTone = null;
    $("event-title").textContent = "Tournament.";
    root.innerHTML = '<div class="room-skel" aria-hidden="true"><div class="skel"><span class="skel__l" style="width:40%"></span><span class="skel__l" style="width:70%"></span>' +
      '<span class="skel__l skel__l--pill"></span></div><div class="skel skel--rows"><span class="skel__l"></span><span class="skel__l"></span></div></div>';
  }
  subscribe(id);
  return fetchAll();
}

function fetchAll() {
  const id = ev.id;
  const mine = ++ev.request;
  const root = $("event-root");
  root.setAttribute("aria-busy", "true");
  return Promise.all([
    session.client.from("tournaments").select(COLUMNS).eq("id", id).limit(1),
    session.client.rpc("rib_my_tournaments", { p_limit: 60 }),
  ]).then(function (res) {
    if (mine !== ev.request) return;
    const t = res[0] && !res[0].error ? (Array.isArray(res[0].data) ? res[0].data[0] : res[0].data) : null;
    if (!t || !t.id) {
      root.setAttribute("aria-busy", "false");
      root.innerHTML = '<div class="empty">' + peakArt("match") + "<h3>Tournament not found</h3><p>It doesn't exist, or it's private and you're not in it.</p></div>";
      return;
    }
    ev.t = t;
    const rows = res[1] && Array.isArray(res[1].data) ? res[1].data : [];
    ev.mine = rows.find(function (x) { return x.id === id; }) || null;
    const started = t.status !== "open" && t.status !== "cancelled";
    return Promise.all([
      started ? session.client.rpc("rib_tournament_bracket", { p_tournament_id: id }) : Promise.resolve(null),
      fetchUsernames([t.creator_id, t.winner_id]),
    ]).then(function (more) {
      if (mine !== ev.request) return;
      ev.bracket = more[0] && !more[0].error ? normalizeBracket(more[0].data) : started ? { rows: [], size: null, rounds: null, failed: !!(more[0] && more[0].error) } : null;
      render();
    });
  }).catch(function () {
    if (mine !== ev.request) return;
    root.setAttribute("aria-busy", "false");
    if (!ev.t) root.innerHTML = '<p class="muted">Couldn\'t load the tournament. Check your connection and try again.</p>';
  });
}

/* ---- derived ---------------------------------------------------------------- */
function rounds() {
  const b = ev.bracket;
  if (b && b.rounds) return b.rounds;
  const size = (b && b.size) || ev.t.max_players;
  const fromRows = b ? b.rows.reduce(function (m, r) { return Math.max(m, r.round); }, 0) : 0;
  return fromRows || roundsFor(size) || 1;
}

function entrant() { return !!ev.mine || (ev.bracket && playerStanding(ev.bracket.rows, session.uid, rounds()).entrant); }

function winnerName() {
  const t = ev.t;
  if (!t.winner_id) return null;
  if (t.winner_id === session.uid) return "you";
  const final = ev.bracket && ev.bracket.rows.filter(function (m) { return m.round === rounds(); })[0];
  if (final && final.winner_id === t.winner_id) return "@" + (final.winner_id === final.player_a ? final.a_username : final.b_username);
  return playerLabel(t.winner_id);
}

function prizeCents() {
  const t = ev.t;
  return hostedSplit(t.entry_fee_cents, t.entrants || t.max_players).winner;
}

// Any entrant but the champion may appeal until payout_at, also while
// another entrant's appeal is already under review.
function appealOpen() {
  const t = ev.t;
  return (t.status === "payout_pending" || t.status === "disputed") && !!t.payout_at && new Date(t.payout_at).getTime() > Date.now() &&
    entrant() && t.creator_id !== session.uid && t.winner_id !== session.uid;
}

/* ---- rendering -------------------------------------------------------------- */
function metaLine(t) {
  const bits = ["hosted by " + esc(playerLabel(t.creator_id))];
  bits.push(t.entry_fee_cents ? formatRcoin(t.entry_fee_cents) + " entry" : "free");
  bits.push((t.entrants || 0) + "/" + t.max_players + " players");
  return '<p class="room-context event-context">' + bits.join(" · ") +
    (t.visibility === "private" ? ' <span class="chip">Private</span>' : "") + "</p>";
}

function stateFor(t) {
  const standing = ev.bracket ? playerStanding(ev.bracket.rows, session.uid, rounds()) : { entrant: false };
  const isEntrant = entrant();
  const fee = t.entry_fee_cents || 0;
  if (t.status === "cancelled") {
    return { tone: "void", html: "<h2>Cancelled</h2><p>" + (isEntrant && fee ? "Your entry fee of " + formatRcoin(fee) + " was refunded to your wallet." : "Every entry fee was refunded.") + "</p>" };
  }
  if (t.status === "open" || t.status === "full") {
    const need = Math.max(0, t.max_players - (t.entrants || 0));
    if (isEntrant) {
      return {
        tone: "wait",
        html: "<h2>You're in</h2><p>" + (t.entrants || 0) + " of " + t.max_players + " players. It starts when it fills" +
          (need ? " (" + need + " to go)" : "") + ", or earlier when the host starts it. Your first match room opens here.</p>" +
          (t.status === "open" ? '<div class="room-actions"><button type="button" class="btn btn--sm" data-ev-leave>Leave and get my entry fee back</button></div>' : ""),
      };
    }
    if (t.status !== "open") return { tone: "wait", html: "<h2>Starting</h2><p>It's full. The bracket is being drawn.</p>" };
    return {
      tone: "act",
      html: "<h2>Registration is open</h2><p>" + (t.entrants || 0) + " of " + t.max_players + " players so far.</p>" +
        (t.visibility === "public" && t.creator_id !== session.uid
          ? '<div class="room-actions"><button type="button" class="btn btn--cta" data-ev-join>Join · ' + (fee ? formatRcoin(fee) : "Free") + "</button></div>"
          : ""),
    };
  }
  if (t.status === "active") {
    if (standing.current) {
      const m = standing.current;
      const label = roundLabel(m.round, rounds());
      const open = '<div class="room-actions"><button type="button" class="btn btn--cta" data-room="' + esc(m.room_id) + '">Open match room</button></div>';
      if (m.status === "setup") {
        return { tone: "wait", html: "<h2>Your " + esc(label.toLowerCase()) + "</h2><p>Waiting for the host to post the lobby. The room shows the lobby code the moment it's up, and you can chat with the host there.</p>" + open };
      }
      if (m.status === "live") {
        return { tone: "act", html: "<h2>Your " + esc(label.toLowerCase()) + " is on</h2><p>The lobby is up. Join it in Wild Rift and play. The host decides the result; report it and upload the end screen in the room.</p>" + open };
      }
      return { tone: "wait", html: "<h2>You're through</h2><p>Waiting for your next opponent. Your next room opens here as soon as it's known.</p>" };
    }
    if (standing.eliminated) {
      return { tone: "lost", html: '<h2 class="is-loss">You\'re out</h2><p>You went out in the ' + esc(roundLabel(standing.outIn, rounds()).toLowerCase()) + ". Thanks for playing. The bracket keeps updating below.</p>" };
    }
    if (isEntrant) return { tone: "wait", html: "<h2>You're through</h2><p>Waiting for your next opponent. Your next room opens here as soon as it's known.</p>" };
    return { tone: "wait", html: "<h2>In progress</h2><p>The host is running the matches. Follow the bracket below.</p>" };
  }
  const champ = t.winner_id === session.uid || standing.champion;
  const won = winnerName();
  if (t.status === "payout_pending") {
    const left = formatCountdown(t.payout_at);
    const clock = left ? '<p class="event-clock">Prizes are paid in <strong data-until="' + esc(t.payout_at) + '">' + esc(left) + "</strong>, when the appeal window closes.</p>"
      : '<p class="event-clock">The appeal window has closed. Prizes are being paid.</p>';
    const appeal = appealOpen()
      ? '<div class="room-actions"><button type="button" class="btn btn--sm" data-ev-appeal>Appeal the result</button></div>' : "";
    if (champ) {
      return {
        tone: "won", champion: true,
        html: '<h2 class="is-win">You\'re the champion.</h2>' +
          (fee ? '<p class="room-prize"><span class="room-prize__v">' + formatRcoin(prizeCents()) + "</span> is yours once the window closes.</p>" : "<p>You won " + esc(t.name) + ".</p>") +
          clock + appeal,
      };
    }
    return { tone: "wait", html: "<h2>Final played</h2><p>" + (won ? esc(won) + " won " + esc(t.name) + "." : "The host decided the final.") + "</p>" + clock + appeal };
  }
  if (t.status === "disputed") {
    return {
      tone: "review",
      html: "<h2>Appeal in review</h2><p>An entrant appealed the result, so prizes are on hold while the Runinback team reviews the match chats and end screens. Everyone sees the decision here.</p>" +
        (appealOpen() ? '<div class="room-actions"><button type="button" class="btn btn--sm" data-ev-appeal>Appeal too</button></div>' : ""),
    };
  }
  if (t.status === "finished") {
    const paid = ev.mine && Number(ev.mine.prize_cents) > 0 ? Number(ev.mine.prize_cents) : 0;
    if (champ) {
      return { tone: "won", champion: true, html: '<h2 class="is-win">You\'re the champion.</h2>' + (paid ? '<p class="room-prize"><span class="room-prize__v">' + formatRcoin(paid) + "</span> was added to your wallet.</p>" : "<p>You won " + esc(t.name) + ".</p>") };
    }
    return { tone: "lost", html: "<h2>Finished</h2><p>" + (won ? esc(won) + " won " + esc(t.name) + ". " : "") + (fee ? "Prizes have been paid." : "") + (paid ? " You received " + formatRcoin(paid) + "." : "") + "</p>" };
  }
  return { tone: "wait", html: "<h2>" + esc(t.name) + "</h2>" };
}

function appealForm(t) {
  const deposit = appealDepositCents(t.entry_fee_cents);
  const matches = (ev.bracket ? ev.bracket.rows : []).filter(function (m) { return m.status === "done" || m.status === "void"; });
  return '<form class="room-dispute event-appeal" id="event-appeal" hidden novalidate>' +
    '<div class="field"><label for="event-appeal-reason">What went wrong?</label>' +
      '<textarea id="event-appeal-reason" maxlength="' + APPEAL_MAX + '" rows="3" aria-describedby="event-appeal-count event-appeal-note" placeholder="For example: the host picked my opponent, but my end screen shows I won."></textarea>' +
      '<p class="field__hint field__count" id="event-appeal-count" aria-live="polite">0 / ' + APPEAL_MAX + "</p></div>" +
    '<div class="field"><label for="event-appeal-room">Which match? (optional)</label><select id="event-appeal-room"><option value="">The whole tournament</option>' +
      matches.map(function (m) {
        return '<option value="' + esc(m.room_id) + '">' + esc(roundLabel(m.round, rounds())) + ": @" + esc(m.a_username || "player") + " vs @" + esc(m.b_username || "player") + "</option>";
      }).join("") + "</select></div>" +
    '<p class="field__hint" id="event-appeal-note">' + (deposit
      ? "Appealing holds a deposit of " + formatRcoin(deposit) + " (10% of the entry fee, at least 1 rcoin). You get it back if the appeal is upheld; if the result stands, it goes to the platform."
      : "The Runinback team reviews the match chats and end screens. Prizes are held until they decide.") + "</p>" +
    '<div class="room-actions"><button type="submit" class="btn btn--danger">' + (deposit ? "Appeal · hold " + formatRcoin(deposit) : "Send appeal") + "</button>" +
      '<button type="button" class="btn" data-ev-appeal-cancel>Cancel</button></div></form>';
}

function render() {
  const t = ev.t;
  const root = $("event-root");
  root.setAttribute("aria-busy", "false");
  $("event-title").textContent = t.name + ".";
  // Keep an appeal being typed across refreshes.
  const form = $("event-appeal");
  const keep = form && !form.hidden ? { reason: $("event-appeal-reason").value, room: $("event-appeal-room").value } : null;
  const state = stateFor(t);
  const b = ev.bracket;
  root.innerHTML = metaLine(t) +
    '<div class="room-state event-state" id="event-state" data-tone="' + state.tone + '">' + state.html + "</div>" +
    '<p class="msg" id="event-msg" hidden></p>' +
    (appealOpen() ? appealForm(t) : "") +
    (b ? '<section class="sec"><div class="sec__head"><h2>Bracket</h2>' + (b.failed ? '<span class="sec__note">Couldn\'t load it right now</span>' : "") + '</div><div class="bracket event-bracket" id="event-bracket"></div></section>' : "") +
    (t.rules ? '<details class="join-rules"><summary>Rules from the host</summary><p>' + esc(t.rules) + "</p></details>" : "");
  if (keep && $("event-appeal")) {
    $("event-appeal").hidden = false;
    $("event-appeal-reason").value = keep.reason;
    $("event-appeal-room").value = keep.room;
    countAppeal();
  }
  if (b) {
    renderBracket($("event-bracket"), b.rows, {
      size: b.size || t.max_players, rounds: rounds(), uid: session.uid,
      champPrize: function () { return t.entry_fee_cents ? prizeCents() : null; },
      action: function (m, mine) {
        return mine && (m.status === "setup" || m.status === "live") ? '<button type="button" class="btn btn--cta btn--sm" data-room="' + esc(m.room_id) + '">Open room</button>' : "";
      },
    });
  }
  const box = $("event-state");
  if (ev.lastTone && ev.lastTone !== state.tone) {
    replayClass(box, "is-changed");
    const h = box.querySelector("h2");
    if (h) announce(h.textContent);
  }
  ev.lastTone = state.tone;
  if (state.champion && !ev.crowned[t.id]) {
    ev.crowned[t.id] = true;
    const h = box.querySelector("h2");
    if (h) replayClass(h, "is-reveal");
    replayClass(box, "is-crowned");
  }
  clearInterval(ev.timer);
  ev.timer = t.status === "payout_pending" ? setInterval(tick, TICK_MS) : 0;
}

function tick() {
  if (document.visibilityState === "hidden" || !pageShown()) return;
  const el = document.querySelector("#event-state [data-until]");
  if (!el) return;
  const left = formatCountdown(el.getAttribute("data-until"));
  if (left) el.textContent = left;
  else fetchAll(); // the window just closed: read the payout status
}

function countAppeal() {
  const input = $("event-appeal-reason");
  const out = $("event-appeal-count");
  if (input && out) out.textContent = input.value.length + " / " + APPEAL_MAX;
}

/* ---- actions ------------------------------------------------------------------ */
function flash(text, ok) { showMessage($("event-msg"), text, ok); }

function send(fn, args, btn, okText) {
  if (ev.busy) { flash("Working… try again in a moment.", true); return Promise.resolve(false); }
  ev.busy = true;
  if (btn) btn.disabled = true;
  return Promise.resolve(session.client.rpc(fn, args)).then(function (r) {
    if (r.error) { flash(errorText(r.error, "Couldn't complete the action."), false); return false; }
    if (okText) flash(okText, true);
    refreshWallet();
    return true;
  }).catch(function () {
    flash("Network error. Check your connection and try again.", false);
    return false;
  }).finally(function () {
    ev.busy = false;
    if (btn && btn.isConnected) btn.disabled = false;
  });
}

function submitAppeal(e) {
  e.preventDefault();
  const reason = ($("event-appeal-reason").value || "").trim();
  if (reason.length < APPEAL_MIN || reason.length > APPEAL_MAX) {
    $("event-appeal-reason").setAttribute("aria-invalid", "true");
    flash("Explain what went wrong (" + APPEAL_MIN + " to " + APPEAL_MAX + " characters).", false);
    $("event-appeal-reason").focus();
    return;
  }
  const room = $("event-appeal-room").value || null;
  const deposit = appealDepositCents(ev.t.entry_fee_cents);
  const go = deposit
    ? confirmAction({
      title: "Appeal and hold " + formatRcoin(deposit) + "?",
      body: "Prizes stay on hold until the Runinback team decides. Your deposit comes back if the appeal is upheld; if the result stands, it goes to the platform.",
      ok: "Send appeal",
      danger: true,
    })
    : Promise.resolve(true);
  go.then(function (ok) {
    if (!ok) return;
    const btn = $("event-appeal").querySelector('[type="submit"]');
    send("rib_tournament_appeal", { p_tournament_id: ev.t.id, p_reason: reason, p_room_id: room }, btn, "Appeal sent. Prizes are on hold while the Runinback team reviews it.")
      .then(function (sent) { if (sent) { $("event-appeal").hidden = true; fetchAll(); } });
  });
}

export function initEvent() {
  const root = $("event-root");
  root.addEventListener("click", function (e) {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.hasAttribute("data-room")) { openRoom(b.getAttribute("data-room")); return; }
    if (b.hasAttribute("data-ev-appeal")) {
      const form = $("event-appeal");
      if (form) { form.hidden = false; $("event-appeal-reason").focus(); }
      return;
    }
    if (b.hasAttribute("data-ev-appeal-cancel")) { $("event-appeal").hidden = true; return; }
    if (b.hasAttribute("data-ev-leave")) {
      confirmAction({ title: "Leave this tournament?", body: "Your entry fee comes back to your wallet right away.", ok: "Leave" }).then(function (ok) {
        if (!ok) return;
        send("rib_tournament_leave", { p_tournament_id: ev.t.id }, b, "You left the tournament. Your entry fee is back.").then(function (done) { if (done) fetchAll(); });
      });
      return;
    }
    if (b.hasAttribute("data-ev-join")) {
      const fee = ev.t.entry_fee_cents || 0;
      const go = fee
        ? confirmAction({ title: "Enter " + ev.t.name + " for " + formatRcoin(fee) + "?", body: "The host runs the bracket and decides each match. You can leave for a full refund until it starts.", ok: "Pay " + formatRcoin(fee) + " and join" })
        : Promise.resolve(true);
      go.then(function (ok) {
        if (ok) send("rib_tournament_join", { p_tournament_id: ev.t.id }, b, "You're in.").then(function (done) { if (done) fetchAll(); });
      });
    }
  });
  root.addEventListener("submit", function (e) { if (e.target.id === "event-appeal") submitAppeal(e); });
  root.addEventListener("input", function (e) { if (e.target.id === "event-appeal-reason") countAppeal(); });
  // My rooms changed (a match opened or was decided): re-read if it's this one.
  document.addEventListener("rib:live", function (e) {
    if (!pageShown() || !ev.id) return;
    if ((e.detail || []).some(function (m) { return m.tournament_id === ev.id; }) || entrant()) scheduleReload();
  });
  // Leaving the page drops the channel and the countdown.
  document.addEventListener("rib:page", function (e) {
    // A read still in flight must not draw on a page that's gone.
    if (e.detail !== "page-event") { unsubscribe(); ev.id = null; ev.request++; }
  });
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible" && pageShown() && ev.id) fetchAll(); });
}
