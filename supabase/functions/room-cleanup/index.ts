// ============================================================================
// room-cleanup — chat retention for match rooms (docs/hosted-tournaments.md,
// "Chat retention").
//
// Called on a schedule with the header `x-ops-secret: $OPS_SECRET` (same
// secret as ops-alerts). Repeatedly:
//   1. rib_room_purge_candidates(batch): rooms whose chat may go (tournament
//      terminal, or a friendly ended more than 24 hours ago) with the lobby
//      screenshots their messages reference;
//   2. removes those objects, and anything else under `<room_id>/`, from the
//      private `room-lobby` bucket through the Storage API;
//   3. rib_room_messages_purge(room ids) for the rooms whose files are gone.
// A room whose files couldn't be removed keeps its messages and is retried
// on the next run. Returns counters.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPS_SECRET = Deno.env.get("OPS_SECRET") ?? "";
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const BUCKET = "room-lobby";
const BATCH = 100;
const MAX_BATCHES = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Candidate {
  room_id: string;
  image_paths: string[] | null;
}

// Constant-time comparison of the shared secret.
function secretMatches(given: string | null): boolean {
  if (!OPS_SECRET || given === null) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(OPS_SECRET);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i];
  return diff === 0;
}

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Every object of one room: the paths its messages reference plus whatever
// sits in its folder (uploads that were never posted).
async function roomObjects(candidate: Candidate): Promise<string[]> {
  const prefix = candidate.room_id + "/";
  const paths = new Set((candidate.image_paths ?? []).filter((p) => typeof p === "string" && p.startsWith(prefix)));
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await admin.storage.from(BUCKET).list(candidate.room_id, { limit: 1000, offset });
    if (error) throw new Error(`list ${candidate.room_id}: ${error.message}`);
    for (const item of data ?? []) {
      if (item.name) paths.add(prefix + item.name);
    }
    if (!data || data.length < 1000) break;
  }
  return [...paths];
}

Deno.serve(async (req) => {
  if (req.method !== "POST" && req.method !== "GET") return respond({ error: "method_not_allowed" }, 405);
  if (!secretMatches(req.headers.get("x-ops-secret"))) return new Response("forbidden", { status: 403 });

  let rooms = 0;
  let messages = 0;
  let objects = 0;
  let failed = 0;

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const { data, error } = await admin.rpc("rib_room_purge_candidates", { p_batch: BATCH });
    if (error) {
      console.error("room-cleanup: candidates failed", error.message);
      return respond({ error: "candidates_failed", rooms, messages, objects, failed }, 500);
    }
    const candidates = ((data ?? []) as Candidate[]).filter((c) => UUID.test(c.room_id));
    if (!candidates.length) break;

    const cleared: string[] = [];
    for (const candidate of candidates) {
      try {
        const paths = await roomObjects(candidate);
        for (let i = 0; i < paths.length; i += 1000) {
          const { error: rmError } = await admin.storage.from(BUCKET).remove(paths.slice(i, i + 1000));
          if (rmError) throw new Error(`remove ${candidate.room_id}: ${rmError.message}`);
        }
        objects += paths.length;
        cleared.push(candidate.room_id);
      } catch (e) {
        failed++;
        console.error("room-cleanup:", e instanceof Error ? e.message : String(e));
      }
    }

    if (cleared.length) {
      const { data: deleted, error: purgeError } = await admin.rpc("rib_room_messages_purge", { p_room_ids: cleared });
      if (purgeError) {
        console.error("room-cleanup: purge failed", purgeError.message);
        return respond({ error: "purge_failed", rooms, messages, objects, failed }, 500);
      }
      rooms += cleared.length;
      messages += Number(deleted ?? 0);
    }
    // Nothing progressed (every room failed) or the queue is drained.
    if (!cleared.length || candidates.length < BATCH) break;
  }

  return respond({ rooms, messages, objects, failed });
});
