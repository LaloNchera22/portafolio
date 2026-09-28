/* ============================================================================
 * Runinback — account state in the navigation (every page with auth).
 * Renders Log in / Sign up or Console / Log out into #nav-account and handles
 * any [data-auth-signout] control (the console's account menu uses it too).
 * ========================================================================== */
import { config } from "../lib/config.js";
import { byId } from "../lib/dom.js";
import { getClient } from "../lib/supabase-client.js";

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
    const client = getClient();
    if (client) client.auth.signOut().finally(function () { window.location.href = "index.html"; });
    else window.location.href = "index.html";
  });

  const client = getClient();
  if (client) {
    client.auth.getSession().then(function (r) { renderNav(r.data && r.data.session); });
    client.auth.onAuthStateChange(function (_event, session) { renderNav(session); });
  }
}
