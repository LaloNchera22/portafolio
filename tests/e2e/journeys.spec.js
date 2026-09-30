import { test, expect } from "./fixtures.js";

async function signIn(page) {
  await page.goto("/login.html");
  await page.fill("#login-email", "player@example.com");
  await page.fill("#login-password", "hunter2");
  await page.click("#login-submit");
  await page.waitForURL("/console.html");
}

test("homepage loads and displays hero", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("h1")).toContainText("Runinback");
});

test("login flow completes and redirects to console", async ({ page }) => {
  await signIn(page);
  await expect(page.locator("#acct-avatar")).toBeVisible();
});

test("login shows a clear error for wrong password", async ({ page }) => {
  await page.goto("/login.html");
  await page.fill("#login-email", "player@example.com");
  await page.fill("#login-password", "wrongpass");
  await page.click("#login-submit");
  await expect(page.locator("#auth-error")).toBeVisible();
  await expect(page.locator("#auth-error")).toContainText("Invalid credentials");
});

test.describe("console", () => {
  test.beforeEach(async ({ page }) => { await signIn(page); });

  test("loads the wallet balance", async ({ page, api }) => {
    await page.goto("/console.html");
    await expect(page.locator("#wallet-chip")).toHaveText("120 rcoin");
    expect(api.calls.some((c) => c.path === "/rest/v1/wallets")).toBe(true);
  });

  test("can navigate to account settings", async ({ page }) => {
    await page.goto("/console.html");
    await page.click("#acct-avatar");
    await page.click("text=Settings");
    await page.waitForURL("/console.html#page-settings");
    await expect(page.locator("#settings-form")).toBeVisible();
  });
});
