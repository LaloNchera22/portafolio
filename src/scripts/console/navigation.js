/* ============================================================================
 * Runinback — console navigation: pages, account menu, and sub-tabs.
 * ========================================================================== */
import { byId, setVisible } from "../lib/dom.js";

let pageLoaders = {};
let routeArg = null; // "#page-room/<id>" → "<id>": what a page should open

// Pages that belong to a nav destination without being one themselves.
const NAV_PARENT = { "page-room": "page-compete", "page-ops": "page-profile", "page-player": "page-ranking" };

/** Parse "#page-room/abc" into { id: "page-room", arg: "abc" }. */
function parseHash(hash) {
  const raw = (hash || "").replace(/^#/, "");
  const cut = raw.indexOf("/");
  if (cut === -1) return { id: raw, arg: null };
  let arg = raw.slice(cut + 1);
  try { arg = decodeURIComponent(arg); } catch (e) { /* a malformed escape: keep it raw */ }
  return { id: raw.slice(0, cut), arg: arg || null };
}

/** The argument of the current route (e.g. the room id), if any. */
export function currentRouteArg() { return routeArg; }

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
  const arg = options && options.arg ? String(options.arg) : null;
  routeArg = arg;
  const hash = "#" + id + (arg ? "/" + encodeURIComponent(arg) : "");
  if (!(options && options.fromHistory) && location.hash !== hash) {
    history.pushState({ page: id, arg: arg }, "", hash);
  }
  document.querySelectorAll(".capp .page").forEach(function (p) { p.hidden = p.id !== id; });
  // reflect the active destination on every nav surface (top tabs + bottom nav)
  const navId = NAV_PARENT[id] || id;
  document.querySelectorAll(".capp__tabs a[data-page], .capp__bnav a[data-page]").forEach(function (a) {
    if (a.getAttribute("data-page") === navId) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  closeAccountMenu();
  syncIndicators();
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

/* ---- sliding indicators ------------------------------------------------------
 * Segmented controls get a thumb that slides to the pressed button; the top
 * tabs an underline, the bottom nav a bar over the current item. Positions
 * are measured, so they're re-synced when a page shows or the size changes.
 * -------------------------------------------------------------------------- */
function syncSeg(group) {
  let thumb = group.querySelector(".seg__thumb");
  if (!thumb) {
    thumb = document.createElement("span");
    thumb.className = "seg__thumb";
    thumb.setAttribute("aria-hidden", "true");
    group.insertBefore(thumb, group.firstChild);
  }
  const on = group.querySelector('button[aria-pressed="true"], button[aria-selected="true"], a[aria-current="page"]');
  if (!on || !on.offsetWidth) return;
  group.style.setProperty("--seg-x", on.offsetLeft + "px");
  group.style.setProperty("--seg-w", on.offsetWidth + "px");
  group.classList.add("has-thumb");
  requestAnimationFrame(function () { group.classList.add("is-ready"); });
}

function syncTabs() {
  const tabs = document.querySelector(".capp__tabs");
  if (tabs) {
    const on = tabs.querySelector('a[aria-current="page"]');
    if (on && on.offsetWidth) {
      tabs.style.setProperty("--tab-x", on.offsetLeft + "px");
      tabs.style.setProperty("--tab-w", on.offsetWidth + "px");
      tabs.classList.add("has-thumb");
    } else {
      tabs.style.setProperty("--tab-w", "0px");
    }
  }
  const bnav = document.querySelector(".capp__bnav");
  if (bnav) {
    const links = Array.prototype.slice.call(bnav.querySelectorAll("a[data-page]"));
    const idx = links.findIndex(function (a) { return a.getAttribute("aria-current") === "page"; });
    bnav.style.setProperty("--bn-i", String(Math.max(0, idx)));
    bnav.style.setProperty("--bn-o", idx === -1 ? "0" : "1");
  }
}

/** Re-measure every sliding indicator (segments, tabs, bottom nav). */
export function syncIndicators() {
  requestAnimationFrame(function () {
    document.querySelectorAll(".capp .seg").forEach(syncSeg);
    syncTabs();
  });
}

/** @param {Record<string, () => void>} loaders page id → loader */
export function initNavigation(loaders) {
  pageLoaders = loaders || {};

  document.querySelectorAll("[data-page]").forEach(function (a) {
    a.addEventListener("click", function (e) { e.preventDefault(); goToPage(a.getAttribute("data-page")); });
  });

  // Any segment press (here or in page modules) moves its thumb.
  document.addEventListener("click", function (e) { if (e.target.closest(".capp .seg")) syncIndicators(); });
  window.addEventListener("resize", syncIndicators, { passive: true });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(syncIndicators);

  window.addEventListener("popstate", function (e) {
    const parsed = parseHash(location.hash);
    const id = (e.state && e.state.page) || parsed.id || "page-games";
    goToPage(id, { fromHistory: true, arg: (e.state && e.state.arg) || parsed.arg });
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
  const toPlayer = byId("switch-to-player");
  if (toPlayer) toPlayer.addEventListener("click", function () { goToPage("page-games"); });

  wireSegment("#compete-seg button[data-seg]", "data-seg",
    { tournaments: "compete-tournaments", mine: "compete-mine", friendlies: "compete-friendlies" }, "aria-pressed",
    function () { const msg = byId("challenge-msg"); if (msg) msg.hidden = true; });
  wireSegment("#dev-nav a[data-dev]", "data-dev",
    { projects: "dev-projects", keys: "dev-keys", payouts: "dev-payouts" }, "aria-current");
}

/** The page named by the URL hash on load, if it is a console page. */
export function initialPage() {
  const parsed = parseHash(location.hash);
  if (!isPage(parsed.id)) return null;
  routeArg = parsed.arg;
  return parsed.id;
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
