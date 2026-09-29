/* ============================================================================
 * Runinback — live match watcher. Wherever the player is in the console,
 * a match that needs them (a ready check, an opponent's report to confirm)
 * shows up in a strip under the bar, as a badge on Compete, in the tab
 * title and, the first time, as a toast with "Open room". Without it a
 * player on another page loses by walkover.
 *
 * Realtime on match_rooms (both seats) triggers a refresh; a slow poll
 * covers dropped connections. Countdowns tick locally.
 * ========================================================================== */
import { byId as $, escapeHtml as esc, setVisible } from "../lib/dom.js";
import { toast } from "../lib/errors.js";
import { roundName } from "../lib/tournament.js";
import { session } from "./context.js";
import { openRoom } from "./room.js";
import { prefs } from "./settings.js";

const POLL_MS = 30000;
const live = { rows: [], seen: {}, channels: [], timer: 0, poll: 0, title: "", first: true };

function countdown(deadline) {
  const ms = new Date(deadline).getTime() - Date.now();
  if (!(ms > 0)) return "0:00";
  const s = Math.ceil(ms / 1000);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

function describe(m) {
  const opp = "@" + (m.opponent_username || "opponent");
  const where = m.kind === "tournament"
    ? esc(m.tournament_name || "Tournament") + (m.rounds ? " · " + roundName(m.round, m.rounds) : "")
    : "Friendly";
  let state;
  let deadline = null;
  if (m.status === "ready_check") {
    state = m.needs_me ? "Get into the lobby and press Ready" : "You're ready. Waiting for " + esc(opp);
    deadline = m.ready_deadline;
  } else if (m.status === "live") {
    if (m.confirm_deadline && m.needs_me) { state = "Confirm " + esc(opp) + "'s result"; deadline = m.confirm_deadline; }
    else if (m.confirm_deadline) { state = "Waiting for " + esc(opp) + " to confirm"; deadline = m.confirm_deadline; }
    else state = "Match on. Report the result when it ends";
  } else {
    state = "In review by the Runinback team";
  }
  return { where: where, opp: opp, state: state, deadline: deadline };
}

function render() {
  const box = $("live-rooms");
  if (!box) return;
  const rows = live.rows;
  setVisible(box, rows.length > 0);
  box.innerHTML = rows.map(function (m) {
    const d = describe(m);
    return '<div class="live-room' + (m.needs_me ? " is-urgent" : "") + '">' +
      '<span class="live-room__dot" aria-hidden="true"></span>' +
      '<div class="live-room__text"><strong>' + d.where + "</strong> · " + esc(m.game) + " vs " + esc(d.opp) +
        '<div class="row__meta">' + d.state + (d.deadline ? ' · <span class="live-room__time" data-deadline="' + esc(d.deadline) + '">' + countdown(d.deadline) + "</span> left" : "") + "</div></div>" +
      '<button type="button" class="btn ' + (m.needs_me ? "btn--cta " : "") + 'btn--sm" data-room="' + esc(m.id) + '">Open room</button></div>';
  }).join("");
  box.querySelectorAll("[data-room]").forEach(function (b) {
    b.addEventListener("click", function () { openRoom(b.getAttribute("data-room")); });
  });

  const urgent = rows.filter(function (m) { return m.needs_me; }).length;
  document.querySelectorAll("[data-live-badge]").forEach(function (el) {
    el.textContent = String(urgent);
    el.hidden = urgent === 0;
    el.setAttribute("aria-label", urgent + (urgent === 1 ? " match needs you" : " matches need you"));
  });
  if (!live.title) live.title = document.title.replace(/^\(\d+\)\s*/, "");
  document.title = (urgent ? "(" + urgent + ") " : "") + live.title;
}

function announce() {
  // First time a room needs me (not on the very first load, and not while
  // I'm already in that room): toast with a way straight in.
  live.rows.forEach(function (m) {
    const key = m.id + ":" + m.status + ":" + (m.confirm_deadline || "");
    if (!m.needs_me || live.seen[key]) return;
    live.seen[key] = true;
    if (live.first || !prefs.match_toasts) return;
    const roomPage = $("page-room");
    if (roomPage && !roomPage.hidden && location.hash.indexOf(m.id) !== -1) return;
    const d = describe(m);
    const text = m.status === "ready_check"
      ? "Your match vs " + d.opp + " is ready. " + countdown(m.ready_deadline) + " to get in."
      : d.opp + " reported a result. Confirm or dispute it.";
    toast(text, "match", { label: "Open room", onClick: function () { openRoom(m.id); } });
  });
  live.first = false;
}

/** Re-read my live rooms (called by Realtime, the poll and after actions). */
export function refreshLive() {
  if (!session.client) return Promise.resolve([]);
  return session.client.rpc("rib_my_rooms").then(function (r) {
    live.rows = Array.isArray(r && r.data) ? r.data : [];
    render();
    announce();
    document.dispatchEvent(new CustomEvent("rib:live", { detail: live.rows }));
    return live.rows;
  }).catch(function () { return live.rows; });
}

/** The room that needs me first, if any (for the start page). */
export function urgentRoom() {
  return live.rows.find(function (m) { return m.needs_me; }) || null;
}

export function initLiveWatch() {
  if (!session.client) return Promise.resolve([]);
  if (session.client.channel) {
    ["player_a", "player_b"].forEach(function (seat) {
      live.channels.push(session.client.channel("live-" + seat)
        .on("postgres_changes", { event: "*", schema: "public", table: "match_rooms", filter: seat + "=eq." + session.uid }, refreshLive)
        .subscribe());
    });
  }
  clearInterval(live.timer);
  live.timer = setInterval(function () {
    document.querySelectorAll("#live-rooms [data-deadline]").forEach(function (el) { el.textContent = countdown(el.getAttribute("data-deadline")); });
  }, 1000);
  clearInterval(live.poll);
  live.poll = setInterval(function () { if (document.visibilityState === "visible") refreshLive(); }, POLL_MS);
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") refreshLive(); });
  return refreshLive();
}
