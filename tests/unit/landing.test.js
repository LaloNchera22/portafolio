import { describe, expect, it } from "vitest";
import { calcPrizes, calcSentence, formatRcoin } from "../../src/scripts/site/landing.js";

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
