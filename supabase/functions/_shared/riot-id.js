// Riot ID validation — pure logic shared by the riot-account Edge Function and
// the unit tests. Riot ID = game name (3–16 characters; Riot allows spaces
// and non-Latin letters) + tag line (3–5 letters/digits), shown as "Name#TAG".
// Same rules as parseRiotId (src/scripts/lib/wild-rift.js) and
// rib_riot_id_valid (SQL), plus no control characters.

const BAD_NAME_RE = /[#\p{C}]/u;
const TAG_LINE_RE = /^[\p{L}\p{N}]+$/u;

export const RIOT_REGIONS = ["americas", "asia", "europe"];

const chars = (s) => [...s].length;

/**
 * @returns {{ ok: true, gameName: string, tagLine: string } | { ok: false, error: "invalid_game_name" | "invalid_tag_line" }}
 */
export function validateRiotId(gameName, tagLine) {
  const name = typeof gameName === "string" ? gameName.normalize("NFC").trim() : "";
  let tag = typeof tagLine === "string" ? tagLine.normalize("NFC").trim() : "";
  if (tag.startsWith("#")) tag = tag.slice(1);
  if (chars(name) < 3 || chars(name) > 16 || BAD_NAME_RE.test(name)) {
    return { ok: false, error: "invalid_game_name" };
  }
  if (chars(tag) < 3 || chars(tag) > 5 || !TAG_LINE_RE.test(tag)) {
    return { ok: false, error: "invalid_tag_line" };
  }
  return { ok: true, gameName: name, tagLine: tag };
}

/** The regional routing host for account-v1; anything unknown falls back to americas. */
export function riotRegion(value) {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return RIOT_REGIONS.includes(v) ? v : "americas";
}

export function riotAccountUrl(region, gameName, tagLine) {
  return `https://${riotRegion(region)}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/`
    + `${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
}

/** Seconds from a Retry-After header (delta-seconds only), clamped to 1..3600; default 10. */
export function retryAfterSeconds(header) {
  const n = Number.parseInt(header ?? "", 10);
  if (!Number.isFinite(n) || n <= 0) return 10;
  return Math.min(3600, n);
}
