// Server-authoritative play: the pure planner used by the game-move Edge
// Function, plus a guard that the SQL allow-list mirrors the shared rules.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { currentState, planMove } from "../../supabase/functions/_shared/game-move-core.js";
import { STAKEABLE_GAME_IDS, STAKEABLE_RULES } from "../../supabase/functions/_shared/game-rules/index.js";

const HOST = "00000000-0000-0000-0000-00000000000a";
const GUEST = "00000000-0000-0000-0000-00000000000b";

function newMatch(game) {
  return { id: "m1", game, host_id: HOST, guest_id: GUEST, status: "active", state: {}, move_seq: 0 };
}

// Mirror what rib_game_commit_move persists.
function commit(match, plan) {
  return {
    ...match,
    state: plan.state,
    move_seq: match.move_seq + 1,
    status: plan.over ? "settled" : "active",
    winner_id: plan.winnerId,
    is_draw: plan.isDraw,
  };
}

describe("planMove: full games", () => {
  it.each(STAKEABLE_GAME_IDS)("%s plays to a settled result with random legal moves", (game) => {
    const rules = STAKEABLE_RULES[game];
    for (let round = 0; round < 5; round++) {
      let match = newMatch(game);
      let plies = 0;
      while (match.status === "active" && plies < 3000) {
        const state = currentState(rules, match);
        const uid = state.turn === 0 ? HOST : GUEST;
        const legal = rules.legal(state);
        const move = legal[Math.floor(Math.random() * legal.length)];
        // the move crosses the network as JSON
        const plan = planMove(match, uid, { move: JSON.parse(JSON.stringify(move)), seq: match.move_seq });
        expect(plan.error, `${game}: ${plan.error}`).toBeUndefined();
        match = commit(match, plan);
        plies++;
      }
      expect(match.status).toBe("settled");
      const result = rules.result(match.state);
      const expectedWinner = result.winner == null ? null : result.winner === 0 ? HOST : GUEST;
      expect(match.winner_id).toBe(expectedWinner);
      expect(match.is_draw).toBe(result.winner == null);
    }
  });
});

describe("planMove: rejections", () => {
  it("rejects moves out of turn", () => {
    expect(planMove(newMatch("tictactoe"), GUEST, { move: 4 })).toEqual({ error: "not_your_turn", status: 409 });
  });

  it("rejects illegal moves", () => {
    expect(planMove(newMatch("tictactoe"), HOST, { move: 42 }).error).toBe("illegal_move");
    const taken = commit(newMatch("tictactoe"), planMove(newMatch("tictactoe"), HOST, { move: 4 }));
    expect(planMove(taken, GUEST, { move: 4 }).error).toBe("illegal_move");
  });

  it("rejects callers who are not in the match", () => {
    expect(planMove(newMatch("tictactoe"), "someone-else", { move: 4 }).error).toBe("not_in_match");
  });

  it("rejects stale sequence numbers", () => {
    expect(planMove(newMatch("tictactoe"), HOST, { move: 4, seq: 3 }).error).toBe("stale_move");
  });

  it("rejects games that are not stakeable and matches that are not active", () => {
    expect(planMove(newMatch("eights"), HOST, { move: 0 }).error).toBe("unknown_game");
    expect(planMove({ ...newMatch("tictactoe"), status: "open" }, HOST, { move: 4 }).error).toBe("match_not_in_progress");
  });

  it("ignores a forged initial state and starts from the rules' position", () => {
    const forged = { ...newMatch("tictactoe"), state: { b: [0, 0, null, null, null, null, null, null, null], turn: 0 } };
    const plan = planMove(forged, HOST, { move: 2 });
    expect(plan.over).toBe(false);
    expect(plan.state.b).toEqual([null, null, 0, null, null, null, null, null, null]);
  });

  it("awards the pot to the opponent on resign", () => {
    expect(planMove(newMatch("connect4"), GUEST, { action: "resign" })).toMatchObject({ over: true, winnerId: HOST, isDraw: false });
  });
});

describe("stakeable allow-list", () => {
  it("matches rib_game_create in the latest migration that defines it", () => {
    const dir = resolve(import.meta.dirname, "../../supabase/migrations");
    const latest = readdirSync(dir).sort().reverse()
      .map((f) => readFileSync(resolve(dir, f), "utf8"))
      .find((sql) => /function public\.rib_game_create/.test(sql));
    const block = latest.slice(latest.lastIndexOf("create or replace function public.rib_game_create"));
    const list = block.match(/p_game not in \(([^)]*)\)/)[1].match(/'([a-z0-9]+)'/g).map((s) => s.slice(1, -1));
    expect([...list].sort()).toEqual([...STAKEABLE_GAME_IDS].sort());
  });
});
