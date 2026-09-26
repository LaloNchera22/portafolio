-- ============================================================================
-- Runinback — anti-abuse limits, lobby indexes, and cleanup (scalability, 2026-09-26).
--
-- TEST MODE, same model as 0001–0006: RLS deny-by-default, every balance move
-- through SECURITY DEFINER RPCs with a fixed empty search_path, atomic.
--
-- Three scalability guards, none of which change a legitimate user's flow:
--   1) Caps in the money/creation RPCs so the DB can't be inflated by spam:
--      a test-balance ceiling of $10,000, and at most 20 live (open/active)
--      games and 20 live challenges per user.
--   2) Partial indexes on status='open' so the lobby stays fast as rows grow
--      (the lobby queries filter exactly on status='open' ordered by created_at).
--   3) rib_cleanup_matches(): deletes terminal (cancelled/settled) game matches
--      older than N days, reclaiming the jsonb board state. The wallet ledger
--      keeps the money record, so nothing financial is lost.
--
-- Additive and idempotent: CREATE OR REPLACE for the RPCs, CREATE INDEX IF NOT
-- EXISTS for the indexes. The redefined RPCs keep their existing behavior and
-- signatures (so existing GRANTs stay valid) and only add the cap checks.
-- Safe to run after 0001–0006.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Partial indexes for the lobby (status = 'open'), matching the queries
--    the console/games front-end runs (order by created_at desc).
-- ----------------------------------------------------------------------------
create index if not exists game_matches_open_idx
  on public.game_matches (created_at desc) where status = 'open';
create index if not exists challenges_open_idx
  on public.challenges (created_at desc) where status = 'open';

-- ----------------------------------------------------------------------------
-- 2) Caps in the RPCs. Constants inline so each function stays self-contained:
--    test-balance ceiling = 1,000,000 cents ($10,000); live rows per user = 20.
-- ----------------------------------------------------------------------------

-- ---- Wallet: test deposit — reject if it would exceed the $10,000 ceiling ---
create or replace function public.rib_deposit_test(p_amount_cents bigint)
returns public.wallets
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_bal bigint; v_row public.wallets;
begin
  if v_uid is null then raise exception 'no autenticado'; end if;
  if p_amount_cents is null or p_amount_cents < 100 or p_amount_cents > 100000 then
    raise exception 'monto de prueba inválido (entre $1 y $1000)';
  end if;
  select test_balance_cents into v_bal from public.wallets where user_id = v_uid;
  if coalesce(v_bal, 0) + p_amount_cents > 1000000 then
    raise exception 'límite de saldo de prueba alcanzado ($10,000)';
  end if;
  perform public.rib_apply(v_uid, 'deposit', p_amount_cents, 0, null, null, 'Depósito de prueba');
  select * into v_row from public.wallets where user_id = v_uid;
  return v_row;
end;
$$;

-- ---- rcoin: buy (test) — same ceiling on the credited amount -----------------
create or replace function public.rib_buy_rcoin_test(p_pay_cents bigint)
returns public.wallets
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_bal    bigint;
  v_credit bigint;
  v_rcoin  bigint;
  v_row    public.wallets;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  if p_pay_cents is null or p_pay_cents < 100 or p_pay_cents > 200000 then
    raise exception 'invalid amount (between $1 and $2000)';
  end if;
  -- 5% entry commission, shown on screen. Credit = 95% of what came in.
  -- Integer math on cents (no float): 95/100 of the paid amount.
  v_credit := (p_pay_cents * 95) / 100;
  v_rcoin  := v_credit / 100;
  select test_balance_cents into v_bal from public.wallets where user_id = v_uid;
  if coalesce(v_bal, 0) + v_credit > 1000000 then
    raise exception 'test balance cap reached ($10,000)';
  end if;
  perform public.rib_apply(
    v_uid, 'rcoin_purchase', v_credit, 0, null, null,
    'Bought ' || v_rcoin::text || ' rcoin (5% entry fee)'
  );
  select * into v_row from public.wallets where user_id = v_uid;
  return v_row;
end;
$$;

