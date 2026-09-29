/* ============================================================================
 * Runinback — match room: where two players who may not know each other meet
 * for a bracket match or a friendly. They set up a private lobby in their
 * game, confirm they're ready, report the result and, if they disagree,
 * dispute it with evidence.
 *
 * The database decides everything (migration 0022): ready and confirmation
 * deadlines, silence-confirms, walkovers, deposits, advancement and payouts.
 * This module renders the state, calls the room RPCs and stays live through
 * Realtime (room row updates + chat inserts).
 * ========================================================================== */
import { byId as $, escapeHtml as esc, showMessage } from "../lib/dom.js";
import { formatRcoin } from "../lib/format.js";
import { roundName } from "../lib/tournament.js";
import { errorText, session } from "./context.js";
import { goToPage } from "./navigation.js";
import { networkLabel } from "./networks.js";
import { refreshWallet } from "./wallet.js";

const LAST_ROOM_KEY = "rib-last-room";
const EVIDENCE_BUCKET = "room-evidence";

const room = { id: null, r: null, info: null, messages: [], evidence: [], channel: null, timer: 0, busy: false };

function rememberRoom(id) {
  try { sessionStorage.setItem(LAST_ROOM_KEY, id); } catch (e) { /* storage blocked */ }
}
function lastRoom() {
  try { return sessionStorage.getItem(LAST_ROOM_KEY); } catch (e) { return null; }
}

/** Open a match room page. */
export function openRoom(id) {
  if (!id) return;
  if (room.id !== id) closeRoom();
  room.id = id;
  rememberRoom(id);
  goToPage("page-room");
}

/** Stop Realtime and timers (when another page opens). */
export function closeRoom() {
  if (room.channel) { try { session.client.removeChannel(room.channel); } catch (e) { /* already gone */ } }
  room.channel = null;
  clearInterval(room.timer);
  room.timer = 0;
}

/** Page loader for #page-room. */
export function loadRoom() {
  const id = room.id || lastRoom();
  if (!id) {
    $("room-title").textContent = "Match room.";
    $("room-root").innerHTML = '<div class="empty"><h3>No room open</h3><p>Rooms open from your tournaments and friendlies once a match is ready.</p></div>';
    return Promise.resolve();
  }
  room.id = id;
  subscribe(id);
  return fetchRoom();
}

function fetchRoom() {
  const id = room.id;
  return Promise.all([
    session.client.from("match_rooms").select("*").eq("id", id).single(),
    session.client.rpc("rib_room_info", { p_room_id: id }),
    session.client.from("room_messages").select("id, user_id, body, created_at").eq("room_id", id).order("id", { ascending: true }).limit(200),
    session.client.from("room_evidence").select("id, user_id, storage_path, source, created_at").eq("room_id", id).order("id", { ascending: true }),
  ]).then(function (res) {
    if (id !== room.id) return;
    if (res[0].error || !res[0].data) {
      $("room-title").textContent = "Match room.";
      $("room-root").innerHTML = '<div class="empty"><h3>Room not found</h3><p>This room doesn\'t exist or isn\'t yours.</p></div>';
      return;
    }
    room.r = res[0].data;
    room.info = (res[1].data && res[1].data[0]) || {};
    room.messages = res[2].data || [];
    room.evidence = res[3].data || [];
    render();
  }).catch(function () {
    $("room-root").innerHTML = '<p class="muted">Couldn\'t load the room. Check your connection and try again.</p>';
  });
}

function subscribe(id) {
  if (room.channel || !session.client.channel) return;
  room.channel = session.client.channel("room-" + id)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "match_rooms", filter: "id=eq." + id }, function (payload) {
      if (id !== room.id || !payload.new) return;
      const was = room.r && room.r.status;
      room.r = Object.assign({}, room.r, payload.new);
      if (was !== room.r.status) refreshWallet();
      render();
    })
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "room_messages", filter: "room_id=eq." + id }, function (payload) {
      if (id !== room.id || !payload.new) return;
      if (room.messages.some(function (m) { return m.id === payload.new.id; })) return;
      room.messages.push(payload.new);
      renderChat();
    })
    .subscribe();
}

