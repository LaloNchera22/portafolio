/* ============================================================================
 * Runinback — authentication (sign up / sign in) for the static site.
 * Talks to Supabase Auth via supabase-js. No secrets live here: the anon key
 * comes from supabase-config.js and every data access is gated server-side by
 * Row Level Security. Degrades gracefully when the backend is not configured.
 * ========================================================================== */
(function () {
  "use strict";

  var CFG = window.RUNINBACK_CONFIG || {};
  var configured = typeof CFG.isConfigured === "function" && CFG.isConfigured();
  var client = null;
  if (configured && window.supabase && window.supabase.createClient) {
    client = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
  }

  var CONSOLE_URL = CFG.CONSOLE_URL || "console.html";
  var modal = document.getElementById("auth-modal");
  var form = document.getElementById("auth-form");
  var mode = "signin";

  /* ---- small helpers ------------------------------------------------------ */
  function $(id) { return document.getElementById(id); }
  function showError(msg) { var e = $("auth-error"); if (e) { e.textContent = msg; e.hidden = false; } }
  function clearError() { var e = $("auth-error"); if (e) { e.hidden = true; e.textContent = ""; } }
  function showNote(msg) { var n = $("auth-note-msg"); if (n) { n.textContent = msg; n.hidden = false; } }
  function clearNote() { var n = $("auth-note-msg"); if (n) { n.hidden = true; n.textContent = ""; } }
  function setLoading(on) {
    var b = $("auth-submit"); if (!b) return;
    b.disabled = on; b.style.opacity = on ? ".6" : "";
    b.textContent = on ? "One moment…" : (mode === "signup" ? "Create account" : "Log in");
  }

  function setMode(m) {
    mode = m === "signup" ? "signup" : "signin";
    var isUp = mode === "signup";
    if ($("auth-title")) $("auth-title").textContent = isUp ? "Create your account" : "Welcome back";
    if ($("auth-sub")) $("auth-sub").textContent = isUp
      ? "Start staking skill-based matches in minutes."
      : "Log in to your Runinback console.";
    if ($("auth-username-field")) $("auth-username-field").hidden = !isUp;
    if ($("auth-username")) $("auth-username").required = isUp;
    if ($("auth-submit")) $("auth-submit").textContent = isUp ? "Create account" : "Log in";
    if ($("auth-switch-text")) $("auth-switch-text").textContent = isUp ? "Already have an account?" : "New to Runinback?";
    if ($("auth-switch-btn")) $("auth-switch-btn").textContent = isUp ? "Log in" : "Create one";
    clearError(); clearNote();
  }

  function openAuth(m) {
    if (!modal) return;
    setMode(m || "signin");
    modal.hidden = false;
    document.body.style.overflow = "hidden";
    var f = $("auth-email"); if (f) { try { f.focus(); } catch (e) {} }
  }
  function closeAuth() {
    if (!modal) return;
    modal.hidden = true;
    document.body.style.overflow = "";
  }

  /* ---- open / close / switch (event delegation) --------------------------- */
  document.addEventListener("click", function (e) {
    var opener = e.target.closest("[data-auth-open]");
    if (opener) { e.preventDefault(); openAuth(opener.getAttribute("data-auth-open")); return; }
    if (e.target.closest("[data-auth-close]")) { closeAuth(); return; }
    if (e.target.closest("[data-auth-switch]")) { e.preventDefault(); setMode(mode === "signin" ? "signup" : "signin"); return; }
    if (e.target === modal) { closeAuth(); return; }
    if (e.target.closest("[data-auth-signout]")) {
      e.preventDefault();
      if (client) { client.auth.signOut().finally(function () { window.location.href = "index.html"; }); }
      else { window.location.href = "index.html"; }
    }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && modal && !modal.hidden) closeAuth();
  });

  /* ---- submit ------------------------------------------------------------- */
  if (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      clearError(); clearNote();
      if (!form.checkValidity()) { form.reportValidity(); return; }
      if (!configured || !client) {
        showError("The backend isn't connected yet. Add your Supabase keys in supabase-config.js.");
        return;
      }
      var email = ($("auth-email").value || "").trim();
      var password = $("auth-password").value || "";
      var username = (($("auth-username") && $("auth-username").value) || "").trim();
      if (password.length < 8) { showError("Use a password of at least 8 characters."); return; }
      if (mode === "signup" && !/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
        showError("Username: 3–24 characters, letters, numbers or underscores.");
        return;
      }

      setLoading(true);
      var run = mode === "signup"
        ? client.auth.signUp({ email: email, password: password, options: { data: { username: username, display_name: username } } })
        : client.auth.signInWithPassword({ email: email, password: password });

      run.then(function (res) {
        if (res.error) { showError(res.error.message || "Something went wrong. Try again."); return; }
        if (mode === "signup" && res.data && res.data.user && !res.data.session) {
          showNote("Check your inbox to confirm your email, then log in.");
          setMode("signin");
          return;
        }
        window.location.href = CONSOLE_URL;
      }).catch(function () {
        showError("Network error. Please try again.");
      }).finally(function () {
        setLoading(false);
      });
    });
  }

  /* ---- reflect session state in the nav ----------------------------------- */
  function renderNav(session) {
    var slot = $("nav-account");
    if (!slot) return;
    if (session) {
      slot.innerHTML =
        '<a class="btn btn--cta btn--sm" href="' + CONSOLE_URL + '">Console</a>' +
        '<button type="button" class="nav__link nav__auth" data-auth-signout>Log out</button>';
    } else {
      slot.innerHTML =
        '<button type="button" class="nav__link nav__auth" data-auth-open="signin">Log in</button>' +
        '<button type="button" class="btn btn--cta btn--sm" data-auth-open="signup">Sign up</button>';
    }
  }
  if (client) {
    client.auth.getSession().then(function (r) { renderNav(r.data && r.data.session); });
    client.auth.onAuthStateChange(function (_evt, session) { renderNav(session); });
  }

  /* ---- exposed for the console page guard --------------------------------- */
  window.RuninbackAuth = {
    client: client,
    configured: configured,
    getSession: function () {
      if (!client) return Promise.resolve(null);
      return client.auth.getSession().then(function (r) { return r.data ? r.data.session : null; });
    },
    signOut: function () { return client ? client.auth.signOut() : Promise.resolve(); },
  };
})();
