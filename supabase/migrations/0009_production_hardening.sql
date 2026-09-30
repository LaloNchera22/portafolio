-- ============================================================================
-- Runinback — production hardening (2026-09-28).
--
-- Closes the findings of the pre-scale security + database review:
--
--   1) Free rcoin: rib_deposit_test / rib_buy_rcoin_test credited any signed-in
--      user with no payment. They now require the server-side platform setting
--      `test_payments_enabled` (OFF by default). Real top-ups keep flowing only
--      through the verified Stripe / Coinbase webhooks.
--   2) Privileges: internal money functions are revoked from anon/authenticated
--      (Supabase default privileges grant EXECUTE to both), client roles lose
--      write privileges on money tables, and profiles / api_keys updates are
--      restricted to the columns the UI edits. A revoked API key can no longer
--      be un-revoked.
--   3) Race conditions: rib_apply is now the single, atomic funds check (guarded
--      UPDATE), per-user caps take an advisory lock, and every function that
--      touches two wallets locks them in a deterministic order (no deadlocks).
--   4) Tournament integrity: the organizer can no longer award the prize pool
--      to themselves.
--   5) Language: every RPC error is English and carries a stable `hint` code the
--      client maps to copy (src/scripts/lib/errors.js), so wording can change
--      without breaking the UI. Legacy Spanish ledger memos are translated.
--   6) Indexes for the console's queries and unindexed foreign keys.
--
-- Signatures are unchanged, so existing GRANTs to `authenticated` stay valid.
-- Idempotent: safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Platform settings (server-only). No RLS policies: clients cannot read or
--    write it; SECURITY DEFINER functions and the service role can.
--    Enable test top-ups on a staging project with:
--      update public.platform_settings set value = 'true' where key = 'test_payments_enabled';
-- ----------------------------------------------------------------------------
create table if not exists public.platform_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.platform_settings enable row level security;
revoke all on public.platform_settings from anon, authenticated;
comment on table public.platform_settings is 'Server-only feature flags. No client access (RLS, no policies).';

insert into public.platform_settings (key, value)
values ('test_payments_enabled', 'false'::jsonb)
on conflict (key) do nothing;

create or replace function public.rib_test_payments_enabled()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((select value = 'true'::jsonb from public.platform_settings where key = 'test_payments_enabled'), false);
$$;

-- ----------------------------------------------------------------------------
-- 2) Privileges
-- ----------------------------------------------------------------------------
-- New functions are no longer executable by default: every RPC must be granted
-- explicitly (every migration already does so). The PUBLIC default is global
-- (a per-schema rule cannot remove it), so it is revoked without IN SCHEMA.
alter default privileges revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon, authenticated;

-- Internal-only functions.
revoke execute on function public.rib_apply(uuid,text,bigint,bigint,text,uuid,text)       from public, anon, authenticated;
revoke execute on function public.rib_credit_rcoin_purchase(uuid,text,bigint)             from public, anon, authenticated;
revoke execute on function public.rib_credit_rcoin_purchase_crypto(uuid,text,bigint)      from public, anon, authenticated;
revoke execute on function public.rib_cleanup_matches(int)                                from public, anon, authenticated;
revoke execute on function public.rib_test_payments_enabled()                             from public, anon, authenticated;
revoke execute on function public.handle_new_user()                                       from public, anon, authenticated;

-- Nothing is executable through the implicit PUBLIC grant (which anon
-- inherits); signed-out visitors never call RPCs (Steam login uses the service
-- role). Client RPCs are re-granted to `authenticated` explicitly in section 8.
revoke execute on all functions in schema public from public, anon;

-- Money and match tables: read-only for clients, writes only through RPCs.
revoke insert, update, delete, truncate on
  public.wallets, public.wallet_ledger, public.challenges, public.tournaments,
  public.tournament_entries, public.game_matches, public.rcoin_purchases
from anon, authenticated;
revoke all on
  public.wallets, public.wallet_ledger, public.challenges, public.tournaments,
  public.tournament_entries, public.game_matches, public.rcoin_purchases,
  public.profiles, public.projects, public.api_keys
