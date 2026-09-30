// @vitest-environment jsdom
// Match room: renders each state of a Wild Rift bracket match from the room
// row, sends the right RPC for every action, and runs
// the end-screen check: upload → rib_room_evidence_add → verify-result, with
// the check status shown per screenshot from the response and Realtime. A
// screenshot never settles a match: a verified one only fast-tracks the
// confirm window to 3 minutes.
import { createHash } from "node:crypto";
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

const selects = {}; // table -> the columns the room asked for
let evidenceRows = []; // what a re-read of room_evidence returns
function query(table) {
  let single = false;
  const builder = new Proxy({}, {
    get(_, prop) {
      if (prop === "then") {
        const data = table === "match_rooms" ? (single ? roomRow : [roomRow]) : table === "room_evidence" ? evidenceRows : single ? null : [];
        return (res, rej) => Promise.resolve({ data, error: null }).then(res, rej);
      }
      if (prop === "single") return () => { single = true; return builder; };
      if (prop === "select") return (cols) => { selects[table] = cols; return builder; };
      return () => builder;
    },
  });
  return builder;
}
// End-screen check doubles.
let evidenceAdd = null;   // (args) => reply of rib_room_evidence_add
let verifyReply = null;   // reply of verify-result
let onVerify = null;      // side effect when verify-result runs (e.g. the room settles)
const invoked = [];
const storage = { uploads: [], removed: [] };
const realtime = {};      // "<event>:<table>" -> handler

const client = {
  from: (table) => query(table),
  rpc: (name, args) => {
    calls.push([name, args]);
    if (name === "rib_room_info") return Promise.resolve({ data: [info], error: null });
    if (failNext === name) { failNext = null; return Promise.resolve({ data: null, error: { message: "x", hint: "ready_expired" } }); }
    if (name === "rib_room_evidence_token") return Promise.resolve({ data: [{ token: "TK1", room_code: "RB-7K2QX", issued_at: new Date().toISOString() }], error: null });
    if (name === "rib_room_evidence_add") return Promise.resolve(evidenceAdd(args));
    return Promise.resolve({ data: {}, error: null });
  },
  functions: {
    invoke: (name, opts) => {
      invoked.push([name, opts.body]);
      if (onVerify) onVerify();
      return Promise.resolve(verifyReply);
    },
  },
  channel: () => ({
    on(type, filter, handler) { realtime[filter.event + ":" + filter.table] = handler; return this; },
    subscribe() { return this; },
  }),
  removeChannel: () => {},
  storage: {
    from: () => ({
      createSignedUrls: () => Promise.resolve({ data: [] }),
      upload: (path) => { storage.uploads.push(path); return Promise.resolve({ error: null }); },
      remove: (paths) => { storage.removed.push(...paths); return Promise.resolve({ error: null }); },
    }),
  },
};
const $ = (id) => document.getElementById(id);
const lastCall = (name) => calls.filter((c) => c[0] === name).pop();

