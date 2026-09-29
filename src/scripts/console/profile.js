/* ============================================================================
 * Runinback — console profile (profiles table, RLS owner-only).
 * ========================================================================== */
import { byId as $, showMessage } from "../lib/dom.js";
import { functionError } from "../lib/errors.js";
import { formatDate } from "../lib/format.js";
import { errorText, rememberUsername, session } from "./context.js";

export const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,24}$/;

let savedUsername = ""; // the username the server has, not what's typed in the form

function showUsername(username) {
  savedUsername = username;
  rememberUsername(session.uid, username);
  $("acct-name").textContent = "@" + username;
}

export function loadProfile() {
  session.client.from("profiles").select("username, display_name, created_at").eq("id", session.uid).single()
    .then(function (r) {
      // Don't blank the form on a failed load (saving it would wipe the handle).
      if (r.error || !r.data) { showMessage($("profile-msg"), "Couldn't load your profile. Refresh to try again.", false); $("profile-save").disabled = true; return; }
      $("profile-save").disabled = false;
      const p = r.data;
      $("profile-username").value = p.username || "";
      $("profile-display-name").value = p.display_name || "";
      $("profile-email").value = $("acct-email").textContent || "";
      $("profile-since").value = formatDate(p.created_at);
      if (p.username) showUsername(p.username);
    });
}

export function initProfile() {
  const form = $("profile-form");
  if (!form) return;
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    const username = ($("profile-username").value || "").trim();
    const displayName = ($("profile-display-name").value || "").trim();
    if (!USERNAME_PATTERN.test(username)) {
      showMessage($("profile-msg"), "Username: 3–24 characters, letters, numbers or underscore.", false);
      return;
    }
    const btn = $("profile-save");
    btn.disabled = true;
    session.client.from("profiles").update({ username: username, display_name: displayName || null }).eq("id", session.uid)
      .then(function (r) {
        if (r.error) {
          const text = r.error.code === "23505" ? "That username is taken." : errorText(r.error, "Couldn't save.");
          showMessage($("profile-msg"), text, false);
          return;
        }
        showMessage($("profile-msg"), "Saved.", true);
        showUsername(username);
      })
      .catch(function () { showMessage($("profile-msg"), "Network error. Try again.", false); })
      .finally(function () { btn.disabled = false; });
  });
}

// Permanent closure: anonymize, revoke keys, leave the ranking, disable login.
export function initAccountClosure() {
  const btn = $("account-close");
  if (!btn) return;
  btn.addEventListener("click", function () {
    // Confirm against the stored username, never the (possibly unsaved) input.
    const handle = savedUsername;
    if (!handle) { showMessage($("account-close-msg"), "Your profile hasn't loaded. Refresh and try again.", false); return; }
    const typed = window.prompt("This can't be undone. Type your username (" + handle + ") to close your account.");
    if (typed === null) return;
    if (typed.trim() !== handle) { showMessage($("account-close-msg"), "The username didn't match. Nothing was changed.", false); return; }
    btn.disabled = true;
    session.client.functions.invoke("close-account", { body: {} })
      .then(function (r) {
        if (r.error) {
          btn.disabled = false;
          return functionError(r.error).then(function (err) {
            showMessage($("account-close-msg"), errorText(err, "Couldn't close the account. Try again later."), false);
          });
        }
        return session.client.auth.signOut().finally(function () { window.location.replace("index.html"); });
      })
      .catch(function () { btn.disabled = false; showMessage($("account-close-msg"), "Network error. Try again.", false); });
  });
}