from anon;

-- profiles: users may edit only their handle and display name (not role).
revoke insert, update, delete, truncate on public.profiles from authenticated;
grant update (username, display_name) on public.profiles to authenticated;

-- api_keys: users may only revoke (set revoked_at). Keys are minted server-side.
revoke insert, update, delete, truncate on public.api_keys from authenticated;
grant update (revoked_at) on public.api_keys to authenticated;

create or replace function public.rib_api_keys_guard_revocation()
returns trigger
language plpgsql security invoker set search_path = ''
as $$
begin
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'a revoked API key cannot be restored' using hint = 'key_already_revoked';
  end if;
  return new;
end;
$$;
revoke execute on function public.rib_api_keys_guard_revocation() from public, anon, authenticated;
drop trigger if exists api_keys_guard_revocation on public.api_keys;
create trigger api_keys_guard_revocation
  before update on public.api_keys
  for each row execute function public.rib_api_keys_guard_revocation();

-- ----------------------------------------------------------------------------
-- 3) Core money primitives
-- ----------------------------------------------------------------------------
-- rib_apply: the ONLY place balances change. The guarded UPDATE makes the funds
-- check and the write one atomic step, so concurrent calls can never overdraw
-- and never surface a raw CHECK violation.
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

-- Lock two wallets in a deterministic (uuid) order before moving money between
-- them. Every multi-wallet RPC calls this first, so two settlements between
-- the same players can never deadlock.
create or replace function public.rib_lock_wallets(p_a uuid, p_b uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform 1 from public.wallets
   where user_id in (p_a, p_b)
   order by user_id
   for update;
end;
$$;
revoke execute on function public.rib_lock_wallets(uuid,uuid) from public, anon, authenticated;

-- Per-user mutex for check-then-act caps (live rows, balance ceiling).
create or replace function public.rib_lock_user(p_uid uuid)
returns void
language sql security definer set search_path = ''
as $$
  select pg_advisory_xact_lock(hashtextextended('rib_user:' || p_uid::text, 0));
$$;
revoke execute on function public.rib_lock_user(uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 4) Wallet RPCs (test mode)
-- ----------------------------------------------------------------------------
create or replace function public.rib_deposit_test(p_amount_cents bigint)
returns public.wallets
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_bal bigint; v_row public.wallets;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  if not public.rib_test_payments_enabled() then
    raise exception 'test payments are disabled' using hint = 'test_payments_disabled';
  end if;
  if p_amount_cents is null or p_amount_cents < 100 or p_amount_cents > 100000 then
    raise exception 'invalid amount (between $1 and $1000)' using hint = 'invalid_amount';
  end if;
  perform public.rib_lock_user(v_uid);
  select test_balance_cents into v_bal from public.wallets where user_id = v_uid;
  if coalesce(v_bal, 0) + p_amount_cents > 1000000 then
    raise exception 'test balance cap reached ($10,000)' using hint = 'deposit_cap_reached';
  end if;
  perform public.rib_apply(v_uid, 'deposit', p_amount_cents, 0, null, null, 'Test deposit');
  select * into v_row from public.wallets where user_id = v_uid;
  return v_row;
end;
$$;

create or replace function public.rib_buy_rcoin_test(p_pay_cents bigint)
returns public.wallets
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_bal bigint; v_credit bigint; v_row public.wallets;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  if not public.rib_test_payments_enabled() then
    raise exception 'test payments are disabled' using hint = 'test_payments_disabled';
  end if;
  if p_pay_cents is null or p_pay_cents < 100 or p_pay_cents > 200000 then
    raise exception 'invalid amount (between $1 and $2000)' using hint = 'invalid_amount';
  end if;
  -- 5% entry commission, exact integer math on cents (95/100 of what was paid).
  v_credit := (p_pay_cents * 95) / 100;
  perform public.rib_lock_user(v_uid);
  select test_balance_cents into v_bal from public.wallets where user_id = v_uid;
  if coalesce(v_bal, 0) + v_credit > 1000000 then
    raise exception 'test balance cap reached ($10,000)' using hint = 'deposit_cap_reached';
  end if;
  perform public.rib_apply(v_uid, 'rcoin_purchase', v_credit, 0, null, null,
    'Bought ' || (v_credit / 100)::text || ' rcoin (5% entry fee)');
  select * into v_row from public.wallets where user_id = v_uid;
  return v_row;
end;
$$;

create or replace function public.rib_withdraw_test(p_amount_cents bigint)
returns public.wallets
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_row public.wallets;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  if p_amount_cents is null or p_amount_cents < 100 then
    raise exception 'invalid amount' using hint = 'invalid_amount';
  end if;
  perform public.rib_apply(v_uid, 'withdrawal', -p_amount_cents, 0, null, null, 'Test withdrawal');
  select * into v_row from public.wallets where user_id = v_uid;
  return v_row;
end;
$$;

-- ----------------------------------------------------------------------------
-- 5) Challenges
-- ----------------------------------------------------------------------------
create or replace function public.rib_challenge_create(
  p_game text, p_mode text, p_stake_cents bigint, p_target_username text default null
) returns public.challenges
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_target uuid; v_status text; v_cnt int; v_row public.challenges;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  if p_game is null or char_length(trim(p_game)) < 1 then
    raise exception 'game is required' using hint = 'game_required';
  end if;
  if p_stake_cents is null or p_stake_cents < 100 or p_stake_cents > 100000 then
    raise exception 'invalid stake (between $1 and $1000)' using hint = 'invalid_stake';
  end if;

  perform public.rib_lock_user(v_uid);
  select count(*) into v_cnt from public.challenges
   where creator_id = v_uid and status in ('open','pending','active');
  if v_cnt >= 20 then
    raise exception 'too many live challenges (max 20)' using hint = 'too_many_open';
  end if;

  if p_target_username is not null and char_length(trim(p_target_username)) > 0 then
    select id into v_target from public.profiles where username = trim(p_target_username);
    if v_target is null then raise exception 'user not found' using hint = 'user_not_found'; end if;
    if v_target = v_uid then raise exception 'you cannot challenge yourself' using hint = 'cannot_challenge_self'; end if;
    v_status := 'pending';
  else
    v_status := 'open';
  end if;

  insert into public.challenges (creator_id, target_id, game, mode, stake_cents, status)
  values (v_uid, v_target, trim(p_game), coalesce(nullif(trim(p_mode), ''), '1v1'), p_stake_cents, v_status)
  returning * into v_row;

  perform public.rib_apply(v_uid, 'challenge_lock', -p_stake_cents, p_stake_cents, 'challenge', v_row.id, 'Stake locked');
  return v_row;
