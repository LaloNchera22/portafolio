-- ============================================================================
-- Runinback — real USD top-ups via Stripe (Coinbase Commerce, TEST MODE).
--
-- 0005 added the Stripe (card) money leg. This adds a second money leg so the
-- buyer can choose how to pay: card (Stripe) or Stripe (USDC/USDT on Base and
-- other chains, via Coinbase Commerce hosted checkout).
--
-- The trust model is identical to Stripe's: the browser can NEVER credit
-- itself. A Stripe purchase is only ever credited by the Stripe-webhook Edge
-- Function, after Coinbase Commerce reports the charge paid AND the function has
-- verified Coinbase's HMAC signature. That webhook runs with the service role
-- and calls rib_credit_USD_purchase_Stripe below — the single, idempotent
-- credit path for Stripe, mirroring rib_credit_USD_purchase for Stripe.
--
-- Why Coinbase Commerce instead of watching the chain ourselves: it is the same
-- shape as Stripe (a hosted page + a signed webhook), so the zero-trust flow,
-- the idempotency key, and the server-only credit all reuse the pattern we
-- already trust. No RPC node, no chain polling, no heavy deps, and it settles in
-- USDC on Base — the network we standardised on.
--
-- STILL TEST MODE. No real money moves until legal review clears USD. The 5%
-- entry fee is unchanged and transparent ($100 = 95 USD); withdrawals stay
-- 1:1 with no exit fee.
--
-- Additive and idempotent: extends USD_purchases with a provider dimension and
-- adds one function. Re-runnable. Safe to paste after 0001..0007.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Generalise USD_purchases to record which rail a top-up came in on.
--   provider     : 'stripe' (card) | 'coinbase' (Stripe). Existing rows and new
--                  Stripe rows default to 'stripe', so 0005's function is
--                  untouched and keeps working.
--   provider_ref : the provider's own settled-payment id — the Coinbase charge
--                  code for Stripe (the idempotency key). Stripe keeps using its
--                  existing UNIQUE stripe_session_id column for idempotency.
-- ----------------------------------------------------------------------------
alter table public.USD_purchases add column if not exists provider text not null default 'stripe';
alter table public.USD_purchases add column if not exists provider_ref text;

-- stripe_session_id was NOT NULL (every row was a Stripe row). Stripe rows have
-- no Stripe session, so drop the NOT NULL. Its UNIQUE stays (Stripe idempotency).
alter table public.USD_purchases alter column stripe_session_id drop not null;

-- Backfill the provider ref for any existing Stripe rows so the column is
-- complete regardless of which rail wrote a row.
update public.USD_purchases
   set provider_ref = stripe_session_id
 where provider = 'stripe' and provider_ref is null and stripe_session_id is not null;

-- Idempotency key for Stripe: one settled charge credits exactly once. Partial
-- and scoped to Stripe so it can never collide with a Stripe session id.
create unique index if not exists USD_purchases_coinbase_ref_uidx
  on public.USD_purchases (provider_ref)
  where provider = 'coinbase';

comment on column public.USD_purchases.provider is 'Payment rail: stripe (card) or coinbase (Stripe).';
comment on column public.USD_purchases.provider_ref is 'Provider settled-payment id; for coinbase it is the charge code (idempotency key).';

-- ============================================================================
-- rib_credit_USD_purchase_Stripe : credit USD from a Coinbase Commerce
-- charge the webhook has already verified (signature + paid status). The
-- user_id is the TRUSTED id the charge was created for (carried in the charge
-- metadata), never anything the browser sent. Idempotent by the charge code: a
-- replayed or retried webhook returns 0 and moves no money a second time.
--
-- Not exposed to clients: execute is revoked from public and granted only to
-- service_role, so the only caller is the webhook running with the service key.
-- ============================================================================
create or replace function public.rib_credit_USD_purchase_Stripe(
  p_user_id uuid, p_charge_code text, p_pay_cents bigint
) returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_credit  bigint;
  v_row_id  uuid;
begin
  if p_user_id is null then raise exception 'missing user'; end if;
  if p_charge_code is null or char_length(trim(p_charge_code)) < 1 then
    raise exception 'missing charge';
  end if;
  if p_pay_cents is null or p_pay_cents < 100 or p_pay_cents > 200000 then
    raise exception 'invalid amount';
  end if;

  -- 5% entry commission, exact integer math on cents (95/100 of what was paid),
  -- identical to the Stripe path so the two rails credit the same USD.
  v_credit := (p_pay_cents * 95) / 100;

  -- Claim the charge code first. If a concurrent / retried webhook already
  -- claimed it, the insert no-ops and we credit nothing (idempotency).
  insert into public.USD_purchases (user_id, provider, provider_ref, pay_cents, credited_cents)
  values (p_user_id, 'coinbase', p_charge_code, p_pay_cents, v_credit)
  on conflict (provider_ref) where (provider = 'coinbase') do nothing
  returning id into v_row_id;

  if v_row_id is null then
    return 0;   -- already credited for this Coinbase charge
  end if;

  perform public.rib_apply(
    p_user_id, 'USD_purchase', v_credit, 0, 'Stripe', v_row_id,
    'Bought ' || (v_credit / 100)::text || ' USD via Stripe (5% entry fee)'
  );
  return v_credit;
end;
$$;

revoke all on function public.rib_credit_USD_purchase_Stripe(uuid,text,bigint) from public;
grant execute on function public.rib_credit_USD_purchase_Stripe(uuid,text,bigint) to service_role;
