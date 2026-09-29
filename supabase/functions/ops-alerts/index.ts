// ============================================================================
// ops-alerts — checks platform health and notifies a chat webhook.
//
// Called on a schedule (see .github/workflows/ops-alerts.yml) with the header
// `x-ops-secret: $OPS_SECRET`. Reads rib_ops_health() and, when a threshold is
// crossed, posts a short message to ALERT_WEBHOOK_URL (Slack- or Discord-
// compatible: sends both `text` and `content`). Always returns the counters.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPS_SECRET = Deno.env.get("OPS_SECRET") ?? "";
const WEBHOOK = Deno.env.get("ALERT_WEBHOOK_URL") ?? "";
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// A counter above its threshold raises an alert.
const THRESHOLDS: Record<string, number> = {
  client_errors_last_hour: 50,
  overdue_tournament_payouts: 0,
  disputed_tournaments: 0,
  overdue_turn_clocks: 0,
  frozen_wallets: 0,
};

Deno.serve(async (req) => {
  if (!OPS_SECRET || req.headers.get("x-ops-secret") !== OPS_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const { data: health, error } = await admin.rpc("rib_ops_health");
  if (error) {
    console.error("ops-alerts: health check failed", error.message);
    return new Response(JSON.stringify({ error: "health_check_failed" }), { status: 500 });
  }

  const breaches = Object.entries(THRESHOLDS)
    .filter(([name, limit]) => Number(health?.[name] ?? 0) > limit)
    .map(([name]) => `${name.replace(/_/g, " ")}: ${health[name]}`);

  if (breaches.length && WEBHOOK) {
    const text = `Runinback ops alert\n- ${breaches.join("\n- ")}`;
    const res = await fetch(WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, content: text }),
    }).catch((e) => { console.error("ops-alerts: webhook failed", String(e)); return null; });
    if (res && !res.ok) console.error("ops-alerts: webhook returned", res.status);
  }
  return new Response(JSON.stringify({ health, breaches }), { headers: { "Content-Type": "application/json" } });
});