end;
$$;

create or replace function public.rib_challenge_accept(p_challenge_id uuid)
returns public.challenges
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_c public.challenges;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  select * into v_c from public.challenges where id = p_challenge_id for update;
  if v_c.id is null then raise exception 'challenge not found' using hint = 'challenge_not_found'; end if;
  if v_c.creator_id = v_uid then raise exception 'you cannot accept your own challenge' using hint = 'cannot_accept_own'; end if;
  if v_c.status not in ('open','pending') then
    raise exception 'this challenge is no longer available' using hint = 'challenge_unavailable';
  end if;
  if v_c.status = 'pending' and v_c.target_id <> v_uid then
    raise exception 'this challenge is for another player' using hint = 'challenge_not_for_you';
  end if;

  perform public.rib_apply(v_uid, 'challenge_lock', -v_c.stake_cents, v_c.stake_cents, 'challenge', v_c.id, 'Stake locked');

  update public.challenges
     set opponent_id = v_uid, status = 'active', matched_at = now()
   where id = v_c.id
   returning * into v_c;
  return v_c;
end;
$$;

create or replace function public.rib_challenge_report(p_challenge_id uuid, p_winner_id uuid)
returns public.challenges
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_c public.challenges; v_pot bigint; v_loser uuid;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  select * into v_c from public.challenges where id = p_challenge_id for update;
  if v_c.id is null then raise exception 'challenge not found' using hint = 'challenge_not_found'; end if;
  if v_c.status not in ('active','disputed') then
    raise exception 'this challenge is not in play' using hint = 'challenge_not_active';
  end if;
  if v_uid <> v_c.creator_id and v_uid is distinct from v_c.opponent_id then
    raise exception 'you are not in this challenge' using hint = 'not_a_participant';
  end if;
  if p_winner_id is null or (p_winner_id <> v_c.creator_id and p_winner_id is distinct from v_c.opponent_id) then
    raise exception 'invalid winner' using hint = 'invalid_winner';
  end if;

  if v_uid = v_c.creator_id then
    update public.challenges set creator_report = p_winner_id where id = v_c.id returning * into v_c;
  else
    update public.challenges set opponent_report = p_winner_id where id = v_c.id returning * into v_c;
  end if;

  if v_c.creator_report is not null and v_c.opponent_report is not null then
    if v_c.creator_report = v_c.opponent_report then
      perform public.rib_lock_wallets(v_c.creator_id, v_c.opponent_id);
      v_pot   := v_c.stake_cents * 2;
      v_loser := case when v_c.creator_report = v_c.creator_id then v_c.opponent_id else v_c.creator_id end;
      perform public.rib_apply(v_c.creator_report, 'challenge_win', v_pot, -v_c.stake_cents, 'challenge', v_c.id, 'Challenge won');
      perform public.rib_apply(v_loser, 'challenge_settled', 0, -v_c.stake_cents, 'challenge', v_c.id, 'Challenge lost');
      update public.challenges set status = 'settled', winner_id = v_c.creator_report, settled_at = now()
       where id = v_c.id returning * into v_c;
    else
      update public.challenges set status = 'disputed' where id = v_c.id returning * into v_c;
    end if;
  end if;
  return v_c;
