// @vitest-environment jsdom
// Hosted tournaments in the console: the match room waits for the host's
// lobby, shows the lobby card and marks the host in the chat; a finished room
// drops its channel and messages; an invite link previews and joins by code;
// the Hosting page posts a lobby and decides a match.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

const HTML = readFileSync(resolve(import.meta.dirname, "../../src/console.html"), "utf8");
const tick = () => new Promise((r) => setTimeout(r, 10));

const calls = [];
let roomRow = null;
let messages = [];
let tRow = { id: "t1", mode: "hosted", visibility: "private", creator_id: "h1", status: "active", entry_fee_cents: 1000, max_players: 4, entrants: 4, name: "Host Cup" };
const tables = () => ({
  match_rooms: [roomRow],
  room_messages: messages,
  room_evidence: [],
  tournaments: [tRow],
  profiles: [{ id: "h1", username: "boss" }],
  game_accounts: [{ network: "riot", handle: "Me#NA1" }],
});
function query(table) {
  let single = false;
  const builder = new Proxy({}, {
    get(_, prop) {
      if (prop === "then") {
        const rows = tables()[table] || [];
        return (res, rej) => Promise.resolve({ data: single ? rows[0] || null : rows, error: null }).then(res, rej);
      }
      if (prop === "single") return () => { single = true; return builder; };
      return () => builder;
    },
  });
  return builder;
}
const channels = { open: 0, removed: 0 };
const realtime = {};
const dashboard = {
  host: { hosted_completed: 0, host_strikes: 0, paid_allowed: true, max_entry_fee_cents: 2500 },
  tournaments: [{
    id: "t1", name: "Host Cup", status: "active", visibility: "private", invite_code: "ABCDEFGH23", size: 4, entrants: 4, entry_fee_cents: 1000,
    open_appeals: 0,
    rooms_needing_action: [
      { room_id: "r1", round: 1, slot: 0, status: "setup", player_a: "u1", player_b: "u2", a_username: "me", b_username: "rival", evidence: [] },
      { room_id: "r2", round: 1, slot: 1, status: "live", player_a: "u3", player_b: "u4", a_username: "neo", b_username: "tri", a_report: "u3", evidence: [] },
    ],
  }],
};
const rpcData = {
  rib_room_info: () => [{ a_username: "me", b_username: "rival", tournament_name: "Host Cup", entry_fee_cents: 1000, tournament_size: 4, rounds: 2, mode: "hosted", host_username: "boss", is_host: false }],
  rib_tournament_preview: () => ({ id: "t1", name: "Host Cup", host_username: "boss", mode: "hosted", visibility: "private", status: "open", size: 8, entrants: 3, entry_fee_cents: 0, rules: "Bo1", is_host: false, joined: false }),
  rib_tournament_join_by_code: () => ({ id: "t1", status: "open" }),
  rib_host_dashboard: () => dashboard,
  rib_tournament_bracket: () => ({ size: 4, rounds: 2, rooms: [] }),
};
const client = {
  from: (table) => query(table),
  rpc: (name, args) => { calls.push([name, args]); return Promise.resolve({ data: rpcData[name] ? rpcData[name]() : {}, error: null }); },
  channel: () => {
    channels.open++;
    return { on(type, filter, handler) { realtime[filter.event + ":" + filter.table] = handler; return this; }, subscribe() { return this; } };
  },
  removeChannel: () => { channels.removed++; },
  storage: { from: () => ({ createSignedUrl: () => Promise.resolve({ data: { signedUrl: "blob:lobby" } }), createSignedUrls: () => Promise.resolve({ data: [] }) }) },
  functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
};
const $ = (id) => document.getElementById(id);
const lastCall = (name) => calls.filter((c) => c[0] === name).pop();

let room, nav, join, hosting, event;
beforeAll(async () => {
  document.documentElement.innerHTML = HTML.replace(/^[\s\S]*?<html[^>]*>/i, "").replace(/<\/html>\s*$/i, "");
  window.scrollTo = () => {};
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const ctx = await import("../../src/scripts/console/context.js");
  nav = await import("../../src/scripts/console/navigation.js");
  room = await import("../../src/scripts/console/room.js");
  join = await import("../../src/scripts/console/join.js");
  hosting = await import("../../src/scripts/console/hosting.js");
  event = await import("../../src/scripts/console/event.js");
  ctx.initContext(client, "u1");
  nav.initNavigation({ "page-room": room.loadRoom, "page-join": () => join.loadJoin(nav.currentRouteArg()), "page-hosting": () => hosting.loadHosting(nav.currentRouteArg()), "page-event": () => event.loadEvent(nav.currentRouteArg()) });
  room.initRoom();
  hosting.initHosting();
  event.initEvent();
});

const base = (extra) => Object.assign({
  id: "r1", kind: "tournament", tournament_id: "t1", round: 1, slot: 0, network: "riot", player_a: "u1", player_b: "u2",
  status: "setup", room_code: "RB-1", lobby_name: null, lobby_password: null, a_report: null, b_report: null, winner_id: null, walkover: false,
}, extra);

