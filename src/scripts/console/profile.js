/* ============================================================================
 * Runinback — console profile: identity (photo, handle, bio, country), the
 * linked Riot ID and account closure. Writes go through RPCs (migration 0024):
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
import { RIOT_NETWORK, parseRiotId, playReturn } from "../lib/wild-rift.js";
import { confirmAction } from "./confirm.js";
import { errorText, rememberUsername, session } from "./context.js";
import { goToPage } from "./navigation.js";

// The public card caches by handle; player.js (loaded on demand) listens.
function forgetPlayer(username) {
  if (username) document.dispatchEvent(new CustomEvent("rib:player-changed", { detail: username }));
}

export const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,24}$/;
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

/* ---- Riot ID ----------------------------------------------------------------
 * The one game account that matters: the Riot ID a player uses in Wild Rift.
 * The room shows it to the opponent (who invites it to the custom game) and
 * every tournament requires it. Linking saves it (rib_game_account_set), then
 * asks Riot whether it exists (riot-account); a confirmed one gets a badge.
 * -------------------------------------------------------------------------- */

// Last successful read. Linking and unlinking happen on this page and
// re-read, so Play can reuse it instead of fetching on every visit.
let accountsRead = null;

function accountsHtml(rows) {
  const riot = rows.find(function (a) { return a.network === RIOT_NETWORK; });
  if (!riot) return '<div class="riot-card is-empty"><p class="riot-card__none">No Riot ID linked yet. Link it below to enter any tournament.</p></div>';
  const cut = riot.handle.lastIndexOf("#");
  const name = cut > 0 ? riot.handle.slice(0, cut) : riot.handle;
  const tag = cut > 0 ? riot.handle.slice(cut) : "";
  return '<div class="riot-card' + (riot.verified_at ? " is-verified" : "") + '"><div class="riot-card__id">' +
    '<span class="riot-card__name">' + esc(name) + '<span class="riot-card__tag">' + esc(tag) + "</span></span>" +
    (riot.verified_at ? ' <span class="tag tag--good" title="Confirmed with Riot on ' + esc(formatDate(riot.verified_at)) + '">Verified</span>' : "") +
    '</div><div class="row__meta">Riot ID · Wild Rift</div>' +
    '<span class="riot-card__lock" hidden>Locked while you play</span>' +
    '<div class="riot-card__act"><button type="button" class="btn btn--sm" data-unlink="' +
    RIOT_NETWORK + '" aria-label="Remove Riot ID ' + esc(riot.handle) + '">Remove</button></div></div>';
}

/**
 * Resolves to the linked accounts, or null when they couldn't be read.
 * `{ cached: true }` reuses the last successful read when there is one.
 */
export function loadGameAccounts(opts) {
  const box = $("game-accounts");
  if (!box) return Promise.resolve(null);
  if (opts && opts.cached && accountsRead) return accountsRead;
  box.setAttribute("aria-busy", "true");
  const read = Promise.resolve(session.client.from("game_accounts").select("network, handle, verified_at").order("network"))
    .then(function (r) {
      if (r.error) { box.innerHTML = '<p class="muted">Couldn\'t load your Riot ID. Refresh to try again.</p>'; return null; }
      const rows = r.data || [];
      box.innerHTML = accountsHtml(rows);
      const save = $("game-account-save");
      if (save) save.textContent = rows.some(function (a) { return a.network === RIOT_NETWORK; }) ? "Change Riot ID" : "Link Riot ID";
      if (rows.some(function (a) { return a.network === RIOT_NETWORK; })) checkLock();
      else applyLock();
      return rows;
    })
    .catch(function () {
      box.innerHTML = '<p class="muted">Couldn\'t reach the server. Refresh to try again.</p>';
      return null;
    })
    .finally(function () { box.removeAttribute("aria-busy"); });
  const pending = read.then(function (rows) {
    if (!rows && accountsRead === pending) accountsRead = null; // don't keep a failure
    return rows;
  });
  accountsRead = pending;
  return pending;
}

/* A Riot ID can't change while it's in play: an open or active tournament
 * entry, or a live room (the server says riot_id_locked). Play and the live
 * watcher share what they read; the profile reads it itself only when that
 * is missing or stale. */
const LOCK_FRESH_MS = 15000;
const LOCK_TEXT = "You can change your Riot ID after your current tournament.";
const lock = { tournaments: null, at: 0, rooms: [], reading: null };
document.addEventListener("rib:mine", function (e) { lock.tournaments = e.detail || []; lock.at = Date.now(); applyLock(); });
document.addEventListener("rib:live", function (e) { lock.rooms = e.detail || []; applyLock(); });

function riotLocked() {
  const entry = (lock.tournaments || []).some(function (t) { return t.status === "open" || t.status === "active"; });
  const room = lock.rooms.some(function (m) { return m.status === "ready_check" || m.status === "live" || m.status === "disputed"; });
  return entry || room;
}

function applyLock() {
  const input = $("game-account-handle");
  if (!input) return;
  const linked = !!document.querySelector('#game-accounts [data-unlink]');
  const locked = linked && riotLocked();
  input.disabled = locked;
  $("game-account-save").disabled = locked;
  document.querySelectorAll("#game-accounts [data-unlink]").forEach(function (b) { b.disabled = locked; });
  const card = document.querySelector("#game-accounts .riot-card");
  if (card) {
    card.classList.toggle("is-locked", locked);
    const note = card.querySelector(".riot-card__lock");
    if (note) note.hidden = !locked;
  }
  const hint = $("game-account-hint");
  if (hint) {
    if (!hint.dataset.base) hint.dataset.base = hint.textContent;
    hint.textContent = locked ? LOCK_TEXT : hint.dataset.base;
  }
}

