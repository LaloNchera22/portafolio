/* global document, setTimeout */
/* Runinback — progressive enhancement flag. Loaded as a tiny classic script
 * in <head> (the CSP allows no inline scripts) so the scroll-reveal hidden
 * states only apply when JavaScript runs. If the site bundle never boots
 * (blocked, offline, stale deploy), drop the flag so content stays visible. */
(function () {
  var root = document.documentElement;
  root.classList.add("js");
  setTimeout(function () {
    if (!root.classList.contains("js-ready")) root.classList.remove("js");
  }, 3000);
})();