-- ---- Game: create — cap live games per user at 20 ---------------------------
create or replace function public.rib_game_create(
  p_game text, p_stake_cents bigint, p_state jsonb default '{}'::jsonb
) returns public.game_matches
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_bal bigint; v_cnt int; v_row public.game_matches;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  if p_game not in ('tictactoe','connect4','reversi','checkers','dots','mancala','eights') then
    raise exception 'unknown game';
  end if;
  if p_stake_cents is null or p_stake_cents < 100 or p_stake_cents > 100000 then
    raise exception 'invalid stake (between $1 and $1000)';
  end if;
  if p_state is not null and octet_length(p_state::text) > 16384 then
    raise exception 'board state too large';
  end if;
  select count(*) into v_cnt from public.game_matches
    where host_id = v_uid and status in ('open','active');
  if v_cnt >= 20 then
    raise exception 'too many active games (max 20); finish or cancel one first';
  end if;
  select test_balance_cents into v_bal from public.wallets where user_id = v_uid;
  if v_bal is null or v_bal < p_stake_cents then raise exception 'not enough balance for the stake'; end if;

  insert into public.game_matches (game, host_id, stake_cents, status, state)
  values (p_game, v_uid, p_stake_cents, 'open', coalesce(p_state, '{}'::jsonb))
  returning * into v_row;

  perform public.rib_apply(v_uid, 'game_lock', -p_stake_cents, p_stake_cents, 'game', v_row.id, 'Stake locked');
  return v_row;
end;
$$;

-- ---- Challenge: create — cap live challenges per user at 20 ------------------
create or replace function public.rib_challenge_create(
  p_game text, p_mode text, p_stake_cents bigint, p_target_username text default null
) returns public.challenges
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid(); v_bal bigint; v_target uuid; v_status text; v_cnt int; v_row public.challenges;
begin
  if v_uid is null then raise exception 'no autenticado'; end if;
  if p_game is null or char_length(trim(p_game)) < 1 then raise exception 'indica el juego'; end if;
  if p_stake_cents is null or p_stake_cents < 100 or p_stake_cents > 100000 then
    raise exception 'apuesta inválida (entre $1 y $1000)';
  end if;

  select count(*) into v_cnt from public.challenges
    where creator_id = v_uid and status in ('open','pending','active');
  if v_cnt >= 20 then
    raise exception 'demasiados retos activos (máx 20); termina o cancela uno primero';
  end if;

  if p_target_username is not null and char_length(trim(p_target_username)) > 0 then
    select id into v_target from public.profiles where username = trim(p_target_username);
    if v_target is null then raise exception 'no existe el usuario %', p_target_username; end if;
    if v_target = v_uid then raise exception 'no puedes retarte a ti mismo'; end if;
    v_status := 'pending';
  else
    v_status := 'open';
  end if;

  select test_balance_cents into v_bal from public.wallets where user_id = v_uid;
  if v_bal is null or v_bal < p_stake_cents then raise exception 'saldo insuficiente para la apuesta'; end if;

  insert into public.challenges (creator_id, target_id, game, mode, stake_cents, status)
  values (v_uid, v_target, trim(p_game), coalesce(nullif(trim(p_mode),''),'1v1'), p_stake_cents, v_status)
  returning * into v_row;

  perform public.rib_apply(v_uid, 'challenge_lock', -p_stake_cents, p_stake_cents, 'challenge', v_row.id, 'Apuesta bloqueada');
  return v_row;
end;
$$;

-- ----------------------------------------------------------------------------
-- 3) Cleanup: delete terminal game matches older than p_days days, reclaiming
--    the jsonb board state. Only 'cancelled'/'settled' rows (no live match is
--    touched); the wallet ledger keeps the money record. Returns the row count.
--    Intended for a scheduled job (pg_cron) or a manual run — granted to
--    service_role, not to end users.
-- ----------------------------------------------------------------------------
create or replace function public.rib_cleanup_matches(p_days int default 30)
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare v_deleted bigint;
begin
  if p_days is null or p_days < 1 then p_days := 30; end if;
  delete from public.game_matches
   where status in ('cancelled','settled')
     and coalesce(settled_at, updated_at) < now() - make_interval(days => p_days);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;
revoke all on function public.rib_cleanup_matches(int) from public;
grant execute on function public.rib_cleanup_matches(int) to service_role;

-- Existing GRANTs on the redefined RPCs stay valid; re-assert for clarity.
grant execute on function public.rib_deposit_test(bigint)                    to authenticated;
grant execute on function public.rib_buy_rcoin_test(bigint)                  to authenticated;
grant execute on function public.rib_game_create(text,bigint,jsonb)          to authenticated;
grant execute on function public.rib_challenge_create(text,text,bigint,text) to authenticated;
