-- ============================================================================
-- Runinback — real rcoin top-ups via Stripe (TEST MODE).
--
-- Until this migration, rcoin was bought with rib_buy_rcoin_test, a client RPC
-- that credited the balance instantly with no payment. This adds the money leg:
-- the browser can NEVER credit itself. A purchase is only ever credited by the
-- stripe-webhook Edge Function, after Stripe has verified the payment and the
-- function has verified Stripe's signature. The webhook runs with the service
-- role and calls rib_credit_rcoin_purchase below; that function is the single,
-- idempotent credit path.
--
-- STILL TEST MODE. Use Stripe *test* keys only. No real money moves until legal
-- review clears rcoin. The 5% entry fee is unchanged and transparent
-- ($100 = 95 rcoin); withdrawals stay 1:1 with no exit fee.
--
-- Additive and idempotent: adds one table and one function, re-runnable. Safe to
-- paste after 0001..0004. Signatures new, so it defines its own GRANTs.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- rcoin_purchases : one row per Stripe Checkout session that credited rcoin.
-- The UNIQUE stripe_session_id is the idempotency key: a webhook that Stripe
-- retries (it retries until it gets a 2xx) credits the balance exactly once.
-- ----------------------------------------------------------------------------
create table if not exists public.rcoin_purchases (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  stripe_session_id  text not null unique,
  pay_cents          bigint not null check (pay_cents >= 100 and pay_cents <= 200000),
  credited_cents     bigint not null check (credited_cents >= 0),
  created_at         timestamptz not null default now()
);
create index if not exists rcoin_purchases_user_idx on public.rcoin_purchases (user_id, created_at desc);
comment on table public.rcoin_purchases is 'One row per settled Stripe Checkout session (TEST MODE). stripe_session_id is UNIQUE = idempotency key; credited only by the stripe-webhook Edge Function.';

-- ============================================================================
-- Row Level Security — deny by default; owner may read their own receipts.
-- No client writes at all: only the service role (webhook) inserts, via the
-- SECURITY DEFINER function below.
-- ============================================================================
alter table public.rcoin_purchases enable row level security;

drop policy if exists "rcoin_purchases: select own" on public.rcoin_purchases;
create policy "rcoin_purchases: select own"
  on public.rcoin_purchases for select to authenticated
  using ( user_id = (select auth.uid()) );

grant select on public.rcoin_purchases to authenticated;

-- ============================================================================
-- rib_credit_rcoin_purchase : credit rcoin from a Stripe payment the webhook
-- has already verified. The user_id is the TRUSTED id the checkout session was
-- created for (carried in the session metadata / client_reference_id), not
-- anything the browser sent. Idempotent by stripe_session_id: a replayed or
-- retried webhook returns 0 and moves no money a second time.
--
-- Not exposed to clients: execute is revoked from public and granted only to
-- service_role, so the only caller is the webhook running with the service key.
-- ============================================================================
create or replace function public.rib_credit_rcoin_purchase(
  p_user_id uuid, p_stripe_session_id text, p_pay_cents bigint
) returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_credit  bigint;
  v_row_id  uuid;
begin
  if p_user_id is null then raise exception 'missing user'; end if;
  if p_stripe_session_id is null or char_length(trim(p_stripe_session_id)) < 1 then
    raise exception 'missing session';
  end if;
  if p_pay_cents is null or p_pay_cents < 100 or p_pay_cents > 200000 then
    raise exception 'invalid amount';
  end if;

  -- 5% entry commission, exact integer math on cents (95/100 of what was paid).
  v_credit := (p_pay_cents * 95) / 100;

  -- Claim the session id first. If a concurrent / retried webhook already
  -- claimed it, the insert no-ops and we credit nothing (idempotency).
  insert into public.rcoin_purchases (user_id, stripe_session_id, pay_cents, credited_cents)
  values (p_user_id, p_stripe_session_id, p_pay_cents, v_credit)
  on conflict (stripe_session_id) do nothing
  returning id into v_row_id;

  if v_row_id is null then
    return 0;   -- already credited for this Stripe session
  end if;

  perform public.rib_apply(
    p_user_id, 'rcoin_purchase', v_credit, 0, 'stripe', v_row_id,
    'Bought ' || (v_credit / 100)::text || ' rcoin via Stripe (5% entry fee)'
  );
  return v_credit;
end;
$$;

revoke all on function public.rib_credit_rcoin_purchase(uuid,text,bigint) from public;
grant execute on function public.rib_credit_rcoin_purchase(uuid,text,bigint) to service_role;
