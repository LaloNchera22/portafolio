// ============================================================================
// issue-api-key — mint a Runinback API key, server-side only.
//
// Zero-trust: the caller's identity is taken from a VERIFIED JWT, never from the
// request body. The plaintext key is generated and SHA-256 hashed here; only the
// hash and a safe prefix are stored. The full key is returned exactly once.
// All DB writes go through supabase-js (bound parameters — no SQL string
// building), so this path carries no SQL injection surface.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.2";
import { corsHeaders, json } from "../_shared/cors.ts";
import { sha256Hex } from "../_shared/crypto.ts";
import { withinRateLimit } from "../_shared/rate-limit.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
// Service role is a SERVER-ONLY secret. It is injected by the Supabase runtime
// and must never reach the browser or the repo.
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function randomKey(env: string): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const body = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `rib_${env}_${body}`;
}


Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);

  // 1) Verify the caller from their JWT. This is the ONLY source of identity.
  const asUser = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: { user }, error: userErr } = await asUser.auth.getUser();
  if (userErr || !user) return json({ error: "unauthorized" }, 401);

  // Abuse guard: per-user rate limit (service role; fails open on DB errors).
  const limiter = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  if (!(await withinRateLimit(limiter, "apiKey", user.id))) return json({ error: "rate_limited" }, 429);
  const { count: activeKeys } = await limiter.from("api_keys").select("id", { count: "exact", head: true })
    .eq("owner_id", user.id).is("revoked_at", null);
  if ((activeKeys ?? 0) >= 25) return json({ error: "too_many_keys" }, 409);

  // 2) Validate input (allowlist only — reject anything unexpected).
  let payload: { name?: string; environment?: string; project_id?: string } = {};
  try { payload = await req.json(); } catch { /* empty body is fine */ }

  const environment = payload.environment === "live" ? "live" : "test";
  // Live keys only once the platform leaves test mode (platform_settings.live_mode).
  if (environment === "live") {
    const { data: live } = await limiter.rpc("rib_live_mode");
    if (live !== true) return json({ error: "live_keys_unavailable" }, 409);
  }
  const name = (payload.name ?? "default").toString().slice(0, 60);
  const projectId = typeof payload.project_id === "string" ? payload.project_id : null;

  // If a project is named, it MUST belong to the caller. We check it through the
  // user-scoped client (RLS only returns the caller's own rows), so a key can
  // never be attached to someone else's project even though the insert below
  // runs with the service role, which bypasses RLS.
  if (projectId) {
    const { data: owned, error: projErr } = await asUser
      .from("projects")
      .select("id")
      .eq("id", projectId)
      .maybeSingle();
    if (projErr || !owned) return json({ error: "invalid_project" }, 403);
  }

  // 3) Generate + hash the key. Only the hash and prefix are persisted.
  const fullKey = randomKey(environment);
  const keyHash = await sha256Hex(fullKey);
  const keyPrefix = fullKey.slice(0, `rib_${environment}_`.length + 4);

  // 4) Insert with the service role, but pin owner_id to the VERIFIED user.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const { data, error } = await admin
    .from("api_keys")
    .insert({
      owner_id: user.id,
      project_id: projectId,
      name,
      environment,
      key_prefix: keyPrefix,
      key_hash: keyHash,
    })
    .select("id, key_prefix, environment, created_at")
    .single();

  if (error) return json({ error: "insert_failed" }, 400);

  // The plaintext key is returned once and never stored.
  return json({ id: data.id, key: fullKey, key_prefix: data.key_prefix, environment }, 201);
});
