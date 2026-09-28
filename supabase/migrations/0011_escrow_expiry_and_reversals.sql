-- ============================================================================
-- Runinback — escrow expiry and top-up reversals (2026-09-28).
--
--   1) Stuck escrow: open tables / challenges never expired, so a host's stake
--      stayed locked until they cancelled, and abandoned matches needed a
--      player to call the void RPC. rib_expire_stale() refunds open rows older
--      than 24h and voids (refunding both players) active or disputed rows
--      idle for 48h. It works in batches with SKIP LOCKED so it never blocks
--      live traffic, and it is scheduled with pg_cron when available.
--   2) Chargebacks: a refunded or disputed card payment left the rcoin in the
--      wallet. rib_reverse_rcoin_purchase() (called by the Stripe webhook)
--      debits what was credited; if the buyer already spent it, it debits what
--      is left and FREEZES the wallet. A frozen wallet can't stake, join or
--      withdraw — enforced centrally in rib_apply.
--   3) rib_cleanup_matches deletes in bounded batches.
--
-- Idempotent. New functions are service_role only.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Schema
-- ----------------------------------------------------------------------------
alter table public.wallets add column if not exists frozen_at     timestamptz;
alter table public.wallets add column if not exists frozen_reason text;

alter table public.rcoin_purchases add column if not exists reversed_at     timestamptz;
alter table public.rcoin_purchases add column if not exists reversed_cents  bigint not null default 0;
alter table public.rcoin_purchases add column if not exists reversal_reason text;

alter table public.wallet_ledger drop constraint if exists wallet_ledger_kind_check;
alter table public.wallet_ledger add constraint wallet_ledger_kind_check
  check (kind in (
    'deposit','withdrawal',
    'challenge_lock','challenge_win','challenge_settled','challenge_refund',
    'tournament_entry','tournament_prize','tournament_refund',
    'rcoin_purchase','rcoin_reversal',
    'game_lock','game_win','game_settled','game_refund'
  )) not valid;
alter table public.wallet_ledger validate constraint wallet_ledger_kind_check;

-- Index for the expiry sweeps (active/disputed rows by inactivity).
create index if not exists game_matches_live_idle_idx
  on public.game_matches (updated_at) where status in ('active','disputed');
create index if not exists challenges_live_matched_idx
  on public.challenges (matched_at) where status in ('active','disputed');
create index if not exists challenges_pending_idx
  on public.challenges (created_at) where status = 'pending';

-- ----------------------------------------------------------------------------
-- rib_apply: same as 0009, plus frozen wallets can't spend.
-- ----------------------------------------------------------------------------
create or replace function public.rib_apply(
  p_uid           uuid,
  p_kind          text,
  p_balance_delta bigint,
  p_locked_delta  bigint,
  p_ref_type      text,
  p_ref_id        uuid,
  p_memo          text
) returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_balance bigint;
begin
  insert into public.wallets (user_id) values (p_uid)
    on conflict (user_id) do nothing;

  if p_balance_delta < 0 and p_kind <> 'rcoin_reversal'
     and exists (select 1 from public.wallets where user_id = p_uid and frozen_at is not null) then
    raise exception 'wallet is frozen' using hint = 'wallet_frozen';
  end if;

  update public.wallets
     set test_balance_cents = test_balance_cents + p_balance_delta,
         test_locked_cents  = test_locked_cents  + p_locked_delta,
         updated_at = now()
   where user_id = p_uid
     and test_balance_cents + p_balance_delta >= 0
     and test_locked_cents  + p_locked_delta  >= 0
  returning test_balance_cents into v_balance;

  if v_balance is null then
    raise exception 'insufficient balance' using hint = 'insufficient_balance';
  end if;

  insert into public.wallet_ledger
    (user_id, kind, amount_cents, balance_after_cents, ref_type, ref_id, memo)
  values
    (p_uid, p_kind, p_balance_delta, v_balance, p_ref_type, p_ref_id, p_memo);

  return v_balance;
