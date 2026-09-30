import { describe, expect, it } from "vitest";
import {
  bracketHold,
  calcPrizes,
  calcSentence,
  formatRcoin,
  nextBracketStage,
  storyProgress,
  storyStepAt,
  tabIndexForKey,
} from "../../src/scripts/site/landing.js";

describe("formatRcoin", () => {
  it("shows up to two decimals and trims trailing zeros", () => {
    expect(formatRcoin(6800)).toBe("68");
    expect(formatRcoin(1260)).toBe("12.6");
    expect(formatRcoin(35)).toBe("0.35");
    expect(formatRcoin(0)).toBe("0");
    expect(formatRcoin("nope")).toBe("0");
  });
});

describe("calcPrizes (landing calculator)", () => {
  it("splits 10 rcoin x 8 players like the payout job", () => {
    expect(calcPrizes(10, 8)).toEqual({ fee: 10, size: 8, pool: "80", winner: "68", host: "4", platform: "8" });
  });

  it("follows the bracket size and the fee", () => {
    expect(calcPrizes(10, 16)).toMatchObject({ winner: "136", host: "8" });
    expect(calcPrizes(50, 32)).toMatchObject({ pool: "1600", winner: "1360", host: "80", platform: "160" });
    expect(calcPrizes(1, 4)).toMatchObject({ pool: "4", winner: "3.4", host: "0.2", platform: "0.4" });
  });

  it("clamps the fee to the slider and falls back to 8 players", () => {
    expect(calcPrizes(0, 8).fee).toBe(1);
    expect(calcPrizes(900, 8).fee).toBe(50);
    expect(calcPrizes("abc", 8).fee).toBe(10);
    expect(calcPrizes(10, 6).size).toBe(8);
  });
});

describe("calcSentence", () => {
  it("reads the whole split in one sentence", () => {
    expect(calcSentence(calcPrizes(10, 8))).toBe("8 players at 10 rcoin: champion 68, host 4, Runinback 8 rcoin.");
  });
});

describe("living bracket timing", () => {
  it("advances stage by stage and wraps after the champion", () => {
    expect(nextBracketStage(0, 3)).toBe(1);
    expect(nextBracketStage(2, 3)).toBe(3);
    expect(nextBracketStage(3, 3)).toBe(0);
    expect(nextBracketStage(2, 2)).toBe(0);
  });

  it("holds the champion longest", () => {
    expect(bracketHold(3, 3)).toBeGreaterThan(bracketHold(1, 3));
    expect(bracketHold(0, 3)).toBe(1500);
    expect(bracketHold(1, 2)).toBe(1800);
  });
});

describe("story progress", () => {
  it("measures how far the pinned track has scrolled", () => {
    expect(storyProgress(100, 4000, 1000)).toBe(0);
    expect(storyProgress(0, 4000, 1000)).toBe(0);
    expect(storyProgress(-1500, 4000, 1000)).toBe(0.5);
    expect(storyProgress(-5000, 4000, 1000)).toBe(1);
  });

  it("copes with a track no taller than the viewport", () => {
    expect(storyProgress(10, 800, 1000)).toBe(0);
    expect(storyProgress(-10, 800, 1000)).toBe(1);
  });

  it("maps progress to one of the steps", () => {
    expect(storyStepAt(0, 6)).toBe(0);
    expect(storyStepAt(0.17, 6)).toBe(1);
    expect(storyStepAt(0.5, 6)).toBe(3);
    expect(storyStepAt(1, 6)).toBe(5);
    expect(storyStepAt(-2, 6)).toBe(0);
    expect(storyStepAt(Number.NaN, 6)).toBe(0);
    expect(storyStepAt(0.5, 0)).toBe(0);
  });
});

describe("tabIndexForKey", () => {
  it("moves with the arrow keys and wraps", () => {
    expect(tabIndexForKey("ArrowRight", 0, 2)).toBe(1);
    expect(tabIndexForKey("ArrowRight", 1, 2)).toBe(0);
    expect(tabIndexForKey("ArrowLeft", 0, 2)).toBe(1);
    expect(tabIndexForKey("ArrowDown", 0, 3)).toBe(1);
    expect(tabIndexForKey("ArrowUp", 0, 3)).toBe(2);
  });

  it("jumps with Home and End and ignores other keys", () => {
    expect(tabIndexForKey("Home", 1, 2)).toBe(0);
    expect(tabIndexForKey("End", 0, 2)).toBe(1);
    expect(tabIndexForKey("Enter", 0, 2)).toBe(-1);
    expect(tabIndexForKey("ArrowRight", 0, 0)).toBe(-1);
  });
});