let room;
beforeAll(async () => {
  document.documentElement.innerHTML = HTML.replace(/^[\s\S]*?<html[^>]*>/i, "").replace(/<\/html>\s*$/i, "");
  window.scrollTo = () => {};
  vi.spyOn(window, "confirm").mockReturnValue(true);
  // No real canvas or image decoding in jsdom: stamp onto a stub.
  HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {}, fillRect() {}, fillText() {} });
  HTMLCanvasElement.prototype.toBlob = function (cb) { cb(new Blob(["stamped"], { type: "image/jpeg" })); };
  window.Image = class {
    constructor() { this.naturalWidth = 2400; this.naturalHeight = 1080; }
    set src(v) { setTimeout(() => this.onload && this.onload(), 0); }
  };
  URL.createObjectURL = () => "blob:end-screen";
  URL.revokeObjectURL = () => {};
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
    expect($("room-root").textContent).toContain("Friday Cup · Semifinals · 10 rcoin entry");
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
    expect($("room-dispute").textContent).toContain("holds a deposit of 1 rcoin");
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

  it("explains who reviews a dispute in a free tournament, with no deposit", async () => {
    info = Object.assign(info, { entry_fee_cents: 0 });
    await show(baseRoom({ status: "live", started_at: soon(), b_report: "u2", confirm_deadline: soon() }));
    expect($("room-root").textContent).toContain("Friday Cup · Semifinals · free");
    $("room-root").querySelector('[data-act="dispute-open"]').click();
    expect($("room-dispute").textContent).toContain("The Runinback team reviews disputed matches.");
    expect($("room-dispute").textContent).not.toContain("deposit");
    expect($("room-root").textContent).not.toMatch(/friendly/i);
  });

  it("colors the state card by what the player has to do, and keeps the clock out of the live region", async () => {
    await show(baseRoom());
    expect($("room-state").getAttribute("data-tone")).toBe("act");
    expect($("room-state").hasAttribute("aria-live")).toBe(false);
    expect($("room-state").querySelector(".room-clock__t").getAttribute("role")).toBe("timer");
    await show(baseRoom({ status: "live", started_at: soon(), b_report: "u2", confirm_deadline: soon() }));
    expect($("room-state").getAttribute("data-tone")).toBe("respond");
    await show(baseRoom({ status: "disputed", started_at: soon(), a_report: "u1", b_report: "u2", disputed_by: "u2" }));
    expect($("room-state").getAttribute("data-tone")).toBe("review");
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

  it("tells the host to create the custom game and invite the opponent's Riot ID", async () => {
    await show(baseRoom());
    const how = $("room-lobby").textContent;
    expect(how).toContain("You host.");
    expect(how).toContain("invite Rival#NA1");
    expect($("room-lobby").querySelector('[data-copy="Rival#NA1"]')).not.toBeNull();
  });

  it("tells the guest to accept the host's invite", async () => {
    await show(baseRoom({ player_a: "u2", player_b: "u1" }));
    expect($("room-lobby").textContent).toContain("hosts. They create the custom game and invite your Riot ID");
  });
});