async function show(row) {
  roomRow = row;
  room.openRoom("r1");
  await room.loadRoom();
  await tick();
}

describe("hosted match room", () => {
  it("waits for the host to post the lobby, with the host's steps", async () => {
    messages = [];
    await show(base());
    expect($("room-state").textContent).toContain("Waiting for the host to post the lobby");
    expect($("room-steps").textContent).toContain("Host decides");
    expect($("room-context").textContent).toContain("hosted by @boss");
    expect($("room-chat-form").hidden).toBe(false);
  });

  it("shows the host's lobby card with a copy button and marks the host in the chat", async () => {
    messages = [
      { id: 1, user_id: "h1", body: "Lobby code: OLD · Password: stale", kind: "lobby", image_path: "r1/0b7c3a52-6c1e-4b1e-9d0a-3f7a1c2b4d5e.png", created_at: new Date().toISOString() },
      { id: 2, user_id: "u2", body: "joining", kind: "chat", created_at: new Date().toISOString() },
    ];
    await show(base({ status: "live", lobby_name: "48213", lobby_password: "frog" }));
    const lobby = $("room-lobby");
    expect(lobby.textContent).toContain("48213");
    expect(lobby.querySelector('[data-copy="48213"]')).not.toBeNull();
    expect(lobby.querySelector('[data-copy="frog"]')).not.toBeNull();
    // The room row wins over an older lobby message.
    expect(lobby.textContent).not.toContain("OLD");
    await tick();
    expect(lobby.querySelector("img").getAttribute("src")).toBe("blob:lobby");
    const host = $("room-chat").querySelector("li.is-host");
    expect(host.textContent).toContain("Host");
    expect($("room-state").textContent).toContain("the host decides");
  });

  it("reports a win as advice for the host, with no confirm or dispute buttons", async () => {
    await show(base({ status: "live" }));
    expect($("room-state").querySelector('[data-act="dispute-open"]')).toBeNull();
    $("room-root").querySelector('[data-act="won"]').click();
    await tick();
    expect(lastCall("rib_room_report")[1]).toEqual({ p_room_id: "r1", p_winner_id: "u1" });
  });

  it("drops the chat and its channel when the room ends", async () => {
    await show(base({ status: "live" }));
    const removed = channels.removed;
    realtime["UPDATE:match_rooms"]({ new: { status: "done", winner_id: "u1" } });
    expect(channels.removed).toBe(removed + 1);
    expect($("room-chat").textContent).toContain("chat is closed");
    expect($("room-state").textContent).toContain("You won.");
  });

  it("keeps at most 200 messages", async () => {
    messages = [];
    await show(base({ status: "live" }));
    for (let i = 1; i <= 205; i++) realtime["INSERT:room_messages"]({ new: { id: 1000 + i, user_id: "u2", body: "m" + i, kind: "chat" } });
    expect($("room-chat").querySelectorAll("li")).toHaveLength(200);
    expect($("room-chat").textContent).not.toContain("m5m");
  });

  it("leaves no channel open after leaving the page", () => {
    nav.goToPage("page-wallet");
    expect(channels.open - channels.removed).toBe(0);
  });
});

describe("invite link", () => {
  it("previews by code and joins with rib_tournament_join_by_code", async () => {
    nav.goToPage("page-join", { arg: "abcde-fgh23" });
    await tick();
    await tick();
    expect(location.hash).toBe("#join/abcde-fgh23");
    expect(lastCall("rib_tournament_preview")[1]).toEqual({ p_code: "ABCDEFGH23" });
    const root = $("join-root");
    expect(root.textContent).toContain("hosted by @boss");
    expect(root.textContent).toContain("Private");
    expect(root.querySelector(".seats").getAttribute("aria-label")).toBe("3 of 8 seats taken");
    root.querySelector("[data-join-code]").click();
    await tick();
    await tick();
    expect(lastCall("rib_tournament_join_by_code")[1]).toEqual({ p_code: "ABCDEFGH23" });
    expect(location.hash).toBe("#page-event/t1");
  });
});

describe("Hosting page", () => {
  it("puts the matches that need the host on top and posts a lobby", async () => {
    nav.goToPage("page-hosting", { arg: "t1" });
    await tick();
    await tick();
    const root = $("hosting-root");
    const cases = root.querySelectorAll("[data-hroom]");
    expect(cases).toHaveLength(2);
    expect(cases[0].textContent).toContain("Post the lobby");
    expect(document.querySelector("[data-host-badge]").textContent).toBe("2");
    const form = cases[0].querySelector("[data-lobby-form]");
    form.elements.code.value = "48213";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();
    expect(lastCall("rib_host_room_lobby")[1]).toEqual({ p_room_id: "r1", p_lobby_code: "48213", p_lobby_password: null, p_image_path: null });
  });

  it("shows the reports and decides a live match", async () => {
    await tick();
    const live = $("hosting-root").querySelector('[data-hroom="r2"]');
    expect(live.textContent).toContain("@neo says @neo won");
    live.querySelector('[data-winner="u3"]').click();
    await tick();
    expect(lastCall("rib_host_decide")[1]).toEqual({ p_room_id: "r2", p_winner_id: "u3", p_walkover: false, p_note: null });
  });

  it("refuses a lobby screenshot that isn't an image", async () => {
    await tick();
    const card = $("hosting-root").querySelector('[data-hroom="r1"]');
    const form = card.querySelector("[data-lobby-form]");
    Object.defineProperty(form.elements.image, "files", { value: [new File(["x"], "x.gif", { type: "image/gif" })], configurable: true });
    const before = calls.length;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(calls.length).toBe(before);
    expect(card.querySelector("[data-case-msg]").textContent).toContain("PNG, JPEG or WebP");
  });
});

