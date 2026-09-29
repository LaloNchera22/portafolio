import { describe, expect, it } from "vitest";
import { formatTimeAgo } from "../../src/scripts/lib/format.js";
import { STAKE_MAX_RCOIN, STAKE_MIN_RCOIN, parseStake, potFor, stepStake } from "../../src/scripts/lib/stake.js";

describe("parseStake", () => {
  it("accepts whole rcoin within the server's range", () => {
    expect(parseStake("25")).toEqual({ rcoin: 25, cents: 2500 });
    expect(parseStake(" 1 ")).toEqual({ rcoin: 1, cents: 100 });
    expect(parseStake(String(STAKE_MAX_RCOIN))).toEqual({ rcoin: 1000, cents: 100000 });
  });

  it("explains what is wrong with an invalid entry fee", () => {
    expect(parseStake("").error).toBe("Enter an entry fee.");
    expect(parseStake("2.5").error).toBe("Use whole rcoin, no decimals.");
    expect(parseStake("-3").error).toBe("Use whole rcoin, no decimals.");
    expect(parseStake("0").error).toBe("The minimum entry fee is 1 rcoin.");
    expect(parseStake("1001").error).toBe("The maximum entry fee is 1,000 rcoin.");
  });

  it("flags a stake above the available balance but keeps the amount", () => {
    expect(parseStake("30", 2000)).toEqual({ error: "You have 20 rcoin available.", rcoin: 30, cents: 3000, short: true });
    expect(parseStake("20", 2000)).toEqual({ rcoin: 20, cents: 2000 });
  });
});

describe("stepStake and potFor", () => {
  it("steps within the allowed range", () => {
    expect(stepStake(10, 1)).toBe(11);
    expect(stepStake(STAKE_MIN_RCOIN, -1)).toBe(STAKE_MIN_RCOIN);
    expect(stepStake(STAKE_MAX_RCOIN, 1)).toBe(STAKE_MAX_RCOIN);
    expect(stepStake(NaN, 1)).toBe(2);
  });

  it("pays the winner both stakes", () => {
    expect(potFor(25)).toBe(50);
  });
});

describe("formatTimeAgo", () => {
  const now = Date.parse("2026-09-28T12:00:00Z");
  it("uses short relative labels", () => {
    expect(formatTimeAgo("2026-09-28T11:59:30Z", now)).toBe("just now");
    expect(formatTimeAgo("2026-09-28T11:55:00Z", now)).toBe("5 min ago");
    expect(formatTimeAgo("2026-09-28T09:00:00Z", now)).toBe("3 h ago");
    expect(formatTimeAgo("2026-09-26T12:00:00Z", now)).toBe("2 d ago");
    expect(formatTimeAgo("not a date", now)).toBe("");
  });
});
