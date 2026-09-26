// ============================================================================
// stripe-webhook — the ONLY path that credits rcoin (TEST MODE).
//
// Zero-trust: this endpoint is public (Stripe calls it), so it trusts nothing
// until it has verified Stripe's signature against STRIPE_WEBHOOK_SECRET. Only
// then does it read the buyer id + amount that stripe-checkout stamped into the
// session, and credit the balance with the service role via the idempotent
// rib_credit_rcoin_purchase RPC. Stripe retries until it gets a 2xx, and the
// RPC is keyed on the Checkout session id, so a retry credits nothing twice.
//
// verify_jwt is false for this function (see config.toml): the signature check
// below is the authentication. Do NOT credit from anything unsigned.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@16?target=deno";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method_not_allowed", { status: 405 });
  if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET) {
    return new Response("stripe_not_configured", { status: 503 });
  }

  const sig = req.headers.get("stripe-signature");
  if (!sig) return new Response("missing_signature", { status: 400 });

  // 1) Verify Stripe's signature over the RAW body. This is the auth boundary.
  const raw = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, sig, STRIPE_WEBHOOK_SECRET);
  } catch (_e) {
    return new Response("bad_signature", { status: 400 });
  }

  // 2) Only a completed, PAID Checkout session credits rcoin.
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.payment_status === "paid") {
      const meta = session.metadata ?? {};
      const userId = meta.user_id ?? session.client_reference_id ?? null;
      const payCents = Math.trunc(Number(meta.pay_cents ?? session.amount_total ?? 0));

      if (userId && Number.isFinite(payCents) && payCents >= 100) {
        const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
          auth: { persistSession: false },
        });
        const { error } = await admin.rpc("rib_credit_rcoin_purchase", {
          p_user_id: userId,
          p_stripe_session_id: session.id,
          p_pay_cents: payCents,
        });
        // On a DB error, return 500 so Stripe retries (idempotency makes retries safe).
        if (error) return new Response("credit_failed", { status: 500 });
      }
    }
  }

  // Acknowledge everything else so Stripe stops retrying events we don't act on.
  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