end;
$$;

create or replace function public.rib_challenge_cancel(p_challenge_id uuid)
returns public.challenges
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_c public.challenges;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  select * into v_c from public.challenges where id = p_challenge_id for update;
  if v_c.id is null then raise exception 'challenge not found' using hint = 'challenge_not_found'; end if;
  if v_c.creator_id <> v_uid then
    raise exception 'only the creator can cancel' using hint = 'only_creator_can_cancel';
  end if;
  if v_c.status not in ('open','pending') then
    raise exception 'this challenge can no longer be cancelled' using hint = 'cannot_cancel';
  end if;

  perform public.rib_apply(v_uid, 'challenge_refund', v_c.stake_cents, -v_c.stake_cents, 'challenge', v_c.id, 'Challenge cancelled, stake refunded');
  update public.challenges set status = 'cancelled' where id = v_c.id returning * into v_c;
  return v_c;
end;
$$;

create or replace function public.rib_challenge_void(p_challenge_id uuid)
returns public.challenges
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_c public.challenges;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  select * into v_c from public.challenges where id = p_challenge_id for update;
  if v_c.id is null then raise exception 'challenge not found' using hint = 'challenge_not_found'; end if;
  if v_uid <> v_c.creator_id and v_uid is distinct from v_c.opponent_id then
    raise exception 'you are not in this challenge' using hint = 'not_a_participant';
  end if;
  if v_c.status not in ('active','disputed') then
    raise exception 'this challenge cannot be voided' using hint = 'cannot_cancel';
  end if;
  if v_c.matched_at is null or v_c.matched_at > now() - interval '2 hours' then
    raise exception 'too soon: a challenge can only be voided after 2 hours of inactivity' using hint = 'void_too_soon';
  end if;

  perform public.rib_lock_wallets(v_c.creator_id, v_c.opponent_id);
  perform public.rib_apply(v_c.creator_id, 'challenge_refund', v_c.stake_cents, -v_c.stake_cents, 'challenge', v_c.id, 'Challenge voided (inactivity), stake refunded');
  if v_c.opponent_id is not null then
    perform public.rib_apply(v_c.opponent_id, 'challenge_refund', v_c.stake_cents, -v_c.stake_cents, 'challenge', v_c.id, 'Challenge voided (inactivity), stake refunded');
  end if;

  update public.challenges set status = 'cancelled', settled_at = now()
   where id = v_c.id returning * into v_c;
  return v_c;
