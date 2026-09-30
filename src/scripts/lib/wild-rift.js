/* ============================================================================
 * Runinback — Wild Rift rules shared by the console (docs/wild-rift-engine.md).
 * The database enforces all of them; these only shape the UI and pre-check
 * input so a player sees a clear message before a round trip.
 * ========================================================================== */
import { isInviteCode, normalizeInviteCode } from "./hosted.js";

export const WILD_RIFT = "Wild Rift";
export const RIOT_NETWORK = "riot";

/** Quick Play tiers: entry fee (cents) × size, mirrors rib_quick_join(). */
export const QUICK_FEES = Object.freeze([0, 100, 500, 1000, 2500, 5000]);
export const QUICK_SIZES = Object.freeze([4, 8]);
export const QUICK_TIERS = Object.freeze(QUICK_FEES.flatMap(function (fee) {
  return QUICK_SIZES.map(function (size) { return Object.freeze({ fee: fee, size: size, key: fee + ":" + size }); });
}));

/** The tier_key the server stores for a Quick Play event ('<fee>:<size>'). */
export function tierKey(fee, size) {
  return fee + ":" + size;
}

/** The tier for a key ("1000:4"), or null when it isn't a Quick Play tier. */
export function findTier(key) {
  return QUICK_TIERS.find(function (t) { return t.key === String(key || ""); }) || null;
}

/**
 * Parse a Riot ID typed as "Name#TAG". Returns { gameName, tagLine } or
 * { error } with a message the form can show. Riot allows spaces and
 * non-Latin letters in the name, so only the length and the "#" are checked.
 */
export function parseRiotId(value) {
  const text = String(value == null ? "" : value).trim();
  if (!text) return { error: "Enter your Riot ID, like Name#TAG." };
  const cut = text.lastIndexOf("#");
  if (cut === -1) return { error: "Add your tagline after a #, like Name#TAG." };
  const gameName = text.slice(0, cut).trim();
  const tagLine = text.slice(cut + 1).trim();
  const nameLength = Array.from(gameName).length;
  if (nameLength < 3 || nameLength > 16) return { error: "The name before the # is 3 to 16 characters." };
  if (!/^[\p{L}\p{N}]{3,5}$/u.test(tagLine)) return { error: "The tagline after the # is 3 to 5 letters or numbers." };
  return { gameName: gameName, tagLine: tagLine };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where a detour (link a Riot ID, add rcoin) goes back to on the Play page,
 * normalized to a Play route arg: "t/<tournament id>", "q/<fee>/<size>",
 * "new" or "j/<invite code>" (back to a join link). A bare tournament id (older links) becomes "t/<id>". Anything else
 * is null, so a crafted link can't send the player somewhere odd.
 */
export function playReturn(value) {
  const parts = String(value || "").split("/");
  if (parts.length === 1 && UUID_PATTERN.test(parts[0])) return "t/" + parts[0];
  if (parts[0] === "t" && parts.length === 2 && UUID_PATTERN.test(parts[1])) return "t/" + parts[1];
  if (parts[0] === "q" && parts.length === 3 && findTier(parts[1] + ":" + parts[2])) return "q/" + parts[1] + "/" + parts[2];
  if (parts[0] === "new" && parts.length === 1) return "new";
  if (parts[0] === "j" && parts.length === 2 && isInviteCode(parts[1])) return "j/" + normalizeInviteCode(parts[1]);
  return null;
}
