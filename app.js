/* ==========================================================================
   Runinback — shared interactions
   Nav behavior, scroll reveal, page-transition curtain, FAQ, forms, footer year.
   Vanilla JS, no dependencies.
   ========================================================================== */

(function () {
  "use strict";

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* --- Sticky / hide-on-scroll nav ------------------------------------- */
  const nav = document.querySelector("[data-nav]");
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
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

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
