/* ==========================================================================
   Runinback — count-up numbers for prizes (marketing pages).
   Built on lib/motion.js, so reduced motion lands on the final value at once.
   The markup always holds the real number; this only animates toward it.
   ========================================================================== */
import { prefersReducedMotion, tweenNumber } from "../lib/motion.js";

/** Number of decimals written in a value such as "12.6" or "126". */
export function decimalsOf(value) {
  const part = String(value).split(".")[1];
  return part ? part.length : 0;
}

/** Render a tweened value with a fixed number of decimals. */
export function formatCount(value, decimals) {
  return decimals ? value.toFixed(decimals) : String(Math.round(value));
}

/**
 * Animate an element's text to `to` (a string like "50.4").
 * @param {Element} el
 * @param {string|number} to
 * @param {{from?: number, delay?: number, duration?: number}} [options]
 */
export function countUp(el, to, options = {}) {
  if (!el) return;
  const target = Number(to);
  const decimals = decimalsOf(to);
  const render = (v) => { el.textContent = formatCount(v, decimals); };
  if (!Number.isFinite(target)) return;
  const from = Number.isFinite(options.from) ? options.from : 0;
  const duration = options.duration || 900;
  if (prefersReducedMotion() || !options.delay) {
    tweenNumber(el, from, target, render, duration);
    return;
  }
  render(from);
  window.setTimeout(() => {
    // A newer value (e.g. the bracket-size toggle) may have taken over meanwhile.
    if (el.dataset.count != null && el.dataset.count !== String(to)) return;
    tweenNumber(el, from, target, render, duration);
  }, options.delay);
}

/** Count every [data-count] inside `root` up from zero (used on scroll reveal). */
export function countUpWithin(root) {
  root.querySelectorAll("[data-count]").forEach((el, i) => {
    const delay = Number(el.dataset.countDelay) || i * 60;
    countUp(el, el.dataset.count, { delay });
  });
}
