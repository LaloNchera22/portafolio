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
    stake_cents: 500, status: "active", matched_at: "2026-01-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z",
  }],
  profiles: [{ id: "u2", username: "rival" }],
};
const rpcData = {
  rib_open_challenges: [
    { id: "a1", game: "Valorant", mode: "1v1", stake_cents: 1000, created_at: new Date(Date.now() - 300000).toISOString(), creator_id: "u3", creator_username: "neo" },
    { id: "a2", game: "FIFA", mode: "bo3", stake_cents: 5000, created_at: new Date(Date.now() - 7200000).toISOString(), creator_id: "u4", creator_username: "trinity" },
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
  const challenges = await import("../../src/scripts/console/challenges.js");
  const ranking = await import("../../src/scripts/console/leaderboard.js");
  const wallet = await import("../../src/scripts/console/wallet.js");
  ctx.initContext(client, "u1");
  nav.initNavigation({});
  challenges.initChallenges();
  ranking.initRanking();
  await wallet.refreshWallet();
  challenges.loadChallenges();
  ranking.loadRanking();
  ranking.loadProfileRecord();
  await tick();
});

describe("challenge lobby", () => {
  it("lists open challenges with creator, stake and pot", () => {
    const lobby = $("challenge-open");
    expect(lobby.querySelectorAll(".row--lobby")).toHaveLength(2);
    expect(lobby.textContent).toContain("@neo");
    expect(lobby.textContent).toContain("prize 20 rcoin");
    expect($("lobby-status").textContent).toBe("2 open challenges");
  });

  it("filters by stake range", async () => {
    document.querySelector('[data-lobby-range] [data-range="high"]').click();
    await tick();
    expect(lastCall("rib_open_challenges")[1]).toMatchObject({ p_min_cents: 2500, p_max_cents: null });
  });

  it("accepts through the escrow RPC", async () => {
    $("challenge-open").querySelector("[data-accept]").click();
    await tick();
    expect(lastCall("rib_challenge_accept")).toBeTruthy();
  });

  it("offers to void a match stuck without a result", () => {
    expect($("challenge-mine").querySelector("[data-void]")).not.toBeNull();
  });
});

describe("custom stake composer", () => {
  const type = (value) => {
    const input = $("challenge-stake-input");
    input.value = value;
    input.dispatchEvent(new Event("input"));
  };

  it("summarizes a valid stake and the pot", () => {
    type("10");
    expect($("challenge-stake-help").textContent).toContain("Winner takes 20 rcoin");
    expect($("challenge-stake-error").textContent).toBe("");
    expect($("challenge-save").disabled).toBe(false);
  });

  it("blocks stakes above the balance or the maximum", () => {
    type("30");
    expect($("challenge-stake-error").textContent).toBe("Error: You have 20 rcoin available.");
    expect($("challenge-stake-input").getAttribute("aria-invalid")).toBe("true");
    expect($("challenge-save").disabled).toBe(true);
    type("1500");
    expect($("challenge-stake-error").textContent).toContain("maximum entry fee is 1,000");
  });

  it("rejects decimals instead of silently rewriting them", () => {
    type("1.5");
    expect($("challenge-stake-input").value).toBe("1.5");
    expect($("challenge-stake-error").textContent).toBe("Error: Use whole rcoin, no decimals.");
    expect($("challenge-save").disabled).toBe(true);
  });

  it("supports stepper and presets", () => {
    type("5");
    document.querySelector('#challenge-stake [data-step="1"]').click();
    expect($("challenge-stake-input").value).toBe("6");
    document.querySelector('[data-stake-presets] [data-preset="10"]').click();
    expect($("challenge-stake-input").value).toBe("10");
  });

  it("posts the custom stake in cents", async () => {
    $("challenge-new").click();
    $("challenge-game").value = "Valorant";
    $("challenge-form").dispatchEvent(new Event("submit", { cancelable: true }));
    await tick();
    expect(lastCall("rib_challenge_create")[1]).toMatchObject({ p_game: "Valorant", p_stake_cents: 1000, p_target_username: null });
    expect($("challenge-msg").textContent).toContain("posted to the lobby");
  });
});

describe("ranking", () => {
  it("renders the board with the top three emphasized and my row highlighted", () => {
    const list = $("ranking-list");
    expect(list.querySelectorAll(".rank")).toHaveLength(3);
    expect(list.querySelectorAll(".rank--top")).toHaveLength(2);
    expect(list.querySelector(".rank--me")).not.toBeNull();
    expect(list.querySelector("ol").getAttribute("role")).toBe("list");
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
