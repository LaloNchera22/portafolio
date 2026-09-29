/* ============================================================================
 * Runinback — console profile (profiles table, RLS owner-only).
 * ========================================================================== */
import { byId as $, escapeHtml as esc, showMessage } from "../lib/dom.js";
import { functionError } from "../lib/errors.js";
import { formatDate } from "../lib/format.js";
import { errorText, rememberUsername, session } from "./context.js";
import { NETWORKS, networkLabel } from "./networks.js";

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

/* ---- game accounts ---------------------------------------------------------
 * The names a player uses on each network (Riot ID, gamertag, ...). A room
 * shows them to the opponent, and a challenge can require one.
 * -------------------------------------------------------------------------- */
export function loadGameAccounts() {
  const box = $("game-accounts");
  if (!box) return Promise.resolve([]);
  return session.client.from("game_accounts").select("network, handle").order("network")
    .then(function (r) {
      if (r.error) { box.innerHTML = '<p class="muted">Couldn\'t load your game accounts. Refresh to try again.</p>'; return []; }
      const rows = r.data || [];
      box.innerHTML = rows.length
        ? '<div class="panel">' + rows.map(function (a) {
            return '<div class="row row--proj"><div><div class="row__name">' + esc(a.handle) + '</div><div class="row__meta">' +
              esc(networkLabel(a.network)) + '</div></div><div class="row__end"><button type="button" class="btn btn--sm" data-unlink="' +
              esc(a.network) + '">Remove</button></div></div>';
          }).join("") + "</div>"
        : '<p class="muted">No game accounts linked yet.</p>';
      box.querySelectorAll("[data-unlink]").forEach(function (b) {
        b.addEventListener("click", function () {
          b.disabled = true;
          session.client.rpc("rib_game_account_remove", { p_network: b.getAttribute("data-unlink") }).then(function (res) {
            if (res.error) { b.disabled = false; showMessage($("game-account-msg"), errorText(res.error, "Couldn't remove it."), false); return; }
            loadGameAccounts();
          });
        });
      });
      return rows;
    });
}

export function initGameAccounts() {
  const form = $("game-account-form");
  if (!form) return;
  const select = $("game-account-network");
  select.innerHTML = NETWORKS.map(function (n) { return '<option value="' + n.id + '">' + esc(n.label) + "</option>"; }).join("");
  const syncHint = function () {
    const n = NETWORKS.find(function (x) { return x.id === select.value; });
    $("game-account-handle").placeholder = n ? n.hint : "";
  };
  select.addEventListener("change", syncHint);
  syncHint();
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    const handle = ($("game-account-handle").value || "").trim();
    if (handle.length < 2) { showMessage($("game-account-msg"), "Enter the name you use in the game.", false); $("game-account-handle").focus(); return; }
    const btn = $("game-account-save");
    btn.disabled = true;
    session.client.rpc("rib_game_account_set", { p_network: select.value, p_handle: handle })
      .then(function (r) {
        if (r.error) { showMessage($("game-account-msg"), errorText(r.error, "Couldn't link the account."), false); return; }
        $("game-account-handle").value = "";
        showMessage($("game-account-msg"), networkLabel(select.value) + " linked.", true);
        loadGameAccounts();
      })
      .catch(function () { showMessage($("game-account-msg"), "Network error. Try again.", false); })
      .finally(function () { btn.disabled = false; });
  });
}
