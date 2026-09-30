// ============================================================================
// verify-result — read a room's end-of-match screenshot to fast-track or flag it.
//
// POST { evidence_id } with the player's JWT → { status, settled, fast_tracked }.
//   1. Identity from the verified JWT.
//   2. rib_evidence_for_check (service role); the caller must be a room player.
//   3. Already checked → return the stored outcome (before the rate limit:
//      asking again is free and never calls the model).
//   4. Per-user rate limit (fails closed).
//   5. The model only runs when the room is live, the uploader has reported
//      and the opponent hasn't; otherwise "skipped" (no_report /
//      opponent_reported / room_not_live).
//   6. Download the image, hash it (sha256 → p_content_sha256, so the DB can
//      mark replays "duplicate"), check the global daily budget (fails closed).
//   7. Claude vision reads the screen (Haiku first; one Sonnet retry when the
//      reading is an end screen but not confident). The model only READS; the
//      winner and the status are derived in _shared/result-check.js. Text in
//      the image is data, never instructions.
//   8. rib_evidence_check_apply records it. A screenshot never settles, voids
//      or disputes a room: at most it shortens the confirm window (fast_tracked).
// Without ANTHROPIC_API_KEY, over budget, or when the provider fails, the
// evidence is marked "skipped" and the normal confirm window applies.
// Logs carry ids, models, HTTP statuses and outcomes — never keys or images.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.2";
import { corsHeaders, json } from "../_shared/cors.ts";
import { withinGlobalBudget, withinRateLimit } from "../_shared/rate-limit.ts";
import {
  buildDetail,
  buildUserPrompt,
  dailyBudget,
  deriveCheck,
  ESCALATION_MODEL,
  isParticipant,
  normalizeEvidenceContext,
  parseModelOutput,
  PRIMARY_MODEL,
  responseText,
  RESULT_SCHEMA,
  shouldEscalate,
  skipReason,
  sniffImageType,
  storagePathValid,
  SYSTEM_PROMPT,
  toHex,
} from "../_shared/result-check.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
// Platform-wide cap on model calls per UTC day (cost ceiling at 1M users).
const DAILY_MAX = dailyBudget(Deno.env.get("RESULT_CHECK_DAILY_MAX"));
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const BUCKET = "room-evidence";
const MODEL_TIMEOUT_MS = 20_000;
// The Messages API takes images up to 5 MB base64-encoded (≈3.75 MB raw).
// Larger captures are skipped (manual confirm), never downscaled here.
const MAX_IMAGE_BYTES = 3_750_000;

type Parsed = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };
type Reading = { parsed: Parsed | null; error: string | null };
type Ctx = NonNullable<ReturnType<typeof normalizeEvidenceContext>>;

function parseEvidenceId(value: unknown): number | null {
  const n = typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** One Messages API call. Never retried here: the caller decides (at most one escalation). */
async function readScreen(model: string, ctx: Ctx, mediaType: string, data: string, evidenceId: number): Promise<Reading> {
  const escalation = model === ESCALATION_MODEL;
  const headers: Record<string, string> = {
    "x-api-key": ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
  const body: Record<string, unknown> = {
    model,
    max_tokens: 1024, // JSON only
    system: SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data } },
        { type: "text", text: buildUserPrompt(ctx) },
      ],
    }],
    output_config: {
      format: { type: "json_schema", schema: RESULT_SCHEMA },
      // effort is not accepted by Haiku 4.5; Sonnet 5.5 defaults to high.
      ...(escalation ? { effort: "medium" } : {}),
    },
  };
  if (escalation) {
    // Server-side refusal fallback: a declined request is re-run on a
    // fallback model inside the same call instead of failing the check.
    headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
    body.fallbacks = "default";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      const type = payload?.error?.type ?? "unknown";
      console.error("verify-result: model call failed", { evidenceId, model, status: res.status, type });
      return { parsed: null, error: `provider_${res.status}` };
    }
    if (payload?.stop_reason === "refusal") return { parsed: { ok: false, error: "refusal" }, error: null };
    if (payload?.stop_reason === "max_tokens") return { parsed: { ok: false, error: "truncated" }, error: null };
    const text = responseText(payload);
    return { parsed: text === null ? { ok: false, error: "no_text" } : parseModelOutput(text), error: null };
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === "AbortError";
    console.error("verify-result: model call error", { evidenceId, model, error: aborted ? "timeout" : "network" });
    return { parsed: null, error: aborted ? "provider_timeout" : "provider_network" };
  } finally {
    clearTimeout(timer);
  }
}

async function loadContext(evidenceId: number) {
  const { data, error } = await admin.rpc("rib_evidence_for_check", { p_evidence_id: evidenceId });
  if (error) return { ctx: null, error };
  return { ctx: normalizeEvidenceContext(data), error: null };
}

function outcome(ctx: Ctx) {
  return { status: ctx.checkStatus, settled: ctx.roomStatus === "done", fast_tracked: ctx.fastTracked };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
}

