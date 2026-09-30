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

/**
 * Forget a one-shot route arg (e.g. "join this tier") once it's been acted
 * on, so a reload or Back doesn't act on it again.
 */
export function clearRouteArg() {
  routeArg = null;
  const id = parseHash(location.hash).id;
  if (isPage(id)) {
    try { history.replaceState({ page: id, arg: null }, "", "#" + id); } catch (e) { /* ignore */ }
  }
}

export function closeAccountMenu(returnFocus) {
  const menu = byId("acct-menu");
  const avatar = byId("acct-avatar");
  if (menu) menu.hidden = true;
  if (avatar) {
    avatar.setAttribute("aria-expanded", "false");
    if (returnFocus) avatar.focus();
  }
}

function menuItems() {
  return Array.prototype.filter.call(document.querySelectorAll("#acct-menu [role='menuitem']"), function (x) { return !x.hidden; });
}

/* Move keyboard focus to the page's heading after a page change, so a
 * screen reader starts at the new page and Tab continues from there. */
function focusHeading(page) {
  const h = page.querySelector("h1");
  if (!h) return;
  if (!h.hasAttribute("tabindex")) h.setAttribute("tabindex", "-1");
  try { h.focus({ preventScroll: true }); } catch (e) { h.focus(); }
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
  const current = document.querySelector(".capp .page:not([hidden])");
  const changed = !current || current.id !== id;
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
  // Not on boot (the page is where the player already is); a loader that
  // focuses something specific (a form field) runs after and wins.
  if (changed && !(options && options.initial)) focusHeading(byId(id));
  if (pageLoaders[id]) pageLoaders[id]();
  window.scrollTo(0, 0);
}

function wireSegment(buttonsSelector, attr, panels) {
  const buttons = document.querySelectorAll(buttonsSelector);
  buttons.forEach(function (b) {
    b.addEventListener("click", function (e) {
      e.preventDefault();
      const which = b.getAttribute(attr);
      buttons.forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
      Object.keys(panels).forEach(function (key) { setVisible(byId(panels[key]), key === which); });
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

  // The skip link lands on the visible page's heading (the hash is the router's).
  const skip = byId("skip-link");
  if (skip) skip.addEventListener("click", function (e) {
    e.preventDefault();
    const page = document.querySelector(".capp .page:not([hidden])");
    if (page) focusHeading(page);
  });

  // Any link to a player, anywhere in the console. Modified clicks open a
  // new tab (the href is a real deep link).
  document.addEventListener("click", function (e) {
    const a = e.target.closest && e.target.closest("[data-player]");
    if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    goToPage("page-player", { arg: a.getAttribute("data-player") });
  });

  // Any segment press (here or in page modules) moves its thumb.
  document.addEventListener("click", function (e) { if (e.target.closest(".capp .seg")) syncIndicators(); });
  window.addEventListener("resize", syncIndicators, { passive: true });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(syncIndicators);

  window.addEventListener("popstate", function (e) {
    const parsed = parseHash(location.hash);
    const id = (e.state && e.state.page) || parsed.id || "page-compete";
    goToPage(id, { fromHistory: true, arg: (e.state && e.state.arg) || parsed.arg });
  });

  const avatar = byId("acct-avatar");
  const menu = byId("acct-menu");
  if (avatar && menu) {
    const open = function (focusFirst) {
      menu.hidden = false;
      avatar.setAttribute("aria-expanded", "true");
      if (focusFirst) { const first = menuItems()[0]; if (first) first.focus(); }
    };
    avatar.addEventListener("click", function (e) {
      e.stopPropagation();
      if (menu.hidden) open(e.detail === 0); // keyboard activation: into the menu
      else closeAccountMenu();
    });
    avatar.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown" && menu.hidden) { e.preventDefault(); open(true); }
    });
    // Arrow keys move between items, Escape closes and returns to the avatar.
    menu.addEventListener("keydown", function (e) {
      const items = menuItems();
      const at = items.indexOf(document.activeElement);
      if (e.key === "Escape") { e.preventDefault(); closeAccountMenu(true); }
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        const next = items[(at + step + items.length) % items.length];
        if (next) next.focus();
      } else if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        const edge = items[e.key === "Home" ? 0 : items.length - 1];
        if (edge) edge.focus();
      } else if (e.key === "Tab") closeAccountMenu();
    });
    menu.addEventListener("click", function (e) { e.stopPropagation(); });
    document.addEventListener("click", function () { closeAccountMenu(); });
  }

  wireSegment("#compete-seg button[data-seg]", "data-seg",
    { play: "compete-play", mine: "compete-mine", custom: "compete-custom" });
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