/* ---- derived state -------------------------------------------------------- */
function me() { return session.uid; }
function amA() { return room.r.player_a === me(); }
function opponentId() { return amA() ? room.r.player_b : room.r.player_a; }
function nameOf(uid) {
  if (uid === me()) return "you";
  const i = room.info || {};
  const n = uid === room.r.player_a ? i.a_username : i.b_username;
  return n ? "@" + n : "your opponent";
}
function myReport() { return amA() ? room.r.a_report : room.r.b_report; }
function theirReport() { return amA() ? room.r.b_report : room.r.a_report; }
function myReady() { return amA() ? room.r.a_ready_at : room.r.b_ready_at; }
function theirReady() { return amA() ? room.r.b_ready_at : room.r.a_ready_at; }
function isPaid() { return room.r.kind === "tournament" && (room.info.entry_fee_cents || 0) > 0; }
function depositCents() { return Math.max(100, Math.floor((room.info.entry_fee_cents || 0) / 10)); }

function countdown(deadline) {
  const ms = new Date(deadline).getTime() - Date.now();
  if (!(ms > 0)) return "0:00";
  const s = Math.ceil(ms / 1000);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

/* ---- rendering ------------------------------------------------------------ */
function contextLine(r, i) {
  if (r.kind === "friendly") return "Friendly · free";
  const round = i.rounds ? roundName(r.round, i.rounds) : "Round " + r.round;
  return esc(i.tournament_name || "Tournament") + " · " + round + " · " + (i.entry_fee_cents ? formatRcoin(i.entry_fee_cents) + " entry" : "free");
}

function render() {
  const r = room.r;
  const i = room.info || {};
  $("room-title").textContent = r.game + ".";
  const live = r.status === "ready_check" || r.status === "live" || r.status === "disputed";
  const network = r.network ? networkLabel(r.network) : "";
  const player = function (uid, username, handle, matches, lost, noShows) {
    return '<div class="room-player' + (uid === me() ? " is-me" : "") + '"><div class="room-player__name">' + esc(username ? "@" + username : "—") +
      (uid === me() ? ' <span class="tag">you</span>' : "") + "</div>" +
      (network ? '<div class="room-player__handle">' + esc(network) + ": " + (handle ? "<strong>" + esc(handle) + "</strong>" : "not linked") + "</div>" : "") +
      '<div class="room-player__rec">' + matches + " matches · " + lost + " disputes lost · " + noShows + " no-shows</div></div>";
  };

  $("room-root").innerHTML =
    '<p class="room-context">' + contextLine(r, i) + "</p>" +
    '<div class="room">' +
      '<div class="room__main">' +
        '<div class="room-players">' +
          player(r.player_a, i.a_username, i.a_handle, i.a_matches || 0, i.a_disputes_lost || 0, i.a_no_shows || 0) +
          '<span class="room-players__vs" aria-hidden="true">vs</span>' +
          player(r.player_b, i.b_username, i.b_handle, i.b_matches || 0, i.b_disputes_lost || 0, i.b_no_shows || 0) +
        "</div>" +
        (live && r.room_code ? lobbyBox(r) : "") +
        '<div class="room-state" id="room-state" aria-live="polite">' + stateHtml(r) + "</div>" +
        '<p class="msg" id="room-msg" hidden></p>' +
        evidenceHtml(r) +
      "</div>" +
      '<aside class="room__chat" aria-label="Room chat">' +
        '<h2 class="room__h">Chat</h2>' +
        '<ol class="room-chat" id="room-chat"></ol>' +
        (live ? '<form class="room-chat__form" id="room-chat-form"><label for="room-chat-input" class="visually-hidden">Message</label>' +
          '<input id="room-chat-input" type="text" maxlength="500" autocomplete="off" placeholder="Message your opponent" />' +
          '<button type="submit" class="btn btn--sm">Send</button></form>' : '<p class="muted room-chat__closed">This room is closed.</p>') +
      "</aside>" +
    "</div>";

  wire(r);
  renderChat();
  loadEvidenceThumbs();
  clearInterval(room.timer);
  room.timer = (r.status === "ready_check" || r.status === "live") ? setInterval(tick, 1000) : 0;
}

function lobbyBox(r) {
  const copy = function (value, label) {
    return '<button type="button" class="btn btn--sm room-copy" data-copy="' + esc(value) + '" aria-label="Copy ' + label + '">Copy</button>';
  };
  return '<div class="room-lobby">' +
    '<div class="room-lobby__code"><span class="k">Match code</span><span class="v">' + esc(r.room_code) + "</span></div>" +
    '<dl class="room-lobby__creds">' +
      "<div><dt>Lobby name</dt><dd><code>" + esc(r.lobby_name) + "</code>" + copy(r.lobby_name, "lobby name") + "</dd></div>" +
      "<div><dt>Password</dt><dd><code>" + esc(r.lobby_password) + "</code>" + copy(r.lobby_password, "password") + "</dd></div>" +
    "</dl>" +
    '<p class="muted room-lobby__how">One of you creates a private or custom match with this name and password; the other joins it. Keep the match code in the lobby name: it ties your captures to this match.</p>' +
  "</div>";
}

function stateHtml(r) {
  const opp = esc(nameOf(opponentId()));
  if (r.status === "waiting") return "<h2>Waiting for your opponent</h2><p>This match opens when the previous round decides who you play.</p>";
  if (r.status === "void") {
    return "<h2>No result</h2><p>" + esc(r.resolution_note || "This match ended without a winner.") + "</p>";
  }
  if (r.status === "done") {
    const won = r.winner_id === me();
    const how = r.walkover ? (won ? " Your opponent didn't show up." : " You didn't get ready in time.") : "";
    const next = r.kind === "tournament" ? (won ? " Your next match opens as soon as your opponent is known." : "") : "";
    return '<h2 class="' + (won ? "is-win" : "is-loss") + '">' + (won ? "You won." : opp + " won.") + "</h2><p>" + how + next +
      (r.resolution_note ? " Review: " + esc(r.resolution_note) + "." : "") + "</p>";
  }
  if (r.status === "disputed") {
    const byMe = r.disputed_by === me();
    return "<h2>In review</h2><p>" + (byMe ? "You disputed " + opp + "'s report." : opp + " disputed your report.") +
      " The Runinback team will check the chat and the captures and decide." +
      (r.dispute_deposit_cents ? " The " + formatRcoin(r.dispute_deposit_cents) + " deposit comes back if the dispute holds and goes to the other player if it doesn't." : "") +
      "</p><p>Add captures of the final score below.</p>";
  }
  if (r.status === "ready_check") {
    const mine = myReady(); const theirs = theirReady();
    const lose = r.kind === "tournament" ? "If only one of you is ready, that player advances." : "If it runs out, the friendly closes.";
    return "<h2>Get into the lobby</h2>" +
      "<p>Set up the private match with the details above, then press Ready. The match starts when both of you are ready.</p>" +
      '<ul class="room-checks"><li class="' + (mine ? "is-done" : "") + '">You ' + (mine ? "are ready" : "aren't ready yet") + "</li>" +
      '<li class="' + (theirs ? "is-done" : "") + '">' + opp + " " + (theirs ? "is ready" : "isn't ready yet") + "</li></ul>" +
      '<p class="room-timer">Ready check ends in <strong data-deadline="' + esc(r.ready_deadline) + '">' + countdown(r.ready_deadline) + "</strong>. " + lose + "</p>" +
      (mine ? "" : '<div class="room-actions"><button type="button" class="btn btn--cta" data-act="ready">I\'m in the lobby, ready</button></div>');
  }
  // live
  const mineR = myReport(); const theirsR = theirReport();
  if (!mineR && !theirsR) {
    return "<h2>Match on</h2><p>Play the match. When it ends, report the result: if " + opp +
      " reports the same, it's settled right away.</p>" +
      '<div class="room-actions"><button type="button" class="btn btn--cta" data-act="won">I won</button>' +
      '<button type="button" class="btn" data-act="lost">I lost</button></div>';
  }
  if (mineR && !theirsR) {
    return "<h2>Waiting for " + opp + "</h2><p>You reported that " + (mineR === me() ? "you" : opp) + " won. " + opp +
      ' can confirm or dispute it; if they don\'t respond, your result stands.</p><p class="room-timer">Time left: <strong data-deadline="' +
      esc(r.confirm_deadline) + '">' + countdown(r.confirm_deadline) + "</strong></p>";
  }
  const theySayIWon = theirsR === me();
  const disputeNote = isPaid()
    ? "Disputing holds a deposit of " + formatRcoin(depositCents()) + ". You get it back if the team agrees with you; otherwise it goes to " + opp + "."
    : r.kind === "friendly" ? "A disputed friendly ends with no result." : "The Runinback team reviews disputed matches.";
  return "<h2>" + opp + " reported " + (theySayIWon ? "that you won" : "that they won") + "</h2>" +
    '<p class="room-timer">You have <strong data-deadline="' + esc(r.confirm_deadline) + '">' + countdown(r.confirm_deadline) +
    "</strong> to respond. After that, their result stands.</p>" +
    (theySayIWon
      ? '<div class="room-actions"><button type="button" class="btn btn--cta" data-act="confirm-me">Confirm my win</button></div>'
      : '<div class="room-actions"><button type="button" class="btn" data-act="confirm-them">Confirm they won</button>' +
        '<button type="button" class="btn btn--danger" data-act="dispute-open">Dispute</button></div>' +
        '<form class="room-dispute" id="room-dispute" hidden novalidate>' +
          '<label for="room-dispute-reason">What happened?</label>' +
          '<textarea id="room-dispute-reason" maxlength="500" rows="3" placeholder="For example: I won 13-9, the final scoreboard is in my capture."></textarea>' +
          '<p class="field__hint">' + disputeNote + "</p>" +
          '<div class="room-actions"><button type="submit" class="btn btn--danger">Open dispute</button>' +
          '<button type="button" class="btn" data-act="dispute-cancel">Cancel</button></div>' +
        "</form>");
}

function evidenceHtml(r) {
  const canAdd = r.status === "live" || r.status === "disputed";
  if (!canAdd && !room.evidence.length) return "";
  const hasScreen = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  return '<section class="room-evidence"><h2 class="room__h">Captures</h2>' +
    '<p class="muted">Captures are taken in the app and stamped with the match code, a one-time token and the server time, so an image made elsewhere can\'t pass as one.</p>' +
    (canAdd ? '<div class="room-actions">' +
      (hasScreen ? '<button type="button" class="btn btn--sm" data-act="capture-screen">Capture my screen</button>' : "") +
      '<button type="button" class="btn btn--sm" data-act="capture-camera">Take a photo</button>' +
      '<input type="file" accept="image/*" capture="environment" id="room-camera" hidden />' +
    "</div>" : "") +
    '<ul class="room-evidence__list" id="room-evidence-list">' + room.evidence.map(function (e) {
      return '<li><a data-evidence="' + esc(e.storage_path) + '" target="_blank" rel="noopener">' +
        '<img alt="Capture by ' + esc(nameOf(e.user_id)) + '" /></a><span>' + esc(nameOf(e.user_id)) + " · " + (e.source === "screen" ? "screen" : "photo") + "</span></li>";
    }).join("") + "</ul></section>";
}

function renderChat() {
  const list = $("room-chat");
  if (!list) return;
  list.innerHTML = room.messages.length
    ? room.messages.map(function (m) {
        const mine = m.user_id === me();
        return '<li class="' + (mine ? "is-me" : "") + '"><span class="room-chat__who">' + esc(mine ? "You" : nameOf(m.user_id)) +
          '</span><span class="room-chat__body">' + esc(m.body) + "</span></li>";
      }).join("")
    : '<li class="room-chat__empty">Say hi and agree who creates the lobby.</li>';
  list.scrollTop = list.scrollHeight;
}

function loadEvidenceThumbs() {
  const links = document.querySelectorAll("#room-evidence-list [data-evidence]");
  if (!links.length || !session.client.storage) return;
  const paths = Array.prototype.map.call(links, function (a) { return a.getAttribute("data-evidence"); });
  session.client.storage.from(EVIDENCE_BUCKET).createSignedUrls(paths, 600).then(function (r) {
    (r.data || []).forEach(function (item, i) {
      if (!item || !item.signedUrl || !links[i]) return;
      links[i].href = item.signedUrl;
      links[i].querySelector("img").src = item.signedUrl;
    });
  });
}

function tick() {
  document.querySelectorAll("#room-state [data-deadline]").forEach(function (el) {
    el.textContent = countdown(el.getAttribute("data-deadline"));
  });
}

/* ---- actions -------------------------------------------------------------- */
function act(fn, args, okText) {
  if (room.busy) return Promise.resolve();
  room.busy = true;
  document.querySelectorAll("#room-state button").forEach(function (b) { b.disabled = true; });
  return session.client.rpc(fn, args).then(function (res) {
    room.busy = false;
    if (res.error) { showMessage($("room-msg"), errorText(res.error, "Couldn't complete the action."), false); return fetchRoom(); }
    if (res.data && res.data.id) room.r = Object.assign({}, room.r, res.data);
    render();
    if (okText) showMessage($("room-msg"), okText, true);
    refreshWallet();
  }).catch(function () {
    room.busy = false;
    showMessage($("room-msg"), "Network error. Check your connection and try again.", false);
    render();
  });
}

function wire(r) {
  const root = $("room-root");
  root.querySelectorAll("[data-copy]").forEach(function (b) {
    b.addEventListener("click", function () {
      if (!navigator.clipboard) return;
      navigator.clipboard.writeText(b.getAttribute("data-copy")).then(function () {
        b.textContent = "Copied";
        b.classList.add("is-done");
        setTimeout(function () { b.textContent = "Copy"; b.classList.remove("is-done"); }, 1600);
      });
    });
  });
  const on = function (name, handler) {
    const b = root.querySelector('[data-act="' + name + '"]');
    if (b) b.addEventListener("click", handler);
  };
  on("ready", function () { act("rib_room_ready", { p_room_id: r.id }, "You're ready."); });
  on("won", function () {
    if (!window.confirm("Report that you won? If your opponent confirms, or doesn't respond in 15 minutes, the win is yours.")) return;
    act("rib_room_report", { p_room_id: r.id, p_winner_id: me() }, "Result sent.");
  });
  on("lost", function () {
    if (!window.confirm("Report that you lost? Your opponent takes the match.")) return;
    act("rib_room_report", { p_room_id: r.id, p_winner_id: opponentId() }, "Result sent. Good game.");
  });
  on("confirm-me", function () { act("rib_room_report", { p_room_id: r.id, p_winner_id: me() }, "Confirmed."); });
  on("confirm-them", function () {
    if (!window.confirm("Confirm that your opponent won?")) return;
    act("rib_room_report", { p_room_id: r.id, p_winner_id: opponentId() }, "Confirmed. Good game.");
  });
  on("dispute-open", function () { $("room-dispute").hidden = false; $("room-dispute-reason").focus(); });
  on("dispute-cancel", function () { $("room-dispute").hidden = true; });
  const dispute = $("room-dispute");
  if (dispute) {
    dispute.addEventListener("submit", function (e) {
      e.preventDefault();
      const reason = ($("room-dispute-reason").value || "").trim();
      if (reason.length < 10) { showMessage($("room-msg"), "Explain what happened (10 to 500 characters).", false); $("room-dispute-reason").focus(); return; }
      act("rib_room_dispute", { p_room_id: r.id, p_reason: reason }, r.kind === "friendly" ? "The friendly closed with no result." : "Dispute opened. Add your captures below.");
    });
  }
  on("capture-screen", function () { captureScreen(); });
  on("capture-camera", function () { $("room-camera").click(); });
  const camera = $("room-camera");
  if (camera) camera.addEventListener("change", function () { if (camera.files && camera.files[0]) capturePhoto(camera.files[0]); camera.value = ""; });

  const chat = $("room-chat-form");
  if (chat) {
    chat.addEventListener("submit", function (e) {
      e.preventDefault();
      const input = $("room-chat-input");
      const body = (input.value || "").trim();
      if (!body) return;
      input.value = "";
      session.client.rpc("rib_room_message", { p_room_id: r.id, p_body: body }).then(function (res) {
        if (res.error) { input.value = body; showMessage($("room-msg"), errorText(res.error, "Couldn't send the message."), false); return; }
        if (res.data && !room.messages.some(function (m) { return m.id === res.data.id; })) { room.messages.push(res.data); renderChat(); }
      });
    });
  }
}

/* ---- captures --------------------------------------------------------------
 * The image comes from the screen or the camera at capture time, gets a
 * server token stamped into its pixels, is hashed, stored under
 * <room>/<user>/ and registered with that token (single use, 15 minutes).
 * -------------------------------------------------------------------------- */
function captureScreen() {
  navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }).then(function (stream) {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    return video.play().then(function () {
      return new Promise(function (resolve) { requestAnimationFrame(resolve); });
    }).then(function () {
      return stampAndUpload({ image: video, width: video.videoWidth, height: video.videoHeight }, "screen")
        .finally(function () { stream.getTracks().forEach(function (t) { t.stop(); }); });
    });
  }).catch(function (err) {
    if (err && err.name === "NotAllowedError") return; // the player cancelled the picker
    showMessage($("room-msg"), "Couldn't capture the screen. Try the photo option instead.", false);
  });
}

