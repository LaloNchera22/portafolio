// @vitest-environment jsdom
// Console flows against the real console.html markup with a fake Supabase
// client: Quick Play (tiers, one-tap join, waiting card, straight into the
// room), custom Wild Rift tournaments, brackets, and the ranking page.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

const HTML = readFileSync(resolve(import.meta.dirname, "../../src/console.html"), "utf8");
const tick = () => new Promise((r) => setTimeout(r, 10));

const calls = [];
const tables = {
  wallets: [{ test_balance_cents: 2000, test_locked_cents: 0 }],
  profiles: [{ id: "u2", username: "rival" }],
  game_accounts: [{ network: "riot", handle: "Me#NA1", verified_at: "2026-09-01T00:00:00Z" }],
};
const activeT3 = { id: "t3", name: "Monday Cup", game: "Wild Rift", network: "riot", entry_fee_cents: 500, size: 4, status: "active", entrants: 4, placement: null, winner_username: null, prize_pool_cents: 1800, created_at: new Date().toISOString() };
let myTournaments = [activeT3];
const rpcData = {
  rib_quick_tiers: () => [
    { entry_fee_cents: 1000, size: 4, waiting: 3, open_events: 1 },
    { entry_fee_cents: 0, size: 8, waiting: 0, open_events: 0 },
  ],
  rib_quick_join: () => ({ id: "t9", name: "Wild Rift 4 · 10 rcoin", status: "open", tier_key: "1000:4", entry_fee_cents: 1000, max_players: 4 }),
  rib_open_tournaments: () => [
    { id: "t1", name: "Friday Cup", game: "Wild Rift", network: "riot", entry_fee_cents: 1000, size: 4, entrants: 3, created_at: new Date().toISOString(), creator_username: "neo", joined: false },
    { id: "t2", name: "Free Cup", game: "Wild Rift", network: "riot", entry_fee_cents: 0, size: 8, entrants: 2, created_at: new Date().toISOString(), creator_username: "me", joined: true },
  ],
  rib_my_tournaments: () => myTournaments,
  rib_tournament_bracket: () => [
    { room_id: "r1", round: 1, slot: 0, player_a: "u1", player_b: "u2", a_username: "me", b_username: "rival", status: "ready_check", winner_id: null, walkover: false },
    { room_id: "r2", round: 1, slot: 1, player_a: "u3", player_b: "u4", a_username: "neo", b_username: "trinity", status: "done", winner_id: "u3", walkover: false },
    { room_id: "r3", round: 2, slot: 0, player_a: null, player_b: "u3", a_username: null, b_username: "neo", status: "waiting", winner_id: null, walkover: false },
  ],
  rib_my_rooms: () => [
    { id: "r1", kind: "tournament", game: "Wild Rift", status: "ready_check", round: 1, tournament_id: "t3", tournament_name: "Monday Cup", opponent_username: "rival", ready_deadline: new Date(Date.now() + 600000).toISOString(), confirm_deadline: null },
  ],
  rib_leaderboard: () => [
    { rank: 1, user_id: "u3", username: "neo", net_cents: 12000, won_cents: 20000, wins: 7, losses: 2 },
    { rank: 2, user_id: "u1", username: "me", net_cents: 900, won_cents: 3000, wins: 3, losses: 3 },
    { rank: 4, user_id: "u5", username: "smith", net_cents: -400, won_cents: 0, wins: 0, losses: 2 },
  ],
  rib_my_standing: () => [{ rank: 2, net_cents: 900, won_cents: 3000, wins: 3, losses: 3 }],
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
  rpc: (name, args) => { calls.push([name, args]); return Promise.resolve({ data: rpcData[name] ? rpcData[name]() : {}, error: null }); },
  functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
};

const $ = (id) => document.getElementById(id);
const lastCall = (name) => calls.filter((c) => c[0] === name).pop();
const count = (name) => calls.filter((c) => c[0] === name).length;

let tournaments, nav;
beforeAll(async () => {
  document.documentElement.innerHTML = HTML.replace(/^[\s\S]*?<html[^>]*>/i, "").replace(/<\/html>\s*$/i, "");
  window.scrollTo = () => {};
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const ctx = await import("../../src/scripts/console/context.js");
  nav = await import("../../src/scripts/console/navigation.js");
  tournaments = await import("../../src/scripts/console/tournaments.js");
  const profile = await import("../../src/scripts/console/profile.js");
  const ranking = await import("../../src/scripts/console/leaderboard.js");
  const wallet = await import("../../src/scripts/console/wallet.js");
  const live = await import("../../src/scripts/console/live.js");
  ctx.initContext(client, "u1");
  nav.initNavigation({});
  nav.initAmountChips(() => {});
  profile.initGameAccounts();
  tournaments.initTournaments();
  ranking.initRanking();
  await wallet.refreshWallet();
  await tournaments.loadTournaments();
  await live.refreshLive();
  ranking.loadRanking();
  ranking.loadProfileRecord();
  await tick();
});

