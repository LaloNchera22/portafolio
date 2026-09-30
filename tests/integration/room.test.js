// @vitest-environment jsdom
// Match room: renders each state of a bracket match or friendly from the
// room row and sends the right RPC for every action.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const HTML = readFileSync(resolve(import.meta.dirname, "../../src/console.html"), "utf8");
const tick = () => new Promise((r) => setTimeout(r, 10));

const calls = [];
let roomRow = null;
let info = null;
let failNext = null; // an RPC name whose next call returns an error

const soon = () => new Date(Date.now() + 10 * 60 * 1000).toISOString();
function baseRoom(extra) {
  return Object.assign({
    id: "r1", kind: "tournament", tournament_id: "t1", round: 1, slot: 0, game: "Valorant", network: "riot",
    player_a: "u1", player_b: "u2", status: "ready_check", room_code: "RB-7K2QX", lobby_name: "Runinback RB-7K2QX",
    lobby_password: "a1b2c3d4", ready_deadline: soon(), a_ready_at: null, b_ready_at: null, started_at: null,
    a_report: null, b_report: null, confirm_deadline: null, winner_id: null, walkover: false,
    disputed_by: null, dispute_deposit_cents: 0, resolution_note: null,
  }, extra);
}

function query(table) {
  let single = false;
  const builder = new Proxy({}, {
    get(_, prop) {
      if (prop === "then") {
        const data = table === "match_rooms" ? (single ? roomRow : [roomRow]) : single ? null : [];
        return (res, rej) => Promise.resolve({ data, error: null }).then(res, rej);
      }
      if (prop === "single") return () => { single = true; return builder; };
      return () => builder;
    },
  });
  return builder;
}
const client = {
  from: (table) => query(table),
  rpc: (name, args) => {
    calls.push([name, args]);
    if (name === "rib_room_info") return Promise.resolve({ data: [info], error: null });
    if (failNext === name) { failNext = null; return Promise.resolve({ data: null, error: { message: "x", hint: "ready_expired" } }); }
    return Promise.resolve({ data: {}, error: null });
  },
  channel: () => ({ on() { return this; }, subscribe() { return this; } }),
  removeChannel: () => {},
  storage: { from: () => ({ createSignedUrls: () => Promise.resolve({ data: [] }) }) },
};
const $ = (id) => document.getElementById(id);
const lastCall = (name) => calls.filter((c) => c[0] === name).pop();

let room;
beforeAll(async () => {
  document.documentElement.innerHTML = HTML.replace(/^[\s\S]*?<html[^>]*>/i, "").replace(/<\/html>\s*$/i, "");
  window.scrollTo = () => {};
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const ctx = await import("../../src/scripts/console/context.js");
  const nav = await import("../../src/scripts/console/navigation.js");
  room = await import("../../src/scripts/console/room.js");
  ctx.initContext(client, "u1");
  nav.initNavigation({ "page-room": room.loadRoom });
  room.initRoom();
});

beforeEach(() => {
  info = {
    a_username: "me", b_username: "rival", a_handle: "Me#NA1", b_handle: "Rival#NA1",
    a_matches: 4, a_disputes_lost: 0, a_no_shows: 0, b_matches: 1, b_disputes_lost: 1, b_no_shows: 2,
    tournament_name: "Friday Cup", entry_fee_cents: 1000, tournament_size: 4, rounds: 2,
  };
});

async function show(row) {
  roomRow = row;
  room.openRoom("r1");
  await room.loadRoom();
  await tick();
}

describe("match room", () => {
  it("keeps an error on screen after the room reloads, and shows the step and the clock", async () => {
    await show(baseRoom());
    expect($("room-steps").querySelector('[aria-current="step"] span').textContent).toBe("Ready");
    expect($("room-state").querySelector(".room-clock")).not.toBeNull();
    failNext = "rib_room_ready";
    $("room-root").querySelector('[data-act="ready"]').click();
    await tick();
    await tick();
    expect($("room-msg").hidden).toBe(false);
    expect($("room-msg").textContent).toContain("ready check");
  });

  it("hands out the lobby details and runs the ready check", async () => {
    await show(baseRoom());
    expect($("room-root").textContent).toContain("Friday Cup · Semifinals · 10 USD entry");
    expect($("room-root").textContent).toContain("RB-7K2QX");
    expect($("room-root").textContent).toContain("a1b2c3d4");
    expect($("room-root").textContent).toContain("Rival#NA1");
    expect($("room-root").textContent).toContain("1 disputes lost · 2 no-shows");
    $("room-root").querySelector('[data-act="ready"]').click();
    await tick();
    expect(lastCall("rib_room_ready")[1]).toEqual({ p_room_id: "r1" });
  });

  it("reports the opponent as the winner on 'I lost', after confirming", async () => {
    await show(baseRoom({ status: "live", a_ready_at: soon(), b_ready_at: soon(), started_at: soon() }));
    window.confirm.mockClear();
    $("room-root").querySelector('[data-act="lost"]').click();
    await tick();
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(lastCall("rib_room_report")[1]).toEqual({ p_room_id: "r1", p_winner_id: "u2" });
  });

  it("offers confirm or a dispute with the deposit when the opponent claims the win", async () => {
    await show(baseRoom({ status: "live", started_at: soon(), b_report: "u2", confirm_deadline: soon() }));
    expect($("room-state").textContent).toContain("@rival reported that they won");
    $("room-root").querySelector('[data-act="dispute-open"]').click();
    expect($("room-dispute").textContent).toContain("holds a deposit of 1 USD");
    const before = calls.length;
    $("room-dispute-reason").value = "too short";
    $("room-dispute").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();
    expect(calls.length).toBe(before);
    $("room-dispute-reason").value = "I won 13-9, the scoreboard is in my capture";
    $("room-dispute").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();
    expect(lastCall("rib_room_dispute")[1]).toEqual({ p_room_id: "r1", p_reason: "I won 13-9, the scoreboard is in my capture" });
  });

  it("explains that a disputed friendly just ends with no result", async () => {
    info = Object.assign(info, { tournament_name: null, entry_fee_cents: null, rounds: null });
    await show(baseRoom({ kind: "friendly", tournament_id: null, status: "live", started_at: soon(), b_report: "u2", confirm_deadline: soon() }));
    expect($("room-root").textContent).toContain("Friendly · free");
    $("room-root").querySelector('[data-act="dispute-open"]').click();
    expect($("room-dispute").textContent).toContain("A disputed friendly ends with no result.");
  });

  it("sends chat messages through the rate-limited RPC", async () => {
    await show(baseRoom());
    $("room-chat-input").value = "lobby is up";
    $("room-chat-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();
    expect(lastCall("rib_room_message")[1]).toEqual({ p_room_id: "r1", p_body: "lobby is up" });
  });

  it("tells the winner of a walkover what happened and closes the chat", async () => {
    await show(baseRoom({ status: "done", winner_id: "u1", walkover: true }));
    expect($("room-state").textContent).toContain("You won.");
    expect($("room-state").textContent).toContain("Your opponent didn't show up.");
    expect($("room-chat-form").hidden).toBe(true);
    expect($("room-steps").querySelector('li:last-child').getAttribute("data-s")).toBe("done");
  });
});
