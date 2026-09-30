// @vitest-environment jsdom
// Live match watcher and in-place fixes for blocked joins: a match that needs
// the player shows on every page (strip, badge, title, toast), and a missing
// Riot ID or a short balance is solved from the tier or the tournament card,
// with a way back to the same join.
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
    { id: "0b7c3a52-6c1e-4b1e-9d0a-3f7a1c2b4d5e", name: "Friday Cup", game: "Wild Rift", network: "riot", entry_fee_cents: 1000, size: 4, entrants: 3, created_at: new Date().toISOString(), creator_username: "neo", joined: false },
    { id: "t2", name: "Big Cup", game: "Wild Rift", network: "riot", entry_fee_cents: 5000, size: 8, entrants: 2, created_at: new Date().toISOString(), creator_username: "neo", joined: false },
  ],
  rib_my_rooms: () => myRooms,
  rib_my_tournaments: () => [],
  rib_quick_tiers: () => [],
};
let riotRows = []; // the player's linked game accounts

function query(table) {
  let single = false;
  const builder = new Proxy({}, {
    get(_, prop) {
      if (prop === "then") {
        const rows = table === "wallets" ? [{ test_balance_cents: 2000, test_locked_cents: 0 }] : table === "game_accounts" ? riotRows : [];
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

let live, tournaments, nav, profile;
beforeAll(async () => {
  document.documentElement.innerHTML = HTML.replace(/^[\s\S]*?<html[^>]*>/i, "").replace(/<\/html>\s*$/i, "");
  document.title = "Console — Runinback";
  window.scrollTo = () => {};
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const ctx = await import("../../src/scripts/console/context.js");
  nav = await import("../../src/scripts/console/navigation.js");
  profile = await import("../../src/scripts/console/profile.js");
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
  const tap = async (key) => {
    document.querySelector('#play-tiers [data-tier="' + key + '"]').click();
    await tick(30);
  };

  it("sends a player without a Riot ID to link it, remembering the tier", async () => {
    await tournaments.loadTournaments();
    await tap("1000:4");
    expect(calls.some((c) => c[0] === "rib_quick_join")).toBe(false);
    expect(location.hash).toMatch(/^#page-profile\//);
    expect(nav.currentRouteArg()).toBe("link/riot/q/1000/4");
  });

  it("offers to link the Riot ID from a custom tournament card", async () => {
    nav.goToPage("page-compete");
    document.querySelector('#compete-seg [data-seg="custom"]').click();
    await tick(30);
    const card = document.querySelector('[data-tid="0b7c3a52-6c1e-4b1e-9d0a-3f7a1c2b4d5e"]');
    expect(card.querySelector("[data-join]")).toBeNull();
    expect(card.querySelector("[data-link]").textContent).toBe("Link Riot ID to join");
    card.querySelector("[data-link]").click();
    expect(nav.currentRouteArg()).toBe("link/riot/t/0b7c3a52-6c1e-4b1e-9d0a-3f7a1c2b4d5e");
  });

  it("offers exactly the missing rcoin when the balance is short", async () => {
    riotRows = [{ network: "riot", handle: "Me#NA1", verified_at: null }];
    await profile.loadGameAccounts();
    nav.goToPage("page-compete");
    document.querySelector('#compete-seg [data-seg="custom"]').click();
    await tick(30);
    const card = document.querySelector('[data-tid="t2"]');
    expect(card.querySelector("[data-topup]").getAttribute("data-topup")).toBe("3000");
    expect(card.textContent).toContain("You need 50 rcoin, you have 20 rcoin.");
    document.querySelector('#compete-seg [data-seg="play"]').click();
    await tap("5000:8");
    expect(calls.some((c) => c[0] === "rib_quick_join")).toBe(false);
    expect(nav.currentRouteArg()).toBe("buy/3000/q/5000/8");
  });

  it("comes back to the tier and joins it", async () => {
    nav.goToPage("page-compete", { arg: "q/1000/4" });
    await tournaments.loadTournaments();
    await tick(30);
    expect(calls.filter((c) => c[0] === "rib_quick_join").pop()[1]).toEqual({ p_entry_fee_cents: 1000, p_size: 4 });
    // One-shot: the route no longer asks to join.
    expect(nav.currentRouteArg()).toBeNull();
    expect(location.hash).toBe("#page-compete");
  });

  it("refreshes the counts every 20 s while Play is on screen, and stops once it isn't", async () => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    nav.goToPage("page-wallet"); // leaving Play stops the poll started earlier
    vi.useFakeTimers();
    try {
      nav.goToPage("page-compete");
      tournaments.loadTournaments();
      const shown = calls.filter((c) => c[0] === "rib_quick_tiers").length;
      vi.advanceTimersByTime(20000);
      expect(calls.filter((c) => c[0] === "rib_quick_tiers").length).toBe(shown + 1);
      nav.goToPage("page-wallet");
      const before = calls.filter((c) => c[0] === "rib_quick_tiers").length;
      vi.advanceTimersByTime(65000);
      expect(calls.filter((c) => c[0] === "rib_quick_tiers").length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
