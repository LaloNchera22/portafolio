/* ============================================================================
 * Runinback — global ranking by net rcoin won (weekly and all time).
 * Data comes from rib_leaderboard / rib_my_standing (player_stats, maintained
 * incrementally by the database), so the page never scans the ledger.
 * ========================================================================== */
import { byId as $, escapeHtml as esc, setVisible } from "../lib/dom.js";
import { centsToRcoin, formatRcoin } from "../lib/format.js";
import { session } from "./context.js";

const PAGE_SIZE = 50;
const state = { period: "week", offset: 0, request: 0, loading: false };

function signed(cents) {
  const value = centsToRcoin(cents);
  return (value > 0 ? "+" : "") + value.toLocaleString("en") + " rcoin";
}

function record(row) {
  return row.wins + "–" + row.losses;
}

function renderStanding(row, period) {
  const box = $("ranking-me");
  if (!row) {
    box.innerHTML = '<p class="standing__empty">You\'re not on the ' + (period === "week" ? "weekly" : "all-time") +
      " board yet. Play a tournament to get ranked.</p>";
  } else {
    box.innerHTML =
      '<div class="standing__rank"><span class="standing__k">Your rank</span><span class="standing__n">' + (row.rank ? Number(row.rank).toLocaleString("en") : "—") + "</span></div>" +
      '<dl class="standing__stats">' +
      '<div><dt>Net</dt><dd class="' + (row.net_cents >= 0 ? "pos" : "neg") + '">' + esc(signed(row.net_cents)) + "</dd></div>" +
      "<div><dt>Won</dt><dd>" + esc(formatRcoin(row.won_cents)) + "</dd></div>" +
      "<div><dt>Record</dt><dd>" + esc(record(row)) + "</dd></div>" +
      "</dl>";
  }
  setVisible(box, true);
}

function rowHtml(row) {
  const me = row.user_id === session.uid;
  const podium = row.rank <= 3 ? " rank--top" : "";
  const hidden = function (text) { return '<span class="visually-hidden">' + text + "</span>"; };
  return '<li class="rank' + podium + (me ? " rank--me" : "") + '">' +
    '<span class="rank__pos">' + hidden("Rank ") + row.rank + "</span>" +
    '<span class="rank__who" title="@' + esc(row.username) + '">@' + esc(row.username) + (me ? ' <span class="tag">you</span>' : "") + "</span>" +
    '<span class="rank__net ' + (row.net_cents >= 0 ? "pos" : "neg") + '">' + hidden("net ") + esc(signed(row.net_cents)) + "</span>" +
    '<span class="rank__won">' + esc(formatRcoin(row.won_cents)) + " won</span>" +
    '<span class="rank__rec">' + hidden("record ") + esc(record(row)) + "</span>" +
    "</li>";
}

function loadPage(append) {
  if (!append) state.offset = 0;
  const period = state.period;
  const request = ++state.request; // a newer tab switch supersedes this response
  state.loading = true;
  $("ranking-more").disabled = true;
  $("ranking-list").setAttribute("aria-busy", "true");
  session.client.rpc("rib_leaderboard", { p_period: period, p_limit: PAGE_SIZE, p_offset: state.offset }).then(function (r) {
    if (request !== state.request) return;
    state.loading = false;
    $("ranking-more").disabled = false;
    const list = $("ranking-list");
    list.setAttribute("aria-busy", "false");
    if (r.error) {
      setVisible($("ranking-more"), false);
      if (!append) list.innerHTML = '<p class="muted">Couldn\'t load the ranking. Try again in a moment.</p>';
      $("ranking-status").textContent = "Couldn't load the ranking.";
      return;
    }
    const rows = r.data || [];
    if (!append && !rows.length) {
      list.innerHTML = '<div class="empty"><h3>No results yet</h3><p>' +
        (period === "week" ? "Nobody has settled a match this week. Be the first on the board." : "Settled matches will appear here.") + "</p></div>";
      setVisible($("ranking-more"), false);
      return;
    }
    const html = rows.map(rowHtml).join("");
    if (append) list.querySelector("ol").insertAdjacentHTML("beforeend", html);
    else list.innerHTML = '<ol class="ranking" role="list" aria-label="' + (period === "week" ? "This week's ranking" : "All-time ranking") + '">' + html + "</ol>";
    state.offset = rows.length > 0 ? Number(rows[rows.length - 1].rank) : state.offset;
    setVisible($("ranking-more"), rows.length === PAGE_SIZE);
    $("ranking-status").textContent = (period === "week" ? "This week's ranking, " : "All-time ranking, ") + list.querySelectorAll("li").length + " players shown";
  }).catch(function () {
    if (request !== state.request) return;
    state.loading = false;
    $("ranking-more").disabled = false;
    $("ranking-list").setAttribute("aria-busy", "false");
    if (!append) $("ranking-list").innerHTML = '<p class="muted">You\'re offline. The ranking loads when you reconnect.</p>';
    $("ranking-status").textContent = "Couldn't load the ranking.";
  });
}

export function loadRanking() {
  loadPage(false);
  const period = state.period;
  session.client.rpc("rib_my_standing", { p_period: period }).then(function (r) {
    if (period !== state.period) return; // the tab changed while loading
    renderStanding(!r.error && r.data && r.data[0] ? r.data[0] : null, period);
  }).catch(function () { /* the board itself reports being offline */ });
}

export function initRanking() {
  document.querySelectorAll("#ranking-period button[data-period]").forEach(function (b) {
    b.addEventListener("click", function () {
      document.querySelectorAll("#ranking-period button").forEach(function (x) {
        x.setAttribute("aria-pressed", String(x === b));
      });
      state.period = b.getAttribute("data-period");
      loadRanking();
    });
  });
  $("ranking-more").addEventListener("click", function () { if (!state.loading) loadPage(true); });
}

/** Compact record for the profile page (all time). */
export function loadProfileRecord() {
  const box = $("profile-stats");
  if (!box) return;
  session.client.rpc("rib_my_standing", { p_period: "all" }).then(function (r) {
    if (r.error) { box.innerHTML = '<p class="muted">Couldn\'t load your record. Try again in a moment.</p>'; return; }
    const row = r.data && r.data[0];
    if (!row) {
      box.innerHTML = '<p class="muted">No ranked results yet. Play a tournament and your record shows up here.</p>';
      return;
    }
    box.innerHTML =
      '<div><span class="n">' + (row.rank ? "#" + Number(row.rank).toLocaleString("en") : "—") + '</span><span class="k">all-time rank</span></div>' +
      '<div><span class="n ' + (row.net_cents >= 0 ? "pos" : "neg") + '">' + esc(signed(row.net_cents)) + '</span><span class="k">net won</span></div>' +
      '<div><span class="n">' + esc(record(row)) + '</span><span class="k">wins–losses</span></div>';
  });
}