end;
$$;

-- ----------------------------------------------------------------------------
-- 6) Tournaments
-- ----------------------------------------------------------------------------
create or replace function public.rib_tournament_create(
  p_name text, p_game text, p_entry_fee_cents bigint, p_max_players int, p_starts_at timestamptz default null
) returns public.tournaments
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_row public.tournaments;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  if p_name is null or char_length(trim(p_name)) < 1 then
    raise exception 'tournament name is required' using hint = 'tournament_name_required';
  end if;
  if p_game is null or char_length(trim(p_game)) < 1 then
    raise exception 'game is required' using hint = 'game_required';
  end if;
  if p_entry_fee_cents is null or p_entry_fee_cents < 0 or p_entry_fee_cents > 50000 then
    raise exception 'invalid entry fee (between $0 and $500)' using hint = 'invalid_entry_fee';
  end if;
  if p_max_players is null or p_max_players < 2 or p_max_players > 128 then
    raise exception 'max players must be between 2 and 128' using hint = 'invalid_max_players';
  end if;
  insert into public.tournaments (creator_id, name, game, entry_fee_cents, max_players, starts_at)
  values (v_uid, trim(p_name), trim(p_game), p_entry_fee_cents, p_max_players, p_starts_at)
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.rib_tournament_join(p_tournament_id uuid)
returns public.tournaments
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_t public.tournaments; v_count int;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  select * into v_t from public.tournaments where id = p_tournament_id for update;
  if v_t.id is null then raise exception 'tournament not found' using hint = 'tournament_not_found'; end if;
  if v_t.status <> 'open' then raise exception 'registration is closed' using hint = 'registration_closed'; end if;
  if exists (select 1 from public.tournament_entries where tournament_id = v_t.id and user_id = v_uid) then
    raise exception 'already registered' using hint = 'already_registered';
  end if;

  if v_t.entry_fee_cents > 0 then
    perform public.rib_apply(v_uid, 'tournament_entry', -v_t.entry_fee_cents, 0, 'tournament', v_t.id, 'Tournament entry');
  end if;

  insert into public.tournament_entries (tournament_id, user_id) values (v_t.id, v_uid);
  update public.tournaments set prize_pool_cents = prize_pool_cents + v_t.entry_fee_cents where id = v_t.id;

  select count(*) into v_count from public.tournament_entries where tournament_id = v_t.id;
  if v_count >= v_t.max_players then
    update public.tournaments set status = 'full' where id = v_t.id;
  end if;

  select * into v_t from public.tournaments where id = v_t.id;
  return v_t;
end;
$$;

-- The organizer declares the winner, but can never award the pool to themself.
-- NOTE: collusion through a second account is still possible; a dispute /
-- result-verification flow is on the roadmap (docs/architecture.md).
create or replace function public.rib_tournament_finish(p_tournament_id uuid, p_winner_id uuid)
returns public.tournaments
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_t public.tournaments;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  select * into v_t from public.tournaments where id = p_tournament_id for update;
  if v_t.id is null then raise exception 'tournament not found' using hint = 'tournament_not_found'; end if;
  if v_t.creator_id <> v_uid then
    raise exception 'only the organizer can finish' using hint = 'only_organizer_can_finish';
  end if;
  if v_t.status not in ('open','full','active') then
    raise exception 'this tournament has already ended' using hint = 'tournament_finished';
  end if;
  if p_winner_id is null or p_winner_id = v_t.creator_id then
    raise exception 'the organizer cannot win their own tournament' using hint = 'organizer_cannot_win';
  end if;
  if not exists (select 1 from public.tournament_entries where tournament_id = v_t.id and user_id = p_winner_id) then
    raise exception 'the winner must be registered' using hint = 'winner_not_registered';
  end if;

  if v_t.prize_pool_cents > 0 then
    perform public.rib_apply(p_winner_id, 'tournament_prize', v_t.prize_pool_cents, 0, 'tournament', v_t.id, 'Tournament prize');
  end if;
  update public.tournament_entries set placement = 1 where tournament_id = v_t.id and user_id = p_winner_id;
  update public.tournaments set status = 'finished', finished_at = now() where id = v_t.id returning * into v_t;
  return v_t;
