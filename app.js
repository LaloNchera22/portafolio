/* ==========================================================================
   Runinback — shared interactions
   Nav behavior, scroll reveal, page-transition curtain, FAQ, forms, footer year.
   Vanilla JS, no dependencies.
   ========================================================================== */

(function () {
  "use strict";

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
  const updateProgress = () => {
    const h = document.documentElement;
    const max = h.scrollHeight - h.clientHeight;
    const p = max > 0 ? Math.min(1, window.scrollY / max) : 0;
    progress.style.setProperty("--p", p.toFixed(4));
  };

  if (nav) {
    let lastY = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      nav.classList.toggle("is-scrolled", y > 20);
      if (y > lastY && y > 400 && !nav.classList.contains("is-open")) {
        nav.classList.add("is-hidden");
      } else {
        nav.classList.remove("is-hidden");
      }
      lastY = y;
      updateProgress();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  } else {
    window.addEventListener("scroll", () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(() => { updateProgress(); ticking = false; });
      }
    }, { passive: true });
    updateProgress();
  }

  if (nav) {

    /* Mobile menu toggle */
    const toggle = nav.querySelector("[data-nav-toggle]");
    if (toggle) {
      toggle.addEventListener("click", () => {
        const open = nav.classList.toggle("is-open");
        toggle.setAttribute("aria-expanded", String(open));
        document.body.style.overflow = open ? "hidden" : "";
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

  /* --- Hero background video: loop only 0–7s ---------------------------- */
  const heroVideo = document.getElementById("hero-video");
  if (heroVideo) {
    const LOOP_END = 7;
    heroVideo.loop = false;
    const toStart = () => {
      try { heroVideo.currentTime = 0; } catch (e) {}
    };
    heroVideo.addEventListener("timeupdate", () => {
      if (heroVideo.currentTime >= LOOP_END) toStart();
    });
    heroVideo.addEventListener("ended", () => {
      toStart();
      if (!reduceMotion) heroVideo.play().catch(() => {});
    });
    if (reduceMotion) {
      toStart();
      heroVideo.pause();
    } else {
      heroVideo.play().catch(() => {});
    }
  }

  /* --- FAQ accordion ---------------------------------------------------- */
  document.querySelectorAll("[data-faq]").forEach((item) => {
    const btn = item.querySelector(".faq__q");
    const panel = item.querySelector(".faq__a");
    if (!btn || !panel) return;
    btn.setAttribute("aria-expanded", "false");
    btn.addEventListener("click", () => {
      const open = item.classList.toggle("is-open");
      btn.setAttribute("aria-expanded", String(open));
      panel.style.maxHeight = open ? panel.scrollHeight + "px" : "0px";
    });
  });

  /* --- Forms (client-side demo, no backend) ----------------------------- */
  document.querySelectorAll("[data-form]").forEach((form) => {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }
      const success = form.querySelector("[data-form-success]");
      form.querySelectorAll("input, textarea, select, button").forEach((el) => (el.disabled = true));
      if (success) {
        success.classList.add("is-visible");
        success.setAttribute("role", "status");
      }
      form.reset();
    });
  });

  /* --- Footer year ------------------------------------------------------ */
  const yearEl = document.querySelector("[data-year]");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  /* --- Magnetic buttons / brand mark ----------------------------------- */
  if (finePointer && !reduceMotion) {
    document.querySelectorAll(".btn--cta, .brand").forEach((el) => {
      el.setAttribute("data-magnetic", "");
      const strength = el.classList.contains("brand") ? 10 : 16;
      el.addEventListener("pointermove", (e) => {
        const r = el.getBoundingClientRect();
        const mx = e.clientX - (r.left + r.width / 2);
        const my = e.clientY - (r.top + r.height / 2);
        el.style.transform = `translate(${(mx / r.width) * strength}px, ${(my / r.height) * strength}px)`;
      });
      el.addEventListener("pointerleave", () => {
        el.style.transform = "";
      });
    });

    /* --- Subtle tilt / parallax on illustration surfaces --------------- */
    document.querySelectorAll(".viz, .showcase-card__preview").forEach((el) => {
      el.addEventListener("pointermove", (e) => {
        const r = el.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width - 0.5;
        const py = (e.clientY - r.top) / r.height - 0.5;
        el.style.transform = `perspective(700px) rotateX(${(-py * 5).toFixed(2)}deg) rotateY(${(px * 6).toFixed(2)}deg)`;
      });
      el.addEventListener("pointerleave", () => {
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

  /* --- Page-transition curtain ----------------------------------------- */
  if (!reduceMotion) {
    const curtain = document.createElement("div");
    curtain.className = "curtain";
    document.body.appendChild(curtain);

    /* Reveal on load */
    curtain.classList.add("is-active");
    requestAnimationFrame(() => {
      setTimeout(() => {
        curtain.classList.remove("is-active");
        curtain.classList.add("is-leaving");
      }, 50);
    });

    const sameOrigin = (href) => {
      try {
        const url = new URL(href, location.href);
        return url.origin === location.origin;
      } catch {
        return false;
      }
    };

    document.addEventListener("click", (e) => {
      const link = e.target.closest("a");
      if (!link) return;
      const href = link.getAttribute("href");
      if (
        !href ||
        href.startsWith("#") ||
        link.target === "_blank" ||
        link.hasAttribute("download") ||
        !sameOrigin(href) ||
        new URL(href, location.href).pathname === location.pathname
      ) {
        return;
      }
      e.preventDefault();
      curtain.classList.remove("is-leaving");
      curtain.classList.add("is-active");
      setTimeout(() => {
        window.location.href = href;
      }, 480);
    });
  }

  /* --- Reactive technical grid in the landing hero -------------------- */
  const heroGrid = document.getElementById("hero-grid");
  if (heroGrid) {
    const hero = heroGrid.closest(".hero");
    const gctx = heroGrid.getContext("2d");
    const pointer = { x: -9999, y: -9999, active: false };
    let gw = 0,
      gh = 0,
      gdpr = 1,
      cell = 68;
    let running = false,
      rafId = 0,
      visible = true;

    const gResize = () => {
      const r = hero.getBoundingClientRect();
      gw = Math.max(1, r.width);
      gh = Math.max(1, r.height);
      gdpr = Math.min(window.devicePixelRatio || 1, 1.5); // cap DPR on mobile
      heroGrid.width = Math.floor(gw * gdpr);
      heroGrid.height = Math.floor(gh * gdpr);
      gctx.setTransform(gdpr, 0, 0, gdpr, 0, 0);
      cell = gw < 640 ? 46 : gw < 1000 ? 58 : 68; // lighter grid on small screens
    };

    // draw the whole square grid (straight lines) with a given stroke style
    const strokeGrid = (style) => {
      gctx.strokeStyle = style;
      gctx.lineWidth = 1;
      gctx.beginPath();
      for (let x = 0; x <= gw; x += cell) {
        gctx.moveTo(x + 0.5, 0);
        gctx.lineTo(x + 0.5, gh);
      }
      for (let y = 0; y <= gh; y += cell) {
        gctx.moveTo(0, y + 0.5);
        gctx.lineTo(gw, y + 0.5);
      }
      gctx.stroke();
    };

    const glowAt = (cx, cy, radius, peak) => {
      const g = gctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      g.addColorStop(0, "rgba(255,255,255," + peak + ")");
      g.addColorStop(1, "rgba(255,255,255,0)");
      return g;
    };

    const gRender = (t) => {
      gctx.clearRect(0, 0, gw, gh);
      strokeGrid("rgba(255,255,255,0.05)"); // faint base grid, always straight
      if (!reduceMotion) {
        const time = t * 0.001;
        const ax = gw * (0.5 + 0.42 * Math.cos(time * 0.35));
        const ay = gh * (0.42 + 0.3 * Math.sin(time * 0.28));
        strokeGrid(glowAt(ax, ay, Math.max(gw, gh) * 0.34, 0.14)); // ambient drift
      }
      if (pointer.active && finePointer) {
        strokeGrid(glowAt(pointer.x, pointer.y, cell * 4.2, 0.5)); // cursor glow
      }
      if (running && !reduceMotion && visible) rafId = requestAnimationFrame(gRender);
      else running = false;
    };

    const gStart = () => {
      if (reduceMotion || !visible) {
        gRender(performance.now());
        return;
      }
      if (running) return;
      running = true;
      rafId = requestAnimationFrame(gRender);
    };
    const gStop = () => {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
    };

    hero.addEventListener("pointermove", (e) => {
      const r = hero.getBoundingClientRect();
      pointer.x = e.clientX - r.left;
      pointer.y = e.clientY - r.top;
      pointer.active = true;
      if (!running) gRender(performance.now()); // pointer response even when paused
    });
    hero.addEventListener("pointerleave", () => {
      pointer.active = false;
      if (!running) gRender(performance.now());
    });

    if ("IntersectionObserver" in window) {
      new IntersectionObserver(
        (entries) => {
          visible = entries[0].isIntersecting;
          if (visible) gStart();
          else gStop(); // pause when the hero scrolls off-screen
        },
        { threshold: 0.01 }
      ).observe(hero);
    }

    window.addEventListener("resize", () => {
      gResize();
      if (!running) gRender(performance.now());
    });

    gResize();
    gStart();
  }
})();
