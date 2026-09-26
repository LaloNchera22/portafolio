// ============================================================================
// stripe-checkout — start a Stripe Checkout session to buy rcoin (TEST MODE).
//
// Zero-trust: the buyer's identity comes from a VERIFIED JWT, never the body.
// The browser only sends how much it wants to pay; this function creates the
// Checkout session with the Stripe SECRET key (server-only) and returns the
// hosted URL to redirect to. NO balance is credited here — crediting happens
// only in stripe-webhook, after Stripe confirms the payment. The user id and
// the paid amount are stamped into the session so the webhook can trust them.
//
// TEST MODE: set STRIPE_SECRET_KEY to a Stripe *test* secret key (sk_test_...).
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@16?target=deno";
import { corsHeaders, json } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
// Where Stripe sends the buyer back. Use the site origin (same as CORS).
const SITE_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "";

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!STRIPE_SECRET_KEY) return json({ error: "stripe_not_configured" }, 503);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);

  // 1) Identity from the verified JWT — the ONLY source of the buyer's id.
  const asUser = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: { user }, error: userErr } = await asUser.auth.getUser();
  if (userErr || !user) return json({ error: "unauthorized" }, 401);

  // 2) Validate the amount (allowlist a plain integer number of cents).
  let payload: { pay_cents?: unknown } = {};
  try { payload = await req.json(); } catch { /* empty body -> invalid below */ }
  const payCents = Math.trunc(Number(payload.pay_cents));
  if (!Number.isFinite(payCents) || payCents < 100 || payCents > 200000) {
    return json({ error: "invalid_amount" }, 400);
  }

  const rcoin = Math.floor((payCents * 95) / 100 / 100);
  const base = (SITE_ORIGIN && SITE_ORIGIN !== "*") ? SITE_ORIGIN : new URL(req.url).origin;

  // 3) Create the Checkout session. The user id and paid amount are stamped
  //    into metadata + client_reference_id so the webhook can trust them.
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      client_reference_id: user.id,
      metadata: { user_id: user.id, pay_cents: String(payCents) },
      payment_intent_data: { metadata: { user_id: user.id, pay_cents: String(payCents) } },
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: payCents,
          product_data: {
            name: `${rcoin} rcoin (test)`,
            description: "rcoin top-up — 5% entry fee included. Test mode, no real money.",
          },
        },
      }],
      success_url: `${base}/console.html?checkout=success`,
      cancel_url: `${base}/console.html?checkout=cancel`,
    });
    return json({ url: session.url });
  } catch (_e) {
    return json({ error: "stripe_error" }, 502);
  }
});