describe("end screen", () => {
  const reported = () => baseRoom({ status: "live", a_ready_at: soon(), b_ready_at: soon(), started_at: soon(), a_report: "u1", confirm_deadline: soon() });
  const upload = async () => {
    const input = $("room-upload");
    const file = new File(["the end screen"], "end.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    for (let i = 0; i < 6; i++) await tick();
  };

  beforeEach(() => {
    evidenceRows = [];
    evidenceAdd = (args) => {
      const row = { id: 55, room_id: "r1", user_id: "u1", storage_path: args.p_path, source: args.p_source, created_at: new Date().toISOString(), check_status: "pending" };
      evidenceRows = [row];
      return { data: row, error: null };
    };
    verifyReply = { data: { status: "verified", settled: false, fast_tracked: false }, error: null };
    onVerify = null;
  });

  it("makes uploading the end screen the next step after reporting", async () => {
    await show(reported());
    const primary = $("room-state").querySelector(".btn--cta");
    expect(primary.textContent).toBe("Upload the end screen");
    expect(primary.getAttribute("data-act")).toBe("upload");
  });

  it("keeps uploading secondary in other states, as evidence for a dispute", async () => {
    await show(baseRoom({ status: "live", started_at: soon(), b_report: "u2", confirm_deadline: soon() }));
    expect($("room-state").querySelector('.btn--cta[data-act="upload"]')).toBeNull();
    expect($("room-evidence").querySelector('[data-act="upload"]')).not.toBeNull();
    await show(baseRoom({ status: "disputed", started_at: soon(), a_report: "u1", b_report: "u2", disputed_by: "u2" }));
    const up = $("room-state").querySelector('[data-act="upload"]');
    expect(up.classList.contains("btn--cta")).toBe(false);
  });

  it("reads only the evidence columns players may see", async () => {
    await show(reported());
    const cols = selects.room_evidence.split(",").map((c) => c.trim());
    expect(cols.sort()).toEqual(["check_status", "checked_at", "created_at", "id", "room_id", "source", "storage_path", "user_id"]);
  });

  it("uploads it, checks it right away and fast-tracks the confirm window when verified", async () => {
    await show(reported());
    const fast = new Date(Date.now() + 3 * 60 * 1000).toISOString();
    verifyReply = { data: { status: "verified", settled: false, fast_tracked: true }, error: null };
    onVerify = () => {
      roomRow = Object.assign(reported(), { confirm_deadline: fast, fast_tracked: true });
      evidenceRows = evidenceRows.map((e) => Object.assign({}, e, { check_status: "verified" }));
    };
    await upload();
    const add = lastCall("rib_room_evidence_add")[1];
    expect(add).toMatchObject({ p_room_id: "r1", p_token: "TK1", p_source: "camera", p_path: "r1/u1/TK1.jpg" });
    // Fingerprint of the original file, so a reused screenshot is caught.
    expect(add.p_sha256).toBe(createHash("sha256").update("the end screen").digest("hex"));
    expect(storage.uploads.pop()).toBe("r1/u1/TK1.jpg");
    expect(invoked.pop()).toEqual(["verify-result", { evidence_id: 55 }]);
    expect($("room-evidence-list").querySelector('[data-ev="55"] .chip').textContent).toBe("Verified");
    expect($("room-msg").textContent).toBe("Verified. The result confirms in 3 minutes unless your opponent disputes it.");
    // Not settled: still waiting, on the shorter clock.
    expect($("room-state").textContent).toContain("Waiting for @rival");
    expect($("room-state").textContent).toContain("Your end screen was verified");
    const clock = $("room-state").querySelector(".room-clock");
    expect(clock.getAttribute("data-deadline")).toBe(fast);
    expect(clock.getAttribute("data-total")).toBe("180");
  });

  it("shows Checking… until the answer; a contradiction leaves the room as it is", async () => {
    await show(reported());
    let answer;
    client.functions.invoke = (name, opts) => { invoked.push([name, opts.body]); return new Promise((r) => { answer = r; }); };
    evidenceAdd = () => ({ data: 77, error: null }); // a bare id works too
    await upload();
    expect(invoked.pop()).toEqual(["verify-result", { evidence_id: 77 }]);
    const chip = () => $("room-evidence-list").querySelector('[data-ev="77"] .chip').textContent;
    expect(chip()).toBe("Checking…");
    realtime["UPDATE:room_evidence"]({ new: { id: 77, check_status: "contradicts" } });
    expect(chip()).toBe("Doesn't match");
    const reads = calls.filter((c) => c[0] === "rib_room_info").length;
    answer({ data: { status: "contradicts", settled: false, fast_tracked: false }, error: null });
    await tick();
    expect($("room-msg").textContent).toBe("Doesn't match this match. It stays attached for review.");
    expect(calls.filter((c) => c[0] === "rib_room_info").length).toBe(reads);
    expect($("room-state").textContent).toContain("Waiting for @rival");
  });

  it("says so when the check finds the screenshot in another match", async () => {
    client.functions.invoke = (name, opts) => { invoked.push([name, opts.body]); return Promise.resolve(verifyReply); };
    verifyReply = { data: { status: "duplicate", settled: false, fast_tracked: false }, error: null };
    await show(reported());
    await upload();
    expect($("room-msg").textContent).toBe("This screenshot was already used in another match.");
    expect($("room-evidence-list").querySelector('[data-ev="55"] .chip').textContent).toBe("Used in another match");
  });

  it("refuses a screenshot used in another match and removes the upload", async () => {
    client.functions.invoke = (name, opts) => { invoked.push([name, opts.body]); return Promise.resolve(verifyReply); };
    await show(reported());
    const before = invoked.length;
    evidenceAdd = () => ({ data: null, error: { message: "this screenshot was already used in another match", hint: "evidence_duplicate" } });
    await upload();
    expect($("room-msg").textContent).toBe("That screenshot was already used in another match. Upload the end screen of this one.");
    expect(storage.removed.pop()).toBe("r1/u1/TK1.jpg");
    expect(invoked.length).toBe(before);
  });

  it("keeps the screenshot when the automatic check is unavailable", async () => {
    await show(reported());
    verifyReply = { data: null, error: { message: "500", context: { json: () => Promise.resolve({ error: "server_error" }) } } };
    await upload();
    expect($("room-evidence-list").querySelector('[data-ev="55"] .chip').textContent).toBe("Not checked");
    expect($("room-msg").textContent).toContain("your opponent can still confirm");
  });
});