function capturePhoto(file) {
  if (!/^image\//.test(file.type)) { showMessage($("room-msg"), "Take a photo of the final score.", false); return; }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = function () {
    stampAndUpload({ image: img, width: img.naturalWidth, height: img.naturalHeight }, "camera").finally(function () { URL.revokeObjectURL(url); });
  };
  img.onerror = function () { URL.revokeObjectURL(url); showMessage($("room-msg"), "That photo couldn't be read.", false); };
  img.src = url;
}

function stampAndUpload(source, kind) {
  const r = room.r;
  showMessage($("room-msg"), "Uploading your capture…", true);
  return session.client.rpc("rib_room_evidence_token", { p_room_id: r.id }).then(function (res) {
    if (res.error || !res.data || !res.data[0]) throw res.error || new Error("no token");
    const t = res.data[0];
    const scale = Math.min(1, 1920 / (source.width || 1920));
    const w = Math.round((source.width || 1280) * scale);
    const h = Math.round((source.height || 720) * scale);
    const bar = Math.max(36, Math.round(h * 0.05));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h + bar;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(source.image, 0, 0, w, h);
    ctx.fillStyle = "#0e100f";
    ctx.fillRect(0, h, w, bar);
    ctx.fillStyle = "#fffce1";
    ctx.font = Math.round(bar * 0.45) + "px ui-monospace, monospace";
    ctx.textBaseline = "middle";
    ctx.fillText(t.room_code + "  ·  token " + t.token + "  ·  " + new Date(t.issued_at).toISOString() + "  ·  " + nameOf(me()), 12, h + bar / 2);
    return new Promise(function (resolve) { canvas.toBlob(resolve, "image/jpeg", 0.9); }).then(function (blob) {
      return blob.arrayBuffer().then(function (buf) { return crypto.subtle.digest("SHA-256", buf); }).then(function (digest) {
        const sha = Array.prototype.map.call(new Uint8Array(digest), function (b) { return b.toString(16).padStart(2, "0"); }).join("");
        const path = r.id + "/" + me() + "/" + t.token + ".jpg";
        return session.client.storage.from(EVIDENCE_BUCKET).upload(path, blob, { contentType: "image/jpeg", upsert: false }).then(function (up) {
          if (up.error) throw up.error;
          return session.client.rpc("rib_room_evidence_add", { p_room_id: r.id, p_token: t.token, p_path: path, p_sha256: sha, p_source: kind });
        });
      });
    });
  }).then(function (res) {
    if (res && res.error) throw res.error;
    showMessage($("room-msg"), "Capture added.", true);
    return fetchRoom();
  }).catch(function (err) {
    showMessage($("room-msg"), errorText(err, "Couldn't add the capture. Try again."), false);
  });
}

export function initRoom() {
  const back = $("room-back");
  if (back) back.addEventListener("click", function () { goToPage("page-compete"); });
  document.addEventListener("rib:page", function (e) { if (e.detail !== "page-room") closeRoom(); });
}
