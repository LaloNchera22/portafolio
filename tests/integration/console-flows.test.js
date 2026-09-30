// @vitest-environment jsdom
// Console flows against the real console.html markup with a fake Supabase
// client: challenge lobby, custom stake composer, posting and accepting a
// challenge, and the ranking page.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

const HTML = readFileSync(resolve(import.meta.dirname, "../../src/console.html"), "utf8");
const tick = () => new Promise((r) => setTimeout(r, 10));

const calls = [];
const tables = {
  wallets: [{ test_balance_cents: 2000, test_locked_cents: 0 }],
  challenges: [{
    id: "c9", creator_id: "u1", opponent_id: "u2", target_id: null, game: "CS2", mode: "1v1",
    stake_cents: 0, status: "active", room_id: "r9", matched_at: "2026-01-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z",
  }],
  profiles: [{ id: "u2", username: "rival" }],
  game_accounts: [{ network: "riot", handle: "Me#NA1" }],
};
const rpcData = {
  rib_open_challenges: [
    { id: "a1", game: "Valorant", mode: "1v1", stake_cents: 0, created_at: new Date(Date.now() - 300000).toISOString(), creator_id: "u3", creator_username: "neo", network: "riot" },
    { id: "a2", game: "FIFA", mode: "bo3", stake_cents: 0, created_at: new Date(Date.now() - 7200000).toISOString(), creator_id: "u4", creator_username: "trinity", network: null },
  ],
  rib_open_tournaments: [
    { id: "t1", name: "Friday Cup", game: "Valorant", network: "riot", entry_fee_cents: 1000, size: 4, entrants: 3, created_at: new Date().toISOString(), creator_username: "neo", joined: false },
    { id: "t2", name: "Free Cup", game: "Chess", network: null, entry_fee_cents: 0, size: 8, entrants: 2, created_at: new Date().toISOString(), creator_username: "me", joined: true },
  ],
  rib_my_tournaments: [
    { id: "t3", name: "Monday Cup", game: "CS2", network: null, entry_fee_cents: 500, size: 4, status: "active", entrants: 4, placement: null, winner_username: null, prize_pool_cents: 1800, created_at: new Date().toISOString() },
  ],
  rib_tournament_bracket: [
    { room_id: "r1", round: 1, slot: 0, player_a: "u1", player_b: "u2", a_username: "me", b_username: "rival", status: "ready_check", winner_id: null, walkover: false },
    { room_id: "r2", round: 1, slot: 1, player_a: "u3", player_b: "u4", a_username: "neo", b_username: "trinity", status: "done", winner_id: "u3", walkover: false },
    { room_id: "r3", round: 2, slot: 0, player_a: null, player_b: "u3", a_username: null, b_username: "neo", status: "waiting", winner_id: null, walkover: false },
  ],
  rib_my_rooms: [
    { id: "r1", kind: "tournament", game: "CS2", status: "ready_check", round: 1, tournament_id: "t3", tournament_name: "Monday Cup", opponent_username: "rival", ready_deadline: new Date(Date.now() + 600000).toISOString(), confirm_deadline: null },
  ],
  rib_leaderboard: [
    { rank: 1, user_id: "u3", username: "neo", net_cents: 12000, won_cents: 20000, wins: 7, losses: 2 },
    { rank: 2, user_id: "u1", username: "me", net_cents: 900, won_cents: 3000, wins: 3, losses: 3 },
    { rank: 4, user_id: "u5", username: "smith", net_cents: -400, won_cents: 0, wins: 0, losses: 2 },
  ],
  rib_my_standing: [{ rank: 2, net_cents: 900, won_cents: 3000, wins: 3, losses: 3 }],
};

// Chainable PostgREST-like query builder resolving to canned rows.
function query(table) {
  let single = false;
  const builder = new Proxy({}, {
    get(_, prop) {
      if (prop === "then") {
        const rows = tables[table] || [];
        return (res, rej) => Promise.resolve(single ? { data: rows[0] || null, error: null } : { data: rows, error: null, count: 0 }).then(res, rej);
      }
      if (prop === "single") return () => { single = true; return builder; };
      return () => builder;
    },
  });
  return builder;
}
const client = {
  from: (table) => query(table),
  rpc: (name, args) => { calls.push([name, args]); return Promise.resolve({ data: rpcData[name] ?? {}, error: null }); },
  functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
};

const $ = (id) => document.getElementById(id);
const lastCall = (name) => calls.filter((c) => c[0] === name).pop();

