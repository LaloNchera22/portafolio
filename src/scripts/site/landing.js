/* ==========================================================================
   Runinback — landing page behaviour (index.html only; a no-op elsewhere).
   - Prize calculator: entry fee × players split with the payout math the
     server uses (lib/hosted.js hostedSplit), numbers rolling to new values.
   - Hero stats count up once on load.
   - Living bracket (hero): the finished bracket in the markup is replayed
     round by round on a slow loop. It runs only while on screen, the tab is
     visible and the pointer isn't resting on it, and it has a Pause button.
   - Backdrop parallax (hero) and mock tilt (Choose your side): mouse only,
     one rAF per frame.
   - Story (#how): on wide screens the section pins and the step under the
     scroll position becomes active (one passive scroll listener, gated by an
     IntersectionObserver); on narrow screens each step plays as it scrolls
     in. CSS scroll-driven animations fill the rail where supported.
   - Tabs (Choose your side): WAI-ARIA tabs with arrow keys, Home and End.
   Under reduced motion only the calculator and the tabs run; the markup and
   CSS already show every finished state.
   ========================================================================== */
import { hostedSplit } from "../lib/hosted.js";
import { prefersReducedMotion, replayClass } from "../lib/motion.js";
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

/** How long the living bracket holds a stage (ms): the champion lingers longest. */
export function bracketHold(stage, last) {
  if (stage >= last) return 3600;
  return stage === 0 ? 1500 : 1800;
}

/** The stage after `stage` in a bracket whose last stage is `last` (wraps to 0). */
export function nextBracketStage(stage, last) {
  return stage >= last ? 0 : stage + 1;
}

/**
 * Pinned-story progress (0–1): how far the track has scrolled past the top
 * of the viewport, out of the distance it can scroll while pinned.
 */
export function storyProgress(top, height, viewport) {
  const run = height - viewport;
  if (!(run > 0)) return top <= 0 ? 1 : 0;
  return Math.min(1, Math.max(0, -top / run));
}

/** The active step (0-based) for a progress value across `count` steps. */
export function storyStepAt(progress, count) {
  if (!(count > 0)) return 0;
  const p = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  return Math.min(count - 1, Math.floor(p * count));
}

/** WAI-ARIA tabs: the tab a key moves to from `index`, or -1 for other keys. */
export function tabIndexForKey(key, index, count) {
  if (!(count > 0)) return -1;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown": return (index + 1) % count;
    case "ArrowLeft":
    case "ArrowUp": return (index - 1 + count) % count;
    case "Home": return 0;
    case "End": return count - 1;
    default: return -1;
  }
}

export function initLanding() {
  const reduce = prefersReducedMotion();
  initPrizeCalc();
  initTabs();
  if (reduce) return;
  const mouse = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  initHeroStats();
  initBrackets();
  initStory();
  if (mouse) {
    initParallax();
    initTilt();
  }
}

