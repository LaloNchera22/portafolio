-- ============================================================================
-- Runinback — security & scalability hardening (post-audit, 2026-09-26).
--
-- TEST MODE, same model as 0001/0002/0003: RLS deny-by-default, all money and
-- match state move through SECURITY DEFINER RPCs with a fixed empty search_path.
-- This migration ADDS NO tables and NO columns. It only re-defines a handful of
-- existing RPCs (CREATE OR REPLACE) to close two audit findings:
--
--   1) Unbounded board state — rib_game_create/join/move accepted a jsonb
--      `state` of any size. Because game_matches is REPLICA IDENTITY FULL and
--      published to Realtime, an oversized row is rebroadcast to every
--      participant on every move: a cheap storage / bandwidth abuse vector.
--      Fix: cap the serialized state at 16 KB inside the RPCs (the only write
--      path — the client has no direct INSERT/UPDATE on game_matches).
--
--   2) rcoin bought with float math — the 5% entry fee used p_pay_cents * 0.95.
--      Fix: exact integer arithmetic on cents so the credited amount can never
--      drift by a fractional cent.
--
-- Additive and idempotent: CREATE OR REPLACE re-runs cleanly. Safe to paste
-- after 0001_init.sql, 0002_arena.sql and 0003_games.sql. Signatures are
-- unchanged, so existing GRANTs stay valid.
-- ============================================================================

-- ---- rcoin: buy (test) — exact integer 5% entry fee ------------------------
create or replace function public.rib_buy_rcoin_test(p_pay_cents bigint)
returns public.wallets
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
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
  perform public.rib_apply(
    v_uid, 'rcoin_purchase', v_credit, 0, null, null,
    'Bought ' || v_rcoin::text || ' rcoin (5% entry fee)'
  );
  select * into v_row from public.wallets where user_id = v_uid;
  return v_row;
end;
$$;

-- ---- Game: create — cap the board state ------------------------------------
create or replace function public.rib_game_create(
  p_game text, p_stake_cents bigint, p_state jsonb default '{}'::jsonb
) returns public.game_matches
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_bal bigint; v_row public.game_matches;
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
  select test_balance_cents into v_bal from public.wallets where user_id = v_uid;
  if v_bal is null or v_bal < p_stake_cents then raise exception 'not enough balance for the stake'; end if;

  insert into public.game_matches (game, host_id, stake_cents, status, state)
  values (p_game, v_uid, p_stake_cents, 'open', coalesce(p_state, '{}'::jsonb))
  returning * into v_row;

  perform public.rib_apply(v_uid, 'game_lock', -p_stake_cents, p_stake_cents, 'game', v_row.id, 'Stake locked');
  return v_row;
end;
$$;

-- ---- Game: join — cap the board state --------------------------------------
create or replace function public.rib_game_join(p_match_id uuid, p_state jsonb default null)
returns public.game_matches
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_m public.game_matches; v_bal bigint;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  if p_state is not null and octet_length(p_state::text) > 16384 then
    raise exception 'board state too large';
  end if;
  select * into v_m from public.game_matches where id = p_match_id for update;
  if v_m.id is null then raise exception 'match not found'; end if;
  if v_m.host_id = v_uid then raise exception 'you cannot join your own match'; end if;
  if v_m.status <> 'open' then raise exception 'this match is no longer open'; end if;

  select test_balance_cents into v_bal from public.wallets where user_id = v_uid;
  if v_bal is null or v_bal < v_m.stake_cents then raise exception 'not enough balance to join'; end if;

  perform public.rib_apply(v_uid, 'game_lock', -v_m.stake_cents, v_m.stake_cents, 'game', v_m.id, 'Stake locked');

  update public.game_matches
     set guest_id = v_uid, status = 'active', matched_at = now(),
         turn_id = v_m.host_id,                       -- host moves first
         state = coalesce(p_state, v_m.state)
   where id = v_m.id
   returning * into v_m;
  return v_m;
end;
$$;

-- ---- Game: submit a move — cap the board state -----------------------------
create or replace function public.rib_game_move(
  p_match_id uuid, p_state jsonb, p_next_turn uuid
) returns public.game_matches
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_m public.game_matches;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  if p_state is not null and octet_length(p_state::text) > 16384 then
    raise exception 'board state too large';
  end if;
  select * into v_m from public.game_matches where id = p_match_id for update;
  if v_m.id is null then raise exception 'match not found'; end if;
  if v_m.status <> 'active' then raise exception 'match is not in progress'; end if;
  if v_uid <> v_m.host_id and v_uid <> v_m.guest_id then raise exception 'you are not in this match'; end if;
  if v_m.turn_id is not null and v_m.turn_id <> v_uid then raise exception 'not your turn'; end if;
  if p_next_turn is not null and p_next_turn <> v_m.host_id and p_next_turn <> v_m.guest_id then
    raise exception 'invalid next turn';
  end if;

  update public.game_matches
     set state = coalesce(p_state, state), turn_id = p_next_turn
   where id = v_m.id
   returning * into v_m;
  return v_m;
end;
$$;

-- Signatures unchanged; GRANTs from 0003 still apply. Re-assert for clarity.
grant execute on function public.rib_buy_rcoin_test(bigint)         to authenticated;
grant execute on function public.rib_game_create(text,bigint,jsonb) to authenticated;
grant execute on function public.rib_game_join(uuid,jsonb)          to authenticated;
grant execute on function public.rib_game_move(uuid,jsonb,uuid)     to authenticated;
