/* ============================================================================
 * Runinback — game networks a player can link (mirrors the check constraint
 * on game_accounts.network in migration 0022).
 * ========================================================================== */
export const NETWORKS = [
  { id: "riot", label: "Riot ID", hint: "Name#TAG" },
  { id: "steam", label: "Steam", hint: "Profile name or friend code" },
  { id: "epic", label: "Epic Games", hint: "Display name" },
  { id: "xbox", label: "Xbox", hint: "Gamertag" },
  { id: "playstation", label: "PlayStation", hint: "Online ID" },
  { id: "nintendo", label: "Nintendo", hint: "Friend code SW-…" },
  { id: "battlenet", label: "Battle.net", hint: "Name#1234" },
  { id: "ea", label: "EA", hint: "EA ID" },
  { id: "activision", label: "Activision", hint: "Name#1234567" },
  { id: "ubisoft", label: "Ubisoft Connect", hint: "Username" },
  { id: "other", label: "Other", hint: "The name you use in the game" },
];

export function networkLabel(id) {
  const n = NETWORKS.find((x) => x.id === id);
  return n ? n.label : "";
}
