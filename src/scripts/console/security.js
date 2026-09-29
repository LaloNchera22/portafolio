/* ============================================================================
 * Runinback — Security: password, email and sessions (Supabase Auth).
 * A password change re-checks the current password first, so an unlocked
 * device left open can't be used to take the account over.
 * ========================================================================== */
import { config } from "../lib/config.js";
import { byId as $, showMessage } from "../lib/dom.js";
import { confirmAction } from "./confirm.js";
import { session } from "./context.js";

const MIN_PASSWORD = 8;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// GoTrue error codes a player can act on (older servers only send prose).
const AUTH_CODES = {
  same_password: "Pick a password different from the current one.",
  weak_password: "That password is too easy to guess. Use a longer one.",
  email_exists: "That email is already used by another account.",
  over_request_rate_limit: "Too many attempts. Wait a few minutes and try again.",
  over_email_send_rate_limit: "Too many emails sent. Wait a few minutes and try again.",
  reauthentication_needed: "For your security, sign out, sign in again and retry.",
  invalid_credentials: "Your current password isn't right.",
};
function authText(error, fallback) {
  if (!error) return fallback;
  if (error.code && AUTH_CODES[error.code]) return AUTH_CODES[error.code];
  if (/invalid login credentials/i.test(error.message || "")) return AUTH_CODES.invalid_credentials;
  return fallback;
}

function currentEmail() {
  return ($("acct-email") && $("acct-email").textContent) || "";
}

function busy(btn, on, idleText) {
  btn.disabled = on;
  if (on) btn.setAttribute("aria-busy", "true");
  else { btn.removeAttribute("aria-busy"); btn.textContent = idleText; }
}

function initPassword() {
  const form = $("password-form");
  const msg = $("password-msg");
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    const btn = $("password-save");
    if (btn.disabled) return;
    const current = $("password-current").value;
    const next = $("password-new").value;
    const again = $("password-confirm").value;
    if (!current) { showMessage(msg, "Enter your current password.", false); $("password-current").focus(); return; }
    if (next.length < MIN_PASSWORD) { showMessage(msg, "Use at least " + MIN_PASSWORD + " characters.", false); $("password-new").focus(); return; }
    if (next === current) { showMessage(msg, "Pick a password different from the current one.", false); $("password-new").focus(); return; }
    if (next !== again) { showMessage(msg, "The two new passwords don't match.", false); $("password-confirm").focus(); return; }
    const email = currentEmail();
    if (!email) { showMessage(msg, "Your account hasn't loaded. Refresh and try again.", false); return; }
    busy(btn, true);
    btn.textContent = "Changing…";
    session.client.auth.signInWithPassword({ email: email, password: current })
      .then(function (r) {
        if (r.error) {
          showMessage(msg, authText(r.error, "Couldn't check your current password. Try again."), false);
          $("password-current").focus();
          return;
        }
        return session.client.auth.updateUser({ password: next }).then(function (u) {
          if (u.error) { showMessage(msg, authText(u.error, "Couldn't change your password. Try again."), false); return; }
          form.reset();
          showMessage(msg, "Password changed. Use it next time you sign in.", true);
        });
      })
      .catch(function () { showMessage(msg, "Network error. Your password wasn't changed.", false); })
      .finally(function () { busy(btn, false, "Change password"); });
  });
}

function initEmail() {
  const form = $("email-form");
  const msg = $("email-msg");
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    const btn = $("email-save");
    if (btn.disabled) return;
    const next = ($("email-new").value || "").trim();
    if (!EMAIL_PATTERN.test(next)) { showMessage(msg, "Enter a valid email address.", false); $("email-new").focus(); return; }
    if (next.toLowerCase() === currentEmail().toLowerCase()) { showMessage(msg, "That's already your email.", false); return; }
    busy(btn, true);
    btn.textContent = "Sending…";
    const redirect = new URL(config.consoleUrl + "#page-profile/security", window.location.href).href;
    session.client.auth.updateUser({ email: next }, { emailRedirectTo: redirect })
      .then(function (r) {
        if (r.error) { showMessage(msg, authText(r.error, "Couldn't start the change. Try again."), false); return; }
        form.reset();
        showMessage(msg, "Check " + next + " (and your current inbox) for a confirmation link. Your email changes once you open it.", true);
      })
      .catch(function () { showMessage(msg, "Network error. Try again.", false); })
      .finally(function () { busy(btn, false, "Change email"); });
  });
}

function initSessions() {
  const btn = $("sessions-others");
  const msg = $("sessions-msg");
  btn.addEventListener("click", function () {
    confirmAction({
      title: "Sign out other devices?",
      body: "Every other browser and app signed in to your account is signed out. This one stays signed in.",
      ok: "Sign out others",
    }).then(function (ok) {
      if (!ok) return;
      btn.disabled = true;
      return session.client.auth.signOut({ scope: "others" })
        .then(function (r) {
          if (r && r.error) { showMessage(msg, authText(r.error, "Couldn't sign out other devices. Try again."), false); return; }
          showMessage(msg, "Other devices are signed out.", true);
        })
        .catch(function () { showMessage(msg, "Network error. Try again.", false); })
        .finally(function () { btn.disabled = false; });
    });
  });
}

export function loadSecurity() {
  const el = $("email-current");
  if (el) el.textContent = currentEmail() || "—";
  const hidden = $("password-username");
  if (hidden) hidden.value = currentEmail();
}

export function initSecurity() {
  if (!$("password-form")) return;
  initPassword();
  initEmail();
  initSessions();
}
