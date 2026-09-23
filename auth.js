/* ============================================================================
 * Runinback — authentication for the static site.
 * Powers login.html and signup.html, keeps the nav in sync on every page, and
 * runs the social providers. No secrets here: the anon key comes from the
 * /api/config endpoint (Vercel env vars) and every data access is gated
 * server-side by RLS.
 * Degrades gracefully when the backend is not configured.
 * ========================================================================== */
(function () {
  "use strict";

  var CFG = window.RUNINBACK_CONFIG || {};
  var configured = typeof CFG.isConfigured === "function" && CFG.isConfigured();
  var CONSOLE_URL = CFG.CONSOLE_URL || "console.html";
  var SCOPE = document.body.getAttribute("data-auth-scope") || "login";

  function readRemember() { try { return localStorage.getItem("rib_remember") !== "0"; } catch (e) { return true; } }
  function writeRemember(v) { try { localStorage.setItem("rib_remember", v ? "1" : "0"); } catch (e) {} }

  function makeClient(remember) {
    if (!(configured && window.supabase && window.supabase.createClient)) return null;
    var storage;
    try { storage = remember ? window.localStorage : window.sessionStorage; } catch (e) { storage = undefined; }
    return window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storage: storage },
    });
  }
  var client = makeClient(readRemember());

  /* ---- helpers ------------------------------------------------------------ */
  function $(id) { return document.getElementById(id); }
  function absUrl(u) { return new URL(u, window.location.href).href; }
  function err(scope, m) { var e = $(scope + "-error"); if (e) { e.textContent = m; e.hidden = false; } var n = $(scope + "-note"); if (n) n.hidden = true; }
  function note(scope, m) { var n = $(scope + "-note"); if (n) { n.textContent = m; n.hidden = false; } var e = $(scope + "-error"); if (e) e.hidden = true; }
  function clearMsg(scope) { var e = $(scope + "-error"); if (e) e.hidden = true; var n = $(scope + "-note"); if (n) n.hidden = true; }
  function notConfigured(scope) { err(scope, "The backend isn't connected yet. Set SUPABASE_URL and SUPABASE_ANON_KEY in your Vercel environment variables."); }
  function isEmail(s) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s); }
  function busy(btn, on, label) { if (!btn) return; btn.disabled = on; btn.style.opacity = on ? ".6" : ""; if (label != null) btn.textContent = on ? "One moment…" : label; }

  // Turn Supabase/GoTrue error codes into clear, actionable messages.
  function friendly(e, fallback) {
    var code = (e && (e.code || e.error_code || e.name)) || "";
    switch (code) {
      case "over_email_send_rate_limit":
      case "email_rate_limit_exceeded":
        return "Too many email requests right now. Please wait a few minutes and try again.";
      case "user_already_exists":
      case "email_exists":
        return "That email already has an account — try logging in instead.";
      case "invalid_credentials":
      case "invalid_login_credentials":
        return "Wrong email or password.";
      case "email_not_confirmed":
        return "Please confirm your email first — check your inbox for the link.";
      case "weak_password":
        return "That password is too weak. Use at least 8 characters.";
      case "email_address_invalid":
        return "That email address looks invalid. Please use another.";
      case "signup_disabled":
        return "Sign-ups are turned off right now.";
      case "provider_disabled":
        return "That sign-in option isn't enabled yet.";
      default:
        return (e && e.message) || fallback || "Something went wrong. Please try again.";
    }
  }

  /* ---- password show / hide ----------------------------------------------- */
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-toggle-pw]"); if (!t) return;
    e.preventDefault();
    var inp = $(t.getAttribute("data-toggle-pw")); if (!inp) return;
    var reveal = inp.type === "password";
    inp.type = reveal ? "text" : "password";
    t.setAttribute("aria-pressed", String(reveal));
    t.textContent = reveal ? "Hide" : "Show";
  });

  /* ---- social sign-in (Google/GitHub/Apple native, Steam via bridge) ------- */
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-oauth]"); if (!b) return;
    e.preventDefault();
    var provider = b.getAttribute("data-oauth");
    clearMsg(SCOPE);
    if (!client) { notConfigured(SCOPE); return; }
    var redirectTo = absUrl(CONSOLE_URL);
    if (provider === "steam") {
      var base = String(CFG.SUPABASE_URL).replace(/\/+$/, "");
      window.location.href = base + "/functions/v1/steam-auth/login?redirect_to=" + encodeURIComponent(redirectTo);
      return;
    }
    client.auth.signInWithOAuth({ provider: provider, options: { redirectTo: redirectTo } })
      .then(function (res) { if (res.error) err(SCOPE, friendly(res.error, "Couldn't start sign-in.")); })
      .catch(function () { err(SCOPE, "Couldn't start sign-in. Try again."); });
  });

  /* ---- nav account state (all pages) -------------------------------------- */
  function renderNav(session) {
    var slot = $("nav-account"); if (!slot) return;
    if (session) {
      slot.innerHTML =
        '<a class="btn btn--cta btn--sm" href="' + CONSOLE_URL + '">Console</a>' +
        '<button type="button" class="nav__link nav__auth" data-auth-signout>Log out</button>';
    } else {
      slot.innerHTML =
        '<a class="nav__link nav__auth" href="login.html">Log in</a>' +
        '<a class="btn btn--cta btn--sm" href="signup.html">Sign up</a>';
    }
  }
  document.addEventListener("click", function (e) {
    if (!e.target.closest("[data-auth-signout]")) return;
    e.preventDefault();
    if (client) client.auth.signOut().finally(function () { window.location.href = "index.html"; });
    else window.location.href = "index.html";
  });
  if (client) {
    client.auth.getSession().then(function (r) { renderNav(r.data && r.data.session); });
    client.auth.onAuthStateChange(function (_evt, session) { renderNav(session); });
  }

  /* ---- LOGIN page --------------------------------------------------------- */
  var loginForm = $("login-form");
  if (loginForm) {
    var rememberBox = $("login-remember");
    if (rememberBox) {
      rememberBox.checked = readRemember();
      rememberBox.addEventListener("change", function () { writeRemember(rememberBox.checked); });
    }

    loginForm.addEventListener("submit", function (e) {
      e.preventDefault(); clearMsg("login");
      if (!loginForm.checkValidity()) { loginForm.reportValidity(); return; }
      if (!configured) { notConfigured("login"); return; }
      var remember = rememberBox ? rememberBox.checked : true;
      writeRemember(remember);
      client = makeClient(remember); // persist the session in the chosen storage
      var email = ($("login-email").value || "").trim();
      var password = $("login-password").value || "";
      var btn = $("login-submit"); busy(btn, true);
      client.auth.signInWithPassword({ email: email, password: password })
        .then(function (res) {
          if (res.error) { err("login", friendly(res.error, "Couldn't sign in.")); return; }
          window.location.href = CONSOLE_URL;
        })
        .catch(function () { err("login", "Network error. Please try again."); })
        .finally(function () { busy(btn, false, "Log in"); });
    });

    var ml = document.querySelector("[data-magiclink]");
    if (ml) ml.addEventListener("click", function () {
      clearMsg("login");
      if (!configured) { notConfigured("login"); return; }
      var email = ($("login-email").value || "").trim();
      if (!isEmail(email)) { err("login", "Enter your email above first, then request the magic link."); return; }
      busy(ml, true, "Email me a magic link");
      client.auth.signInWithOtp({ email: email, options: { emailRedirectTo: absUrl(CONSOLE_URL) } })
        .then(function (res) {
          if (res.error) { err("login", friendly(res.error)); return; }
          note("login", "Magic link sent — check your inbox to finish signing in.");
        })
        .finally(function () { busy(ml, false, "Email me a magic link"); });
    });

    var fp = document.querySelector("[data-forgot]");
    if (fp) fp.addEventListener("click", function () {
      clearMsg("login");
      if (!configured) { notConfigured("login"); return; }
      var email = ($("login-email").value || "").trim();
      if (!isEmail(email)) { err("login", "Enter your email above first, then tap reset."); return; }
      client.auth.resetPasswordForEmail(email, { redirectTo: absUrl("login.html") })
        .then(function (res) {
          if (res.error) { err("login", friendly(res.error)); return; }
          note("login", "Password reset link sent — check your inbox.");
        });
    });
  }

  /* ---- SIGN UP page ------------------------------------------------------- */
  function updateStrength(p) {
    var bar = $("pw-strength"), label = $("pw-strength-label");
    if (!bar) return;
    var s = 0;
    if (p.length >= 8) s++;
    if (p.length >= 12) s++;
    if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++;
    if (/\d/.test(p)) s++;
    if (/[^a-zA-Z0-9]/.test(p)) s++;
    var idx = p.length ? Math.min(Math.max(s, 1), 4) : 0;
    var widths = [0, 33, 55, 78, 100];
    var names = ["—", "Weak", "Fair", "Good", "Strong"];
    var colors = ["transparent", "#ff5b5b", "rgba(255,252,225,0.5)", "var(--color-surface-cream)", "#35d07f"];
    bar.style.width = widths[idx] + "%";
    bar.style.background = colors[idx];
    if (label) label.textContent = names[idx];
  }

  var signupForm = $("signup-form");
  if (signupForm) {
    var pw = $("signup-password");
    if (pw) pw.addEventListener("input", function () { updateStrength(pw.value); });

    signupForm.addEventListener("submit", function (e) {
      e.preventDefault(); clearMsg("signup");
      if (!signupForm.checkValidity()) { signupForm.reportValidity(); return; }
      var username = ($("signup-username").value || "").trim();
      var email = ($("signup-email").value || "").trim();
      var password = $("signup-password").value || "";
      var confirm = $("signup-confirm").value || "";
      var terms = $("signup-terms");
      var roleEl = document.querySelector('input[name="role"]:checked');
      var role = roleEl ? roleEl.value : "player";

      if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) { err("signup", "Username: 3–24 characters, letters, numbers or underscore."); return; }
      if (password.length < 8) { err("signup", "Use a password of at least 8 characters."); return; }
      if (password !== confirm) { err("signup", "Passwords don't match."); return; }
      if (terms && !terms.checked) { err("signup", "Please accept the terms to continue."); return; }
      if (!configured) { notConfigured("signup"); return; }

      var btn = $("signup-submit"); busy(btn, true);
      client.auth.signUp({
        email: email,
        password: password,
        options: { data: { username: username, display_name: username, role: role }, emailRedirectTo: absUrl(CONSOLE_URL) },
      })
        .then(function (res) {
          if (res.error) { err("signup", friendly(res.error, "Couldn't create the account.")); return; }
          if (res.data && res.data.user && !res.data.session) {
            note("signup", "Account created — check your inbox to confirm your email, then log in.");
            return;
          }
          window.location.href = CONSOLE_URL;
        })
        .catch(function () { err("signup", "Network error. Please try again."); })
        .finally(function () { busy(btn, false, "Create account"); });
    });
  }

  /* ---- exposed for the console page (guard + real data access) ------------- */
  window.RuninbackAuth = {
    configured: configured,
    getSession: function () {
      if (!client) return Promise.resolve(null);
      return client.auth.getSession().then(function (r) { return r.data ? r.data.session : null; });
    },
    // The live supabase-js client: every query it runs is gated by RLS, so the
    // console can only ever read or write rows the signed-in user owns.
    getClient: function () { return client; },
    signOut: function () { return client ? client.auth.signOut() : Promise.resolve(); },
  };
})();
