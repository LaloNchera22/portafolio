// @vitest-environment jsdom
// The console's one polite live region: a burst of updates is read once,
// the newest text wins, and nothing is announced faster than the gap.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { announce } from "../../src/scripts/lib/announce.js";

const region = () => globalThis.document.getElementById("capp-announce");
const text = () => region().textContent.replace(/\u00a0$/, "");

describe("announce", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("creates a polite status region and speaks the first message at once", () => {
    announce("Match on");
    expect(region().getAttribute("aria-live")).toBe("polite");
    expect(region().getAttribute("role")).toBe("status");
    expect(text()).toBe("Match on");
  });

  it("collapses a burst into the newest message after the gap", () => {
    vi.advanceTimersByTime(5000);
    announce("3 of 4 seats taken");
    announce("Less than a minute left.");
    announce("Time's up. Settling the result.");
    expect(text()).toBe("3 of 4 seats taken");
    vi.advanceTimersByTime(3000);
    expect(text()).toBe("Time's up. Settling the result.");
  });

  it("re-reads a repeated sentence as a change", () => {
    vi.advanceTimersByTime(5000);
    announce("Match on");
    const first = region().textContent;
    vi.advanceTimersByTime(5000);
    announce("Match on");
    expect(region().textContent).not.toBe(first);
    expect(text()).toBe("Match on");
  });
});
