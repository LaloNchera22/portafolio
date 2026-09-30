// Playwright fixtures: a fake Supabase (auth, REST, RPC, functions) behind
// page.route, an optional signed-in session, and a guard that fails the test
// on uncaught page errors.
import { test as base, expect } from "@playwright/test";

const SUPABASE = "http://127.0.0.1:54321";
export const USER = { id: "00000000-0000-0000-0000-0000000000e2", email: "e2e@example.test", user_metadata: { username: "e2e_player" } };

export const data = {
  wallet: { test_balance_cents: 12000, test_locked_cents: 0 },
  tournaments: [
    { id: "t-1", name: "Friday Cup", game: "Wild Rift", network: "riot", entry_fee_cents: 1000, size: 4, entrants: 3, created_at: new Date().toISOString(), creator_username: "neo", joined: false },
  ],
  quickTiers: [
    { entry_fee_cents: 1000, size: 4, waiting: 3, open_events: 1 },
    { entry_fee_cents: 0, size: 8, waiting: 5, open_events: 1 },
  ],
  quickJoin: { id: "t-9", name: "Wild Rift 4 · 10 rcoin", game: "Wild Rift", network: "riot", entry_fee_cents: 1000, max_players: 4, status: "open", tier_key: "1000:4" },
  // What rib_my_tournaments returns once the player joined Quick Play.
  quickWaiting: { id: "t-9", name: "Wild Rift 4 · 10 rcoin", game: "Wild Rift", network: "riot", entry_fee_cents: 1000, size: 4, status: "open", entrants: 2, tier_key: "1000:4", created_at: new Date().toISOString() },
  // Edge Functions: the end-screen check fast-tracks, never settles; Riot can't be asked in tests.
  verifyResult: { status: "verified", settled: false, fast_tracked: true },
  riotAccount: { verified: false, reason: "unavailable" },
  gameAccounts: [{ network: "riot", handle: "E2E#NA1", verified_at: "2026-09-01T00:00:00Z" }],
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

// Hosted tournaments (docs/hosted-tournaments.md): one open public tournament
// behind an invite code, in the shapes the normalizers in lib/hosted.js read.
export const HOSTED_CODE = "KRAKEN2X5P";
data.hosted = {
  code: HOSTED_CODE,
  preview: {
    id: "t-h1", name: "Kraken Cup", host_username: "neo", mode: "hosted", visibility: "public", size: 8, entrants: 5,
    entry_fee_cents: 1000, status: "open", rules: "Best of one. No smurfs.", is_host: false, joined: false,
  },
  // rib_tournament_join_by_code returns the tournaments row.
  joined: { id: "t-h1", name: "Kraken Cup", mode: "hosted", visibility: "public", status: "open", max_players: 8, entrants: 6, entry_fee_cents: 1000 },
  bracket: { size: 8, rounds: 3, rooms: [] },
  roomInfo: [{ mode: "hosted", is_host: false, host_id: "u-host", a_username: "alice", b_username: "bob", entry_fee_cents: 1000, rounds: 3 }],
};

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

export const test = base.extend({
  // Every request to the fake project URL is answered here; calls are recorded.
  api: [async ({ page }, use) => {
    const calls = [];
    // Per-test answers: api.rpc(name, value | (body, calls) => value) and
    // api.table(name, rows) replace the defaults below for that test only.
    const overrides = { rpc: {}, table: {} };
    let queued = false;
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
        if (fn in overrides.rpc) {
          const value = overrides.rpc[fn];
          return json(route, typeof value === "function" ? value(body, calls) : value);
        }
        if (fn === "rib_tournament_preview") {
          if (body && body.p_code === data.hosted.code) return json(route, data.hosted.preview);
          return json(route, { code: "P0001", details: null, hint: "invite_invalid", message: "invite_invalid" }, 400);
        }
        if (fn === "rib_tournament_join_by_code") return json(route, data.hosted.joined);
        if (fn === "rib_tournament_join") return json(route, data.hosted.joined);
        if (fn === "rib_tournament_bracket") return json(route, data.hosted.bracket);
        if (fn === "rib_room_info") return json(route, data.hosted.roomInfo);
        if (fn === "rib_host_start" || fn === "rib_host_cancel") return json(route, Object.assign({}, data.hosted.joined, { status: fn === "rib_host_start" ? "active" : "cancelled" }));
        if (fn === "rib_host_rotate_invite") return json(route, "NEWCODE234");
        if (fn === "rib_host_room_lobby" || fn === "rib_host_decide" || fn === "rib_host_void_room") return json(route, { id: body && body.p_room_id, status: "live" });
        if (fn === "rib_tournament_appeal") return json(route, Object.assign({}, data.hosted.joined, { status: "disputed" }));
        if (fn === "rib_open_tournaments") return json(route, data.tournaments);
        if (fn === "rib_hosted_create") return json(route, { id: "t-night", name: body.p_name, status: "open", mode: "hosted", visibility: body.p_visibility, invite_code: "NIGHTCUP23", max_players: body.p_size, entry_fee_cents: body.p_entry_fee_cents, entrants: 0 });
        if (fn === "rib_host_dashboard") return json(route, { host: { hosted_completed: 0, host_strikes: 0, live_limit: 3, paid_allowed: true, max_entry_fee_cents: 2500 }, tournaments: [] });
        if (fn === "rib_quick_tiers") return json(route, data.quickTiers);
        if (fn === "rib_quick_join") { queued = true; return json(route, data.quickJoin); }
        if (fn === "rib_my_tournaments") return json(route, queued ? [data.quickWaiting] : []);
        if (fn === "rib_my_rooms") return json(route, []);
        if (fn === "rib_leaderboard") return json(route, data.leaderboard);
        if (fn === "rib_my_standing") return json(route, [{ rank: 2, net_cents: 700, won_cents: 1400, wins: 1, losses: 0 }]);
        if (fn === "rib_my_profile") return json(route, data.profile);
        if (fn === "rib_profile_update") return json(route, Object.assign({}, data.profile, { username: body.p_username, bio: body.p_bio, country: body.p_country }));
        if (fn === "rib_settings_get" || fn === "rib_settings_update") return json(route, data.settings);
        if (fn === "rib_public_profile") return json(route, body && body.p_username === "neo" ? data.player : null);
        return json(route, {});
      }
      const table = path.startsWith("/rest/v1/") ? path.slice("/rest/v1/".length) : null;
      if (table && table in overrides.table) {
        const single = (request.headers()["accept"] || "").includes("vnd.pgrst.object");
        const rows = overrides.table[table];
        return json(route, single && Array.isArray(rows) ? rows[0] || null : rows);
      }
      if (path === "/rest/v1/wallets") return json(route, data.wallet);
      if (path === "/rest/v1/game_accounts") return json(route, data.gameAccounts);
      if (path === "/rest/v1/profiles") {
        const single = (request.headers()["accept"] || "").includes("vnd.pgrst.object");
        const profile = { username: "e2e_player", display_name: null, created_at: "2026-09-01T00:00:00Z" };
        return json(route, single ? profile : [{ id: "u-2", username: "neo" }]);
      }
      if (path.startsWith("/rest/v1/")) {
        const single = (request.headers()["accept"] || "").includes("vnd.pgrst.object");
        return json(route, single ? null : []);
      }
      if (path === "/functions/v1/verify-result") return json(route, data.verifyResult);
      if (path === "/functions/v1/riot-account") return json(route, data.riotAccount);
      if (path.startsWith("/functions/v1/")) return json(route, { error: "not_mocked" }, 500);
      return route.abort();
    });
    await use({
      calls,
      rpc(name, value) { overrides.rpc[name] = value; },
      table(name, rows) { overrides.table[name] = rows; },
    });
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
