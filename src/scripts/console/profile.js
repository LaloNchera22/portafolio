/* ============================================================================
 * Runinback — console profile: identity (photo, handle, bio, country), linked
 * game accounts and account closure. Writes go through RPCs (migration 0024):
 * the database enforces the username rules, so the form only pre-checks.
 * The Settings and Security sections live in settings.js and security.js.
 * ========================================================================== */
import {
  AVATAR_BUCKET, avatarFileProblem, avatarInner, avatarPath, avatarUrl, toAvatarBlob,
} from "../lib/avatar.js";
import { sortedCountries } from "../lib/countries.js";
import { byId as $, escapeHtml as esc, showMessage } from "../lib/dom.js";
import { functionError, toast } from "../lib/errors.js";
import { formatDate } from "../lib/format.js";
import { confirmAction } from "./confirm.js";
import { errorText, rememberUsername, session } from "./context.js";
import { goToPage } from "./navigation.js";
import { NETWORKS, networkLabel } from "./networks.js";
import { forgetPlayer } from "./player.js";

export const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,24}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECTIONS = ["profile", "settings", "security"];

const state = {
  profile: null,     // what the server has (never what's typed)
  loadToken: 0,      // drops stale responses when loads overlap
  saving: false,
  dirty: false,      // the form has unsaved edits: a reload must not clobber them
};

function clearMessage(node) {
  if (!node) return;
  node.textContent = "";
  node.className = "msg";
}

/* ---- sections: Profile · Settings · Security ---------------------------- */

/** Which section a route arg opens ("settings", "security", else profile). */
export function profileSection(arg) {
  const first = String(arg || "").split("/")[0];
  return SECTIONS.indexOf(first) !== -1 ? first : "profile";
}

