/* ============================================================================
 * Runinback — small motion helpers for user-visible state changes.
 * Every helper lands on the final state immediately when the visitor asks
 * for reduced motion or the browser can't animate, so callers never have to
 * branch and tests always see the end value.
 * ========================================================================== */

export function prefersReducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (e) {
    return false;
  }
}

function canAnimate() {
  return typeof window !== "undefined" && typeof window.requestAnimationFrame === "function" && !prefersReducedMotion();
}

const running = new WeakMap(); // element -> frame id, so a new tween replaces the old one

/**
 * Count a number from `from` to `to`, calling `render(value)` each frame
 * (ease-out, ~450ms). Retargets cleanly if called again mid-tween.
 */
export function tweenNumber(el, from, to, render, duration = 450) {
  if (!el) return;
  if (running.has(el)) cancelAnimationFrame(running.get(el));
  if (!canAnimate() || from === to || !Number.isFinite(from)) {
    running.delete(el);
    render(to);
    return;
  }
  const start = performance.now();
  // Read the clock here rather than trusting the rAF timestamp: a frame can
  // be stamped before `start`, which would make t negative and overshoot.
  const step = () => {
    const t = Math.max(0, Math.min(1, (performance.now() - start) / duration));
    const eased = 1 - Math.pow(1 - t, 3);
    render(t === 1 ? to : from + (to - from) * eased);
    if (t < 1) running.set(el, requestAnimationFrame(step));
    else running.delete(el);
  };
  running.set(el, requestAnimationFrame(step));
}

/** Replay a one-shot CSS animation class (e.g. a bump after a value changes). */
export function replayClass(el, className) {
  if (!el || !canAnimate()) return;
  el.classList.remove(className);
  void el.offsetWidth; // restart the animation
  el.classList.add(className);
  el.addEventListener("animationend", () => el.classList.remove(className), { once: true });
}
