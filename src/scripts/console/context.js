/* ============================================================================
 * Runinback — console shared context: the signed-in user, the Supabase
 * client, and a cache of usernames for other players.
 * ========================================================================== */
import { friendlyError } from "../lib/errors.js";

export const session = {
  client: null,
  uid: null,
  balanceCents: null, // last known available balance (UI hints only; the server decides)
};

const usernameCache = {}; // user id -> username

export function initContext(client, uid) {
  session.client = client;
  session.uid = uid;
  usernameCache[uid] = "you";
}

export function rememberUsername(uid, username) {
  usernameCache[uid] = username;
}

/** Fetch usernames for any ids not cached yet (one round trip). */
export function fetchUsernames(ids) {
  const missing = (ids || []).filter(function (id, i, all) {
    return id && !(id in usernameCache) && all.indexOf(id) === i;
  });
  if (!missing.length) return Promise.resolve(usernameCache);
  return session.client.from("profiles").select("id, username").in("id", missing).then(function (r) {
    // On failure render with the generic label but don't cache it, so the next
    // load tries again.
    if (r.error) return usernameCache;
    (r.data || []).forEach(function (p) { usernameCache[p.id] = p.username; });
    missing.forEach(function (id) { if (!(id in usernameCache)) usernameCache[id] = "player"; });
    return usernameCache;
  }).catch(function () { return usernameCache; });
}

/** "you", "@handle", or "—" for an empty id. */
export function playerLabel(id) {
  if (!id) return "—";
  return id === session.uid ? "you" : "@" + (usernameCache[id] || "player");
}

/** Clean, professional text for a backend error — never the raw DB message. */
export function errorText(error, fallback) {
  return friendlyError(error, fallback);
}
