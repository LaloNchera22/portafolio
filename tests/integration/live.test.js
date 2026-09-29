// @vitest-environment jsdom
// Live match watcher and in-place fixes for blocked joins: a match that needs
// the player shows on every page (strip, badge, title, toast), and a missing
// game account or a short balance is solved from the tournament card.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

const HTML = readFileSync(resolve(import.meta.dirname, "../../src/console.html"), "utf8");
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 10));
const soon = () => new Date(Date.now() + 10 * 60 * 1000).toISOString();

let myRooms = [];
const calls = [];
const rpcData = {
  rib_open_tournaments: () => [
    { id: "t1", name: "Friday Cup", game: "Valorant", network: "riot", entry_fee_cents: 1000, size: 4, entrants: 3, created_at: new Date().toISOString(), creator_username: "neo", joined: false },
    { id: "t2", name: "Big Cup", game: "CS2", network: null, entry_fee_cents: 5000, size: 8, entrants: 2, created_at: new Date().toISOString(), creator_username: "neo", joined: false },
  ],
  rib_my_rooms: () => myRooms,
  rib_my_tournaments: () => [],
};

function query(table) {
  let single = false;
  const builder = new Proxy({}, {
    get(_, prop) {
      if (prop === "then") {
        const rows = table === "wallets" ? [{ test_balance_cents: 2000, test_locked_cents: 0 }] : [];
        return (res, rej) => Promise.resolve({ data: single ? rows[0] || null : rows, error: null }).then(res, rej);
      }
      if (prop === "single") return () => { single = true; return builder; };
      return () => builder;
    },
  });
  return builder;
}
const client = {
  from: (t) => query(t),
  rpc: (name, args) => { calls.push([name, args]); return Promise.resolve({ data: rpcData[name] ? rpcData[name]() : {}, error: null }); },
  channel: () => ({ on() { return this; }, subscribe() { return this; } }),
  removeChannel: () => {},
};
const $ = (id) => document.getElementById(id);

let live, tournaments;
beforeAll(async () => {
  document.documentElement.innerHTML = HTML.replace(/^[\s\S]*?<html[^>]*>/i, "").replace(/<\/html>\s*$/i, "");
  document.title = "Console — Runinback";
  window.scrollTo = () => {};
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const ctx = await import("../../src/scripts/console/context.js");
  const nav = await import("../../src/scripts/console/navigation.js");
  const wallet = await import("../../src/scripts/console/wallet.js");
  live = await import("../../src/scripts/console/live.js");
  tournaments = await import("../../src/scripts/console/tournaments.js");
  ctx.initContext(client, "u1");
  nav.initNavigation({});
  nav.initAmountChips(() => {});
  tournaments.initTournaments();
  await wallet.refreshWallet();
  await live.initLiveWatch();
});

describe("live match watcher", () => {
  it("stays quiet with nothing to do", () => {
    expect($("live-rooms").hidden).toBe(true);
    expect(document.querySelector("[data-live-badge]").hidden).toBe(true);
  });

  it("flags a match that needs me on every page: strip, badge, title and a toast", async () => {
    myRooms = [{ id: "r1", kind: "tournament", game: "Valorant", status: "ready_check", round: 1, rounds: 2, tournament_id: "t9",
      tournament_name: "Monday Cup", opponent_username: "neo", ready_deadline: soon(), confirm_deadline: null, needs_me: true, my_report: null }];
    await live.refreshLive();
    expect($("live-rooms").hidden).toBe(false);
    expect($("live-rooms").textContent).toContain("Monday Cup · Semifinals");
    expect($("live-rooms").textContent).toContain("Get into the lobby and press Ready");
    expect(document.querySelector("[data-live-badge]").textContent).toBe("1");
    expect(document.title).toBe("(1) Console — Runinback");
    const t = document.querySelector(".rib-toast");
    expect(t.textContent).toContain("Your match vs @neo is ready");
    expect(t.querySelector(".rib-toast__act").textContent).toBe("Open room");
    expect(live.urgentRoom().id).toBe("r1");
  });

  it("drops the badge once nothing needs me", async () => {
    myRooms = [];
    await live.refreshLive();
    expect(document.querySelector("[data-live-badge]").hidden).toBe(true);
    expect(document.title).toBe("Console — Runinback");
  });
});

describe("joining without what it takes", () => {
  it("offers to link the required account instead of a join that fails", async () => {
    await tournaments.loadTournaments();
    await tick(30);
    const card = document.querySelector('[data-tid="t1"]');
    expect(card.querySelector("[data-join]")).toBeNull();
    expect(card.querySelector('[data-link="riot"]').textContent).toBe("Link Riot ID to join");
  });

  it("offers exactly the missing rcoin when the balance is short", () => {
    const card = document.querySelector('[data-tid="t2"]');
    expect(card.querySelector("[data-topup]").getAttribute("data-topup")).toBe("3000");
    expect(card.textContent).toContain("You need 50 rcoin, you have 20 rcoin.");
  });
});
