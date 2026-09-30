/* ==========================================================================
   Runinback — shared interactions (marketing, auth and static pages)
   Nav, mobile menu, scroll reveal (one IntersectionObserver), count-ups,
   background video, FAQ, mailto forms, magnetic CTAs, cookie notice.
   Vanilla JS, no dependencies. Every page is complete without it.
   ========================================================================== */
import { countUpWithin } from "./count-up.js";

const MOBILE_MENU = "(max-width: 640px)";

export function initSiteInteractions() {
  // Tell public/js-flag.js the bundle booted, so reveal states stay enabled.
  document.documentElement.classList.add("js-ready");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = window.matchMedia("(pointer: fine)").matches;

  initScrollChrome();
  initMobileMenu();
  initReveal(reduceMotion);
  initBackgroundVideos(reduceMotion);
  initFaq();
  initMailtoForms();
  initMagnetic(finePointer && !reduceMotion);
  initAnchors(reduceMotion);
  initCookieNotice();

  const yearEl = document.querySelector("[data-year]");
  if (yearEl) yearEl.textContent = new Date().getFullYear();
}

/* --- Progress bar + hide-on-scroll nav --------------------------------- */
function initScrollChrome() {
  const progress = document.createElement("div");
  progress.className = "progress";
  progress.setAttribute("aria-hidden", "true");
  document.body.appendChild(progress);

  const nav = document.querySelector("[data-nav]");
  // One rAF-throttled handler; the scrollable height is cached and only
  // re-measured on resize/load, never read per scroll event.
  let maxScroll = 0;
  let ticking = false;
  let lastY = window.scrollY;
  const measure = () => {
    const h = document.documentElement;
    maxScroll = h.scrollHeight - h.clientHeight;
  };
  const update = () => {
    ticking = false;
    const y = window.scrollY;
    if (nav) {
      nav.classList.toggle("is-scrolled", y > 20);
      nav.classList.toggle("is-hidden", y > lastY && y > 400 && !nav.classList.contains("is-open"));
    }
    lastY = y;
    const p = maxScroll > 0 ? Math.min(1, y / maxScroll) : 0;
    progress.style.setProperty("--p", p.toFixed(4));
  };
  window.addEventListener("scroll", () => {
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  }, { passive: true });
  window.addEventListener("resize", () => { measure(); update(); }, { passive: true });
  window.addEventListener("load", measure);
  measure();
  update();
}

/* --- Mobile menu --------------------------------------------------------
   A full-screen sheet below 640px. While open, the page behind is inert, so
   Tab stays inside the header; Escape or a link closes it and focus returns
   to the toggle. */
function initMobileMenu() {
  const nav = document.querySelector("[data-nav]");
  const toggle = nav && nav.querySelector("[data-nav-toggle]");
  const links = nav && nav.querySelector(".nav__links");
  if (!toggle || !links) return;
  if (!links.id) links.id = "nav-links";
  toggle.setAttribute("aria-controls", links.id);
  if (toggle.tagName === "BUTTON") toggle.type = "button";

  const behind = [document.getElementById("main"), document.querySelector(".footer")].filter(Boolean);
  const mq = window.matchMedia(MOBILE_MENU);
  const isOpen = () => nav.classList.contains("is-open");
  const setMenu = (open, restoreFocus) => {
    nav.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    document.body.classList.toggle("menu-open", open);
    behind.forEach((el) => { el.inert = open; });
    if (open) {
      const first = links.querySelector("a, button");
      if (first) first.focus({ preventScroll: true });
    } else if (restoreFocus) {
      toggle.focus({ preventScroll: true });
    }
  };
  toggle.setAttribute("aria-label", "Open menu");
  toggle.addEventListener("click", () => setMenu(!isOpen(), true));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) setMenu(false, true);
  });
  links.addEventListener("click", (e) => {
    if (isOpen() && e.target.closest("a")) setMenu(false, false);
  });
  // Rotating a phone to landscape can cross the breakpoint with the menu open.
  const onBreakpoint = () => { if (!mq.matches && isOpen()) setMenu(false, false); };
  if (mq.addEventListener) mq.addEventListener("change", onBreakpoint);
}

