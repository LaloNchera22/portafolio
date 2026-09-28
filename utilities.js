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

  return {
    clone: clone,
    el: el,
    pick: pick
  };
})();