describe("Quick Play", () => {
  it("shows every tier (fee × size) with the prize and live waiting counts", () => {
    const tiers = $("play-tiers").querySelectorAll("[data-tier]");
    expect(tiers).toHaveLength(12);
    const ten = $("play-tiers").querySelector('[data-tier="1000:4"]');
    expect(ten.textContent).toContain("10 rcoin");
    expect(ten.textContent).toContain("4 players");
    expect(ten.textContent).toContain("Champion 25.2 rcoin");
    expect(ten.textContent).toContain("3 waiting");
    expect(ten.getAttribute("aria-label")).toBe("10 rcoin entry, 4 players, champion wins 25.2 rcoin, 3 waiting");
    const free = $("play-tiers").querySelector('[data-tier="0:8"]');
    expect(free.textContent).toContain("Free");
    expect(free.textContent).toContain("Start one");
    expect($("play-status").textContent).toBe("3 players waiting");
  });

  it("reuses fresh counts instead of refetching on every visit", async () => {
    const before = count("rib_quick_tiers");
    await tournaments.loadTournaments();
    expect(count("rib_quick_tiers")).toBe(before);
    expect(count("rib_my_tournaments")).toBe(1);
  });

  it("has no game or network field anywhere: Wild Rift and Riot ID are fixed", () => {
    expect($("tournament-game")).toBeNull();
    expect($("tournament-network")).toBeNull();
    expect($("challenge-form")).toBeNull();
    expect($("page-games")).toBeNull();
  });

  it("joins a tier in one tap after confirming the entry fee, then shows the waiting card", async () => {
    window.confirm.mockClear();
    myTournaments = [{ id: "t9", name: "Wild Rift 4 · 10 rcoin", game: "Wild Rift", network: "riot", entry_fee_cents: 1000, size: 4, tier_key: "1000:4", status: "open", entrants: 2, created_at: new Date().toISOString() }, activeT3];
    $("play-tiers").querySelector('[data-tier="1000:4"]').click();
    await tick();
    await tick();
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(lastCall("rib_quick_join")[1]).toEqual({ p_entry_fee_cents: 1000, p_size: 4 });
    const waiting = $("play-waiting");
    expect(waiting.textContent).toContain("Wild Rift 4 · 10 rcoin");
    expect(waiting.textContent).toContain("2/4 players · 2 to go");
    expect(waiting.querySelector(".seats").getAttribute("aria-label")).toBe("2 of 4 seats taken");
    expect(waiting.querySelector('[data-leave="t9"]')).not.toBeNull();
    expect(waiting.querySelector('[data-invite="t9"]')).not.toBeNull();
    // The tier knows I'm in (by its Quick Play name, even without tier_key).
    expect($("play-tiers").querySelector('[data-tier="1000:4"]').textContent).toContain("You're in");
  });

  it("doesn't send a second join for a tier I'm already waiting in", async () => {
    const before = count("rib_quick_join");
    $("play-tiers").querySelector('[data-tier="1000:4"]').click();
    await tick();
    expect(count("rib_quick_join")).toBe(before);
  });

  it("goes straight into the first room when the event fills", async () => {
    document.dispatchEvent(new CustomEvent("rib:live", { detail: [{ id: "r5", tournament_id: "t9", status: "ready_check", round: 1 }] }));
    expect(nav.currentRouteArg()).toBe("r5");
    expect($("page-room").hidden).toBe(false);
    expect($("play-waiting").textContent).toBe("");
    nav.goToPage("page-compete");
  });

  it("leaves from the waiting card for a refund", async () => {
    myTournaments = [{ id: "t8", name: "Wild Rift 8 · Free", game: "Wild Rift", network: "riot", entry_fee_cents: 0, size: 8, tier_key: "0:8", status: "open", entrants: 3, created_at: new Date().toISOString() }];
    // A visit after the cached list went stale reads it again.
    const later = Date.now() + 20000;
    const now = vi.spyOn(Date, "now").mockReturnValue(later);
    await tournaments.loadTournaments();
    now.mockRestore();
    await tick();
    $("play-waiting").querySelector('[data-leave="t8"]').click();
    await tick();
    expect(lastCall("rib_tournament_leave")[1]).toEqual({ p_tournament_id: "t8" });
    myTournaments = [activeT3];
    await tick();
  });
});