/* --- Prize calculator --------------------------------------------------- */
function initPrizeCalc() {
  const calc = document.querySelector("[data-prize-calc]");
  if (!calc) return;
  const range = calc.querySelector("[data-calc-fee]");
  const feeOut = calc.querySelector("[data-calc-fee-out]");
  const outputs = calc.querySelectorAll("[data-calc]");
  const status = calc.querySelector("[data-calc-status]");
  const result = calc.querySelector("[data-calc-result]");
  if (!range) return;
  // One sentence for screen readers once the values settle, not one per drag step.
  let announceTimer = 0;
  const announce = (r) => {
    if (!status) return;
    window.clearTimeout(announceTimer);
    announceTimer = window.setTimeout(() => { status.textContent = calcSentence(r); }, ANNOUNCE_DELAY_MS);
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
    const r = calcPrizes(range.value, selectedSize());
    if (feeOut) feeOut.textContent = r.fee + " rcoin";
    range.setAttribute("aria-valuetext", r.fee + " rcoin");
    paintRange();
    outputs.forEach((el) => {
      const next = r[el.dataset.calc];
      if (next == null) return;
      if (animate) {
        const from = Number(el.textContent);
        countUp(el, next, { from: Number.isFinite(from) ? from : 0, duration: 600 });
      } else {
        el.textContent = next;
      }
    });
    if (animate) {
      announce(r);
      replayClass(result, "is-bump");
    }
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

/* --- Living bracket ------------------------------------------------------
   Stage n shows every slot/run with data-r <= n and dims every player with
   data-out <= n. The loop pauses for any reason in `reasons`. */
// One Pause/Play choice for both hero brackets (8 and 4 players), so it
// survives the breakpoint swap between them.
let userPaused = false;
const bracketSyncs = [];

function initBrackets() {
  if (!("IntersectionObserver" in window)) return;
  document.querySelectorAll("[data-bracket]").forEach(initBracket);
}

function initBracket(fig) {
  const staged = Array.from(fig.querySelectorAll("[data-r]"));
  if (!staged.length) return;
  const outs = Array.from(fig.querySelectorAll("[data-out]"));
  const rounds = Array.from(fig.querySelectorAll(".bk__round"));
  const label = fig.querySelector("[data-bk-label]");
  const prize = fig.querySelector("[data-bk-prize]");
  const toggle = fig.querySelector("[data-bk-toggle]");
  const svg = fig.querySelector(".bk__svg");
  const last = Math.max(...staged.map((el) => Number(el.dataset.r) || 0));
  const reasons = new Set(["offscreen"]);
  let stage = 0;
  let timer = 0;

  const paint = (s) => {
    stage = s;
    staged.forEach((el) => el.classList.toggle("is-on", Number(el.dataset.r) <= s));
    outs.forEach((el) => el.classList.toggle("is-out", Number(el.dataset.out) <= s));
    rounds.forEach((el) => el.classList.toggle("is-current", Number(el.dataset.col) === s));
    if (label && rounds[s]) label.textContent = rounds[s].textContent;
    if (!prize) return;
    if (s === last) countUp(prize, prize.dataset.bkPrize, { from: 0, duration: 900, delay: 380 });
    else prize.textContent = "0";
  };
  const finishReset = () => {
    paint(0);
    fig.classList.remove("is-resetting");
  };
  const schedule = () => {
    window.clearTimeout(timer);
    const paused = userPaused || reasons.size > 0;
    fig.classList.toggle("is-paused", paused);
    if (paused) return;
    if (fig.classList.contains("is-resetting")) finishReset();
    timer = window.setTimeout(advance, bracketHold(stage, last));
  };
  const advance = () => {
    const next = nextBracketStage(stage, last);
    if (next !== 0) {
      paint(next);
      schedule();
      return;
    }
    // Fade the results out, rewind under the fade, then fade back in.
    fig.classList.add("is-resetting");
    timer = window.setTimeout(() => {
      paint(0);
      timer = window.setTimeout(() => {
        fig.classList.remove("is-resetting");
        schedule();
      }, 650);
    }, 650);
  };
  const pause = (reason) => { reasons.add(reason); schedule(); };
  const resume = (reason) => { reasons.delete(reason); schedule(); };

  fig.classList.add("is-live");
  paint(0);
  fig.classList.add("is-paused");

  new IntersectionObserver((entries) => {
    entries.forEach((entry) => (entry.isIntersecting ? resume("offscreen") : pause("offscreen")));
  }, { threshold: 0.25 }).observe(fig);
  document.addEventListener("visibilitychange", () => (document.hidden ? pause("hidden") : resume("hidden")));
  if (svg) {
    svg.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") pause("hover"); });
    svg.addEventListener("pointerleave", () => resume("hover"));
  }
  const sync = () => {
    if (toggle) {
      toggle.textContent = userPaused ? "Play" : "Pause";
      toggle.setAttribute("aria-label", (userPaused ? "Play" : "Pause") + " the bracket animation");
    }
    schedule();
  };
  bracketSyncs.push(sync);
  if (toggle) {
    toggle.hidden = false;
    toggle.addEventListener("click", () => {
      userPaused = !userPaused;
      bracketSyncs.forEach((fn) => fn());
    });
  }
  sync();
}

/* --- Hero backdrop parallax (mouse only) ------------------------------- */
function initParallax() {
  const hero = document.querySelector("[data-hero]");
  const backdrop = hero && hero.querySelector(".backdrop--stage");
  if (!backdrop) return;
  let frame = 0;
  let x = 0;
  let y = 0;
  const paint = () => {
    frame = 0;
    backdrop.style.setProperty("--px", x.toFixed(3));
    backdrop.style.setProperty("--py", y.toFixed(3));
  };
  hero.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    x = (e.clientX / window.innerWidth) * 2 - 1;
    y = (e.clientY / window.innerHeight) * 2 - 1;
    if (!frame) frame = requestAnimationFrame(paint);
  }, { passive: true });
  hero.addEventListener("pointerleave", () => {
    x = 0;
    y = 0;
    if (!frame) frame = requestAnimationFrame(paint);
  });
}

