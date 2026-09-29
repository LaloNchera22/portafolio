// Playwright fixtures: a fake Supabase (auth, REST, RPC, functions) behind
// page.route, an optional signed-in session, and a guard that fails the test
// on uncaught page errors.
import { test as base, expect } from "@playwright/test";

const SUPABASE = "http://127.0.0.1:54321";
const USER = { id: "00000000-0000-0000-0000-0000000000e2", email: "e2e@example.test", user_metadata: { username: "e2e_player" } };

export const data = {
  wallet: { test_balance_cents: 12000, test_locked_cents: 0 },
  lobby: [
    { id: "c-1", game: "Valorant", mode: "1v1", stake_cents: 0, created_at: new Date().toISOString(), creator_id: "u-2", creator_username: "neo", network: null },
  ],
  tournaments: [
    { id: "t-1", name: "Friday Cup", game: "Valorant", network: null, entry_fee_cents: 1000, size: 4, entrants: 3, created_at: new Date().toISOString(), creator_username: "neo", joined: false },
  ],
  profile: { username: "e2e_player", display_name: null, bio: null, country: null, avatar_version: 0, created_at: "2026-09-01T00:00:00Z", username_next_change_at: null },
  settings: {
    match_toasts: true, product_emails: false, show_on_leaderboard: true, show_game_accounts: false, monthly_cap_cents: null,
    month_spent_cents: 0, cooloff_until: null, pending_cap: null, pending_cooloff_end_at: null, next_export_at: null,
  },
  player: {
    username: "neo", display_name: "Neo", bio: "Valorant, mostly.", country: "MX", avatar: null, created_at: "2026-01-01T00:00:00Z",
    is_me: false, ranked: true, stats: { net_cents: 5000, won_cents: 9000, wins: 4, losses: 1, rank_all: 1 }, game_accounts: null, tournaments: [],
  },
  leaderboard: [
    { rank: 1, user_id: "u-2", username: "neo", net_cents: 5000, won_cents: 9000, wins: 4, losses: 1 },
    { rank: 2, user_id: USER.id, username: "e2e_player", net_cents: 700, won_cents: 1400, wins: 1, losses: 0 },
  ],
};

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

export const test = base.extend({
  // Every request to the fake project URL is answered here; calls are recorded.
  api: [async ({ page }, use) => {
    const calls = [];
    await page.route(SUPABASE + "/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const body = request.postDataJSON ? (() => { try { return request.postDataJSON(); } catch { return null; } })() : null;
      calls.push({ method: request.method(), path, body });

      if (path === "/auth/v1/token") {
        return json(route, { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" }, 400);
      }
      if (path === "/auth/v1/signup") return json(route, { id: "new", email: body && body.email }, 200);
      if (path === "/auth/v1/user") return json(route, USER);
      if (path === "/auth/v1/logout") return route.fulfill({ status: 204 });
      if (path.startsWith("/rest/v1/rpc/")) {
        const fn = path.slice("/rest/v1/rpc/".length);
        if (fn === "rib_open_challenges") return json(route, data.lobby);
        if (fn === "rib_open_tournaments") return json(route, data.tournaments);
        if (fn === "rib_my_tournaments" || fn === "rib_my_rooms") return json(route, []);
        if (fn === "rib_leaderboard") return json(route, data.leaderboard);
        if (fn === "rib_my_standing") return json(route, [{ rank: 2, net_cents: 700, won_cents: 1400, wins: 1, losses: 0 }]);
        if (fn === "rib_my_profile") return json(route, data.profile);
        if (fn === "rib_profile_update") return json(route, Object.assign({}, data.profile, { username: body.p_username, bio: body.p_bio, country: body.p_country }));
        if (fn === "rib_settings_get" || fn === "rib_settings_update") return json(route, data.settings);
        if (fn === "rib_public_profile") return json(route, body && body.p_username === "neo" ? data.player : null);
        return json(route, {});
      }
      if (path === "/rest/v1/wallets") return json(route, data.wallet);
      if (path === "/rest/v1/profiles") {
        const single = (request.headers()["accept"] || "").includes("vnd.pgrst.object");
        const profile = { username: "e2e_player", display_name: null, created_at: "2026-09-01T00:00:00Z" };
        return json(route, single ? profile : [{ id: "u-2", username: "neo" }]);
      }
      if (path.startsWith("/rest/v1/")) {
        const single = (request.headers()["accept"] || "").includes("vnd.pgrst.object");
        return json(route, single ? null : []);
      }
      if (path.startsWith("/functions/v1/")) return json(route, { error: "not_mocked" }, 500);
      return route.abort();
    });
    await use({ calls });
  }, { auto: true }],

  // Fail on any uncaught error in the page.
  page: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await use(page);
    expect(errors, "uncaught page errors").toEqual([]);
  },
});

/** Start the page with a stored, unexpired Supabase session. */
export async function signIn(page) {
  await page.addInitScript((user) => {
    const session = {
      access_token: "e2e-access-token", refresh_token: "e2e-refresh-token", token_type: "bearer",
      expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user,
    };
    window.localStorage.setItem("sb-127-auth-token", JSON.stringify(session));
  }, USER);
}

export { expect };
