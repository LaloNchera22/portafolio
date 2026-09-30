// Hosted-tournament journeys (docs/hosted-tournaments.md): invite links, joining
// by code, the host's dashboard, lobbies and decisions, appeals, small screens.
import { HOSTED_CODE, USER, data, expect, signIn, test } from "./fixtures.js";

const CODE = HOSTED_CODE;
const ORIGIN = "http://127.0.0.1:4173";
const rpcPath = (name) => "/rest/v1/rpc/" + name;
const called = (api, name) => api.calls.filter((c) => c.path === rpcPath(name));

const ALICE = "00000000-0000-0000-0000-0000000000a1";
const BOB = "00000000-0000-0000-0000-0000000000b2";
const CARA = "00000000-0000-0000-0000-0000000000c3";
const HOST = "00000000-0000-0000-0000-0000000000f4";

const HOST_INFO = { hosted_completed: 1, host_strikes: 0, live_limit: 3, paid_allowed: true, max_entry_fee_cents: 2500 };
const dashboard = (tournaments) => ({ host: HOST_INFO, tournaments });

function hosted(over) {
  return Object.assign({
    id: "t-h1", name: "Kraken Cup", status: "open", size: 8, entrants: 5, entry_fee_cents: 1000, visibility: "public",
    invite_code: CODE, open_appeals: 0, rooms: [], created_at: new Date().toISOString(),
  }, over);
}

function room(over) {
  return Object.assign({
    room_id: "r-1", round: 1, slot: 1, status: "setup", player_a: ALICE, player_b: BOB, a_username: "alice", b_username: "bob",
    a_riot_id: "Alice#NA1", b_riot_id: "Bob#NA1", a_report: null, b_report: null, evidence: [], created_at: new Date().toISOString(),
  }, over);
}

/** The tournaments row the player's page reads, and the bracket around the signed-in player. */
function finalPlayed(api, { champion }) {
  const me = USER.id;
  const winnerId = champion ? me : ALICE;
  api.table("tournaments", [{
    id: "t-h1", name: "Kraken Cup", mode: "hosted", visibility: "public", status: "payout_pending", max_players: 4, entrants: 4,
    entry_fee_cents: 1000, payout_at: new Date(Date.now() + 23.5 * 3600e3).toISOString(), creator_id: HOST, winner_id: winnerId,
    rules: null, created_at: new Date().toISOString(),
  }]);
  api.rpc("rib_my_tournaments", [{
    id: "t-h1", name: "Kraken Cup", mode: "hosted", visibility: "public", status: "payout_pending", size: 4, entrants: 4,
    entry_fee_cents: 1000, placement: champion ? 1 : 3, prize_cents: 0, created_at: new Date().toISOString(),
  }]);
  const done = { status: "done", walkover: false };
  api.rpc("rib_tournament_bracket", {
    size: 4, rounds: 2,
    rooms: [
      Object.assign({ room_id: "r-a", round: 1, slot: 1, player_a: me, player_b: ALICE, a_username: "e2e_player", b_username: "alice", winner_id: champion ? me : ALICE }, done),
      Object.assign({ room_id: "r-b", round: 1, slot: 2, player_a: BOB, player_b: CARA, a_username: "bob", b_username: "cara", winner_id: CARA }, done),
      Object.assign({ room_id: "r-f", round: 2, slot: 1, player_a: champion ? me : ALICE, player_b: CARA, a_username: champion ? "e2e_player" : "alice", b_username: "cara", winner_id: winnerId }, done),
    ],
  });
}

test.describe("invite link, signed out", () => {
  test("previews the tournament and keeps the code through sign-in", async ({ page, api }) => {
    await page.goto("/console.html#join/krak-en2x5p");
    const card = page.locator("#join-guest-root .join-card");
    await expect(card).toContainText("Kraken Cup");
    await expect(card).toContainText("hosted by @neo");
    await expect(card.locator(".tcard__pool .v")).toHaveText("10 rcoin");
    await expect(card).toContainText("Winner if it fills (85%)");
    await expect(card.locator(".tprize")).toContainText("68 rcoin");
    await expect(card).toContainText("5/8 players");
    expect(called(api, "rib_tournament_preview")[0].body).toEqual({ p_code: CODE });
    expect(called(api, "rib_tournament_join_by_code")).toHaveLength(0);

    const signInLink = card.getByRole("link", { name: "Sign in to join" });
    await expect(signInLink).toHaveAttribute("href", "login.html");
    // Stay on the page: only the remembered code matters here, not the login page's transition.
    await page.evaluate(() => document.addEventListener("click", (e) => e.preventDefault()));
    await signInLink.click();
    const saved = await page.evaluate(() => JSON.parse(window.localStorage.getItem("rib:pending-join")));
    expect(saved.code).toBe(CODE);

    // After signing in, the console opens the invite instead of Play.
    await signIn(page);
    await page.goto("/console.html");
    await expect(page.locator("#page-join")).toBeVisible();
    await expect(page).toHaveURL(new RegExp("#join/" + CODE + "$"));
    await expect(page.locator("#join-title")).toHaveText("Kraken Cup.");
    await expect(page.locator('#join-root [data-join-code="' + CODE + '"]')).toHaveText("Join · 10 rcoin");
    await expect.poll(() => page.evaluate(() => window.localStorage.getItem("rib:pending-join"))).toBeNull();
  });

  test("an unknown code says so and offers sign-in", async ({ page }) => {
    await page.goto("/console.html#join/ZZZZZZZZZZ");
    await expect(page.locator("#join-guest-root")).toContainText("We couldn't open this invite");
    await expect(page.getByRole("link", { name: "Sign in to join" })).toBeVisible();
  });
});

