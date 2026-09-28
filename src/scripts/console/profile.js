/* ============================================================================
 * Runinback — console profile (profiles table, RLS owner-only).
 * ========================================================================== */
import { byId as $, showMessage } from "../lib/dom.js";
import { formatDate } from "../lib/format.js";
import { errorText, rememberUsername, session } from "./context.js";

export const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,24}$/;

function showUsername(username) {
  rememberUsername(session.uid, username);
  $("acct-name").textContent = "@" + username;
}

export function loadProfile() {
  session.client.from("profiles").select("username, display_name, created_at").eq("id", session.uid).single()
    .then(function (r) {
      const p = r.data || {};
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
