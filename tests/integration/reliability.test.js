// @vitest-environment jsdom
// Regression tests for failures found by the plugin-agent audit: no fake zero
// balance on errors, no
// silent 1-rcoin fallback for invalid table stakes, and returning to the games
// page keeps a board in progress.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

const HTML = readFileSync(resolve(import.meta.dirname, "../../src/console.html"), "utf8");
const tick = () => new Promise((r) => setTimeout(r, 10));

let walletResponse = { data: { test_balance_cents: 4200, test_locked_cents: 0 }, error: null };
const calls = [];
const challenges = [{
  id: "c1", creator_id: "u1", opponent_id: "u2", target_id: null, game: "CS2", mode: "1v1",
  stake_cents: 500, status: "active", matched_at: new Date().toISOString(), created_at: new Date().toISOString(),
}];

function query(table) {
  let single = false;
  const builder = new Proxy({}, {
    get(_, prop) {
      if (prop === "then") {
        const result = table === "wallets" ? walletResponse
          : { data: single ? null : (table === "challenges" ? challenges : []), error: null, count: 0 };
        return (res, rej) => Promise.resolve(result).then(res, rej);
      }
      if (prop === "single") return () => { single = true; return builder; };
      return () => builder;
    },
  });
  return builder;
}
const client = {
  from: (table) => query(table),
  rpc: (name, args) => { calls.push([name, args]); return Promise.resolve({ data: name === "rib_open_challenges" ? [] : {}, error: null }); },
  channel: () => ({ on() { return this; }, subscribe() { return this; } }),
  removeChannel: () => {},
  functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
};
const $ = (id) => document.getElementById(id);

let ctx, wallet, challengesMod, engine;
beforeAll(async () => {
  document.documentElement.innerHTML = HTML.replace(/^[\s\S]*?<html[^>]*>/i, "").replace(/<\/html>\s*$/i, "");
  window.scrollTo = () => {};
  vi.spyOn(window, "confirm").mockReturnValue(true);
  ctx = await import("../../src/scripts/console/context.js");
  wallet = await import("../../src/scripts/console/wallet.js");
  challengesMod = await import("../../src/scripts/console/challenges.js");
  engine = await import("../../src/scripts/games/engine.js");
  ctx.initContext(client, "u1");
  challengesMod.initChallenges();
  await wallet.refreshWallet();
});

describe("wallet balance", () => {
  it("keeps the last known balance when a refresh fails", async () => {
    expect($("wallet-chip").textContent).toBe("42 rcoin");
    walletResponse = { data: null, error: { message: "network" } };
    await wallet.refreshWallet();
    expect($("wallet-chip").textContent).toBe("42 rcoin");
    expect(ctx.session.balanceCents).toBe(4200);
    walletResponse = { data: { test_balance_cents: 4200, test_locked_cents: 0 }, error: null };
  });
});

describe("games page", () => {
  it("blocks an invalid custom table stake instead of falling back to 1 rcoin", async () => {
    engine.initGames({ client, UID: "u1", refreshWallet: () => Promise.resolve(), configured: true });
    await tick();
    const card = [...document.querySelectorAll(".gcard")].find((c) => /Tic-Tac-Toe/.test(c.textContent));
    card.click();
    const custom = document.querySelector(".gplay__custom");
    const create = [...document.querySelectorAll(".gplay__act")].find((b) => b.textContent === "Create table");
    custom.value = "0";
    custom.dispatchEvent(new Event("input"));
    expect(create.disabled).toBe(true);
    expect(document.querySelector(".gplay__pot").textContent).toContain("minimum entry fee");
    custom.value = "7";
    custom.dispatchEvent(new Event("input"));
    expect(create.disabled).toBe(false);
    expect(document.querySelector(".gplay__pot").textContent).toBe("Winner takes 14 rcoin");
    document.querySelector(".gplay__x").click();
  });

  it("makes the game modal accessible: labelled, focused, Escape returns focus", () => {
    const card = [...document.querySelectorAll(".gcard")].find((c) => /Connect Four/.test(c.textContent));
    card.focus();
    card.click();
    const dialog = document.querySelector(".gplay--modal");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")).textContent).toBe("Connect Four");
    expect(dialog.contains(document.activeElement)).toBe(true);
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".gplay--modal")).toBeNull();
    expect(document.activeElement).toBe(card);
  });

  it("labels board squares for screen readers", () => {
    const card = [...document.querySelectorAll(".gcard")].find((c) => /Tic-Tac-Toe/.test(c.textContent));
    card.click();
    [...document.querySelectorAll(".gplay__act")].find((b) => b.textContent === "Play free").click();
    const squares = document.querySelectorAll("#g-board button");
    expect(squares.length).toBe(9);
    expect(squares[0].getAttribute("aria-label")).toBe("Square 1, empty, available");
    expect(document.getElementById("g-turn").getAttribute("role")).toBe("status");
    document.querySelector("#games-root .gscreen__top button").click(); // Leave
  });

  it("keeps a board in progress when the games page is opened again", async () => {
    const card = [...document.querySelectorAll(".gcard")].find((c) => /Tic-Tac-Toe/.test(c.textContent));
    card.click();
    [...document.querySelectorAll(".gplay__act")].find((b) => b.textContent === "Play free").click();
    expect(document.querySelector("#games-root .gstage")).not.toBeNull();
    engine.initGames({ client, UID: "u1", refreshWallet: () => Promise.resolve(), configured: true });
    expect(document.querySelector("#games-root .gstage")).not.toBeNull();
  });
});
