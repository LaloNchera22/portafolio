import { describe, expect, it } from "vitest";
import { QUICK_TIERS, WILD_RIFT, findTier, parseRiotId, playReturn, tierKey } from "../../src/scripts/lib/wild-rift.js";

describe("Quick Play tiers", () => {
  it("covers every entry fee × size the server accepts", () => {
    expect(WILD_RIFT).toBe("Wild Rift");
    expect(QUICK_TIERS).toHaveLength(12);
    expect(QUICK_TIERS.map((t) => t.fee)).toEqual([0, 0, 100, 100, 500, 500, 1000, 1000, 2500, 2500, 5000, 5000]);
    expect(QUICK_TIERS.slice(0, 2).map((t) => t.size)).toEqual([4, 8]);
  });

  it("uses the server's tier_key format", () => {
    expect(tierKey(1000, 4)).toBe("1000:4");
    expect(findTier("2500:8")).toMatchObject({ fee: 2500, size: 8 });
    expect(findTier("300:4")).toBeNull();
    expect(findTier("1000:6")).toBeNull();
    expect(findTier(null)).toBeNull();
  });
});

describe("parseRiotId", () => {
  it("splits a valid Riot ID and trims around it", () => {
    expect(parseRiotId("  Faker#KR1 ")).toEqual({ gameName: "Faker", tagLine: "KR1" });
    expect(parseRiotId("Hide on bush#KR1")).toEqual({ gameName: "Hide on bush", tagLine: "KR1" });
    expect(parseRiotId("Жанна#EUW")).toEqual({ gameName: "Жанна", tagLine: "EUW" });
  });

  it("splits on the last #, so a # in the name is kept", () => {
    expect(parseRiotId("A#B#NA1")).toEqual({ gameName: "A#B", tagLine: "NA1" });
  });

  it("explains what's wrong", () => {
    expect(parseRiotId("").error).toContain("Enter your Riot ID");
    expect(parseRiotId("Faker").error).toContain("after a #");
    expect(parseRiotId("Fa#KR1").error).toContain("3 to 16");
    expect(parseRiotId("ThisNameIsWayTooLong#KR1").error).toContain("3 to 16");
    expect(parseRiotId("Faker#K1").error).toContain("3 to 5");
    expect(parseRiotId("Faker#KR1234").error).toContain("3 to 5");
    expect(parseRiotId("Faker#K-1").error).toContain("3 to 5");
  });
});

describe("playReturn", () => {
  const id = "0b7c3a52-6c1e-4b1e-9d0a-3f7a1c2b4d5e";
  it("normalizes the ways back to Play", () => {
    expect(playReturn(id)).toBe("t/" + id);
    expect(playReturn("t/" + id)).toBe("t/" + id);
    expect(playReturn("q/1000/4")).toBe("q/1000/4");
    expect(playReturn("new")).toBe("new");
  });

  it("drops anything that isn't one of them", () => {
    expect(playReturn("q/999/4")).toBeNull();
    expect(playReturn("t/not-an-id")).toBeNull();
    expect(playReturn("page-wallet")).toBeNull();
    expect(playReturn("")).toBeNull();
    expect(playReturn(null)).toBeNull();
  });
});