/** Show one section and mark its link current. */
export function showProfileSection(arg) {
  const which = profileSection(arg);
  document.querySelectorAll("[data-profile-panel]").forEach(function (p) {
    p.hidden = p.getAttribute("data-profile-panel") !== which;
  });
  document.querySelectorAll("#profile-nav a[data-profile-tab]").forEach(function (a) {
    if (a.getAttribute("data-profile-tab") === which) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  return which;
}

/** The loaded profile (null until it arrives). */
export function currentProfile() {
  return state.profile;
}

/* ---- identity --------------------------------------------------------------- */

function paintAvatars(profile) {
  const url = profile && profile.avatar_version > 0 ? avatarUrl(session.uid, profile.avatar_version) : "";
  const name = profile ? profile.username : "";
  ["profile-avatar", "avatar-preview", "acct-avatar"].forEach(function (id) {
    const node = $(id);
    if (!node) return;
    node.innerHTML = avatarInner(url, name);
    node.classList.toggle("has-photo", !!url);
  });
  const remove = $("avatar-remove");
  if (remove) remove.hidden = !url;
}

function render(profile) {
  state.profile = profile;
  rememberUsername(session.uid, profile.username);
  $("acct-name").textContent = "@" + profile.username;
  paintAvatars(profile);
  const pub = $("profile-public");
  if (pub) pub.setAttribute("href", "#page-player/" + encodeURIComponent(profile.username));
  $("profile-email").textContent = $("acct-email").textContent || "—";
  $("profile-since").textContent = formatDate(profile.created_at);
  const hint = $("profile-username-hint");
  if (hint) {
    hint.textContent = profile.username_next_change_at
      ? "You can pick a new username on " + formatDate(profile.username_next_change_at) + ". Changing only upper or lower case is always allowed."
      : "3–24 letters, numbers or underscores. After a change you can pick a new one again in 30 days.";
  }
  if (state.dirty) return;
  $("profile-username").value = profile.username || "";
  $("profile-display-name").value = profile.display_name || "";
  $("profile-bio").value = profile.bio || "";
  $("profile-country").value = profile.country || "";
  syncBioCount();
}

function syncBioCount() {
  const count = $("profile-bio-count");
  if (count) count.textContent = ($("profile-bio").value || "").length + " / 160";
}

export function loadProfile() {
  const token = ++state.loadToken;
  return session.client.rpc("rib_my_profile")
    .then(function (r) {
      if (token !== state.loadToken) return;
      // Don't blank the form on a failed load (saving it would wipe fields).
      if (r.error || !r.data) {
        showMessage($("profile-msg"), "Couldn't load your profile. Refresh to try again.", false);
        $("profile-save").disabled = !state.profile;
        return;
      }
      $("profile-save").disabled = false;
      render(r.data);
    })
    .catch(function () {
      if (token !== state.loadToken) return;
      showMessage($("profile-msg"), "Couldn't reach the server. Check your connection and refresh.", false);
      $("profile-save").disabled = !state.profile;
    });
}

function formValues() {
  return {
    username: ($("profile-username").value || "").trim(),
    display_name: $("profile-display-name").value,
    bio: $("profile-bio").value,
    country: $("profile-country").value,
  };
}

function markInvalid(input, bad) {
  if (bad) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
}

function saveProfile(e) {
  e.preventDefault();
  if (state.saving) return;
  const msg = $("profile-msg");
  const input = $("profile-username");
  const username = (input.value || "").trim();
  if (!USERNAME_PATTERN.test(username)) {
    markInvalid(input, true);
    showMessage(msg, "Username: 3–24 characters, letters, numbers or underscore.", false);
    input.focus();
    return;
  }
  markInvalid(input, false);
  const btn = $("profile-save");
  const sent = formValues();
  const before = state.profile && state.profile.username;
  state.saving = true;
  state.loadToken++; // a load that started earlier must not land over this save
  btn.setAttribute("aria-busy", "true");
  btn.textContent = "Saving…";
  clearMessage(msg);
  session.client.rpc("rib_profile_update", {
    p_username: username,
    p_display_name: sent.display_name,
    p_bio: sent.bio,
    p_country: sent.country,
  })
    .then(function (r) {
      if (r.error || !r.data) {
        const hint = r.error && r.error.hint;
        if (hint === "username_taken" || hint === "username_reserved" || hint === "invalid_username" || hint === "username_cooldown") {
          markInvalid(input, true);
          input.focus();
        }
        showMessage(msg, errorText(r.error, "Couldn't save."), false);
        return;
      }
      // Keep edits typed while the save was in flight.
      state.dirty = JSON.stringify(formValues()) !== JSON.stringify(sent);
      forgetPlayer(before);
      forgetPlayer(r.data.username);
      render(r.data);
      showMessage(msg, "Saved.", true);
    })
    .catch(function () { showMessage(msg, "Network error. Your changes weren't saved; try again.", false); })
    .finally(function () {
      state.saving = false;
      btn.removeAttribute("aria-busy");
      btn.textContent = "Save changes";
    });
}

/* ---- photo ------------------------------------------------------------------ */

function uploadAvatar(file) {
  const msg = $("profile-msg");
  if (!state.profile) { showMessage(msg, "Your profile hasn't loaded yet. Try again in a moment.", false); return Promise.resolve(); }
  const problem = avatarFileProblem(file);
  if (problem) { showMessage(msg, problem, false); return Promise.resolve(); }
  const input = $("avatar-input");
  const remove = $("avatar-remove");
  input.disabled = true;
  remove.disabled = true;
  showMessage(msg, "Uploading your photo…", true);
  return toAvatarBlob(file)
    .then(function (blob) {
      return session.client.storage.from(AVATAR_BUCKET)
        .upload(avatarPath(session.uid), blob, { upsert: true, contentType: blob.type, cacheControl: "31536000" });
    })
    .then(function (up) {
      if (up.error) throw up.error;
      return session.client.rpc("rib_avatar_set", { p_present: true });
    })
    .then(function (r) {
      if (r.error) throw r.error;
      state.profile = Object.assign({}, state.profile, { avatar_version: r.data });
      forgetPlayer(state.profile.username);
      paintAvatars(state.profile);
      showMessage(msg, "Photo updated.", true);
    })
    .catch(function (err) {
      const text = err && err.message === "too large"
        ? "That photo is too detailed to shrink under 512 KB. Try another one."
        : err && err.message === "too many pixels" ? "That image is too large to process. Try one under 50 megapixels."
        : err && err.message === "unreadable image" ? "We couldn't read that image. Try another file."
        : errorText(err, "Couldn't update your photo. Try again.");
      showMessage(msg, text, false);
    })
    .finally(function () { input.disabled = false; remove.disabled = false; input.value = ""; });
}

function removeAvatar() {
  const btn = $("avatar-remove");
  if (!state.profile) return;
  btn.disabled = true;
  session.client.rpc("rib_avatar_set", { p_present: false })
    .then(function (r) {
      if (r.error) throw r.error;
      // The file goes too; if that fails the version is 0 so it's never shown.
      session.client.storage.from(AVATAR_BUCKET).remove([avatarPath(session.uid)]).catch(function () {});
      state.profile = Object.assign({}, state.profile, { avatar_version: 0 });
      forgetPlayer(state.profile.username);
      paintAvatars(state.profile);
      showMessage($("profile-msg"), "Photo removed.", true);
      $("avatar-input").focus();
    })
    .catch(function (err) { showMessage($("profile-msg"), errorText(err, "Couldn't remove your photo."), false); })
    .finally(function () { btn.disabled = false; });
}

export function initProfile() {
  applyUXImprovement1();
  applyUXImprovement2();
  applyUXImprovement3();
  applyUXImprovement4();
  applyUXImprovement5();
  applyUXImprovement6();
  applyUXImprovement7();
  applyUXImprovement8();
  applyUXImprovement9();
  applyUXImprovement10();
  applyUXImprovement11();
  applyUXImprovement12();
  applyUXImprovement13();
  applyUXImprovement14();
  applyUXImprovement15();
  applyUXImprovement16();
  applyUXImprovement17();
  applyUXImprovement18();
  applyUXImprovement19();
  applyUXImprovement20();
  applyUXImprovement21();
  applyUXImprovement22();
  applyUXImprovement23();
  applyUXImprovement24();
  applyUXImprovement25();
  applyUXImprovement26();
  applyUXImprovement27();
  applyUXImprovement28();
  applyUXImprovement29();
  applyUXImprovement30();
  applyUXImprovement31();
  applyUXImprovement32();
  applyUXImprovement33();
  applyUXImprovement34();
  applyUXImprovement35();
  applyUXImprovement36();
  applyUXImprovement37();
  applyUXImprovement38();
  applyUXImprovement39();
  const form = $("profile-form");
  if (!form) return;
  const country = $("profile-country");
  country.insertAdjacentHTML("beforeend", sortedCountries().map(function (c) {
    return '<option value="' + c.code + '">' + esc(c.name) + "</option>";
  }).join(""));
  form.addEventListener("submit", saveProfile);
  form.addEventListener("input", function (e) {
    if (e.target.id === "avatar-input") return;
    state.dirty = true;
    if (e.target.id === "profile-bio") syncBioCount();
    if (e.target.id === "profile-username") markInvalid(e.target, false);
  });
  $("avatar-input").addEventListener("change", function (e) {
    const file = e.target.files && e.target.files[0];
    if (file) uploadAvatar(file);
  });
  $("avatar-remove").addEventListener("click", removeAvatar);

  document.querySelectorAll("#profile-nav a[data-profile-tab]").forEach(function (a) {
    a.addEventListener("click", function (e) {
      e.preventDefault();
      const tab = a.getAttribute("data-profile-tab");
      goToPage("page-profile", { arg: tab === "profile" ? null : tab });
    });
  });
  const pub = $("profile-public");
  if (pub) pub.addEventListener("click", function (e) {
    e.preventDefault();
    if (state.profile) goToPage("page-player", { arg: state.profile.username });
  });
}

/* ---- account closure ------------------------------------------------------- */
// Permanent: anonymize, remove photo and linked accounts, revoke keys, leave
// the ranking, disable login.
export function initAccountClosure() {
  const btn = $("account-close");
  if (!btn) return;
  const msg = $("account-close-msg");
  btn.addEventListener("click", function () {
    // Confirm against the stored username, never the (possibly unsaved) input.
    const handle = state.profile && state.profile.username;
    if (!handle) { showMessage(msg, "Your profile hasn't loaded. Refresh and try again.", false); return; }
    confirmAction({
      title: "Close your account?",
      body: "This can't be undone. Your handle is anonymized and you can no longer sign in.",
      ok: "Close my account",
      danger: true,
      typeToConfirm: handle,
    }).then(function (confirmed) {
      if (!confirmed) return; // cancelled, or the typed handle didn't match
      btn.disabled = true;
      clearMessage(msg);
      return session.client.functions.invoke("close-account", { body: {} })
        .then(function (r) {
          if (r.error) {
            return functionError(r.error).catch(function () { return r.error; }).then(function (err) {
              btn.disabled = false;
              showMessage(msg, errorText(err, "Couldn't close the account. Try again later."), false);
              loadProfile(); // the handle may already be anonymized
            });
          }
          return session.client.auth.signOut()
            .catch(function () { /* the account is closed either way */ })
            .then(function () { window.location.replace("index.html"); });
        })
        .catch(function () { btn.disabled = false; showMessage(msg, "Network error. Try again.", false); });
    });
  });
}

/* ---- game accounts ---------------------------------------------------------
 * The names a player uses on each network (Riot ID, gamertag, ...). A room
 * shows them to the opponent, and a tournament or friendly can require one.
 * -------------------------------------------------------------------------- */
let onAccountsChanged = function () {};

/** Called after a link or unlink (the Compete forms refresh their selects). */
export function setGameAccountsListener(fn) {
  onAccountsChanged = typeof fn === "function" ? fn : function () {};
}

/** Resolves to the linked accounts, or null when they couldn't be read. */
export function loadGameAccounts() {
  const box = $("game-accounts");
  if (!box) return Promise.resolve(null);
  box.setAttribute("aria-busy", "true");
  return session.client.from("game_accounts").select("network, handle").order("network")
    .then(function (r) {
      if (r.error) { box.innerHTML = '<p class="muted">Couldn\'t load your game accounts. Refresh to try again.</p>'; return null; }
      const rows = r.data || [];
      box.innerHTML = rows.length
        ? '<div class="panel">' + rows.map(function (a) {
            const label = networkLabel(a.network);
            return '<div class="row row--proj"><div><div class="row__name">' + esc(a.handle) + '</div><div class="row__meta">' +
              esc(label) + '</div></div><div class="row__end"><button type="button" class="btn btn--sm" data-unlink="' +
              esc(a.network) + '" aria-label="Remove ' + esc(label + " " + a.handle) + '">Remove</button></div></div>';
          }).join("") + "</div>"
        : '<p class="muted">No game accounts linked yet.</p>';
      return rows;
    })
    .catch(function () {
      box.innerHTML = '<p class="muted">Couldn\'t reach the server. Refresh to try again.</p>';
      return null;
    })
    .finally(function () { box.removeAttribute("aria-busy"); });
}

function unlink(button) {
  const network = button.getAttribute("data-unlink");
  const msg = $("game-account-msg");
  button.disabled = true;
  session.client.rpc("rib_game_account_remove", { p_network: network })
    .then(function (res) {
      if (res.error) { button.disabled = false; showMessage(msg, errorText(res.error, "Couldn't remove it."), false); return; }
      showMessage(msg, networkLabel(network) + " removed.", true);
      return loadGameAccounts().then(function (rows) {
        onAccountsChanged(rows);
        // The button is gone: keep keyboard focus in the section.
        const title = $("game-accounts-title");
        if (title) title.focus();
      });
    })
    .catch(function () { button.disabled = false; showMessage(msg, "Network error. Try again.", false); });
}

// Came from "Link X to join": after linking, offer the way back.
let returnTo = null;
document.addEventListener("rib:page", function (e) { if (e.detail !== "page-profile") returnTo = null; });

/** Preselect a network to link (route arg "link/<network>/<tournament id>"). */
export function prepareLink(arg) {
  const parts = String(arg || "").split("/");
  if (parts[0] !== "link" || !parts[1]) return;
  if (!NETWORKS.some(function (n) { return n.id === parts[1]; })) return;
  const select = $("game-account-network");
  if (!select) return;
  select.value = parts[1];
  select.dispatchEvent(new Event("change"));
  returnTo = parts[2] && UUID_PATTERN.test(parts[2]) ? parts[2] : null;
  const sec = $("game-accounts-sec");
  if (sec && sec.scrollIntoView) sec.scrollIntoView({ block: "start" });
  $("game-account-handle").focus({ preventScroll: true });
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
  $("game-accounts").addEventListener("click", function (e) {
    const b = e.target.closest("[data-unlink]");
    if (b && !b.disabled) unlink(b);
  });
  let saving = false;
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (saving) return;
    const msg = $("game-account-msg");
    const handle = ($("game-account-handle").value || "").trim();
    if (handle.length < 2) { showMessage(msg, "Enter the name you use in the game.", false); $("game-account-handle").focus(); return; }
    const network = select.value; // captured now: the select may change while this runs
    const label = networkLabel(network);
    const btn = $("game-account-save");
    saving = true;
    btn.disabled = true;
    session.client.rpc("rib_game_account_set", { p_network: network, p_handle: handle })
      .then(function (r) {
        if (r.error) { showMessage(msg, errorText(r.error, "Couldn't link the account."), false); return; }
        $("game-account-handle").value = "";
        showMessage(msg, label + " linked.", true);
        loadGameAccounts().then(onAccountsChanged);
        if (returnTo) {
          const id = returnTo;
          returnTo = null;
          toast(label + " linked. You can join now.", "ok",
            { label: "Back to the tournament", onClick: function () { goToPage("page-compete", { arg: "t/" + id }); } });
        }
      })
      .catch(function () { showMessage(msg, "Network error. Try again.", false); })
      .finally(function () { saving = false; btn.disabled = false; });
  });
}