beforeAll(async () => {
  document.documentElement.innerHTML = HTML.replace(/^[\s\S]*?<html[^>]*>/i, "").replace(/<\/html>\s*$/i, "");
  window.scrollTo = () => {};
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const ctx = await import("../../src/scripts/console/context.js");
  const nav = await import("../../src/scripts/console/navigation.js");
  const tournaments = await import("../../src/scripts/console/tournaments.js");
  const ranking = await import("../../src/scripts/console/leaderboard.js");
  const wallet = await import("../../src/scripts/console/wallet.js");
  ctx.initContext(client, "u1");
  nav.initNavigation({});
  nav.initAmountChips(() => {});
  tournaments.initTournaments();
  ranking.initRanking();
  await wallet.refreshWallet();
  tournaments.loadTournaments();
  ranking.loadRanking();
  ranking.loadProfileRecord();
  await tick();
});


describe("tournaments", () => {
  it("lists tournaments waiting for players with fill and prizes", () => {
    const list = $("tournament-list");
    expect(list.querySelectorAll(".tcard")).toHaveLength(2);
    expect(list.textContent).toContain("3/4 players · 1 seat left");
    expect(list.textContent).toContain("Riot ID required");
    expect(list.textContent).toContain("Champion 25.2 rcoin · runner-up 10.8 rcoin");
    expect(list.querySelector(".seats").getAttribute("aria-label")).toBe("3 of 4 seats taken");
    expect(list.querySelectorAll('[data-tid="t1"] .seat.is-taken')).toHaveLength(3);
    expect(list.querySelector('[data-leave="t2"]')).not.toBeNull();
  });

  it("joins through the tournament RPC", async () => {
    $("tournament-list").querySelector('[data-join="t1"]').click();
    await tick();
    expect(lastCall("rib_tournament_join")[1]).toEqual({ p_tournament_id: "t1" });
  });

  it("previews the prize split before creating", async () => {
    expect($("tournament-prize").textContent).toContain("Platform (10%)");
    document.querySelector('[data-chips="tournament-size"] [data-amt="8"]').click();
    await new Promise((r) => setTimeout(r, 400)); // the numbers count to their new values
    expect($("tournament-prize").textContent).toContain("Pool80 rcoin");
  });

  it("creates a sit & go with the chosen size and fee", async () => {
    $("tournament-new").click();
    $("tournament-name").value = "Cup";
    $("tournament-game").value = "Wild Rift";
    $("tournament-form").dispatchEvent(new Event("submit", { cancelable: true }));
    await tick();
    expect(lastCall("rib_tournament_create")[1]).toMatchObject({ p_name: "Cup", p_game: "Wild Rift", p_entry_fee_cents: 1000, p_size: 8 });
  });

  it("shows the match waiting for me", () => {
    expect($("live-rooms").hidden).toBe(false);
    expect($("live-rooms").textContent).toContain("Monday Cup");
    expect($("live-rooms").querySelector('[data-room="r1"]')).not.toBeNull();
  });

  it("draws my bracket by round with an Open room button on my live match", async () => {
    $("tournament-mine").querySelector('[data-bracket="t3"]').click();
    await tick();
    const bracket = $("bracket-t3");
    expect([...bracket.querySelectorAll("h4")].map((h) => h.textContent)).toEqual(["Semifinals", "Final", "Champion"]);
    expect(bracket.querySelector(".is-win").textContent).toBe("@neo");
    expect(bracket.querySelector('[data-room="r1"]')).not.toBeNull();
  });
});

describe("ranking", () => {
  it("puts the top three on a podium and highlights me", () => {
    const list = $("ranking-list");
    expect([...list.querySelectorAll(".podium li")].map((li) => li.className.split(" ")[0])).toEqual(["p1", "p2", "p3"]);
    expect(list.querySelectorAll(".ranking .rank")).toHaveLength(0);
    expect(list.querySelector(".podium .is-me")).not.toBeNull();
    expect(list.querySelector("ol.ranking").getAttribute("role")).toBe("list");
  });

  it("pins my standing and shows my record on the profile", () => {
    expect($("ranking-me").querySelector(".standing__n").textContent).toBe("2");
    expect($("profile-stats").textContent).toContain("#2");
    expect($("profile-stats").textContent).toContain("3–3");
  });

  it("switches period", async () => {
    document.querySelector('#ranking-period [data-period="all"]').click();
    await tick();
    expect(lastCall("rib_leaderboard")[1].p_period).toBe("all");
  });
});