describe("custom tournaments", () => {
  it("lists open ones with fill and prizes on the Custom tab", async () => {
    document.querySelector('#compete-seg [data-seg="custom"]').click();
    await tick();
    const list = $("tournament-list");
    expect($("compete-custom").hidden).toBe(false);
    expect(list.querySelectorAll(".tcard")).toHaveLength(2);
    expect(list.textContent).toContain("3/4 players · 1 seat left");
    expect(list.textContent).toContain("Champion 25.2 rcoin · runner-up 10.8 rcoin");
    expect(list.querySelector(".seats").getAttribute("aria-label")).toBe("3 of 4 seats taken");
    expect(list.querySelectorAll('[data-tid="t1"] .seat.is-taken')).toHaveLength(3);
    expect(list.querySelector('[data-leave="t2"]')).not.toBeNull();
    expect(lastCall("rib_open_tournaments")[1]).toMatchObject({ p_game: null });
  });

  it("joins through the tournament RPC", async () => {
    $("tournament-list").querySelector('[data-join="t1"]').click();
    await tick();
    expect(lastCall("rib_tournament_join")[1]).toEqual({ p_tournament_id: "t1" });
  });

  it("previews the hosted split (winner 85%, host 5%, platform 10%) before creating", async () => {
    expect($("tournament-prize").textContent).toContain("Platform (10%)");
    document.querySelector('[data-chips="tournament-size"] [data-amt="8"]').click();
    await new Promise((r) => setTimeout(r, 400)); // the numbers count to their new values
    const text = $("tournament-prize").textContent;
    expect(text).toContain("Prize pool (full)80 rcoin");
    expect(text).toContain("Winner (85%)68 rcoin");
    expect(text).toContain("Host commission (5%)4 rcoin");
    expect(text).toContain("Platform (10%)8 rcoin");
  });

  it("hosts a tournament with the chosen size, fee, visibility and rules", async () => {
    $("tournament-new").click();
    expect($("tournament-form").hidden).toBe(false);
    $("tournament-name").value = "Cup";
    document.querySelector('#tournament-visibility [data-vis="private"]').click();
    $("tournament-rules").value = "Best of 1";
    $("tournament-form").dispatchEvent(new Event("submit", { cancelable: true }));
    await tick();
    await tick();
    expect(lastCall("rib_hosted_create")[1]).toEqual({ p_name: "Cup", p_size: 8, p_entry_fee_cents: 1000, p_visibility: "private", p_rules: "Best of 1" });
    expect($("tournament-form").hidden).toBe(true);
  });

  it("asks for a name and a whole-rcoin fee before calling the server", () => {
    const before = count("rib_hosted_create");
    $("tournament-new").click();
    $("tournament-name").value = "  ";
    $("tournament-form").dispatchEvent(new Event("submit", { cancelable: true }));
    expect(count("rib_hosted_create")).toBe(before);
    expect($("tournament-msg").textContent).toBe("Give the tournament a name.");
    $("tournament-name").value = "Cup";
    $("tournament-fee").value = "2.5";
    $("tournament-form").dispatchEvent(new Event("submit", { cancelable: true }));
    expect(count("rib_hosted_create")).toBe(before);
    expect($("tournament-fee").getAttribute("aria-invalid")).toBe("true");
    $("tournament-fee").value = "10";
  });

  it("opens an invite code typed with a dash, or a pasted link", () => {
    $("invite-code-input").value = "abcde-fgh23";
    $("invite-code-form").dispatchEvent(new Event("submit", { cancelable: true }));
    expect(location.hash).toBe("#join/ABCDEFGH23");
    nav.goToPage("page-compete");
    $("invite-code-input").value = "https://runinback.com/console.html#join/abcdefgh23";
    $("invite-code-form").dispatchEvent(new Event("submit", { cancelable: true }));
    expect(location.hash).toBe("#join/ABCDEFGH23");
    nav.goToPage("page-compete");
    $("invite-code-input").value = "nope";
    $("invite-code-form").dispatchEvent(new Event("submit", { cancelable: true }));
    expect($("invite-code-msg").hidden).toBe(false);
  });
});

describe("my tournaments", () => {
  it("shows the match waiting for me", () => {
    expect($("live-rooms").hidden).toBe(false);
    expect($("live-rooms").textContent).toContain("Monday Cup");
    expect($("live-rooms").querySelector('[data-room="r1"]')).not.toBeNull();
  });

  it("draws my bracket by round with an Open room button on my live match", async () => {
    document.querySelector('#compete-seg [data-seg="mine"]').click();
    await tick();
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
