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

  test("loads the wallet balance and the games lobby", async ({ page, api }) => {
    await page.goto("/console.html");
    await expect(page.locator("#wallet-chip")).toHaveText("120 rcoin");
    await expect(page.locator(".gcard").first()).toBeVisible();
    expect(api.calls.some((c) => c.path === "/rest/v1/wallets")).toBe(true);
  });

  test("plays a practice move on the tic-tac-toe board", async ({ page }) => {
    await page.goto("/console.html");
    await page.getByRole("button", { name: "Open Tic-Tac-Toe", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Tic-Tac-Toe" })).toBeVisible();
    await page.getByRole("button", { name: "Play free" }).click();
    const first = page.getByRole("button", { name: /^Square 1, empty/ });
    await first.click();
    await expect(page.getByRole("button", { name: /^Square 1, ✕/ })).toBeVisible();
    // the square that just changed gets the "placed" animation hook
    await expect(page.getByRole("button", { name: /^Square 1, ✕/ })).toHaveClass(/is-changed/);
  });

  test("creates a 4-player tournament and posts a free friendly", async ({ page, api }) => {
    await page.goto("/console.html#page-compete");
    await expect(page.locator(".tcard")).toContainText("Friday Cup");
    await expect(page.locator(".tcard")).toContainText("3/4 players");
    await page.click("#tournament-new");
    await page.fill("#tournament-name", "Night Cup");
    await page.fill("#tournament-game", "CS2");
    await expect(page.locator("#tournament-prize")).toContainText("Platform (10%)");
    await page.click("#tournament-save");
    await expect.poll(() => api.calls.find((c) => c.path === "/rest/v1/rpc/rib_tournament_create")?.body)
      .toMatchObject({ p_name: "Night Cup", p_game: "CS2", p_entry_fee_cents: 1000, p_size: 4 });
    await page.click("#challenge-new");
    await page.fill("#challenge-game", "Chess");
    await page.click("#challenge-save");
    await expect.poll(() => api.calls.find((c) => c.path === "/rest/v1/rpc/rib_challenge_create")?.body)
      .toEqual({ p_game: "Chess", p_mode: "1v1", p_target_username: null, p_network: null });
  });

  test("shows the ranking with my standing", async ({ page }) => {
    await page.goto("/console.html");
    await page.locator('.capp__tabs a[data-page="page-ranking"], .capp__bnav a[data-page="page-ranking"]').locator("visible=true").first().click();
    await expect(page.locator(".rank")).toHaveCount(2);
    await expect(page.locator(".standing__n")).toHaveText("2");
  });

  test("developer portal offers test keys only while in test mode", async ({ page }) => {
    await page.goto("/console.html");
    await page.evaluate(() => document.querySelector("#switch-to-developer").click());
    await page.click('#dev-nav a[data-dev="keys"]');
    await page.click("#key-new");
    await expect(page.locator('#key-env option[value="live"]')).toBeDisabled();
    await expect(page.locator("#page-developer")).not.toContainText("SDK integration");
  });
});

test("code blocks copy and confirm in place", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/developers.html");
  const copy = page.locator(".terminal__copy").first();
  await copy.click();
  await expect(copy).toHaveClass(/is-done/);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("RIB_KEY=");
  await expect(copy).not.toHaveClass(/is-done/, { timeout: 4000 });
});
