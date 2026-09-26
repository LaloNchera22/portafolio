// ============================================================================
// crypto-checkout — start a Coinbase Commerce charge to buy rcoin with crypto
// (USDC/USDT on Base and other chains). TEST MODE.
//
// Zero-trust, mirroring stripe-checkout: the buyer's identity comes from a
// VERIFIED JWT, never the body. The browser only says how much it wants to pay;
// this function creates the charge with the Coinbase Commerce API key
// (server-only) and returns the hosted checkout URL to redirect to. NO balance
// is credited here — crediting happens only in crypto-webhook, after Coinbase
// confirms the payment. The user id and paid amount are stamped into the charge
// metadata so the webhook can trust them.
//
// TEST MODE: no real money moves until legal review clears rcoin.
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const COINBASE_API_KEY = Deno.env.get("COINBASE_COMMERCE_API_KEY") ?? "";
// Where Coinbase sends the buyer back. Use the site origin (same as CORS).
const SITE_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "";
const COMMERCE_URL = "https://api.commerce.coinbase.com/charges";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!COINBASE_API_KEY) return json({ error: "crypto_not_configured" }, 503);

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
  const amountUsd = (payCents / 100).toFixed(2);

  // 3) Create the charge. pricing_type fixed_price pins the USD amount; the buyer
  //    pays the equivalent in USDC/USDT/etc. The user id + paid amount go in
  //    metadata so the webhook credits the right person the right amount.
  try {
    const resp = await fetch(COMMERCE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CC-Api-Key": COINBASE_API_KEY,
        "X-CC-Version": "2018-03-22",
      },
      body: JSON.stringify({
        name: `${rcoin} rcoin (test)`,
        description: "rcoin top-up — 5% entry fee included. Test mode, no real money.",
        pricing_type: "fixed_price",
        local_price: { amount: amountUsd, currency: "USD" },
        metadata: { user_id: user.id, pay_cents: String(payCents) },
        redirect_url: `${base}/console.html?checkout=success`,
        cancel_url: `${base}/console.html?checkout=cancel`,
      }),
    });
    if (!resp.ok) return json({ error: "crypto_error" }, 502);
    const body = await resp.json();
    const url = body?.data?.hosted_url;
    if (!url) return json({ error: "crypto_error" }, 502);
    return json({ url });
  } catch (_e) {
    return json({ error: "crypto_error" }, 502);
  }
});
