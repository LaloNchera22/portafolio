/* ============================================================================
 * Runinback — Settings: notifications, privacy, play limits and data export
 * (profile_settings, migration 0024). Switches save as soon as they change;
 * play limits save on an explicit action and follow the server's rule:
 * tighten at once, loosen after a wait.
 * ========================================================================== */
import { byId as $, showMessage } from "../lib/dom.js";
import { centsToRcoin, formatDate, formatRcoin } from "../lib/format.js";
import { confirmAction } from "./confirm.js";
import { errorText, session } from "./context.js";
import { prefs, rememberPrefs } from "./prefs.js";

export { prefs };

const COOLOFF_LABELS = { 1: "1 day", 7: "1 week", 30: "1 month", 90: "3 months", 180: "6 months", 365: "1 year" };
let current = null;
let loading = null;
let seq = 0; // the newest request wins; an older reply never repaints over it

function when(iso) {
  const d = new Date(iso);
  return formatDate(iso) + ", " + d.toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" });
}

function render(s) {
  current = s;
  rememberPrefs(s);
  document.querySelectorAll("[data-setting]").forEach(function (input) {
    input.checked = !!s[input.getAttribute("data-setting")];
  });
  $("settings-notify").disabled = false;
  $("settings-privacy").disabled = false;

  // Monthly limit
  const cap = s.monthly_cap_cents;
  const spent = s.month_spent_cents || 0;
  const meter = $("cap-meter");
  meter.hidden = cap == null;
  if (cap != null) {
    const pct = cap > 0 ? Math.min(100, Math.round((spent / cap) * 100)) : 100;
    $("cap-meter-fill").style.width = pct + "%";
    meter.classList.toggle("is-full", spent >= cap);
    $("cap-meter-text").textContent = formatRcoin(spent) + " of " + formatRcoin(cap) + " used this month · " +
      formatRcoin(Math.max(0, cap - spent)) + " left";
  }
  const amount = $("cap-amount");
  if (document.activeElement !== amount) amount.value = cap == null ? "" : String(centsToRcoin(cap));
  $("cap-remove").hidden = cap == null;
  const pending = s.pending_cap;
  $("cap-pending").hidden = !pending;
  if (pending) {
    $("cap-pending-text").textContent = (pending.cents == null ? "Removing your limit" : "Raising your limit to " + formatRcoin(pending.cents)) +
      " on " + when(pending.at) + ".";
  }

  // Cool-off
  const active = !!s.cooloff_until && new Date(s.cooloff_until) > new Date();
  $("cooloff-off").hidden = active;
  $("cooloff-on").hidden = !active;
  if (active) {
    $("cooloff-text").textContent = "Paid tournaments are paused until " + when(s.cooloff_until) + ". Free tournaments stay open.";
    $("cooloff-end").hidden = !!s.pending_cooloff_end_at;
    $("cooloff-pending").hidden = !s.pending_cooloff_end_at;
    if (s.pending_cooloff_end_at) $("cooloff-pending-text").textContent = "Your cool-off ends early on " + when(s.pending_cooloff_end_at) + ".";
  }

  const exp = $("data-export");
  exp.disabled = !!s.next_export_at && new Date(s.next_export_at) > new Date();
  exp.title = exp.disabled ? "Available again " + when(s.next_export_at) : "";
}

/** Load settings when the Settings section opens. */
export function loadSettings() {
  if (!session.client) return Promise.resolve(null);
  if (loading) return loading;
  const mine = ++seq;
  loading = session.client.rpc("rib_settings_get")
    .then(function (r) {
      if (mine !== seq) return current;
      if (r.error || !r.data) {
        showMessage($("settings-msg"), errorText(r.error, "Couldn't load your settings. Refresh to try again."), false);
        return null;
      }
      const msg = $("settings-msg");
      if (msg.classList.contains("msg--err")) { msg.textContent = ""; msg.className = "msg"; }
      render(r.data);
      return r.data;
    })
    .catch(function () {
      if (mine !== seq) return current;
      showMessage($("settings-msg"), "Couldn't reach the server. Refresh to try again.", false);
      return null;
    })
    .finally(function () { loading = null; });
  return loading;
}

