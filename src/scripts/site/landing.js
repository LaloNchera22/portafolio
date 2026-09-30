/* ==========================================================================
   Runinback — landing page behaviour (index.html only; a no-op elsewhere).
   - Prize calculator: entry fee × players split with the payout math the
     server uses (lib/hosted.js hostedSplit), numbers counting to new values.
   - Hero stats count up once on load.
   - Spotlight: cards marked [data-spotlight] get --mx/--my from the pointer
     (fine pointers only, one rAF per frame).
   - Timeline: the #how rail fills with scroll (--progress) and the step
     under the reading line is marked active; one passive scroll listener,
     running only while the section is near the viewport.
   Everything except the calculator is skipped under reduced motion.
   ========================================================================== */
import { hostedSplit } from "../lib/hosted.js";
import { prefersReducedMotion } from "../lib/motion.js";
import { countUp, countUpWithin } from "./count-up.js";

export const CALC_FEE_MIN = 1;
export const CALC_FEE_MAX = 50;
export const CALC_SIZES = Object.freeze([4, 8, 16, 32]);

/** Cents → rcoin text with up to 2 decimals and no trailing zeros ("68", "12.6", "0.35"). */
export function formatRcoin(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return "0";
  return String(parseFloat((n / 100).toFixed(2)));
}

/**
 * The calculator's numbers for a fee in whole rcoin and a bracket size.
 * The fee is clamped to the slider's range; an unknown size falls back to 8.
 * Returns { fee, size, pool, winner, host, platform } as rcoin strings (fee/size as numbers).
 */
export function calcPrizes(feeRcoin, size) {
  const raw = Math.round(Number(feeRcoin));
  const fee = Math.min(CALC_FEE_MAX, Math.max(CALC_FEE_MIN, Number.isFinite(raw) ? raw : 10));
  const players = CALC_SIZES.includes(Number(size)) ? Number(size) : 8;
  const split = hostedSplit(fee * 100, players);
  return {
    fee: fee,
    size: players,
    pool: formatRcoin(split.pool),
    winner: formatRcoin(split.winner),
    host: formatRcoin(split.host),
    platform: formatRcoin(split.platform),
  };
}

const ANNOUNCE_DELAY_MS = 600;

/** The status sentence read out after the calculator settles. */
export function calcSentence(r) {
  return r.size + " players at " + r.fee + " rcoin: champion " + r.winner + ", host " + r.host + ", Runinback " + r.platform + " rcoin.";
}

export function initLanding() {
  const reduce = prefersReducedMotion();
  initPrizeCalc();
  if (reduce) return;
  initHeroStats();
  initSpotlight();
  initTimeline();
}

/* --- Prize calculator --------------------------------------------------- */
function initPrizeCalc() {
  const calc = document.querySelector("[data-prize-calc]");
  if (!calc) return;
  const range = calc.querySelector("[data-calc-fee]");
  const feeOut = calc.querySelector("[data-calc-fee-out]");
  const outputs = calc.querySelectorAll("[data-calc]");
  const status = calc.querySelector("[data-calc-status]");
  if (!range) return;
  // One sentence for screen readers once the values settle, not one per drag step.
  let announceTimer = 0;
  const announce = (result) => {
    if (!status) return;
    window.clearTimeout(announceTimer);
    announceTimer = window.setTimeout(() => { status.textContent = calcSentence(result); }, ANNOUNCE_DELAY_MS);
  };

  const selectedSize = () => {
    const checked = calc.querySelector('input[name="calc-size"]:checked');
    return checked ? Number(checked.value) : 8;
  };
  const paintRange = () => {
    const min = Number(range.min) || CALC_FEE_MIN;
    const max = Number(range.max) || CALC_FEE_MAX;
    const pct = ((Number(range.value) - min) / (max - min)) * 100;
    range.style.setProperty("--fill", pct.toFixed(2) + "%");
  };

  const update = (animate) => {
    const result = calcPrizes(range.value, selectedSize());
    if (feeOut) feeOut.textContent = result.fee + " rcoin";
    range.setAttribute("aria-valuetext", result.fee + " rcoin");
    paintRange();
    outputs.forEach((el) => {
      const next = result[el.dataset.calc];
      if (next == null) return;
      if (animate) {
        const from = Number(el.textContent);
        countUp(el, next, { from: Number.isFinite(from) ? from : 0, duration: 500 });
      } else {
        el.textContent = next;
      }
    });
    if (animate) announce(result);
  };

  range.addEventListener("input", () => update(true));
  calc.addEventListener("change", (e) => {
    if (e.target.matches('input[name="calc-size"]')) update(true);
  });
  // A restored form (back/forward cache) may not match the static markup.
  update(false);
}

/* --- Hero stats count up once, with the hero entrance ------------------- */
function initHeroStats() {
  const stats = document.querySelector(".lx-stats");
  if (stats) countUpWithin(stats);
}

/* --- Pointer spotlight on cards ------------------------------------------ */
function initSpotlight() {
  if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
  document.querySelectorAll("[data-spotlight]").forEach((card) => {
    let frame = 0;
    let px = 0;
    let py = 0;
    // One layout read per frame, taken in the frame itself, so scrolling
    // under a still pointer never leaves the glow in a stale spot.
    const paint = () => {
      frame = 0;
      const rect = card.getBoundingClientRect();
      card.style.setProperty("--mx", (px - rect.left).toFixed(1) + "px");
      card.style.setProperty("--my", (py - rect.top).toFixed(1) + "px");
    };
    card.addEventListener("pointermove", (e) => {
      px = e.clientX;
      py = e.clientY;
      if (!frame) frame = requestAnimationFrame(paint);
    }, { passive: true });
    card.addEventListener("pointerenter", () => card.classList.add("is-lit"));
    card.addEventListener("pointerleave", () => card.classList.remove("is-lit"));
  });
}

/* --- Timeline: scroll progress + active step ------------------------------ */
function initTimeline() {
  const list = document.querySelector("[data-steps]");
  if (!list || !("IntersectionObserver" in window)) return;
  const steps = Array.from(list.querySelectorAll(".lx-step"));
  if (!steps.length) return;

  let near = false;
  let ticking = false;
  const update = () => {
    ticking = false;
    const line = window.innerHeight * 0.55; // the reading line
    const box = list.getBoundingClientRect();
    const progress = box.height > 0 ? Math.min(1, Math.max(0, (line - box.top) / box.height)) : 0;
    list.style.setProperty("--progress", progress.toFixed(4));
    let active = -1;
    steps.forEach((step, i) => {
      if (step.getBoundingClientRect().top <= line) active = i;
    });
    steps.forEach((step, i) => {
      step.classList.toggle("is-active", i === active);
      step.classList.toggle("is-done", i < active);
    });
  };
  const onScroll = () => {
    if (!near || ticking) return;
    ticking = true;
    requestAnimationFrame(update);
  };

  list.classList.add("is-tracking");
  new IntersectionObserver((entries) => {
    near = entries.some((entry) => entry.isIntersecting);
    if (near) onScroll();
  }, { rootMargin: "25% 0px 25% 0px" }).observe(list);
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });
}