end;
$$;

create or replace function public.rib_tournament_cancel(p_tournament_id uuid)
returns public.tournaments
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_t public.tournaments; r record;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  select * into v_t from public.tournaments where id = p_tournament_id for update;
  if v_t.id is null then raise exception 'tournament not found' using hint = 'tournament_not_found'; end if;
  if v_t.creator_id <> v_uid then raise exception 'only the organizer can cancel' using hint = 'cannot_cancel'; end if;
  if v_t.status not in ('open','full') then
    raise exception 'this tournament can no longer be cancelled' using hint = 'cannot_cancel';
  end if;

  if v_t.entry_fee_cents > 0 then
    -- Deterministic order so concurrent cancels can't deadlock on wallets.
    for r in select user_id from public.tournament_entries where tournament_id = v_t.id order by user_id loop
      perform public.rib_apply(r.user_id, 'tournament_refund', v_t.entry_fee_cents, 0, 'tournament', v_t.id, 'Tournament cancelled, entry refunded');
    end loop;
  end if;

  update public.tournaments set status = 'cancelled', prize_pool_cents = 0, finished_at = now()
   where id = v_t.id returning * into v_t;
  return v_t;
end;
$$;

-- ----------------------------------------------------------------------------
-- 7) Games
-- ----------------------------------------------------------------------------
create or replace function public.rib_game_create(
  p_game text, p_stake_cents bigint, p_state jsonb default '{}'::jsonb
) returns public.game_matches
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_cnt int; v_row public.game_matches;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  -- Mirror of STAKEABLE_GAME_IDS in src/scripts/games/catalog/catalog-meta.js.
  if p_game is null or p_game not in ('tictactoe','connect4','reversi','checkers','dots','mancala','eights') then
    raise exception 'unknown game' using hint = 'unknown_game';
  end if;
  if p_stake_cents is null or p_stake_cents < 100 or p_stake_cents > 100000 then
    raise exception 'invalid stake (between $1 and $1000)' using hint = 'invalid_stake';
  end if;
  if p_state is not null and octet_length(p_state::text) > 16384 then
    raise exception 'board state too large' using hint = 'state_too_large';
  end if;

  perform public.rib_lock_user(v_uid);
  select count(*) into v_cnt from public.game_matches
   where host_id = v_uid and status in ('open','active');
  if v_cnt >= 20 then
    raise exception 'too many active games (max 20)' using hint = 'too_many_open';
  end if;

  insert into public.game_matches (game, host_id, stake_cents, status, state)
  values (p_game, v_uid, p_stake_cents, 'open', coalesce(p_state, '{}'::jsonb))
  returning * into v_row;

  perform public.rib_apply(v_uid, 'game_lock', -p_stake_cents, p_stake_cents, 'game', v_row.id, 'Stake locked');
  return v_row;
end;
$$;