function update(patch, msgNode, okText, button) {
  if (button) {
    if (button.disabled) return Promise.resolve(false);
    button.disabled = true;
  }
  const mine = ++seq;
  return session.client.rpc("rib_settings_update", { p_patch: patch })
    .then(function (r) {
      if (mine !== seq && !r.error) return true; // a newer request will repaint
      if (r.error || !r.data) {
        showMessage(msgNode, errorText(r.error, "Couldn't save that."), false);
        if (current) render(current); // roll the controls back
        return false;
      }
      render(r.data);
      if (okText) showMessage(msgNode, okText, true);
      return true;
    })
    .catch(function () {
      showMessage(msgNode, "Network error. Nothing was changed.", false);
      if (current) render(current);
      return false;
    })
    .finally(function () { if (button) button.disabled = false; });
}

function initSwitches() {
  document.querySelectorAll("[data-setting]").forEach(function (input) {
    input.addEventListener("change", function () {
      const key = input.getAttribute("data-setting");
      const patch = {};
      patch[key] = input.checked;
      const label = input.labels && input.labels[0] ? input.labels[0].textContent : "Setting";
      update(patch, $("settings-msg"), label + ": " + (input.checked ? "on" : "off") + ".", input);
    });
  });
}

function initLimits() {
  const msg = $("settings-msg");
  $("cap-form").addEventListener("submit", function (e) {
    e.preventDefault();
    const text = String($("cap-amount").value).trim();
    if (!/^\d+$/.test(text) || Number(text) > 100000) {
      showMessage(msg, "Enter whole rcoin from 0 to 100,000, or remove the limit.", false);
      $("cap-amount").focus();
      return;
    }
    const cents = Number(text) * 100;
    const loosening = current && (current.monthly_cap_cents == null ? false : cents > current.monthly_cap_cents);
    update({ monthly_cap_cents: cents }, msg,
      loosening ? "Your new limit takes effect in 24 hours." : "Limit saved. It applies now.", $("cap-save"));
  });
  $("cap-remove").addEventListener("click", function () {
    confirmAction({
      title: "Remove your monthly limit?",
      body: "Your current limit stays in place for 24 hours, then it's removed. You can cancel before then.",
      ok: "Remove in 24 hours",
    }).then(function (ok) {
      if (ok) update({ monthly_cap_cents: null }, msg, "Your limit will be removed in 24 hours.", $("cap-remove"));
    });
  });
  $("cap-pending-cancel").addEventListener("click", function () {
    update({ cancel_pending_cap: true }, msg, "Change cancelled. Your current limit stays.", $("cap-pending-cancel"));
  });

  $("cooloff-start").addEventListener("click", function () {
    const picked = document.querySelector('#cooloff-days input[name="cooloff"]:checked');
    const days = picked ? Number(picked.value) : 7;
    confirmAction({
      title: "Pause paid tournaments for " + COOLOFF_LABELS[days] + "?",
      body: "You won't be able to enter paid tournaments until it ends. Ending it early takes 7 days. Tournaments you already joined continue.",
      ok: "Start cool-off",
    }).then(function (ok) {
      if (ok) update({ cooloff_days: days }, msg, "Cool-off started.", $("cooloff-start"));
    });
  });
  $("cooloff-end").addEventListener("click", function () {
    update({ end_cooloff: true }, msg, "Your cool-off will end in 7 days (or sooner, if it was ending anyway).", $("cooloff-end"));
  });
  $("cooloff-keep").addEventListener("click", function () {
    update({ cancel_end_cooloff: true }, msg, "Your cool-off continues as planned.", $("cooloff-keep"));
  });
}

function initExport() {
  const btn = $("data-export");
  btn.addEventListener("click", function () {
    btn.disabled = true;
    const msg = $("data-msg");
    session.client.rpc("rib_my_data_export")
      .then(function (r) {
        if (r.error || !r.data) {
          btn.disabled = false;
          showMessage(msg, errorText(r.error, "Couldn't prepare your data. Try again later."), false);
          return;
        }
        const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "runinback-data-" + new Date().toISOString().slice(0, 10) + ".json";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        showMessage(msg, "Downloaded. The next download is available in an hour." +
          (r.data.ledger_truncated ? " Your wallet history was long, so the file holds the latest 5,000 entries." : ""), true);
        if (current) render(Object.assign({}, current, { next_export_at: new Date(Date.now() + 3600 * 1000).toISOString() }));
      })
      .catch(function () { btn.disabled = false; showMessage(msg, "Network error. Try again.", false); });
  });
}

export function initSettings() {
  if (!$("profile-panel-settings")) return;
  initSwitches();
  initLimits();
  initExport();
}
