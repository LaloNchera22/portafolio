/* ============================================================================
 * Runinback — console navigation: pages, account menu, and sub-tabs.
 * ========================================================================== */
import { byId, setVisible } from "../lib/dom.js";

let pageLoaders = {};

export function closeAccountMenu() {
  const menu = byId("acct-menu");
  const avatar = byId("acct-avatar");
  if (menu) menu.hidden = true;
  if (avatar) avatar.setAttribute("aria-expanded", "false");
}

function isPage(id) {
  const el = id && byId(id);
  return !!(el && el.classList.contains("page"));
}

/**
 * Show one console page, sync every nav surface, and run its loader. Each
 * switch is a history entry so Back/Forward move between console pages and
 * the hash deep-links a page.
 */
export function goToPage(id, options) {
  if (!isPage(id)) return;
  if (!(options && options.fromHistory) && location.hash !== "#" + id) {
    history.pushState({ page: id }, "", "#" + id);
  }
  document.querySelectorAll(".capp .page").forEach(function (p) { p.hidden = p.id !== id; });
  // reflect the active destination on every nav surface (top tabs + bottom nav)
  document.querySelectorAll(".capp__tabs a[data-page], .capp__bnav a[data-page]").forEach(function (a) {
    if (a.getAttribute("data-page") === id) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  closeAccountMenu();
  document.dispatchEvent(new CustomEvent("rib:page", { detail: id }));
  if (pageLoaders[id]) pageLoaders[id]();
  window.scrollTo(0, 0);
}

function wireSegment(buttonsSelector, attr, panels, currentAttr, onSwitch) {
  const buttons = document.querySelectorAll(buttonsSelector);
  buttons.forEach(function (b) {
    b.addEventListener("click", function (e) {
      e.preventDefault();
      const which = b.getAttribute(attr);
      buttons.forEach(function (x) {
        if (currentAttr === "aria-pressed") x.setAttribute("aria-pressed", String(x === b));
        else if (x === b) x.setAttribute("aria-current", "page");
        else x.removeAttribute("aria-current");
      });
      Object.keys(panels).forEach(function (key) { setVisible(byId(panels[key]), key === which); });
      if (onSwitch) onSwitch(which);
    });
  });
}

/** @param {Record<string, () => void>} loaders page id → loader */
export function initNavigation(loaders) {
  pageLoaders = loaders || {};

  document.querySelectorAll("[data-page]").forEach(function (a) {
    a.addEventListener("click", function (e) { e.preventDefault(); goToPage(a.getAttribute("data-page")); });
  });

  window.addEventListener("popstate", function (e) {
    const id = (e.state && e.state.page) || location.hash.slice(1) || "page-games";
    goToPage(id, { fromHistory: true });
  });

  const avatar = byId("acct-avatar");
  const menu = byId("acct-menu");
  if (avatar && menu) {
    avatar.addEventListener("click", function (e) {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
      avatar.setAttribute("aria-expanded", String(!menu.hidden));
    });
    menu.addEventListener("click", function (e) { e.stopPropagation(); });
    document.addEventListener("click", closeAccountMenu);
  }
  const toDeveloper = byId("switch-to-developer");
  const toPlayer = byId("switch-to-player");
  if (toDeveloper) toDeveloper.addEventListener("click", function (e) { e.preventDefault(); goToPage("page-developer"); });
  if (toPlayer) toPlayer.addEventListener("click", function () { goToPage("page-games"); });

  wireSegment("#compete-seg button[data-seg]", "data-seg",
    { tournaments: "compete-tournaments", mine: "compete-mine", friendlies: "compete-friendlies" }, "aria-pressed",
    function () { const msg = byId("challenge-msg"); if (msg) msg.hidden = true; });
  wireSegment("#dev-nav a[data-dev]", "data-dev",
    { projects: "dev-projects", keys: "dev-keys", payouts: "dev-payouts" }, "aria-current");
}

/** The page named by the URL hash on load, if it is a console page. */
export function initialPage() {
  const id = location.hash.slice(1);
  return isPage(id) ? id : null;
}

/** Wire every [data-chips] group: one selected chip at a time. */
export function initAmountChips(onChange) {
  document.querySelectorAll("[data-chips]").forEach(function (group) {
    group.addEventListener("click", function (e) {
      const b = e.target.closest("button[data-amt]");
      if (!b) return;
      group.querySelectorAll("button").forEach(function (x) { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", String(x === b)); });
      if (onChange) onChange(group.getAttribute("data-chips"), parseInt(b.getAttribute("data-amt"), 10));
    });
  });
}

/** The selected chip amount (cents) of a [data-chips] group, or NaN. */
export function selectedChipAmount(name) {
  const group = document.querySelector('[data-chips="' + name + '"]');
  const on = group && group.querySelector("button.on");
  return on ? parseInt(on.getAttribute("data-amt"), 10) : NaN;
}
