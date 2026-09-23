/* ============================================================================
 * Runinback — console page guard.
 * Convenience gate only: it hides the page until a session is confirmed and
 * bounces signed-out visitors to the landing. The REAL protection is server
 * side — Row Level Security means even a forged client sees no data it doesn't
 * own. Never rely on this guard alone for authorization.
 * ========================================================================== */
(function () {
  "use strict";
  var A = window.RuninbackAuth;
  var loading = document.getElementById("console-loading");
  var main = document.getElementById("console-main");

  function toLanding() { window.location.replace("index.html"); }

  if (!A) { toLanding(); return; }

  if (!A.configured) {
    if (loading) {
      loading.innerHTML =
        '<p class="muted">The backend isn\'t connected yet. Set <code>SUPABASE_URL</code> and <code>SUPABASE_ANON_KEY</code> in your Vercel environment variables to enable accounts.</p>';
    }
    return;
  }

  A.getSession().then(function (session) {
    if (!session) { toLanding(); return; }
    if (loading) loading.hidden = true;
    if (main) main.hidden = false;
    var who = document.getElementById("console-user");
    if (who) {
      var u = session.user || {};
      var uname = u.user_metadata && u.user_metadata.username;
      who.textContent = uname ? "@" + uname : (u.email || "");
    }
  });
})();
