// ============================================================================
// crypto-webhook — the ONLY path that credits rcoin bought with crypto. TEST MODE.
//
// Zero-trust, mirroring stripe-webhook: this endpoint is public (Coinbase calls
// it), so it trusts nothing until it has verified Coinbase's HMAC signature over
// the RAW body against COINBASE_COMMERCE_WEBHOOK_SECRET. Only then does it read
// the buyer id + amount that crypto-checkout stamped into the charge metadata,
// and credit the balance with the service role via the idempotent
// rib_credit_rcoin_purchase_crypto RPC. Coinbase retries until it gets a 2xx,
// and the RPC is keyed on the charge code, so a retry credits nothing twice.
//
// verify_jwt is false for this function (see config.toml): the signature check
// below is the authentication. Do NOT credit from anything unsigned.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("COINBASE_COMMERCE_WEBHOOK_SECRET") ?? "";

// Constant-time-ish compare over the hex digests (both fixed length here).
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method_not_allowed", { status: 405 });
  if (!WEBHOOK_SECRET) return new Response("crypto_not_configured", { status: 503 });

  const sig = req.headers.get("X-CC-Webhook-Signature") ?? "";
  if (!sig) return new Response("missing_signature", { status: 400 });

  // 1) Verify Coinbase's HMAC over the RAW body. This is the auth boundary.
  const raw = await req.text();
  const expected = await hmacHex(WEBHOOK_SECRET, raw);
  if (!safeEqual(sig.trim().toLowerCase(), expected)) {
    return new Response("bad_signature", { status: 400 });
  }

  let event: any;
  try { event = JSON.parse(raw)?.event; } catch { return new Response("bad_body", { status: 400 }); }
  if (!event) return new Response("bad_body", { status: 400 });

  // 2) Only a confirmed/resolved (fully paid) charge credits rcoin.
  if (event.type === "charge:confirmed" || event.type === "charge:resolved") {
    const charge = event.data ?? {};
    const meta = charge.metadata ?? {};
    const code = charge.code ?? null;
    const userId = meta.user_id ?? null;
    const payCents = Math.trunc(Number(meta.pay_cents ?? 0));

    if (code && userId && Number.isFinite(payCents) && payCents >= 100) {
      const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
      });
      const { error } = await admin.rpc("rib_credit_rcoin_purchase_crypto", {
        p_user_id: userId,
        p_charge_code: code,
        p_pay_cents: payCents,
      });
      // On a DB error, return 500 so Coinbase retries (idempotency makes retries safe).
      if (error) return new Response("credit_failed", { status: 500 });
    }
  }

  // Acknowledge everything else so Coinbase stops retrying events we don't act on.
  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
