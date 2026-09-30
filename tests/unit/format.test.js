import { describe, expect, it } from "vitest";
import {
  centsToUSD, formatUSD, formatUsd, parseDollarsToCents, parseUSDToCents, quotePurchase,
} from "../../src/scripts/lib/format.js";

describe("formatUsd", () => {
  it("formats integer cents as dollars", () => {
    expect(formatUsd(12345)).toBe("$123.45");
    expect(formatUsd(0)).toBe("$0.00");
  });

  it("treats invalid input as zero", () => {
    expect(formatUsd(undefined)).toBe("$0.00");
    expect(formatUsd("abc")).toBe("$0.00");
  });
});

describe("USD conversion", () => {
  it("converts cents to USD with at most two decimals", () => {
    expect(centsToUSD(9500)).toBe(95);
    expect(centsToUSD(1)).toBe(0.01);
    expect(formatUSD(250)).toBe("2.5 USD");
  });
});

describe("parsing user input", () => {
  it("accepts dot and comma decimals for dollars", () => {
    expect(parseDollarsToCents("12.5")).toBe(1250);
    expect(parseDollarsToCents("12,5")).toBe(1250);
    expect(parseDollarsToCents("0.015")).toBe(2);
  });

  it("returns NaN for non-numeric input", () => {
    expect(parseDollarsToCents("")).toBeNaN();
    expect(parseUSDToCents("abc")).toBeNaN();
  });

  it("rounds USD to whole units", () => {
    expect(parseUSDToCents("3.6")).toBe(400);
  });
});

describe("quotePurchase", () => {
  it("charges a 5% entry fee and floors the credited amount like the backend", () => {
    expect(quotePurchase(10000)).toEqual({ payCents: 10000, receiveCents: 9500, feeCents: 500 });
    // 101 * 95 / 100 = 95.95 → floor 95; the remainder is the fee.
    expect(quotePurchase(101)).toEqual({ payCents: 101, receiveCents: 95, feeCents: 6 });
  });

  it("always sums back to the paid amount", () => {
    for (let pay = 0; pay <= 5000; pay += 7) {
      const q = quotePurchase(pay);
      expect(q.receiveCents + q.feeCents).toBe(pay);
      expect(q.receiveCents).toBeGreaterThanOrEqual(0);
    }
  });

  it("quotes zero for invalid or negative amounts", () => {
    expect(quotePurchase(NaN)).toEqual({ payCents: 0, receiveCents: 0, feeCents: 0 });
    expect(quotePurchase(-500)).toEqual({ payCents: 0, receiveCents: 0, feeCents: 0 });
  });
});