create or replace function public.rib_game_report(p_match_id uuid, p_winner_id uuid default null)
returns public.game_matches
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_m public.game_matches; v_pot bigint; v_loser uuid; v_draw boolean;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  select * into v_m from public.game_matches where id = p_match_id for update;
  if v_m.id is null then raise exception 'match not found' using hint = 'match_not_found'; end if;
  if v_m.status not in ('active','disputed') then
    raise exception 'match is not in progress' using hint = 'match_not_in_progress';
  end if;
  if v_uid <> v_m.host_id and v_uid is distinct from v_m.guest_id then
    raise exception 'you are not in this match' using hint = 'not_in_match';
  end if;
  v_draw := (p_winner_id is null);
  if not v_draw and p_winner_id <> v_m.host_id and p_winner_id is distinct from v_m.guest_id then
    raise exception 'invalid winner' using hint = 'invalid_winner';
  end if;

  if v_uid = v_m.host_id then
    update public.game_matches set host_report = p_winner_id, host_draw = v_draw where id = v_m.id returning * into v_m;
  else
    update public.game_matches set guest_report = p_winner_id, guest_draw = v_draw where id = v_m.id returning * into v_m;
  end if;

  if (v_m.host_report is not null or v_m.host_draw)
     and (v_m.guest_report is not null or v_m.guest_draw) then
    perform public.rib_lock_wallets(v_m.host_id, v_m.guest_id);

    if v_m.host_draw and v_m.guest_draw then
      perform public.rib_apply(v_m.host_id,  'game_refund', v_m.stake_cents, -v_m.stake_cents, 'game', v_m.id, 'Draw, stake refunded');
      perform public.rib_apply(v_m.guest_id, 'game_refund', v_m.stake_cents, -v_m.stake_cents, 'game', v_m.id, 'Draw, stake refunded');
      update public.game_matches set status = 'settled', is_draw = true, settled_at = now()
       where id = v_m.id returning * into v_m;

    elsif (not v_m.host_draw) and (not v_m.guest_draw) and v_m.host_report = v_m.guest_report then
      v_pot   := v_m.stake_cents * 2;
      v_loser := case when v_m.host_report = v_m.host_id then v_m.guest_id else v_m.host_id end;
      perform public.rib_apply(v_m.host_report, 'game_win',     v_pot, -v_m.stake_cents, 'game', v_m.id, 'Game won');
      perform public.rib_apply(v_loser,         'game_settled', 0,     -v_m.stake_cents, 'game', v_m.id, 'Game lost');
      update public.game_matches set status = 'settled', winner_id = v_m.host_report, settled_at = now()
       where id = v_m.id returning * into v_m;

    else
      update public.game_matches set status = 'disputed' where id = v_m.id returning * into v_m;
    end if;
  end if;
  return v_m;
end;
$$;

create or replace function public.rib_game_void(p_match_id uuid)
returns public.game_matches
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_m public.game_matches;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  select * into v_m from public.game_matches where id = p_match_id for update;
  if v_m.id is null then raise exception 'match not found' using hint = 'match_not_found'; end if;
  if v_uid <> v_m.host_id and v_uid is distinct from v_m.guest_id then
    raise exception 'you are not in this match' using hint = 'not_in_match';
  end if;
  if v_m.status not in ('active','disputed') then
    raise exception 'this match cannot be voided' using hint = 'cannot_cancel';
  end if;
  if v_m.updated_at > now() - interval '2 hours' then
    raise exception 'too soon: a match can only be voided after 2 hours of inactivity' using hint = 'void_too_soon';
  end if;

  perform public.rib_lock_wallets(v_m.host_id, v_m.guest_id);
  perform public.rib_apply(v_m.host_id, 'game_refund', v_m.stake_cents, -v_m.stake_cents, 'game', v_m.id, 'Match voided (inactivity), stake refunded');
  if v_m.guest_id is not null then
    perform public.rib_apply(v_m.guest_id, 'game_refund', v_m.stake_cents, -v_m.stake_cents, 'game', v_m.id, 'Match voided (inactivity), stake refunded');
  end if;

  update public.game_matches set status = 'cancelled', settled_at = now()
   where id = v_m.id returning * into v_m;
  return v_m;
end;
$$;

