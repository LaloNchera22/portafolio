// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { replayClass, tweenNumber } from "../../src/scripts/lib/motion.js";

function setReducedMotion(reduce) {
  window.matchMedia = vi.fn().mockReturnValue({ matches: reduce });
}

describe("motion helpers", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("lands on the final value at once under reduced motion", () => {
    setReducedMotion(true);
    const seen = [];
    tweenNumber(document.createElement("span"), 100, 500, (v) => seen.push(v));
    expect(seen).toEqual([500]);
  });

  it("counts toward the target and ends exactly on it", async () => {
    setReducedMotion(false);
    const seen = [];
    tweenNumber(document.createElement("span"), 0, 1000, (v) => seen.push(v), 60);
    await new Promise((r) => setTimeout(r, 200));
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1]).toBe(1000);
    expect(seen.every((v, i) => i === 0 || v >= seen[i - 1])).toBe(true);
  });

  it("renders the first value without animating when there is nothing to count", () => {
    setReducedMotion(false);
    const seen = [];
    tweenNumber(document.createElement("span"), 700, 700, (v) => seen.push(v));
    expect(seen).toEqual([700]);
  });

  it("does not add animation classes under reduced motion", () => {
    setReducedMotion(true);
    const el = document.createElement("span");
    replayClass(el, "is-bumped");
    expect(el.classList.contains("is-bumped")).toBe(false);
  });
});