describe("Hosting page while the host is typing", () => {
  it("asks for a note before a walkover", async () => {
    nav.goToPage("page-hosting", { arg: "t1" });
    await tick();
    await tick();
    const card = $("hosting-root").querySelector('[data-hroom="r1"]');
    const before = calls.filter((c) => c[0] === "rib_host_decide").length;
    card.querySelector('[data-walkover="u1"]').click();
    await tick();
    expect(calls.filter((c) => c[0] === "rib_host_decide").length).toBe(before);
    expect(card.querySelector("[data-case-msg]").textContent).toContain("at least 3 characters");
  });

  it("holds a Realtime refresh until the host is done typing, then applies it", async () => {
    const input = $("hosting-root").querySelector('[data-hroom="r2"] [data-note]');
    input.focus();
    input.value = "end screen shows neo";
    const details = $("hosting-root").querySelector('[data-hroom="r2"] details');
    details.open = true;
    realtime["*:match_rooms"]({ new: { id: "r2" } });
    await new Promise((r) => setTimeout(r, 500));
    // Same node, same text: nothing was wiped.
    expect($("hosting-root").querySelector('[data-hroom="r2"] [data-note]')).toBe(input);
    input.blur();
    await tick();
    const again = $("hosting-root").querySelector('[data-hroom="r2"] [data-note]');
    expect(again).not.toBe(input);
    expect(again.value).toBe("end screen shows neo");
    expect($("hosting-root").querySelector('[data-hroom="r2"] details').open).toBe(true);
  });

  it("offers Start and Cancel only while registration is open", async () => {
    dashboard.tournaments[0].status = "open";
    dashboard.tournaments[0].entrants = 5;
    dashboard.tournaments[0].size = 8;
    nav.goToPage("page-wallet");
    nav.goToPage("page-hosting", { arg: "t1" });
    await tick();
    await tick();
    expect($("hosting-root").querySelector("[data-start]")).not.toBeNull();
    // Built from this page's own URL, like the invite links on Play.
    expect($("hosting-root").querySelector("#host-share-url").textContent).toBe(location.origin + location.pathname + "#join/ABCDEFGH23");
    dashboard.tournaments[0].status = "full";
    nav.goToPage("page-wallet");
    nav.goToPage("page-hosting", { arg: "t1" });
    await tick();
    await tick();
    expect($("hosting-root").querySelector("[data-start]")).toBeNull();
    expect($("hosting-root").querySelector("[data-cancel]")).toBeNull();
    dashboard.tournaments[0].status = "active";
  });
});

describe("tournament page: appeals", () => {
  const future = () => new Date(Date.now() + 3600e3).toISOString();
  async function open() {
    nav.goToPage("page-wallet");
    nav.goToPage("page-event", { arg: "t1" });
    await tick();
    await tick();
    await tick();
  }

  it("lets an entrant appeal during the window, with the deposit", async () => {
    rpcData.rib_my_tournaments = () => [{ id: "t1", status: "payout_pending" }];
    tRow = Object.assign({}, tRow, { status: "payout_pending", winner_id: "u9", payout_at: future() });
    await open();
    expect($("event-root").querySelector("[data-ev-appeal]")).not.toBeNull();
    expect($("event-appeal-note").textContent).toContain("deposit of 1 rcoin");
  });

  it("still allows appeals while another is in review, until payout_at", async () => {
    tRow = Object.assign({}, tRow, { status: "disputed", winner_id: "u9", payout_at: future() });
    await open();
    expect($("event-root").querySelector("[data-ev-appeal]")).not.toBeNull();
  });

  it("hides Appeal from the champion", async () => {
    tRow = Object.assign({}, tRow, { status: "payout_pending", winner_id: "u1", payout_at: future() });
    await open();
    expect($("event-state").textContent).toContain("You're the champion.");
    expect($("event-root").querySelector("[data-ev-appeal]")).toBeNull();
  });

  it("drops a read that lands after the page closed", async () => {
    nav.goToPage("page-event", { arg: "t1" });
    const html = $("event-root").innerHTML;
    nav.goToPage("page-wallet");
    tRow = Object.assign({}, tRow, { name: "Renamed Cup" });
    await tick();
    await tick();
    expect($("event-root").innerHTML).toBe(html);
  });
});