/* --- Scroll reveal ------------------------------------------------------
   One observer for every [data-reveal]. Children of a [data-stagger] list
   get increasing delays; count-ups inside a revealed block start with it. */
function initReveal(reduceMotion) {
  document.querySelectorAll("[data-stagger]").forEach((list) => {
    Array.from(list.children).forEach((child, i) => {
      if (child.hasAttribute("data-reveal")) child.style.setProperty("--reveal-delay", (i * 0.07).toFixed(2) + "s");
    });
  });

  const els = document.querySelectorAll("[data-reveal]");
  const show = (el) => {
    el.classList.add("is-visible");
    countUpWithin(el);
  };
  if (!els.length) return;
  if (reduceMotion || !("IntersectionObserver" in window)) {
    els.forEach((el) => el.classList.add("is-visible"));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      io.unobserve(entry.target);
      show(entry.target);
    });
  }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
  els.forEach((el) => io.observe(el));
}

/* --- Background videos (hero + auth split panel) ------------------------
   Play only while on screen (a display:none panel never intersects, so it
   never downloads), and never under reduced motion. */
function initBackgroundVideos(reduceMotion) {
  const videos = [document.getElementById("hero-video")]
    .concat(Array.from(document.querySelectorAll(".auth-aside__video")))
    .filter(Boolean);
  videos.forEach((video) => {
    // iOS/Android autoplay only honors inline muted playback set in JS too.
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.loop = true;
    if (reduceMotion) { video.removeAttribute("autoplay"); video.pause(); return; }

    const unlockEvents = ["touchstart", "pointerdown", "keydown"];
    const unlock = () => {
      video.play().then(() => unlockEvents.forEach((ev) => window.removeEventListener(ev, unlock))).catch(() => {});
    };
    const play = () => {
      const p = video.play();
      if (p && typeof p.then === "function") {
        p.catch(() => unlockEvents.forEach((ev) => window.addEventListener(ev, unlock, { passive: true })));
      }
    };
    if (!("IntersectionObserver" in window)) { play(); return; }
    new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          if (video.preload === "none") video.preload = "auto";
          play();
        } else {
          video.pause();
        }
      });
    }).observe(video);
  });
}

/* --- FAQ accordion ------------------------------------------------------ */
function initFaq() {
  document.querySelectorAll("[data-faq]").forEach((item, i) => {
    const btn = item.querySelector(".faq__q");
    const panel = item.querySelector(".faq__a");
    if (!btn || !panel) return;
    if (!panel.id) panel.id = "faq-panel-" + i;
    btn.setAttribute("aria-controls", panel.id);
    btn.setAttribute("aria-expanded", "false");
    if (btn.tagName === "BUTTON") btn.type = "button";
    // A closed answer must not stay in the tab order or be read out.
    panel.inert = true;
    btn.addEventListener("click", () => {
      const open = item.classList.toggle("is-open");
      btn.setAttribute("aria-expanded", String(open));
      panel.inert = !open;
      panel.style.maxHeight = open ? panel.scrollHeight + "px" : "0px";
    });
  });
}

/* --- Forms: hand off to the visitor's email app ------------------------
   There is no form backend, so never claim a message was sent: build a
   mailto with the answers and say plainly where it went. */
function initMailtoForms() {
  document.querySelectorAll("[data-form]").forEach((form) => {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }
      const to = form.getAttribute("data-form");
      const subject = form.getAttribute("data-form-subject") || "Runinback";
      const body = [...form.querySelectorAll("input, select, textarea")]
        .filter((el) => el.name && el.value.trim())
        .map((el) => {
          const label = form.querySelector('label[for="' + el.id + '"]');
          return (label ? label.textContent.trim() : el.name) + ": " + el.value.trim();
        })
        .join("\n");
      window.location.href = "mailto:" + to + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
      const success = form.querySelector("[data-form-success]");
      if (success) {
        success.classList.add("is-visible");
        success.setAttribute("role", "status");
      }
    });
  });
}

