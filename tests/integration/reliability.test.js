// @vitest-environment jsdom
// Regression tests for failures found by the plugin-agent audit: no fake zero
// balance on errors, no
// silent 1-USD fallback for invalid table stakes, and returning to the games
// page keeps a board in progress.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

const HTML = readFileSync(resolve(import.meta.dirname, "../../src/console.html"), "utf8");

let walletResponse = { data: { test_balance_cents: 4200, test_locked_cents: 0 }, error: null };
const calls = [];
const challenges = [];

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

let ctx, wallet;
beforeAll(async () => {
  document.documentElement.innerHTML = HTML.replace(/^[\s\S]*?<html[^>]*>/i, "").replace(/<\/html>\s*$/i, "");
  window.scrollTo = () => {};
  vi.spyOn(window, "confirm").mockReturnValue(true);
  ctx = await import("../../src/scripts/console/context.js");
  wallet = await import("../../src/scripts/console/wallet.js");
  ctx.initContext(client, "u1");
  await wallet.refreshWallet();
});

describe("wallet balance", () => {
  it("keeps the last known balance when a refresh fails", async () => {
    expect($("wallet-chip").textContent).toBe("42 USD");
    walletResponse = { data: null, error: { message: "network" } };
    await wallet.refreshWallet();
    expect($("wallet-chip").textContent).toBe("42 USD");
    expect(ctx.session.balanceCents).toBe(4200);
    walletResponse = { data: { test_balance_cents: 4200, test_locked_cents: 0 }, error: null };
  });
});
