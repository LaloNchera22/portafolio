// ============================================================================
// game-move — server-authoritative staked play.
//
// POST { match_id, move, seq }          play one move
// POST { match_id, action: "resign" }   concede (the opponent takes the pot)
//
// The browser never writes board state or results. This function derives the
// caller from the verified JWT, replays the move with the same pure rules the
// client uses (supabase/functions/_shared/game-rules), and commits the new
// state through rib_game_commit_move, which checks move_seq (optimistic
// concurrency) and settles the pot atomically when the game ends.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.2";
import { corsHeaders, json } from "../_shared/cors.ts";
import { withinRateLimit } from "../_shared/rate-limit.ts";
import { planMove } from "../_shared/game-move-core.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

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
  if (!(await withinRateLimit(admin, "gameMove", user.id))) return json({ error: "rate_limited" }, 429);

  let body: { match_id?: unknown; move?: unknown; seq?: unknown; action?: unknown } = {};
  try { body = await req.json(); } catch { /* validated below */ }
  if (typeof body.match_id !== "string" || !UUID.test(body.match_id)) return json({ error: "match_not_found" }, 400);
  const action = body.action === "resign" ? "resign" : "move";
  if (JSON.stringify(body.move ?? null).length > 512) return json({ error: "illegal_move" }, 422);

  const { data: match, error: loadErr } = await admin
    .from("game_matches")
    .select("id, game, host_id, guest_id, status, state, move_seq")
    .eq("id", body.match_id)
    .maybeSingle();
  if (loadErr) return json({ error: "server_error" }, 500);
  if (!match) return json({ error: "match_not_found" }, 404);

  const plan = planMove(match, user.id, {
    action,
    move: body.move,
    seq: typeof body.seq === "number" ? body.seq : undefined,
  });
  if ("error" in plan) return json({ error: plan.error }, plan.status);

  const { data: committed, error: commitErr } = await admin.rpc("rib_game_commit_move", {
    p_match_id: match.id,
    p_expected_seq: match.move_seq,
    p_state: plan.state,
    p_next_turn: plan.nextTurnId,
    p_over: plan.over,
    p_winner_id: plan.winnerId,
  });
  if (commitErr) {
    const code = commitErr.hint || "server_error";
    return json({ error: code }, code === "stale_move" ? 409 : 500);
  }
  return json({ match: committed });
});
