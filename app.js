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
})();