/* --- Magnetic primary CTAs + brand mark (fine pointers only) ------------ */
function initMagnetic(enabled) {
  if (!enabled) return;
  document.querySelectorAll(".btn--cta:not(.btn--sm), .brand").forEach((el) => {
    el.setAttribute("data-magnetic", "");
    const strength = el.classList.contains("brand") ? 10 : 14;
    let rect = null;
    let frame = 0;
    el.addEventListener("pointerenter", () => { rect = el.getBoundingClientRect(); });
    el.addEventListener("pointermove", (e) => {
      if (!rect) rect = el.getBoundingClientRect();
      const mx = e.clientX - (rect.left + rect.width / 2);
      const my = e.clientY - (rect.top + rect.height / 2);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        el.style.transform = `translate(${(mx / rect.width) * strength}px, ${(my / rect.height) * strength}px)`;
      });
    }, { passive: true });
    el.addEventListener("pointerleave", () => {
      cancelAnimationFrame(frame);
      rect = null;
      el.style.transform = "";
    });
  });
}

/* --- Smooth in-page anchors (with nav offset) --------------------------- */
function initAnchors(reduceMotion) {
  document.querySelectorAll('a[href^="#"], a[href*=".html#"]').forEach((link) => {
    const url = new URL(link.href, window.location.href);
    if (url.pathname !== window.location.pathname || !url.hash || url.hash === "#") return;
    link.addEventListener("click", (e) => {
      let target;
      try { target = document.querySelector(url.hash); } catch (err) { return; }
      if (!target) return;
      e.preventDefault();
      const top = target.getBoundingClientRect().top + window.scrollY - 88;
      window.scrollTo({ top, behavior: reduceMotion ? "auto" : "smooth" });
      if (history.replaceState) history.replaceState(null, "", url.hash);
    });
  });
}

/* --- Cookie notice ------------------------------------------------------ */
function initCookieNotice() {
  const KEY = "rib-cookie-consent";
  let stored = null;
  try { stored = localStorage.getItem(KEY); } catch (e) {}
  if (stored === "accepted" || stored === "declined") return;

  const save = (value) => {
    try { localStorage.setItem(KEY, value); } catch (e) {}
  };

  const banner = document.createElement("aside");
  banner.className = "cookie-consent";
  banner.setAttribute("role", "region");
  banner.setAttribute("aria-label", "Cookie notice");
  banner.innerHTML =
    '<p class="cookie-consent__text">We use essential cookies to keep you signed in and run the site. ' +
    "With your consent we may also use optional cookies to understand how it's used. Read our " +
    '<a href="cookies.html">Cookie Policy</a>.</p>' +
    '<div class="cookie-consent__actions">' +
    '<button type="button" class="btn btn--ghost btn--sm" data-cookie="declined">Decline</button>' +
    '<button type="button" class="btn btn--cta btn--sm" data-cookie="accepted">Accept</button>' +
    "</div>";
  // Early in the document (right after the skip link) so keyboard and
  // screen-reader users meet it before the page content it overlays.
  const skip = document.querySelector(".skip-link");
  if (skip) skip.after(banner);
  else document.body.prepend(banner);

  requestAnimationFrame(() => {
    setTimeout(() => banner.classList.add("is-in"), 60);
  });

  banner.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-cookie]");
    if (!btn) return;
    save(btn.getAttribute("data-cookie"));
    banner.classList.remove("is-in");
    // Don't strand keyboard focus on a button that's about to disappear.
    const main = document.getElementById("main");
    if (main && banner.contains(document.activeElement)) {
      if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
      main.focus({ preventScroll: true });
    }
    setTimeout(() => banner.remove(), 650);
  });
}
