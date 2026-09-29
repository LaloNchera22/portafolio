// Rules of every game that can be played for USD. The server validates and
// applies every staked move with these exact modules (game-move Edge Function),
// so only deterministic, perfect-information games belong here: no dice, no
// shuffled decks, no hidden hands.
//
// MUST mirror the allow-list in the rib_game_create RPC (a unit test checks it).
export const STAKEABLE_RULES = Object.freeze({});

export const STAKEABLE_GAME_IDS = Object.freeze(Object.keys(STAKEABLE_RULES));