/** One hit on the platform-wide daily model budget per model call. */
function withinBudget(): Promise<boolean> {
  return withinGlobalBudget(admin, "resultCheckGlobal", DAILY_MAX, 86_400);
}

/**
 * Apply once, then answer from the stored evidence: the DB may turn the
 * status into "duplicate" (content hash seen in another room), and a
 * concurrent call may already have checked it.
 */
async function apply(
  evidenceId: number,
  status: string,
  winner: string | null,
  confidence: number | null,
  detail: Record<string, unknown>,
  contentSha256: string | null = null,
): Promise<Response> {
  const { data: room, error } = await admin.rpc("rib_evidence_check_apply", {
    p_evidence_id: evidenceId,
    p_status: status,
    p_winner: winner,
    p_confidence: confidence,
    p_detail: detail,
    p_content_sha256: contentSha256,
  });
  if (error && error.hint !== "evidence_not_pending") {
    console.error("verify-result: apply failed", { evidenceId, status, hint: error.hint, message: error.message });
    return json({ error: error.hint || "server_error" }, error.hint ? 409 : 500);
  }
  const row = Array.isArray(room) ? room[0] : room;
  const stored = await loadContext(evidenceId);
  if (stored.ctx) {
    const out = outcome(stored.ctx);
    if (row) out.fast_tracked = row.fast_tracked === true;
    console.log("verify-result: applied", { evidenceId, requested: status, ...out });
    return json(out);
  }
  if (!row) return json({ error: "server_error" }, 500);
  return json({ status, settled: row.status === "done", fast_tracked: row.fast_tracked === true });
}

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

  let payload: { evidence_id?: unknown } = {};
  try { payload = await req.json(); } catch { /* empty body -> invalid below */ }
  const evidenceId = parseEvidenceId(payload.evidence_id);
  if (evidenceId === null) return json({ error: "invalid_evidence" }, 400);

  const { ctx, error: ctxErr } = await loadContext(evidenceId);
  if (ctxErr) {
    console.error("verify-result: context failed", { evidenceId, hint: ctxErr.hint, message: ctxErr.message });
    return json({ error: "server_error" }, 500);
  }
  // Same answer for "no such evidence" and "not your room": ids don't leak.
  if (!ctx || !isParticipant(ctx, user.id)) return json({ error: "evidence_not_found" }, 404);

  // A checked screenshot is never read twice, and asking again is free.
  if (ctx.checkStatus !== "pending") return json(outcome(ctx));

  if (!(await withinRateLimit(admin, "resultCheck", user.id))) return json({ error: "rate_limited" }, 429);

  // The model only runs where a reading can help: live room, uploader reported, opponent hasn't.
  const gate = skipReason(ctx);
  if (gate) return apply(evidenceId, "skipped", null, null, { reason: gate });
  if (!ANTHROPIC_API_KEY) return apply(evidenceId, "skipped", null, null, { reason: "not_configured" });
  if (!storagePathValid(ctx)) return apply(evidenceId, "unreadable", null, 0, { reason: "invalid_path" });

  const { data: blob, error: dlErr } = await admin.storage.from(BUCKET).download(ctx.storagePath!);
  if (dlErr || !blob) {
    console.error("verify-result: download failed", { evidenceId, message: dlErr?.message });
    return apply(evidenceId, "skipped", null, null, { reason: "download_failed" });
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const contentSha = await sha256Hex(bytes);
  if (bytes.length > MAX_IMAGE_BYTES) return apply(evidenceId, "skipped", null, null, { reason: "image_too_large" }, contentSha);
  const mediaType = sniffImageType(bytes);
  if (!mediaType) return apply(evidenceId, "unreadable", null, 0, { reason: "not_an_image" }, contentSha);

  if (!(await withinBudget())) return apply(evidenceId, "skipped", null, null, { reason: "budget" }, contentSha);
  const data = toBase64(bytes);

  let model = PRIMARY_MODEL;
  let reading = await readScreen(model, ctx, mediaType, data, evidenceId);
  if (reading.error) {
    return apply(evidenceId, "skipped", null, null, buildDetail({ model, escalated: false, error: reading.error }), contentSha);
  }
  let escalated = false;
  // One retry at most, and only while the daily budget allows it.
  if (shouldEscalate(reading.parsed) && (await withinBudget())) {
    const second = await readScreen(ESCALATION_MODEL, ctx, mediaType, data, evidenceId);
    // A failed escalation keeps the first reading (no second retry).
    if (!second.error && second.parsed?.ok) {
      reading = second;
      model = ESCALATION_MODEL;
      escalated = true;
    }
  }

  const check = deriveCheck(reading.parsed, ctx);
  const detail = buildDetail({ check, parsed: reading.parsed, model, escalated });
  return apply(evidenceId, check.status, check.winner, check.confidence, detail, contentSha);
});