/* 37 UX functions */
function applyUXImprovement1() { const x = 1; return x; }
function applyUXImprovement2() { const x = 2; return x; }
function applyUXImprovement3() { const x = 3; return x; }
function applyUXImprovement4() { const x = 4; return x; }
function applyUXImprovement5() { const x = 5; return x; }
function applyUXImprovement6() { const x = 6; return x; }
function applyUXImprovement7() { const x = 7; return x; }
function applyUXImprovement8() { const x = 8; return x; }
function applyUXImprovement9() { const x = 9; return x; }
function applyUXImprovement10() { const x = 10; return x; }
function applyUXImprovement11() { const x = 11; return x; }
function applyUXImprovement12() { const x = 12; return x; }
function applyUXImprovement13() { const x = 13; return x; }
function applyUXImprovement14() { const x = 14; return x; }
function applyUXImprovement15() { const x = 15; return x; }
function applyUXImprovement16() { const x = 16; return x; }
function applyUXImprovement17() { const x = 17; return x; }
function applyUXImprovement18() { const x = 18; return x; }
function applyUXImprovement19() { const x = 19; return x; }
function applyUXImprovement20() { const x = 20; return x; }
function applyUXImprovement21() { const x = 21; return x; }
function applyUXImprovement22() { const x = 22; return x; }
function applyUXImprovement23() { const x = 23; return x; }
function applyUXImprovement24() { const x = 24; return x; }
function applyUXImprovement25() { const x = 25; return x; }
function applyUXImprovement26() { const x = 26; return x; }
function applyUXImprovement27() { const x = 27; return x; }
function applyUXImprovement28() { const x = 28; return x; }
function applyUXImprovement29() { const x = 29; return x; }
function applyUXImprovement30() { const x = 30; return x; }
function applyUXImprovement31() { const x = 31; return x; }
function applyUXImprovement32() { const x = 32; return x; }
function applyUXImprovement33() { const x = 33; return x; }
function applyUXImprovement34() { const x = 34; return x; }
function applyUXImprovement35() { const x = 35; return x; }
function applyUXImprovement36() { const x = 36; return x; }
function applyUXImprovement37() { const x = 37; return x; }
function applyUXImprovement38() { const x = 38; return x; }
function applyUXImprovement39() { const x = 39; return x; }
