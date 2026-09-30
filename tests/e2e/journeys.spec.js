// Critical user journeys in a real browser (desktop and mobile projects).
import { expect, signIn, test } from "./fixtures.js";

test("landing states test mode and loads without errors", async ({ page, api }) => {
  await page.goto("/index.html");
  await expect(page.locator(".announce")).toContainText("Test mode");
  await expect(page.locator("#hero-video")).toHaveAttribute("poster", "/media/hero-poster.webp");
  await expect(page.locator("h1")).toBeVisible();
  expect(api.calls.every((c) => !c.path.startsWith("/rest/"))).toBe(true);
});

test("sign-up requires the age confirmation", async ({ page, api }) => {
  await page.goto("/signup.html");
  await page.fill("#signup-username", "new_player");
  await page.fill("#signup-email", "new@example.test");
  await page.fill("#signup-password", "a-strong-password-1");
  await page.fill("#signup-confirm", "a-strong-password-1");
  await page.check("#signup-terms");
  await page.click("#signup-submit");
  expect(api.calls.some((c) => c.path === "/auth/v1/signup")).toBe(false);
  await page.check("#signup-age");
  await page.click("#signup-submit");
  await expect.poll(() => api.calls.some((c) => c.path === "/auth/v1/signup")).toBe(true);
});

test("login shows a clear error for wrong credentials", async ({ page }) => {
  await page.goto("/login.html");
  await page.fill("#login-email", "someone@example.test");
  await page.fill("#login-password", "wrong-password");
  await page.click("#login-submit");
  await expect(page.locator("#login-error")).toHaveText("Wrong email or password.");
});

test.describe("console", () => {
  test.beforeEach(async ({ page }) => { await signIn(page); });

  test("loads the wallet balance", async ({ page, api }) => {
    await page.goto("/console.html");
    await expect(page.locator("#wallet-chip")).toHaveText("120 rcoin");
    expect(api.calls.some((c) => c.path === "/rest/v1/wallets")).toBe(true);
  });

  test("joins Quick Play in one tap and waits for the last seat", async ({ page, api }) => {
    page.on("dialog", (dialog) => dialog.accept());
    await page.goto("/console.html");
    const tier = page.locator('#play-tiers [data-tier="1000:4"]');
    await expect(tier).toContainText("3 waiting");
    await expect(tier).toContainText("Champion 25.2 rcoin");
    await expect(page.locator("#play-tiers [data-tier]")).toHaveCount(12);
    await tier.click();
    await expect.poll(() => api.calls.find((c) => c.path === "/rest/v1/rpc/rib_quick_join")?.body)
      .toEqual({ p_entry_fee_cents: 1000, p_size: 4 });
    await expect(page.locator("#play-waiting")).toContainText("Wild Rift 4 · 10 rcoin");
    await expect(page.locator('#play-waiting [data-leave="t-9"]')).toBeVisible();
  });

  test("creates a custom Wild Rift tournament", async ({ page, api }) => {
    await page.goto("/console.html#page-compete");
    await page.click('#compete-seg [data-seg="custom"]');
    await expect(page.locator("#tournament-list .tcard")).toContainText("Friday Cup");
    await expect(page.locator("#tournament-list .tcard")).toContainText("3/4 players");
    await page.click("#tournament-new");
    await expect(page.locator("#tournament-game")).toHaveCount(0);
    await page.fill("#tournament-name", "Night Cup");
    await expect(page.locator("#tournament-prize")).toContainText("Platform (10%)");
    await page.click("#tournament-save");
    await expect.poll(() => api.calls.find((c) => c.path === "/rest/v1/rpc/rib_tournament_create")?.body)
      .toMatchObject({ p_name: "Night Cup", p_game: "Wild Rift", p_network: "riot", p_entry_fee_cents: 1000, p_size: 4 });
  });

  test("shows the ranking with my standing", async ({ page }) => {
    await page.goto("/console.html");
    await page.locator('.capp__tabs a[data-page="page-ranking"], .capp__bnav a[data-page="page-ranking"]').locator("visible=true").first().click();
    await expect(page.locator(".rank")).toHaveCount(2);
    await expect(page.locator(".standing__n")).toHaveText("2");
  });

  test("edits the profile, opens settings and a player's public card", async ({ page, api }) => {
    await page.goto("/console.html#page-profile");
    await expect(page.locator("#profile-username")).toHaveValue("e2e_player");
    await page.fill("#profile-bio", "Ranked grinder.");
    await page.selectOption("#profile-country", "MX");
    await page.click("#profile-save");
    await expect(page.locator("#profile-msg")).toHaveText("Saved.");
    await expect.poll(() => api.calls.find((c) => c.path === "/rest/v1/rpc/rib_profile_update")?.body)
      .toMatchObject({ p_username: "e2e_player", p_bio: "Ranked grinder.", p_country: "MX" });
    await page.click('#profile-nav a[data-profile-tab="settings"]');
    await expect(page).toHaveURL(/#page-profile\/settings$/);
    await expect(page.locator("#set-show_on_leaderboard")).toBeChecked();
    await page.goto("/console.html#page-ranking");
    await page.locator('#ranking-list [data-player="neo"]').first().click();
    await expect(page.locator("#player-title")).toHaveText("Neo");
    await expect(page.locator("#player-root")).toContainText("Mexico");
  });

});