test.describe("join by code", () => {
  test.beforeEach(async ({ page }) => { await signIn(page); });

  test("confirms, joins with the normalized code and lands on the tournament", async ({ page, api }) => {
    let joined = false;
    const row = { id: "t-h1", name: "Kraken Cup", mode: "hosted", visibility: "public", status: "open", max_players: 8, entrants: 6, entry_fee_cents: 1000, creator_id: HOST, winner_id: null, rules: null, created_at: new Date().toISOString() };
    api.table("tournaments", [row]);
    api.rpc("rib_tournament_join_by_code", () => { joined = true; return data.hosted.joined; });
    api.rpc("rib_my_tournaments", () => (joined ? [{ id: "t-h1", name: "Kraken Cup", mode: "hosted", status: "open", size: 8, entrants: 6, entry_fee_cents: 1000, created_at: row.created_at }] : []));

    await page.goto("/console.html#join/kraken-2x5p");
    await expect(page.locator("#join-title")).toHaveText("Kraken Cup.");
    await expect(page.locator("#join-root")).toContainText("Rules from the host");
    await page.locator("#join-root [data-join-code]").click();
    const dialog = page.locator("#confirm-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Enter Kraken Cup for 10 rcoin?");
    expect(called(api, "rib_tournament_join_by_code")).toHaveLength(0);
    await page.click("#confirm-ok");
    await expect.poll(() => called(api, "rib_tournament_join_by_code")[0]?.body).toEqual({ p_code: CODE });
    await expect(page).toHaveURL(/#page-event\/t-h1$/);
    await expect(page.locator("#event-title")).toHaveText("Kraken Cup.");
    await expect(page.locator("#event-state")).toContainText("You're in");
  });

  test("cancelling the dialog joins nothing", async ({ page, api }) => {
    await page.goto("/console.html#join/" + CODE);
    await page.locator("#join-root [data-join-code]").click();
    await expect(page.locator("#confirm-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#confirm-dialog")).toBeHidden();
    expect(called(api, "rib_tournament_join_by_code")).toHaveLength(0);
    await expect(page).toHaveURL(new RegExp("#join/" + CODE + "$"));
  });

  test("a code that doesn't exist offers the code box again", async ({ page }) => {
    await page.goto("/console.html#join/ZZZZZZZZZZ");
    await expect(page.locator("#join-root")).toContainText("We couldn't open this invite");
    await expect(page.locator("#join-code-input")).toHaveValue("ZZZZZ-ZZZZZ");
  });
});

test.describe("host dashboard", () => {
  test.beforeEach(async ({ page }) => { await signIn(page); });

  test("lists hosted tournaments with a copyable share link", async ({ page, api, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    api.rpc("rib_host_dashboard", dashboard([
      hosted(),
      hosted({ id: "t-h2", name: "Night Ladder", status: "active", entrants: 8, invite_code: "PQRSTUV234", rooms: [room()] }),
    ]));
    await page.goto("/console.html#page-hosting");
    const cards = page.locator("#hosting-root .hcard");
    await expect(cards).toHaveCount(2);
    const open = page.locator('#hosting-root [data-host="t-h1"]');
    await expect(open).toContainText("Kraken Cup");
    await expect(open).toContainText("5/8 players");
    const active = page.locator('#hosting-root [data-host="t-h2"]');
    await expect(active).toContainText("1 match needs you");
    await expect(active.getByRole("button", { name: "Copy link" })).toHaveCount(0);

    await open.getByRole("button", { name: "Manage" }).click();
    await expect(page).toHaveURL(/#page-hosting\/t-h1$/);
    await expect(page.locator("#host-share-url")).toHaveText(ORIGIN + "/console.html#join/" + CODE);
    await expect(page.locator("#host-share .share__code strong")).toHaveText("KRAKE-N2X5P");
    await page.locator("#host-share [data-copy-link]").click();
    await expect(page.locator("#host-share [data-copy-link]")).toHaveText("Copied");
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(ORIGIN + "/console.html#join/" + CODE);
  });

  test("Start now needs an open tournament with at least 4 entrants", async ({ page, api }) => {
    api.rpc("rib_host_dashboard", dashboard([
      hosted({ id: "t-h1", name: "Four Players", entrants: 4 }),
      hosted({ id: "t-h3", name: "Three Players", entrants: 3, invite_code: "ABCDEFGH23" }),
      hosted({ id: "t-h2", name: "Underway", status: "active", entrants: 8, invite_code: null }),
    ]));
    await page.goto("/console.html#page-hosting/t-h3");
    await expect(page.locator("#hosting-title")).toHaveText("Three Players.");
    await expect(page.locator("button[data-start]")).toBeDisabled();
    await expect(page.locator(".hfill")).toContainText("You can start early once 4 players have joined.");

    await page.goto("/console.html#page-hosting/t-h2");
    await expect(page.locator("#hosting-title")).toHaveText("Underway.");
    await expect(page.locator("button[data-start]")).toHaveCount(0);

    await page.goto("/console.html#page-hosting/t-h1");
    await expect(page.locator("#hosting-title")).toHaveText("Four Players.");
    const startNow = page.locator("button[data-start]");
    await expect(startNow).toBeEnabled();
    await startNow.click();
    await expect(page.locator("#confirm-dialog")).toContainText("Start with 4 players?");
    expect(called(api, "rib_host_start")).toHaveLength(0);
    await page.click("#confirm-ok");
    await expect.poll(() => called(api, "rib_host_start")[0]?.body).toEqual({ p_tournament_id: "t-h1" });
  });
});

test.describe("host matches", () => {
  const setup = room({ room_id: "r-setup", round: 1, slot: 1, status: "setup" });
  const live = room({
    room_id: "r-live", round: 1, slot: 2, status: "live", player_a: CARA, player_b: HOST, a_username: "cara", b_username: "dan",
    a_riot_id: "Cara#NA1", b_riot_id: "Dan#NA1", started_at: new Date(Date.now() - 20 * 60e3).toISOString(),
  });

  test.beforeEach(async ({ page, api }) => {
    await signIn(page);
    api.rpc("rib_host_dashboard", dashboard([hosted({ id: "t-h2", name: "Night Ladder", status: "active", size: 4, entrants: 4, invite_code: null, rooms: [setup, live] })]));
    api.rpc("rib_tournament_bracket", { size: 4, rounds: 2, rooms: [setup, live] });
    await page.goto("/console.html#page-hosting/t-h2");
    await expect(page.locator("#hosting-title")).toHaveText("Night Ladder.");
  });

  test("posts the lobby code and password for a room in setup", async ({ page, api }) => {
    const card = page.locator('[data-hroom="r-setup"]');
    await expect(card).toContainText("Post the lobby");
    // The lobby form is validated before anything is sent.
    await card.getByRole("button", { name: "Post lobby" }).click();
    await expect(card.locator("[data-case-msg]")).toContainText("Add the lobby code or a screenshot");
    expect(called(api, "rib_host_room_lobby")).toHaveLength(0);
    await card.getByLabel("Lobby code").fill("  RUN-4821 ");
    await card.getByLabel("Password (optional)").fill("hunter2");
    await card.getByRole("button", { name: "Post lobby" }).click();
    await expect.poll(() => called(api, "rib_host_room_lobby")[0]?.body).toEqual({
      p_room_id: "r-setup", p_lobby_code: "RUN-4821", p_lobby_password: "hunter2", p_image_path: null,
    });
  });

  test("picks the winner of a live room", async ({ page, api }) => {
    const card = page.locator('[data-hroom="r-live"]');
    await expect(card).toContainText("Pick the winner");
    await card.getByRole("button", { name: "@cara won" }).click();
    await expect(page.locator("#confirm-dialog")).toContainText("Decide: @cara won?");
    expect(called(api, "rib_host_decide")).toHaveLength(0);
    await page.click("#confirm-ok");
    await expect.poll(() => called(api, "rib_host_decide")[0]?.body).toEqual({
      p_room_id: "r-live", p_winner_id: CARA, p_walkover: false, p_note: null,
    });
  });

  test("a walkover needs a note", async ({ page, api }) => {
    const card = page.locator('[data-hroom="r-setup"]');
    await card.locator("summary", { hasText: "Someone didn't show up?" }).click();
    await card.getByRole("button", { name: "Walkover to @alice" }).click();
    await expect(card.locator("[data-case-msg]")).toContainText("Add a note");
    await expect(page.locator("#confirm-dialog")).toBeHidden();
    expect(called(api, "rib_host_decide")).toHaveLength(0);

    await card.locator("[data-note]").fill("bob never joined the lobby");
    await card.getByRole("button", { name: "Walkover to @alice" }).click();
    await expect(page.locator("#confirm-dialog")).toContainText("Walkover to @alice?");
    await page.click("#confirm-ok");
    await expect.poll(() => called(api, "rib_host_decide")[0]?.body).toEqual({
      p_room_id: "r-setup", p_winner_id: ALICE, p_walkover: true, p_note: "bob never joined the lobby",
    });
  });
});

test.describe("appeal window", () => {
  test.beforeEach(async ({ page }) => { await signIn(page); });

  test("an entrant who didn't win can appeal with a reason", async ({ page, api }) => {
    finalPlayed(api, { champion: false });
    await page.goto("/console.html#page-event/t-h1");
    const state = page.locator("#event-state");
    await expect(state).toContainText("Final played");
    await expect(state.locator("[data-until]")).toHaveText(/^\d+ h \d{2} min$/);
    await state.getByRole("button", { name: "Appeal the result" }).click();

    const form = page.locator("#event-appeal");
    await expect(form).toBeVisible();
    await expect(form).toContainText("holds a deposit of 1 rcoin");
    await form.getByRole("button", { name: /^Appeal · hold 1 rcoin$/ }).click();
    await expect(page.locator("#event-msg")).toContainText("Explain what went wrong");
    expect(called(api, "rib_tournament_appeal")).toHaveLength(0);

    const reason = "The host picked alice but my end screen shows I won.";
    await page.fill("#event-appeal-reason", reason);
    await form.getByRole("button", { name: /^Appeal · hold 1 rcoin$/ }).click();
    await expect(page.locator("#confirm-dialog")).toContainText("Appeal and hold 1 rcoin?");
    await page.click("#confirm-ok");
    await expect.poll(() => called(api, "rib_tournament_appeal")[0]?.body).toEqual({
      p_tournament_id: "t-h1", p_reason: reason, p_room_id: null,
    });
  });

  test("the champion has nothing to appeal", async ({ page, api }) => {
    finalPlayed(api, { champion: true });
    await page.goto("/console.html#page-event/t-h1");
    await expect(page.locator("#event-state")).toContainText("You're the champion.");
    await expect(page.locator("#event-state [data-until]")).toHaveText(/^\d+ h \d{2} min$/);
    await expect(page.locator("[data-ev-appeal]")).toHaveCount(0);
    await expect(page.locator("#event-appeal")).toHaveCount(0);
  });

  test("My tournaments shows the hosted row in the appeal window", async ({ page, api }) => {
    finalPlayed(api, { champion: false });
    await page.goto("/console.html#page-compete");
    await page.click('#compete-seg [data-seg="mine"]');
    const row = page.locator("#tournament-mine .row--tmine");
    await expect(row).toContainText("Kraken Cup");
    await expect(row).toContainText("Final played");
    await expect(row).toContainText("Prizes are paid when the appeal window closes");
    await row.getByRole("button", { name: "View" }).click();
    await expect(page).toHaveURL(/#page-event\/t-h1$/);
    await expect(page.locator("#event-state")).toContainText("Final played");
  });
});

test.describe("small screens", () => {
  test("no hosted page scrolls sideways at 320px", async ({ page, api }) => {
    await signIn(page);
    finalPlayed(api, { champion: false });
    const tournaments = [
      hosted({ id: "t-h2", name: "A tournament with a rather long name that has to wrap on a phone", status: "active", size: 4, entrants: 4, rooms: [room({ room_id: "r-setup" }), room({ room_id: "r-live", status: "live", slot: 2, a_report: ALICE })] }),
      hosted({ id: "t-h1" }),
    ];
    api.rpc("rib_host_dashboard", dashboard(tournaments));
    await page.setViewportSize({ width: 320, height: 640 });
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const pages = [
      ["#page-hosting", "#hosting-root .hcard"],
      ["#page-hosting/t-h2", '[data-hroom="r-live"]'],
      ["#page-hosting/t-h1", "#host-share"],
      ["#join/" + CODE, "#join-root .join-card"],
      ["#page-event/t-h1", "#event-state [data-until]"],
    ];
    for (const [hash, ready] of pages) {
      await page.goto("/console.html" + hash);
      await expect(page.locator(ready).first(), hash).toBeVisible();
      expect(await overflow(), hash).toBeLessThanOrEqual(0);
    }
  });

  test("the signed-out invite fits a 320px phone", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto("/console.html#join/" + CODE);
    await expect(page.locator("#join-guest-root .join-card")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });
});