-- ----------------------------------------------------------------------------
-- 8) Re-assert grants for every client RPC (signatures unchanged).
-- ----------------------------------------------------------------------------
grant execute on function public.rib_deposit_test(bigint)                                 to authenticated;
grant execute on function public.rib_buy_rcoin_test(bigint)                               to authenticated;
grant execute on function public.rib_withdraw_test(bigint)                                to authenticated;
grant execute on function public.rib_challenge_create(text,text,bigint,text)              to authenticated;
grant execute on function public.rib_challenge_accept(uuid)                               to authenticated;
grant execute on function public.rib_challenge_report(uuid,uuid)                          to authenticated;
grant execute on function public.rib_challenge_cancel(uuid)                               to authenticated;
grant execute on function public.rib_challenge_void(uuid)                                 to authenticated;
grant execute on function public.rib_tournament_create(text,text,bigint,int,timestamptz)  to authenticated;
grant execute on function public.rib_tournament_join(uuid)                                to authenticated;
grant execute on function public.rib_tournament_finish(uuid,uuid)                         to authenticated;
grant execute on function public.rib_tournament_cancel(uuid)                              to authenticated;
grant execute on function public.rib_game_create(text,bigint,jsonb)                       to authenticated;
grant execute on function public.rib_game_join(uuid,jsonb)                                to authenticated;
grant execute on function public.rib_game_move(uuid,jsonb,uuid)                           to authenticated;
grant execute on function public.rib_game_report(uuid,uuid)                               to authenticated;
grant execute on function public.rib_game_cancel(uuid)                                    to authenticated;
grant execute on function public.rib_game_void(uuid)                                      to authenticated;

-- ----------------------------------------------------------------------------
-- 9) Integrity constraints (NOT VALID first, then validate: no long lock).
-- ----------------------------------------------------------------------------
do $$
begin
  alter table public.game_matches
    add constraint game_matches_distinct_players check (guest_id is null or host_id <> guest_id) not valid;
exception when duplicate_object then null;
end;
$$;
alter table public.game_matches validate constraint game_matches_distinct_players;

do $$
begin
  alter table public.rcoin_purchases
    add constraint rcoin_purchases_provider_check check (provider in ('stripe','coinbase')) not valid;
exception when duplicate_object then null;
end;
$$;
alter table public.rcoin_purchases validate constraint rcoin_purchases_provider_check;

-- ----------------------------------------------------------------------------
-- 10) Indexes for the console's queries and unindexed foreign keys.
-- ----------------------------------------------------------------------------
create index if not exists challenges_target_idx        on public.challenges (target_id) where target_id is not null;
create index if not exists challenges_winner_idx        on public.challenges (winner_id) where winner_id is not null;
create index if not exists tournaments_created_idx      on public.tournaments (created_at desc);
create index if not exists tournaments_creator_idx      on public.tournaments (creator_id);
create index if not exists projects_owner_created_idx   on public.projects (owner_id, created_at desc);
create index if not exists api_keys_owner_created_idx   on public.api_keys (owner_id, created_at desc);
create index if not exists api_keys_project_idx         on public.api_keys (project_id) where project_id is not null;
create index if not exists api_keys_key_hash_idx        on public.api_keys (key_hash) where revoked_at is null;
create index if not exists game_matches_turn_idx        on public.game_matches (turn_id) where turn_id is not null;
create index if not exists game_matches_winner_idx      on public.game_matches (winner_id) where winner_id is not null;

-- Superseded by the composite indexes above / unique constraint.
drop index if exists public.projects_owner_idx;
drop index if exists public.api_keys_owner_idx;
drop index if exists public.tournament_entries_t_idx;

-- ----------------------------------------------------------------------------
-- 11) Language: translate legacy Spanish ledger memos and table comments.
-- ----------------------------------------------------------------------------
update public.wallet_ledger set memo = case memo
    when 'Depósito de prueba'         then 'Test deposit'
    when 'Retiro de prueba'           then 'Test withdrawal'
    when 'Apuesta bloqueada'          then 'Stake locked'
    when 'Reto ganado'                then 'Challenge won'
    when 'Reto perdido'               then 'Challenge lost'
    when 'Reto cancelado, reembolso'  then 'Challenge cancelled, stake refunded'
    when 'Inscripción a torneo'       then 'Tournament entry'
    when 'Premio de torneo'           then 'Tournament prize'
    else memo
  end
 where memo in ('Depósito de prueba','Retiro de prueba','Apuesta bloqueada','Reto ganado','Reto perdido',
                'Reto cancelado, reembolso','Inscripción a torneo','Premio de torneo');

comment on table public.wallets is 'TEST-MODE balance (off-chain). Real funds will be non-custodial on Base. RLS: owner-only read; writes only through SECURITY DEFINER RPCs.';
