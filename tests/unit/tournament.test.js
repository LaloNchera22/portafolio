import { describe, expect, it } from "vitest";
import { prizeSplit, roundName, roundsFor } from "../../src/scripts/lib/tournament.js";

describe("prizeSplit", () => {
  it("matches the server: 10% platform, then 70/30", () => {
    // 4 players x 10 rcoin: the SQL suite asserts 2520 / 1080 / 400.
    expect(prizeSplit(1000, 4)).toEqual({ pool: 4000, platform: 400, prizes: 3600, first: 2520, second: 1080 });
  });

  it("keeps every cent: prizes + platform always equals the pool", () => {
    for (const fee of [100, 137, 999, 2500, 50000]) {
      for (const size of [4, 8]) {
        const s = prizeSplit(fee, size);
        expect(s.first + s.second + s.platform).toBe(s.pool);
        expect(s.prizes / s.pool).toBeGreaterThanOrEqual(0.7); // Riot: >= 70% of fees to prizes
      }
    }
  });

  it("is all zeros for free or invalid events", () => {
    expect(prizeSplit(0, 8).pool).toBe(0);
    expect(prizeSplit(1000, 5).pool).toBe(0);
  });
});

describe("bracket rounds", () => {
  it("names rounds from the final backwards", () => {
    expect(roundsFor(4)).toBe(2);
    expect(roundsFor(8)).toBe(3);
    expect([1, 2, 3].map((r) => roundName(r, 3))).toEqual(["Quarterfinals", "Semifinals", "Final"]);
    expect(roundName(1, 2)).toBe("Semifinals");
    expect(roundsFor(16)).toBe(4);
    expect(roundsFor(32)).toBe(5);
    expect([1, 2].map((r) => roundName(r, 5))).toEqual(["Round of 32", "Round of 16"]);
  });
});
