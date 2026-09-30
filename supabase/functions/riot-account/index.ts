// ============================================================================
// riot-account — prove the caller's Riot ID exists and pin its puuid.
//
// POST { game_name, tag_line } with the player's JWT.
//   200 { verified: true, game_name, tag_line }        (Riot's canonical casing)
//   200 { verified: false, reason: "not_found" }        (no such Riot ID)
//   200 { verified: false, reason: "unavailable" }      (RIOT_API_KEY not set)
// Only ever writes the CALLER's own account (user id from the verified JWT).
// Riot account-v1 on the regional host RIOT_REGION (americas by default). The
// Riot key is a server secret and is never logged or returned.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.2";
import { corsHeaders, json } from "../_shared/cors.ts";
import { withinRateLimit } from "../_shared/rate-limit.ts";
import { retryAfterSeconds, riotAccountUrl, validateRiotId } from "../_shared/riot-id.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RIOT_API_KEY = (Deno.env.get("RIOT_API_KEY") ?? "").trim();
const RIOT_REGION = Deno.env.get("RIOT_REGION") ?? "americas";
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const RIOT_TIMEOUT_MS = 8_000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);
  const asUser = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: { user }, error: userErr } = await asUser.auth.getUser();
  if (userErr || !user) return json({ error: "unauthorized" }, 401);

  let payload: { game_name?: unknown; tag_line?: unknown } = {};
  try { payload = await req.json(); } catch { /* empty body -> invalid below */ }
  const id = validateRiotId(payload.game_name, payload.tag_line);
  if (!id.ok) return json({ error: id.error }, 400);

  if (!RIOT_API_KEY) return json({ verified: false, reason: "unavailable" });

  // After validation, so typos don't burn the budget; before Riot, so abuse can't burn our quota.
  if (!(await withinRateLimit(admin, "riotAccount", user.id))) return json({ error: "rate_limited" }, 429);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RIOT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(riotAccountUrl(RIOT_REGION, id.gameName, id.tagLine), {
      headers: { "X-Riot-Token": RIOT_API_KEY, "Accept": "application/json" },
      signal: controller.signal,
    });
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === "AbortError";
    console.error("riot-account: Riot call error", { user: user.id, error: aborted ? "timeout" : "network" });
    return json({ error: "riot_unavailable" }, 503);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 404) {
    await res.body?.cancel();
    return json({ verified: false, reason: "not_found" });
  }
  if (res.status === 429) {
    await res.body?.cancel();
    const retryAfter = retryAfterSeconds(res.headers.get("Retry-After"));
    return new Response(JSON.stringify({ error: "riot_rate_limited", retry_after: retryAfter }), {
      status: 503,
      headers: { ...corsHeaders, "Content-Type": "application/json", "Retry-After": String(retryAfter) },
    });
  }
  if (!res.ok) {
    await res.body?.cancel();
    console.error("riot-account: Riot call failed", { user: user.id, status: res.status });
    return json({ error: "riot_unavailable" }, 503);
  }

  const account = await res.json().catch(() => null);
  const puuid = typeof account?.puuid === "string" ? account.puuid : "";
  if (!puuid) {
    console.error("riot-account: unexpected Riot payload", { user: user.id });
    return json({ error: "riot_unavailable" }, 503);
  }
  // Keep Riot's canonical casing when it passes our own rules.
  const canonical = validateRiotId(account.gameName, account.tagLine);
  const gameName = canonical.ok ? canonical.gameName : id.gameName;
  const tagLine = canonical.ok ? canonical.tagLine : id.tagLine;

  const { error: rpcErr } = await admin.rpc("rib_riot_account_verified", {
    p_user_id: user.id,
    p_puuid: puuid,
    p_game_name: gameName,
    p_tag_line: tagLine,
  });
  if (rpcErr) {
    console.error("riot-account: save failed", { user: user.id, hint: rpcErr.hint, message: rpcErr.message });
    return json({ error: rpcErr.hint || "server_error" }, rpcErr.hint ? 409 : 500);
  }
  return json({ verified: true, game_name: gameName, tag_line: tagLine });
});
