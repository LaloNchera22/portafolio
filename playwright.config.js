// End-to-end tests in a real browser against the production build. Supabase
// is replaced by network mocks (tests/e2e/fixtures.js), so no backend is
// needed: the site is built with a fake project URL that the mocks intercept.
import { defineConfig, devices } from "@playwright/test";

export const FAKE_SUPABASE_URL = "http://127.0.0.1:54321";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "npm run build && npx vite preview --port 4173 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:4173/index.html",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      SUPABASE_URL: FAKE_SUPABASE_URL,
      SUPABASE_ANON_KEY: "e2e-anon-key",
      STRIPE_ENABLED: "false",
      CRYPTO_ENABLED: "false",
    },
  },
});
