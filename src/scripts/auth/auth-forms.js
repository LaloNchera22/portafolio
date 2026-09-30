/* ============================================================================
 * Runinback — authentication forms for the static site.
 * Powers login.html and signup.html: email + password, magic link, password
 * reset and the Supabase social providers (Google, GitHub, Apple). No
 * secrets here: every data access is gated server-side by RLS.
 * Degrades gracefully when the backend is not configured.
 * ========================================================================== */
import { config, isBackendConfigured } from "../lib/config.js";
import { byId as $ } from "../lib/dom.js";
import {
  getClient,
  resetClient,
  readRememberPreference,
  writeRememberPreference,
} from "../lib/supabase-client.js";

export function initAuthForms() {

  var configured = isBackendConfigured();
  var CONSOLE_URL = config.consoleUrl;
  var SCOPE = document.body.getAttribute("data-auth-scope") || "login";
  var client = getClient();

  /* ---- helpers ------------------------------------------------------------ */
  function absUrl(u) { return new URL(u, window.location.href).href; }
  // Show an error; with a field id, also mark that field invalid, tie the
  // message to it for screen readers, and move focus there.
  function err(scope, m, fieldId) {
    clearInvalid(scope);
    var e = $(scope + "-error"); if (e) { e.textContent = m; e.hidden = false; }
    var n = $(scope + "-note"); if (n) n.hidden = true;
    var f = fieldId && $(fieldId);
    if (f) {
      f.setAttribute("aria-invalid", "true");
      var ids = (f.getAttribute("aria-describedby") || "").split(" ").filter(Boolean);
      if (ids.indexOf(scope + "-error") < 0) f.setAttribute("aria-describedby", ids.concat(scope + "-error").join(" "));
      f.focus();
    }
  }
  function clearInvalid(scope) {
    var form = $(scope + "-form");
    if (form) form.querySelectorAll('[aria-invalid="true"]').forEach(function (f) { f.removeAttribute("aria-invalid"); });
  }
  function note(scope, m) { var n = $(scope + "-note"); if (n) { n.textContent = m; n.hidden = false; } var e = $(scope + "-error"); if (e) e.hidden = true; }
  function clearMsg(scope) { clearInvalid(scope); var e = $(scope + "-error"); if (e) e.hidden = true; var n = $(scope + "-note"); if (n) n.hidden = true; }
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

  /* ---- social sign-in (Supabase OAuth providers) --------------------------- */
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-oauth]"); if (!b) return;
    e.preventDefault();
    var provider = b.getAttribute("data-oauth");
    clearMsg(SCOPE);
    if (!client) { notConfigured(SCOPE); return; }
    var redirectTo = absUrl(CONSOLE_URL);
    client.auth.signInWithOAuth({ provider: provider, options: { redirectTo: redirectTo } })
      .then(function (res) { if (res.error) err(SCOPE, friendly(res.error, "Couldn't start sign-in.")); })
      .catch(function () { err(SCOPE, "Couldn't start sign-in. Try again."); });
  });

  /* ---- LOGIN page --------------------------------------------------------- */
  var loginForm = $("login-form");
  if (loginForm) {
    var rememberBox = $("login-remember");
    if (rememberBox) {
      rememberBox.checked = readRememberPreference();
      rememberBox.addEventListener("change", function () { writeRememberPreference(rememberBox.checked); });
    }

    loginForm.addEventListener("submit", function (e) {
      e.preventDefault(); clearMsg("login");
      if (!loginForm.checkValidity()) { loginForm.reportValidity(); return; }
      if (!configured) { notConfigured("login"); return; }
      var remember = rememberBox ? rememberBox.checked : true;
      writeRememberPreference(remember);
      client = resetClient(remember); // persist the session in the chosen storage
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
      if (!isEmail(email)) { err("login", "Enter your email above first, then request the magic link.", "login-email"); return; }
      busy(ml, true, "Email me a magic link");
      client.auth.signInWithOtp({ email: email, options: { emailRedirectTo: absUrl(CONSOLE_URL) } })
        .then(function (res) {
          if (res.error) { err("login", friendly(res.error)); return; }
          note("login", "Magic link sent — check your inbox to finish signing in.");
        })
        .catch(function () { err("login", "Network error. Please try again."); })
        .finally(function () { busy(ml, false, "Email me a magic link"); });
    });

    var fp = document.querySelector("[data-forgot]");
    if (fp) fp.addEventListener("click", function () {
      clearMsg("login");
      if (!configured) { notConfigured("login"); return; }
      var email = ($("login-email").value || "").trim();
      if (!isEmail(email)) { err("login", "Enter your email above first, then tap reset.", "login-email"); return; }
      client.auth.resetPasswordForEmail(email, { redirectTo: absUrl("login.html") })
        .then(function (res) {
          if (res.error) { err("login", friendly(res.error)); return; }
          note("login", "Password reset link sent — check your inbox.");
        })
        .catch(function () { err("login", "Network error. Please try again."); });
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

      if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) { err("signup", "Username: 3–24 characters, letters, numbers or underscore.", "signup-username"); return; }
      if (password.length < 8) { err("signup", "Use a password of at least 8 characters.", "signup-password"); return; }
      if (password !== confirm) { err("signup", "Passwords don't match.", "signup-confirm"); return; }
      const age = $("signup-age");
      if (age && !age.checked) { err("signup", "Please confirm you're 18 or older and eligible to play where you live.", "signup-age"); return; }
      if (terms && !terms.checked) { err("signup", "Please accept the terms to continue.", "signup-terms"); return; }
      if (!configured) { notConfigured("signup"); return; }

      var btn = $("signup-submit"); busy(btn, true);
      client.auth.signUp({
        email: email,
        password: password,
        // Records the self-declared age/eligibility confirmation with the account.
        options: { data: { username: username, display_name: username, age_confirmed_at: new Date().toISOString() }, emailRedirectTo: absUrl(CONSOLE_URL) },
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
}
