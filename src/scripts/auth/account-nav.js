/* ============================================================================
 * Runinback — account state in the navigation (every page with auth).
 * Renders Log in / Sign up or Console / Log out into #nav-account and handles
 * any [data-auth-signout] control (the console's account menu uses it too).
 * ========================================================================== */
import { config } from "../lib/config.js";
import { byId } from "../lib/dom.js";

// The Supabase client is ~55 KB gzipped. Logged-out visitors (most of the
// marketing traffic) never need it, so load it only when a stored session or
// an auth redirect could exist; the static markup already shows Log in / Sign up.
const SESSION_KEY = /^sb-.+-auth-token$/;

function hasStoredSession() {
  const stores = [];
  try { stores.push(window.localStorage); } catch (e) { /* storage blocked */ }
  try { stores.push(window.sessionStorage); } catch (e) { /* storage blocked */ }
  return stores.some(function (store) {
    for (let i = 0; i < store.length; i++) if (SESSION_KEY.test(store.key(i) || "")) return true;
    return false;
  });
}

function hasAuthRedirect() {
  return /access_token=|refresh_token=|[?&]code=/.test(window.location.hash + window.location.search);
}

function loadClient() {
  return import("../lib/supabase-client.js").then(function (m) { return m.getClient(); });
}

function renderNav(session) {
  const slot = byId("nav-account");
  if (!slot) return;
  if (session) {
    slot.innerHTML =
      '<a class="btn btn--cta btn--sm" href="' + config.consoleUrl + '">Console</a>' +
      '<button type="button" class="nav__link nav__auth" data-auth-signout>Log out</button>';
  } else {
    slot.innerHTML =
      '<a class="nav__link nav__auth" href="login.html">Log in</a>' +
      '<a class="btn btn--cta btn--sm" href="signup.html">Sign up</a>';
  }
}

export function initAccountNav() {
  document.addEventListener("click", function (e) {
    if (!e.target.closest("[data-auth-signout]")) return;
    e.preventDefault();
    loadClient()
      .then(function (client) { return client ? client.auth.signOut() : null; })
      .catch(function () { /* signing out locally is best effort */ })
      .finally(function () { window.location.href = "index.html"; });
  });

  if (!hasStoredSession() && !hasAuthRedirect()) return;
  loadClient().then(function (client) {
    if (!client) return;
    client.auth.getSession().then(function (r) { renderNav(r.data && r.data.session); });
    client.auth.onAuthStateChange(function (_event, session) { renderNav(session); });
  }).catch(function () { /* keep the logged-out nav */ });
}
