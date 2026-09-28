/* ============================================================================
 * Runinback — Shared Utilities
 * ========================================================================== */
window.RIBUtilities = (function () {
  "use strict";

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  function pick(a) {
    return a[(Math.random() * a.length) | 0];
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function money(cents) {
    return "$" + ((Number(cents) || 0) / 100).toFixed(2);
  }

  function rcoin(cents) {
    var n = (Number(cents) || 0) / 100;
    return parseFloat(n.toFixed(2));
  }

  function notify(error, fallback, kind) {
    var E = window.RIBErrors;
    var text = (E && E.friendly) ? E.friendly(error, fallback) : (fallback || "Something went wrong. Please try again.");
    if (E && E.toast) E.toast(text, kind || "err");
    else if (kind !== "info" && kind !== "ok") alert(text);
  }

  return {
    clone: clone,
    el: el,
    pick: pick,
    esc: esc,
    money: money,
    rcoin: rcoin,
    notify: notify
  };
})();
