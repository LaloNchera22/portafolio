/* ============================================================================
 * Runinback — a player's public card (#page-player/<username>): photo, bio,
 * country, record and recent tournaments, as their privacy settings allow
 * (rib_public_profile, migration 0024). Cards are cached for a minute so
 * flipping between the ranking and players doesn't refetch.
 * ========================================================================== */
import { avatarInner, avatarUrl } from "../lib/avatar.js";
import { countryName } from "../lib/countries.js";
import { byId as $, escapeHtml as esc } from "../lib/dom.js";
import { formatDate, formatUSD } from "../lib/format.js";
import { session } from "./context.js";
import { goToPage } from "./navigation.js";
import { networkLabel } from "./networks.js";

const CACHE_MS = 60 * 1000;
const cache = new Map(); // lower(username) -> { at, data }
let request = 0;

function signed(cents) {
  const v = formatUSD(cents);
  return cents > 0 ? "+" + v : v;
}

function placementText(t) {
  if (t.placement === 1) return "Champion";
  if (t.placement === 2) return "Runner-up";
  if (t.placement) return "Top " + (t.placement <= 4 ? 4 : 8);
  return "Played";
}

function notFound(name) {
  return '<div class="empty"><h3>No player called @' + esc(name) + "</h3><p>The name may have changed, or the account was closed.</p>" +
    '<p><button type="button" class="btn btn--sm" data-go-ranking>Back to the ranking</button></p></div>';
}

function render(p) {
  const photo = p.avatar ? avatarUrl(p.avatar) : "";
  const title = p.display_name || "@" + p.username;
  const where = p.country ? '<span class="pcard__where">' + esc(countryName(p.country)) + "</span>" : "";
  let html = '<div class="head pcard__head"><div class="phead">' +
    '<span class="avatar avatar--xl' + (photo ? " has-photo" : "") + '" aria-hidden="true">' + avatarInner(photo, p.username) + "</span>" +
    '<div><p class="eyebrow">Player</p><h1 id="player-title" tabindex="-1">' + esc(title) + "</h1>" +
    '<p class="pcard__meta">' + (p.display_name ? "@" + esc(p.username) + " · " : "") + where + (where ? " · " : "") +
    "Member since " + esc(formatDate(p.created_at)) + "</p></div></div>" +
    (p.is_me ? '<div class="head__r"><button type="button" class="btn btn--sm" data-edit-profile>Edit profile</button></div>' : "") +
    "</div>";
  if (p.bio) html += '<p class="pcard__bio">' + esc(p.bio) + "</p>";

  const s = p.stats;
  html += '<div class="sec"><div class="sec__head"><h2>Record</h2></div>';
  if (s) {
    html += '<div class="statline">' +
      "<div><span class=\"n\">" + (s.rank_all ? "#" + Number(s.rank_all).toLocaleString("en") : "—") + '</span><span class="k">all-time rank</span></div>' +
      '<div><span class="n ' + (s.net_cents >= 0 ? "pos" : "neg") + '">' + esc(signed(s.net_cents)) + '</span><span class="k">net won</span></div>' +
      '<div><span class="n">' + esc(formatUSD(s.won_cents)) + '</span><span class="k">prizes</span></div>' +
      '<div><span class="n">' + s.wins + "–" + s.losses + '</span><span class="k">wins–losses</span></div></div>';
    if (p.is_me && !p.ranked) html += '<p class="muted">Only you see this: you\'re hidden from the ranking.</p>';
  } else {
    html += '<p class="muted">' + (p.ranked ? "No tournament matches yet." : "This player keeps their record private.") + "</p>";
  }
  html += "</div>";

  if (p.game_accounts && p.game_accounts.length) {
    html += '<div class="sec"><div class="sec__head"><h2>Game accounts</h2></div><div class="panel">' +
      p.game_accounts.map(function (g) {
        return '<div class="row"><div><div class="row__name">' + esc(g.handle) + '</div><div class="row__meta">' + esc(networkLabel(g.network)) + "</div></div></div>";
      }).join("") + "</div>" +
      (p.is_me ? '<p class="muted">' + "Visible to others only if you turn it on in Settings." + "</p>" : "") + "</div>";
  }

  html += '<div class="sec"><div class="sec__head"><h2>Recent tournaments</h2></div>';
  html += p.tournaments && p.tournaments.length
    ? '<div class="panel">' + p.tournaments.map(function (t) {
        const tone = t.placement === 1 ? " chip--settle" : t.placement === 2 ? " chip--match" : "";
        return '<div class="row"><div><div class="row__name">' + esc(t.name) + '</div><div class="row__meta">' + esc(t.game) + " · " + t.size +
          " players · " + esc(formatDate(t.finished_at)) + '</div></div><span class="chip' + tone + '">' + placementText(t) + "</span></div>";
      }).join("") + "</div>"
    : '<p class="muted">No finished tournaments yet.</p>';
  html += "</div>";
  return html;
}

/** Open a player's card (route arg = username). */
export function loadPlayer(arg) {
  const root = $("player-root");
  if (!root) return;
  const name = String(arg || "").trim();
  if (!name) { root.innerHTML = '<div class="empty"><h3>Pick a player</h3><p>Open anyone from the ranking to see their card.</p><p><button type="button" class="btn btn--sm" data-go-ranking>Go to the ranking</button></p></div>'; return; }
  if (!/^[a-zA-Z0-9_]{3,24}$/.test(name)) { root.innerHTML = notFound(name); return; }
  const key = name.toLowerCase();
  const hit = cache.get(key);
  const token = ++request;
  const show = function (data) {
    if (token !== request) return;
    root.innerHTML = data ? render(data) : notFound(name);
    const h = $("player-title");
    if (h) h.focus({ preventScroll: true });
  };
  if (hit && Date.now() - hit.at < CACHE_MS) { show(hit.data); return; }
  root.setAttribute("aria-busy", "true");
  root.innerHTML = '<p class="muted is-loading">Loading…</p>';
  session.client.rpc("rib_public_profile", { p_username: name })
    .then(function (r) {
      if (r.error) { if (token === request) root.innerHTML = '<p class="muted">Couldn\'t load this player. Try again.</p>'; return; }
      if (r.data) {
        cache.set(key, { at: Date.now(), data: r.data });
        if (cache.size > 200) cache.delete(cache.keys().next().value);
      }
      show(r.data || null);
    })
    .catch(function () { if (token === request) root.innerHTML = '<p class="muted">Couldn\'t reach the server. Try again.</p>'; })
    .finally(function () { if (token === request) root.removeAttribute("aria-busy"); });
}

/** Forget a cached card (after editing your own profile). */
export function forgetPlayer(username) {
  if (username) cache.delete(String(username).toLowerCase());
}

export function initPlayer() {
  const root = $("player-root");
  if (!root) return;
  root.addEventListener("click", function (e) {
    if (e.target.closest("[data-edit-profile]")) goToPage("page-profile");
    else if (e.target.closest("[data-go-ranking]")) goToPage("page-ranking");
  });
  // Any link to a player, anywhere in the console.
  document.addEventListener("click", function (e) {
    const a = e.target.closest("[data-player]");
    // Let modified clicks open a new tab (the href is a real deep link).
    if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    goToPage("page-player", { arg: a.getAttribute("data-player") });
  });
}
