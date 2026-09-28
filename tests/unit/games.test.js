// Property tests for every game's pure rules: a game must always offer legal
// moves until it ends, the bot must answer with a legal move, and every match
// must finish within a bounded number of plies (no infinite loops on a staked
// table).
import { describe, expect, it } from "vitest";
import { CORE_GAMES } from "../../src/scripts/games/catalog/core-games.js";
import { EXTRA_GAMES } from "../../src/scripts/games/catalog/extra-games.js";
import { STAKEABLE_GAME_IDS } from "../../src/scripts/games/catalog/catalog-meta.js";
import { GAME_HELP } from "../../src/scripts/games/help.js";

const ALL_GAMES = [...CORE_GAMES, ...EXTRA_GAMES];
const MATCHES_PER_GAME = 8;
const MAX_PLIES = 3000;

const sameMove = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function playMatch(mod, pickHumanMove) {
  let state = mod.init();
  let plies = 0;
  while (!mod.result(state) && plies < MAX_PLIES) {
    const legal = mod.legal(state);
    expect(legal.length, `${mod.id}: no legal moves in a live position`).toBeGreaterThan(0);
    const move = state.turn === 1 ? mod.bot(state) : pickHumanMove(legal);
    if (state.turn === 1) {
      expect(legal.some((m) => sameMove(m, move)), `${mod.id}: bot played an illegal move`).toBe(true);
    }
    state = mod.apply(state, move);
    plies++;
  }
  return { state, plies };
}

describe("game catalog", () => {
  it("has unique ids and the metadata the lobby renders", () => {
    const ids = ALL_GAMES.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of ALL_GAMES) {
      expect(g.name, g.id).toBeTruthy();
      expect(g.icon, g.id).toBeTruthy();
      expect(typeof g.view, g.id).toBe("function");
    }
  });

  it("has how-to-play copy for every playable game", () => {
    for (const g of ALL_GAMES) expect(GAME_HELP[g.id], g.id).toBeTruthy();
  });

  it("only marks existing games as stakeable", () => {
    const ids = ALL_GAMES.map((g) => g.id);
    for (const id of STAKEABLE_GAME_IDS) expect(ids, id).toContain(id);
  });
});

describe.each(ALL_GAMES.map((g) => [g.id, g]))("%s rules", (_id, mod) => {
  it("starts with seat 0 to move and no result", () => {
    const s = mod.init();
    expect(s.turn).toBe(0);
    expect(mod.result(s)).toBeFalsy();
  });

  it("does not mutate the input state when applying a move", () => {
    const s = mod.init();
    const before = JSON.stringify(s);
    mod.apply(s, mod.legal(s)[0]);
    expect(JSON.stringify(s)).toBe(before);
  });

  it("always terminates with a valid result (random human vs bot)", () => {
    for (let i = 0; i < MATCHES_PER_GAME; i++) {
      const { state, plies } = playMatch(mod, (legal) => legal[Math.floor(Math.random() * legal.length)]);
      expect(plies, `${mod.id}: match did not end`).toBeLessThan(MAX_PLIES);
      const r = mod.result(state);
      expect(r.over).toBe(true);
      expect([0, 1, null]).toContain(r.winner);
    }
  });
});