/* --- Story: pinned on wide screens, stacked and played on scroll-in ----- */
function initStory() {
  const story = document.querySelector("[data-story]");
  if (!story || !("IntersectionObserver" in window)) return;
  const track = story.querySelector(".lx-story__track");
  const steps = Array.from(story.querySelectorAll(".lx-story__step"));
  const ticks = Array.from(story.querySelectorAll(".lx-rail__tick"));
  if (!track || !steps.length) return;
  const wide = window.matchMedia("(min-width: 960px) and (min-height: 620px)");
  let mode = "";
  let near = false;
  let ticking = false;
  let active = -1;

  const setActive = (i) => {
    if (i === active) return;
    active = i;
    steps.forEach((step, k) => {
      step.classList.toggle("is-active", k === i);
      step.classList.toggle("is-past", k < i);
    });
    ticks.forEach((tick, k) => tick.classList.toggle("is-on", k <= i));
    story.style.setProperty("--step", String(i));
  };
  const update = () => {
    ticking = false;
    if (mode !== "pin") return;
    const box = track.getBoundingClientRect();
    const p = storyProgress(box.top, box.height, window.innerHeight);
    track.style.setProperty("--progress", p.toFixed(4));
    setActive(storyStepAt(p, steps.length));
  };
  const onScroll = () => {
    if (!near || ticking || mode !== "pin") return;
    ticking = true;
    requestAnimationFrame(update);
  };
  // Stacked: each step plays its scene once, as it scrolls into view.
  const playOnce = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-active");
      playOnce.unobserve(entry.target);
    });
  }, { rootMargin: "0px 0px -15% 0px", threshold: 0 });
  const applyMode = () => {
    mode = wide.matches ? "pin" : "stack";
    story.dataset.mode = mode;
    active = -1;
    steps.forEach((step) => step.classList.remove("is-active", "is-past"));
    playOnce.disconnect();
    if (mode === "pin") update();
    else steps.forEach((step) => playOnce.observe(step));
  };

  new IntersectionObserver((entries) => {
    near = entries.some((entry) => entry.isIntersecting);
    story.classList.toggle("is-in", near);
    if (near) onScroll();
  }, { rootMargin: "0px 0px -15% 0px" }).observe(track);
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });
  wide.addEventListener("change", applyMode);
  applyMode();
}

/* --- Tabs: Choose your side --------------------------------------------- */
function initTabs() {
  const list = document.querySelector("[data-tabs]");
  if (!list) return;
  const tabs = Array.from(list.querySelectorAll('[role="tab"]'));
  const panels = tabs.map((tab) => document.getElementById(tab.getAttribute("aria-controls")));
  const side = document.querySelector("[data-side]");
  if (!tabs.length || panels.some((panel) => !panel)) return;
  let current = Math.max(0, tabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true"));

  const select = (i, focus) => {
    if (side) side.dataset.dir = i >= current ? "1" : "-1";
    tabs.forEach((tab, k) => {
      const on = k === i;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      panels[k].hidden = !on;
    });
    list.style.setProperty("--tab-i", String(i));
    list.dataset.active = tabs[i].id;
    current = i;
    if (focus) tabs[i].focus();
  };
  tabs.forEach((tab, k) => tab.addEventListener("click", () => { if (k !== current) select(k, false); }));
  list.addEventListener("keydown", (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const i = tabIndexForKey(e.key, current, tabs.length);
    if (i < 0) return;
    e.preventDefault();
    if (i !== current) select(i, true);
  });
  select(current, false);
  list.classList.add("is-ready");
}

/* --- Gentle 3D tilt on the console mocks (mouse only) ------------------- */
function initTilt() {
  document.querySelectorAll("[data-tilt]").forEach((el) => {
    let frame = 0;
    let px = 0;
    let py = 0;
    const paint = () => {
      frame = 0;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const nx = (px - rect.left) / rect.width - 0.5;
      const ny = (py - rect.top) / rect.height - 0.5;
      el.style.setProperty("--ry", (nx * 8).toFixed(2) + "deg");
      el.style.setProperty("--rx", (ny * -6).toFixed(2) + "deg");
    };
    el.addEventListener("pointermove", (e) => {
      if (e.pointerType !== "mouse") return;
      px = e.clientX;
      py = e.clientY;
      if (!frame) frame = requestAnimationFrame(paint);
    }, { passive: true });
    el.addEventListener("pointerleave", () => {
      cancelAnimationFrame(frame);
      frame = 0;
      el.style.setProperty("--rx", "0deg");
      el.style.setProperty("--ry", "0deg");
    });
  });
}
