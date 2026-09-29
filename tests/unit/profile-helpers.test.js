// Country list and avatar helpers shared by the profile and player pages.
import { describe, expect, it } from "vitest";
import { avatarFileProblem, avatarInner, avatarPath } from "../../src/scripts/lib/avatar.js";
import { COUNTRY_CODES, countryName } from "../../src/scripts/lib/countries.js";

describe("countries", () => {
  it("has every ISO 3166-1 alpha-2 code once", () => {
    expect(COUNTRY_CODES).toHaveLength(249);
    expect(new Set(COUNTRY_CODES).size).toBe(249);
    expect(COUNTRY_CODES).not.toContain("EU");
    expect(COUNTRY_CODES).not.toContain("UK");
  });

  it("matches the database's list", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync(new URL("../../supabase/migrations/0024_profile_settings.sql", import.meta.url), "utf8");
    const body = sql.slice(sql.indexOf("rib_country_valid"), sql.indexOf("rib_username_reserved"));
    const codes = (body.match(/'[A-Z ]+'/g) || []).join(" ").replace(/'/g, "").split(/\s+/).filter(Boolean);
    expect(codes).toEqual(COUNTRY_CODES);
  });

  it("names a code", () => {
    expect(countryName("MX")).toBe("Mexico");
    expect(countryName("")).toBe("");
  });
});

describe("avatar", () => {
  it("accepts only reasonable images", () => {
    expect(avatarFileProblem({ type: "image/gif", size: 10 })).toContain("PNG, JPG or WebP");
    expect(avatarFileProblem({ type: "image/png", size: 11 * 1024 * 1024 })).toContain("over 10 MB");
    expect(avatarFileProblem({ type: "image/webp", size: 2048 })).toBe("");
  });

  it("stores one photo per player and falls back to an escaped initial", () => {
    expect(avatarPath("u1")).toBe("u1/avatar.webp");
    expect(avatarInner("", "neo")).toBe("N");
    expect(avatarInner("", "<b>")).toBe("&lt;");
    expect(avatarInner("https://x/a.webp?v=2", "neo")).toContain('src="https://x/a.webp?v=2"');
  });
});
