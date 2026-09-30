import { describe, expect, it } from "vitest";
import { retryAfterSeconds, riotAccountUrl, riotRegion, validateRiotId } from "../../supabase/functions/_shared/riot-id.js";

describe("validateRiotId", () => {
  it("accepts valid Riot IDs and trims them", () => {
    expect(validateRiotId("  Zeráth ", " LAN1 ")).toEqual({ ok: true, gameName: "Zeráth", tagLine: "LAN1" });
    expect(validateRiotId("Night Owl", "#4242")).toEqual({ ok: true, gameName: "Night Owl", tagLine: "4242" });
    expect(validateRiotId("x.Ghost_99!", "EUW").ok).toBe(true); // Riot allows symbols; SQL checks length and '#'.
    expect(validateRiotId("abc", "abc").ok).toBe(true);
    expect(validateRiotId("a".repeat(16), "abcde").ok).toBe(true);
    expect(validateRiotId("夜のフクロウ", "JP1").ok).toBe(true);
  });

  it("rejects bad game names", () => {
    for (const bad of ["ab", "a".repeat(17), "", "   ", "Name#TAG", "tab\there", "nul\u0000l", null, 42]) {
      expect(validateRiotId(bad, "TAG")).toEqual({ ok: false, error: "invalid_game_name" });
    }
  });

  it("rejects bad tag lines", () => {
    for (const bad of ["ab", "abcdef", "a b", "a-b", "", null]) {
      expect(validateRiotId("Zerath", bad)).toEqual({ ok: false, error: "invalid_tag_line" });
    }
  });
});

describe("Riot routing", () => {
  it("allowlists the regional host", () => {
    expect(riotRegion("EUROPE")).toBe("europe");
    expect(riotRegion("asia")).toBe("asia");
    expect(riotRegion("evil.example.com/")).toBe("americas");
    expect(riotRegion(undefined)).toBe("americas");
  });

  it("encodes the path segments", () => {
    expect(riotAccountUrl("americas", "Night Owl", "4242"))
      .toBe("https://americas.api.riotgames.com/riot/account/v1/accounts/by-riot-id/Night%20Owl/4242");
    expect(riotAccountUrl("x", "Zeráth", "LAN1")).toContain("/Zer%C3%A1th/LAN1");
  });

  it("reads Retry-After", () => {
    expect(retryAfterSeconds("7")).toBe(7);
    expect(retryAfterSeconds(null)).toBe(10);
    expect(retryAfterSeconds("soon")).toBe(10);
    expect(retryAfterSeconds("99999")).toBe(3600);
  });
});