end;
$$;
revoke execute on function public.rib_apply(uuid,text,bigint,bigint,text,uuid,text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Reversal of a refunded / disputed top-up. Returns the cents debited
-- (0 when the purchase is unknown or already reversed: idempotent).
-- ----------------------------------------------------------------------------
create or replace function public.rib_reverse_rcoin_purchase(
  p_provider text, p_ref text, p_reason text
) returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_p       public.rcoin_purchases;
  v_balance bigint;
  v_debit   bigint;
begin
  if p_provider not in ('stripe','coinbase') or p_ref is null then
    raise exception 'invalid reversal reference' using hint = 'invalid_amount';
  end if;

  select * into v_p from public.rcoin_purchases
   where (p_provider = 'stripe'   and stripe_session_id = p_ref)
      or (p_provider = 'coinbase' and provider = 'coinbase' and provider_ref = p_ref)
   for update;
  if v_p.id is null or v_p.reversed_at is not null then
    return 0;
  end if;

  select test_balance_cents into v_balance from public.wallets where user_id = v_p.user_id for update;
  v_debit := least(v_p.credited_cents, coalesce(v_balance, 0));

  if v_debit > 0 then
    perform public.rib_apply(
      v_p.user_id, 'rcoin_reversal', -v_debit, 0,
      case when p_provider = 'stripe' then 'stripe' else 'crypto' end, v_p.id,
      left('Top-up reversed (' || coalesce(p_reason, 'refund') || ')', 140)
    );
  end if;

  update public.rcoin_purchases
     set reversed_at = now(), reversed_cents = v_debit, reversal_reason = p_reason
   where id = v_p.id;

  -- Already spent: keep what's left from being staked or withdrawn until an
  -- operator settles the shortfall.
  if v_debit < v_p.credited_cents then
    update public.wallets
       set frozen_at = coalesce(frozen_at, now()),
           frozen_reason = coalesce(frozen_reason, 'Reversed top-up shortfall: ' || (v_p.credited_cents - v_debit)::text || ' cents')
     where user_id = v_p.user_id;
  end if;

  return v_debit;
end;
$$;
revoke execute on function public.rib_reverse_rcoin_purchase(text,text,text) from public, anon, authenticated;
grant execute on function public.rib_reverse_rcoin_purchase(text,text,text) to service_role;

-- ----------------------------------------------------------------------------
-- Escrow expiry sweep. Returns how many rows each rule resolved.
-- ----------------------------------------------------------------------------
create or replace function public.rib_expire_stale(
  p_open_hours int default 24, p_idle_hours int default 48, p_batch int default 500
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_m public.game_matches;
  v_c public.challenges;
  v_open_games int := 0;
  v_open_challenges int := 0;
  v_idle_games int := 0;
  v_idle_challenges int := 0;
begin
  -- Open tables nobody joined: refund the host.
  for v_m in
    select * from public.game_matches
     where status = 'open' and created_at < now() - make_interval(hours => p_open_hours)
     order by created_at limit p_batch
     for update skip locked
  loop
    perform public.rib_apply(v_m.host_id, 'game_refund', v_m.stake_cents, -v_m.stake_cents, 'game', v_m.id, 'Open table expired, stake refunded');
    update public.game_matches set status = 'cancelled', settled_at = now() where id = v_m.id;
    v_open_games := v_open_games + 1;
  end loop;

  -- Open / pending challenges nobody accepted: refund the creator.
  for v_c in
    select * from public.challenges
     where status in ('open','pending') and created_at < now() - make_interval(hours => p_open_hours)
     order by created_at limit p_batch
     for update skip locked
  loop
    perform public.rib_apply(v_c.creator_id, 'challenge_refund', v_c.stake_cents, -v_c.stake_cents, 'challenge', v_c.id, 'Open challenge expired, stake refunded');
    update public.challenges set status = 'cancelled', settled_at = now() where id = v_c.id;
    v_open_challenges := v_open_challenges + 1;
  end loop;

  -- Abandoned or disputed matches: void and refund both players.
  for v_m in
    select * from public.game_matches
     where status in ('active','disputed') and updated_at < now() - make_interval(hours => p_idle_hours)
     order by updated_at limit p_batch
     for update skip locked
  loop
    perform public.rib_lock_wallets(v_m.host_id, v_m.guest_id);
    perform public.rib_apply(v_m.host_id, 'game_refund', v_m.stake_cents, -v_m.stake_cents, 'game', v_m.id, 'Match voided (inactivity), stake refunded');
    if v_m.guest_id is not null then
      perform public.rib_apply(v_m.guest_id, 'game_refund', v_m.stake_cents, -v_m.stake_cents, 'game', v_m.id, 'Match voided (inactivity), stake refunded');
    end if;
    update public.game_matches set status = 'cancelled', settled_at = now() where id = v_m.id;
    v_idle_games := v_idle_games + 1;
  end loop;

  for v_c in
    select * from public.challenges
     where status in ('active','disputed') and matched_at < now() - make_interval(hours => p_idle_hours)
     order by matched_at limit p_batch
     for update skip locked
  loop
    perform public.rib_lock_wallets(v_c.creator_id, v_c.opponent_id);
    perform public.rib_apply(v_c.creator_id, 'challenge_refund', v_c.stake_cents, -v_c.stake_cents, 'challenge', v_c.id, 'Challenge voided (inactivity), stake refunded');
    if v_c.opponent_id is not null then
      perform public.rib_apply(v_c.opponent_id, 'challenge_refund', v_c.stake_cents, -v_c.stake_cents, 'challenge', v_c.id, 'Challenge voided (inactivity), stake refunded');
    end if;
    update public.challenges set status = 'cancelled', settled_at = now() where id = v_c.id;
    v_idle_challenges := v_idle_challenges + 1;
  end loop;

  return jsonb_build_object(
    'open_games', v_open_games, 'open_challenges', v_open_challenges,
    'idle_games', v_idle_games, 'idle_challenges', v_idle_challenges
  );
end;
$$;
revoke execute on function public.rib_expire_stale(int,int,int) from public, anon, authenticated;
grant execute on function public.rib_expire_stale(int,int,int) to service_role;

-- ----------------------------------------------------------------------------
-- Cleanup in bounded batches (one huge DELETE would bloat WAL and hold locks).
-- ----------------------------------------------------------------------------
create or replace function public.rib_cleanup_matches(p_days int default 30)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare v_deleted bigint;
begin
  if p_days is null or p_days < 1 then p_days := 30; end if;
  delete from public.game_matches
   where id in (
     select id from public.game_matches
      where status in ('cancelled','settled')
        and coalesce(settled_at, updated_at) < now() - make_interval(days => p_days)
      limit 5000
   );
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;
revoke execute on function public.rib_cleanup_matches(int) from public, anon, authenticated;
grant execute on function public.rib_cleanup_matches(int) to service_role;

-- ----------------------------------------------------------------------------
-- Schedule (Supabase ships pg_cron; skipped where it isn't installed).
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('rib-expire-stale', '*/10 * * * *', 'select public.rib_expire_stale()');
    perform cron.schedule('rib-cleanup-matches', '17 3 * * *', 'select public.rib_cleanup_matches(30)');
  else
    raise notice 'pg_cron not available: schedule rib_expire_stale() and rib_cleanup_matches() externally';
  end if;
end;
$$;
