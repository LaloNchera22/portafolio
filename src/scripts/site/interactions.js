/* ==========================================================================
   Runinback — shared interactions
   Nav behavior, scroll reveal, hero video, FAQ, forms, footer year.
   Vanilla JS, no dependencies.
   ========================================================================== */

export function initSiteInteractions() {
  // Tell public/js-flag.js the bundle booted, so reveal states stay enabled.
  document.documentElement.classList.add("js-ready");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const finePointer = window.matchMedia("(pointer: fine)").matches;

  /* --- Scroll progress bar --------------------------------------------- */
  const progress = document.createElement("div");
  progress.className = "progress";
  progress.setAttribute("aria-hidden", "true");
  document.body.appendChild(progress);

  /* --- Sticky / hide-on-scroll nav ------------------------------------- */
  const nav = document.querySelector("[data-nav]");
  let ticking = false;

  // One rAF-throttled handler for the nav state and the progress bar; the
  // scrollable height is cached and refreshed on resize, not read per event.
  let maxScroll = 0;
  const measure = () => {
    const h = document.documentElement;
    maxScroll = h.scrollHeight - h.clientHeight;
  };
  const updateProgress = (y) => {
    const p = maxScroll > 0 ? Math.min(1, y / maxScroll) : 0;
    progress.style.setProperty("--p", p.toFixed(4));
  };
  let lastY = window.scrollY;
  const onScroll = () => {
    ticking = false;
    const y = window.scrollY;
    if (nav) {
      nav.classList.toggle("is-scrolled", y > 20);
      nav.classList.toggle("is-hidden", y > lastY && y > 400 && !nav.classList.contains("is-open"));
    }
    lastY = y;
    updateProgress(y);
  };
  window.addEventListener("scroll", () => {
    if (!ticking) { ticking = true; requestAnimationFrame(onScroll); }
  }, { passive: true });
  window.addEventListener("resize", () => { measure(); onScroll(); }, { passive: true });
  // Late content (fonts, FAQ panels) changes the page height after load.
  window.addEventListener("load", measure);
  measure();
  onScroll();

  if (nav) {

    /* Mobile menu toggle */
    const toggle = nav.querySelector("[data-nav-toggle]");
    if (toggle) {
      const setMenu = (open) => {
        nav.classList.toggle("is-open", open);
        toggle.setAttribute("aria-expanded", String(open));
        document.body.style.overflow = open ? "hidden" : "";
      };
      toggle.addEventListener("click", () => setMenu(!nav.classList.contains("is-open")));
      // Escape closes the menu and returns focus to the toggle.
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && nav.classList.contains("is-open")) { setMenu(false); toggle.focus(); }
      });
      nav.querySelectorAll(".nav__link, .nav__links .btn").forEach((link) => {
        link.addEventListener("click", () => {
          nav.classList.remove("is-open");
          toggle.setAttribute("aria-expanded", "false");
          document.body.style.overflow = "";
        });
      });
    }
  }

  /* --- Scroll reveal ---------------------------------------------------- */
  const revealEls = document.querySelectorAll("[data-reveal]");
  if (revealEls.length) {
    if (reduceMotion || !("IntersectionObserver" in window)) {
      revealEls.forEach((el) => el.classList.add("is-visible"));
    } else {
      const io = new IntersectionObserver(
        (entries, obs) => {
          entries.forEach((entry, i) => {
            if (entry.isIntersecting) {
              entry.target.style.setProperty("--reveal-delay", (entry.target.dataset.revealDelay || (i % 4) * 0.08) + "s");
              entry.target.classList.add("is-visible");
              obs.unobserve(entry.target);
            }
          });
        },
        { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
      );
      revealEls.forEach((el) => io.observe(el));
    }
  }

  /* --- Section band reveal (landing) ------------------------------------ */
  const bands = document.querySelectorAll("[data-band]");
  if (bands.length) {
    if (reduceMotion || !("IntersectionObserver" in window)) {
      bands.forEach((b) => b.classList.add("is-in"));
    } else {
      const bio = new IntersectionObserver(
        (entries, obs) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              entry.target.classList.add("is-in");
              obs.unobserve(entry.target);
            }
          });
        },
        { threshold: 0.16, rootMargin: "0px 0px -8% 0px" }
      );
      bands.forEach((b) => bio.observe(b));
    }
  }

  /* --- Background videos (hero + auth split panel) --------------------- */
  // The clip is cut to the 7s loop, so native `loop` does the work. Play only
  // while the video is actually on screen (the auth panel is hidden on phones,
  // and the hero scrolls away), and never under reduced motion.
  const initBackgroundVideo = (video) => {
    // iOS/Android autoplay only honors *inline muted* playback set at the JS
    // level too, so set every flag before trying to play.
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.loop = true;
    if (reduceMotion) { video.pause(); return; }

    // If the browser blocks autoplay, the first gesture starts it.
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
        // A display:none panel never intersects, so it never downloads or plays.
        if (entry.isIntersecting) {
          if (video.preload === "none") video.preload = "auto";
          play();
        } else {
          video.pause();
        }
      });
    }).observe(video);
  };
  [document.getElementById("hero-video")]
    .concat(Array.from(document.querySelectorAll(".auth-aside__video")))
    .filter(Boolean)
    .forEach(initBackgroundVideo);

  /* --- FAQ accordion ---------------------------------------------------- */
  document.querySelectorAll("[data-faq]").forEach((item) => {
    const btn = item.querySelector(".faq__q");
    const panel = item.querySelector(".faq__a");
    if (!btn || !panel) return;
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

  /* --- Forms: hand off to the visitor's email app ---------------------- */
  // There is no form backend yet, so never claim a message was sent: build
  // a mailto with the answers and say plainly where it went.
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

  /* --- Copy buttons on code blocks ------------------------------------- */
  // The label cross-fades to "Copied" and back, so the click is confirmed
  // right where it happened.
  if (navigator.clipboard) {
    document.querySelectorAll(".terminal").forEach((term) => {
      const bar = term.querySelector(".terminal__bar");
      const code = term.querySelector("code");
      if (!bar || !code) return;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "terminal__copy";
      btn.setAttribute("aria-label", "Copy code");
      btn.innerHTML = '<span class="terminal__copy-idle">Copy</span><span class="terminal__copy-done" aria-hidden="true">Copied</span>';
      bar.appendChild(btn);
      let reset = 0;
      btn.addEventListener("click", () => {
        navigator.clipboard.writeText(code.textContent).then(() => {
          btn.classList.add("is-done");
          btn.setAttribute("aria-label", "Copied");
          clearTimeout(reset);
          reset = setTimeout(() => { btn.classList.remove("is-done"); btn.setAttribute("aria-label", "Copy code"); }, 1600);
        }).catch(() => {});
      });
    });
  }

  /* --- Footer year ------------------------------------------------------ */
  const yearEl = document.querySelector("[data-year]");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  /* --- Magnetic buttons / brand mark ----------------------------------- */
  // The element's box is measured once on enter, not on every pointermove,
  // and writes are coalesced into one frame.
  if (finePointer && !reduceMotion) {
    document.querySelectorAll(".btn--cta, .brand").forEach((el) => {
      el.setAttribute("data-magnetic", "");
      const strength = el.classList.contains("brand") ? 10 : 16;
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

  /* --- Smooth in-page anchor scrolling (with nav offset) --------------- */
  document.querySelectorAll('a[href^="#"]').forEach((link) => {
    const id = link.getAttribute("href");
    if (!id || id === "#") return;
    link.addEventListener("click", (e) => {
      const target = document.querySelector(id);
      if (!target) return;
      e.preventDefault();
      const top = target.getBoundingClientRect().top + window.scrollY - 88;
      window.scrollTo({ top, behavior: reduceMotion ? "auto" : "smooth" });
      if (history.replaceState) history.replaceState(null, "", id);
    });
  });

  /* --- Page transitions ------------------------------------------------ */
  // Cross-page fades come from CSS (@view-transition in site.css): no
  // overlay on load and no delay before the next page starts loading.

  /* --- Cookie consent banner ------------------------------------------- */
  (function cookieConsent() {
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
  })();
}
