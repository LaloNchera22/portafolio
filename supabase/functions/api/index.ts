// ============================================================================
// api — Runinback public API v1, authenticated with a developer API key.
//
//   GET /api/v1/status                      → the key's project and environment
//   GET /api/v1/games                       → games that can be played for stakes
//   GET /api/v1/leaderboard?period=week|all&limit=1..100
//
// Send the key as `Authorization: Bearer rib_test_…`. Keys are verified by
// hash (the plaintext is never stored), revoked keys are rejected, each key
// is rate limited, and every call records the key's last use. Server-to-server
// only: keys must never ship in a browser, so no CORS headers are sent.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.2";
import { sha256Hex } from "../_shared/Stripe.ts";
import { STAKEABLE_RULES } from "../_shared/game-rules/index.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const KEY_FORMAT = /^rib_(test|live)_[0-9a-f]{48}$/;

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function fail(code: string, message: string, status: number): Response {
  return reply({ error: { code, message } }, status);
}

Deno.serve(async (req) => {
  if (req.method !== "GET") return fail("method_not_allowed", "Use GET.", 405);

  const auth = req.headers.get("Authorization") ?? "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!KEY_FORMAT.test(key)) return fail("invalid_key", "Send your API key as 'Authorization: Bearer rib_…'.", 401);

  const { data: rows, error: keyErr } = await admin.rpc("rib_api_verify_key", { p_key_hash: await sha256Hex(key) });
  if (keyErr) {
    console.error("api: key verification failed", keyErr.message);
    return fail("server_error", "Try again shortly.", 500);
  }
  const caller = rows?.[0];
  if (!caller) return fail("invalid_key", "This key doesn't exist or was revoked.", 401);

  const { data: allowed } = await admin.rpc("rib_rate_limit_hit", {
    p_bucket: "api", p_subject: caller.key_id, p_max: 120, p_window_seconds: 60,
  });
  if (allowed === false) return fail("rate_limited", "Too many requests: 120 per minute per key.", 429);

  const url = new URL(req.url);
  const route = url.pathname.replace(/^.*\/api/, "").replace(/\/+$/, "") || "/";

  if (route === "/v1/status") {
    return reply({
      ok: true,
      environment: caller.environment,
      project: caller.project_id ? { id: caller.project_id, name: caller.project_name } : null,
      key_prefix: caller.key_prefix,
      mode: "test",
    });
  }

  if (route === "/v1/games") {
    return reply({
      data: Object.values(STAKEABLE_RULES).map((g: { id: string; name: string }) => ({ id: g.id, name: g.name, stakeable: true })),
    });
  }

  if (route === "/v1/leaderboard") {
    const period = url.searchParams.get("period") === "all" ? "all" : "week";
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 20));
    const { data, error } = await admin.rpc("rib_leaderboard", { p_period: period, p_limit: limit, p_offset: 0 });
    if (error) {
      console.error("api: leaderboard failed", error.message);
      return fail("server_error", "Try again shortly.", 500);
    }
    return reply({
      period,
      data: (data ?? []).map((r: { rank: number; username: string; net_cents: number; won_cents: number; wins: number; losses: number }) => ({
        rank: r.rank, username: r.username, net_USD: r.net_cents / 100, won_USD: r.won_cents / 100, wins: r.wins, losses: r.losses,
      })),
    });
  }

  return fail("not_found", "Unknown endpoint. See /developers.html for the API reference.", 404);
});