function checkLock() {
  if (lock.tournaments && Date.now() - lock.at < LOCK_FRESH_MS) { applyLock(); return Promise.resolve(); }
  if (!lock.reading) {
    lock.reading = Promise.resolve(session.client.rpc("rib_my_tournaments", { p_limit: 30 })).then(function (r) {
      if (r && !r.error && Array.isArray(r.data)) { lock.tournaments = r.data; lock.at = Date.now(); }
    }).catch(function () { /* unknown: the server still enforces it */ }).finally(function () { lock.reading = null; });
  }
  return lock.reading.then(applyLock);
}

function unlink(button) {
  const msg = $("game-account-msg");
  button.disabled = true;
  session.client.rpc("rib_game_account_remove", { p_network: RIOT_NETWORK })
    .then(function (res) {
      if (res.error) {
        button.disabled = false;
        const locked = res.error.hint === "riot_id_locked";
        showMessage(msg, locked ? LOCK_TEXT : errorText(res.error, "Couldn't remove it."), false);
        if (locked) { lock.at = 0; checkLock(); }
        return;
      }
      showMessage(msg, "Riot ID removed.", true);
      return loadGameAccounts().then(function () {
        // The button is gone: keep keyboard focus in the section.
        const title = $("game-accounts-title");
        if (title) title.focus();
      });
    })
    .catch(function () { button.disabled = false; showMessage(msg, "Network error. Try again.", false); });
}

// Came from "Link your Riot ID to join": after linking, offer the way back.
let returnTo = null;
document.addEventListener("rib:page", function (e) { if (e.detail !== "page-profile") returnTo = null; });

/** Focus the Riot ID field (route arg "link/riot[/<way back to Play>]"). */
export function prepareLink(arg) {
  const parts = String(arg || "").split("/");
  if (parts[0] !== "link" || parts[1] !== RIOT_NETWORK) return;
  returnTo = playReturn(parts.slice(2).join("/"));
  const sec = $("game-accounts-sec");
  if (sec && sec.scrollIntoView) sec.scrollIntoView({ block: "start" });
  const input = $("game-account-handle");
  if (input) input.focus({ preventScroll: true });
}

// Ask Riot whether the ID exists. Only a clear "not found" is worth a word:
// an unavailable check leaves it linked, unverified, without alarming anyone.
function verifyRiotId(id) {
  if (!session.client.functions) return Promise.resolve(null);
  return session.client.functions.invoke("riot-account", { body: { game_name: id.gameName, tag_line: id.tagLine } })
    .then(function (r) {
      if (r.error) {
        return functionError(r.error).then(function (err) {
          return err.hint === "riot_account_taken" || err.hint === "invalid_game_name" || err.hint === "invalid_tag_line" ? err : null;
        }).catch(function () { return null; });
      }
      return r.data || null;
    })
    .catch(function () { return null; });
}

function goBack(target) {
  const label = target === "new" ? "Back to your tournament" : target.indexOf("q/") === 0 ? "Join now" : "Back to the tournament";
  // "j/<code>": back to the invite link the player came from.
  const back = target.indexOf("j/") === 0
    ? function () { goToPage("page-join", { arg: target.slice(2) }); }
    : function () { goToPage("page-compete", { arg: target }); };
  toast("Riot ID linked. You can join now.", "ok", { label: label, onClick: back });
}

export function initGameAccounts() {
  const form = $("game-account-form");
  if (!form) return;
  $("game-accounts").addEventListener("click", function (e) {
    const b = e.target.closest("[data-unlink]");
    if (b && !b.disabled) unlink(b);
  });
  let saving = false;
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (saving) return;
    const msg = $("game-account-msg");
    const input = $("game-account-handle");
    const id = parseRiotId(input.value);
    if (id.error) { input.setAttribute("aria-invalid", "true"); showMessage(msg, id.error, false); input.focus(); return; }
    input.removeAttribute("aria-invalid");
    const btn = $("game-account-save");
    const label = btn.textContent;
    saving = true;
    btn.disabled = true;
    btn.textContent = "Linking…";
    session.client.rpc("rib_game_account_set", { p_network: RIOT_NETWORK, p_handle: id.gameName + "#" + id.tagLine })
      .then(function (r) {
        if (r.error) {
          const locked = r.error.hint === "riot_id_locked";
          showMessage(msg, locked ? LOCK_TEXT : errorText(r.error, "Couldn't link your Riot ID."), false);
          if (locked) { lock.at = 0; checkLock(); }
          return;
        }
        input.value = "";
        return verifyRiotId(id).then(function (check) {
          if (check && check.hint) showMessage(msg, errorText(check, "Riot didn't accept that Riot ID. Check the name and the tag."), false);
          else if (check && check.verified) showMessage(msg, "Riot ID linked and verified with Riot.", true);
          else if (check && check.reason === "not_found") showMessage(msg, "Linked, but Riot doesn't know " + id.gameName + "#" + id.tagLine + ". Check the name and the tag.", false);
          else showMessage(msg, "Riot ID linked.", true);
          return loadGameAccounts();
        }).then(function () {
          if (!returnTo) return;
          const target = returnTo;
          returnTo = null;
          goBack(target);
        });
      })
      .catch(function () { showMessage(msg, "Network error. Try again.", false); })
      .finally(function () { saving = false; btn.disabled = false; if (btn.textContent === "Linking…") btn.textContent = label; applyLock(); });
  });
}
