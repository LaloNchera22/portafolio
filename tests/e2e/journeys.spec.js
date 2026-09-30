// Critical user journeys in a real browser (desktop and mobile projects).
import { expect, signIn, test } from "./fixtures.js";

test("landing states test mode and loads without errors", async ({ page, api }) => {
  await page.goto("/index.html");
  await expect(page.locator(".announce")).toContainText("Test mode");
  await expect(page.locator(".hero .backdrop--stage")).toHaveCount(1); await expect(page.locator("video")).toHaveCount(0);
  await expect(page.locator("h1")).toBeVisible();
  expect(api.calls.every((c) => !c.path.startsWith("/rest/"))).toBe(true);
});

test("landing prize calculator splits entry fees by bracket size", async ({ page }) => {
  await page.goto("/index.html");
  await page.getByRole("button", { name: "Decline" }).click();
  const calc = page.locator("[data-prize-calc]");
  await calc.scrollIntoViewIfNeeded();
  const champion = calc.locator('[data-calc="winner"]');
  const host = calc.locator('[data-calc="host"]');
  await expect(calc.locator("[data-calc-fee-out]")).toHaveText("10 rcoin");
  await expect(champion).toHaveText("68");
  await expect(host).toHaveText("4");
  await calc.getByRole("radio", { name: "16", exact: true }).check();
  await expect(champion).toHaveText("136");
  await expect(host).toHaveText("8");
  await calc.getByLabel("Entry fee").fill("50");
  await expect(calc.locator("[data-calc-fee-out]")).toHaveText("50 rcoin");
  await calc.getByRole("radio", { name: "32", exact: true }).check();
  await expect(champion).toHaveText("1360");
  await expect(calc.locator('[data-calc="pool"]')).toHaveText("1600");
});

test("landing nav shows only Log in and Sign up, with no menu toggle", async ({ page }) => {
  await page.goto("/index.html");
  const nav = page.locator("header.nav nav");
  await expect(nav).toHaveCount(1);
  await expect(nav).toHaveAttribute("aria-label", "Account");
  const links = nav.getByRole("link");
  await expect(links).toHaveText(["Log in", "Sign up"]);
  await expect(nav.getByRole("link", { name: "Log in" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Sign up" })).toBeVisible();
  await expect(page.locator("[data-nav-toggle], .nav__toggle, .nav__links")).toHaveCount(0);
  await expect(page.locator("header.nav button")).toHaveCount(0);
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
    await page.goto("/console.html");
    const tier = page.locator('#play-tiers [data-tier="1000:4"]');
    await expect(tier).toContainText("3 waiting");
    await expect(tier).toContainText("Champion 25.2 rcoin");
    await expect(page.locator("#play-tiers [data-tier]")).toHaveCount(12);
    await tier.click();
    // A paid entry is confirmed in the page's own dialog, with the prizes spelled out.
    const dialog = page.locator("#confirm-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Enter for 10 rcoin?");
    await expect(dialog).toContainText("The champion wins 25.2 rcoin, the runner-up 10.8 rcoin");
    await expect(page.locator("#confirm-cancel")).toBeFocused();
    expect(api.calls.some((c) => c.path === "/rest/v1/rpc/rib_quick_join")).toBe(false);
    await page.click("#confirm-ok");
    await expect.poll(() => api.calls.find((c) => c.path === "/rest/v1/rpc/rib_quick_join")?.body)
      .toEqual({ p_entry_fee_cents: 1000, p_size: 4 });
    await expect(page.locator("#play-waiting")).toContainText("Wild Rift 4 · 10 rcoin");
    await expect(page.locator('#play-waiting [data-leave="t-9"]')).toBeVisible();
    await expect(page.locator("#play-waiting .seats")).toHaveAttribute("aria-label", "2 of 4 seats taken");
  });

  test("cancelling the entry dialog sends nothing", async ({ page, api }) => {
    await page.goto("/console.html");
    await page.locator('#play-tiers [data-tier="1000:4"]').click();
    await expect(page.locator("#confirm-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#confirm-dialog")).toBeHidden();
    await expect(page.locator('#play-tiers [data-tier="1000:4"]')).toBeFocused();
    expect(api.calls.some((c) => c.path === "/rest/v1/rpc/rib_quick_join")).toBe(false);
  });

  test("moves focus to the new page's heading and back with the keyboard menu", async ({ page, isMobile }) => {
    test.skip(isMobile, "the account menu is keyboard-driven on desktop");
    await page.goto("/console.html");
    await expect(page.locator('#play-tiers [data-tier="0:4"]')).toBeVisible();
    await page.locator("#acct-avatar").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator('#acct-menu [data-page="page-profile"]')).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator("#acct-menu")).toBeHidden();
    await expect(page.locator("#acct-avatar")).toBeFocused();
    await page.click('.capp__tabs a[data-page="page-wallet"]');
    await expect(page.locator("#page-wallet h1")).toBeFocused();
  });

  test("no page scrolls sideways on a 320px phone", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    for (const hash of ["#page-compete", "#page-wallet", "#page-ranking", "#page-profile", "#page-profile/settings", "#page-profile/security"]) {
      await page.goto("/console.html" + hash);
      await expect(page.locator("#capp")).toBeVisible();
      await page.waitForTimeout(150);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, hash).toBeLessThanOrEqual(0);
    }
  });

  test("hosts a Wild Rift tournament", async ({ page, api }) => {
    await page.goto("/console.html#page-compete");
    await page.click('#compete-seg [data-seg="custom"]');
    await expect(page.locator("#tournament-list .tcard")).toContainText("Friday Cup");
    await expect(page.locator("#tournament-list .tcard")).toContainText("3/4 players");
    await page.click("#tournament-new");
    await expect(page.locator("#tournament-game")).toHaveCount(0);
    await page.fill("#tournament-name", "Night Cup");
    await expect(page.locator("#tournament-prize")).toContainText("Host commission (5%)");
    await expect(page.locator("#tournament-prize")).toContainText("Platform (10%)");
    await page.click("#tournament-save");
    await expect.poll(() => api.calls.find((c) => c.path === "/rest/v1/rpc/rib_hosted_create")?.body)
      .toMatchObject({ p_name: "Night Cup", p_entry_fee_cents: 1000, p_size: 4, p_visibility: "public" });
    expect(api.calls.some((c) => c.path === "/rest/v1/rpc/rib_tournament_create")).toBe(false);
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
