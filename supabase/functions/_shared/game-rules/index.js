// Rules of every game that can be played for USD. The server validates and
// applies every staked move with these exact modules (game-move Edge Function),
// so only deterministic, perfect-information games belong here: no dice, no
// shuffled decks, no hidden hands.
//
// MUST mirror the allow-list in the rib_game_create RPC (a unit test checks it).
import checkers from "./checkers.js";
import connect4 from "./connect4.js";
import dots from "./dots.js";
import mancala from "./mancala.js";
import reversi from "./reversi.js";
import tictactoe from "./tictactoe.js";

export const STAKEABLE_RULES = Object.freeze({ tictactoe, connect4, reversi, checkers, dots, mancala });

export const STAKEABLE_GAME_IDS = Object.freeze(Object.keys(STAKEABLE_RULES));
