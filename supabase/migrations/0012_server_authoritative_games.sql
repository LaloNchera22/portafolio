-- ============================================================================
-- Runinback — server-authoritative staked games (2026-09-28).
--
-- Until now the browser applied moves and wrote the board (rib_game_move) and
-- both players reported the result (rib_game_report); a loser could stall a pot
-- by disputing. From this migration on:
--   * the game-move Edge Function validates every move with the shared pure
--     rules and commits it through rib_game_commit_move (service role only),
--     with optimistic concurrency on move_seq;
--   * the pot settles automatically the moment the rules say the game is over
--     (or a player resigns) — no reports, no disputes;
--   * rib_game_move and rib_game_report are no longer callable by clients;
--   * only deterministic, perfect-information games can be staked: Crazy
--     Eights (shuffled deck, hidden hands) is practice-only for now.
--
-- Cut-over (runs once): matches that started under the old client-driven flow
-- are voided with both stakes refunded, and open Crazy Eights tables are
-- refunded. Idempotent.
-- ============================================================================

alter table public.game_matches add column if not exists move_seq int not null default 0;

-- ----------------------------------------------------------------------------
-- Commit one validated transition (called only by the game-move function).
-- ----------------------------------------------------------------------------
create or replace function public.rib_game_commit_move(
  p_match_id uuid, p_expected_seq int, p_state jsonb, p_next_turn uuid, p_over boolean, p_winner_id uuid
) returns public.game_matches
language plpgsql security definer set search_path = ''
as $$
declare v_m public.game_matches; v_loser uuid;
begin
  select * into v_m from public.game_matches where id = p_match_id for update;
  if v_m.id is null then raise exception 'match not found' using hint = 'match_not_found'; end if;
  if v_m.status <> 'active' then raise exception 'match is not in progress' using hint = 'match_not_in_progress'; end if;
  if v_m.move_seq <> p_expected_seq then
    raise exception 'the board changed, retry with the latest state' using hint = 'stale_move';
  end if;
  if p_state is null or octet_length(p_state::text) > 16384 then
    raise exception 'board state too large' using hint = 'state_too_large';
  end if;
  if p_winner_id is not null and p_winner_id <> v_m.host_id and p_winner_id <> v_m.guest_id then
    raise exception 'invalid winner' using hint = 'invalid_winner';
  end if;

  if not p_over then
    update public.game_matches
       set state = p_state, turn_id = p_next_turn, move_seq = move_seq + 1
     where id = v_m.id
     returning * into v_m;
    return v_m;
  end if;

  perform public.rib_lock_wallets(v_m.host_id, v_m.guest_id);
  if p_winner_id is null then
    perform public.rib_apply(v_m.host_id,  'game_refund', v_m.stake_cents, -v_m.stake_cents, 'game', v_m.id, 'Draw, stake refunded');
    perform public.rib_apply(v_m.guest_id, 'game_refund', v_m.stake_cents, -v_m.stake_cents, 'game', v_m.id, 'Draw, stake refunded');
  else
    v_loser := case when p_winner_id = v_m.host_id then v_m.guest_id else v_m.host_id end;
    perform public.rib_apply(p_winner_id, 'game_win',     v_m.stake_cents * 2, -v_m.stake_cents, 'game', v_m.id, 'Game won');
    perform public.rib_apply(v_loser,     'game_settled', 0,                   -v_m.stake_cents, 'game', v_m.id, 'Game lost');
  end if;

  update public.game_matches
     set state = p_state, turn_id = null, move_seq = move_seq + 1,
         status = 'settled', winner_id = p_winner_id, is_draw = (p_winner_id is null), settled_at = now()
   where id = v_m.id
   returning * into v_m;
  return v_m;
end;
$$;
revoke execute on function public.rib_game_commit_move(uuid,int,jsonb,uuid,boolean,uuid) from public, anon, authenticated;
grant execute on function public.rib_game_commit_move(uuid,int,jsonb,uuid,boolean,uuid) to service_role;

-- ----------------------------------------------------------------------------
-- Staked tables: deterministic, perfect-information games only. The stored
-- state is informational until the first move (the server starts from the
-- rules' initial position).
-- ----------------------------------------------------------------------------
create or replace function public.rib_game_create(
  p_game text, p_stake_cents bigint, p_state jsonb default '{}'::jsonb
) returns public.game_matches
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_cnt int; v_row public.game_matches;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  -- Mirror of STAKEABLE_RULES in supabase/functions/_shared/game-rules/index.js.
  if p_game is null or p_game not in ('tictactoe','connect4','reversi','checkers','dots','mancala') then
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
grant execute on function public.rib_game_create(text,bigint,jsonb) to authenticated;

-- Clients can no longer write boards or results.
revoke execute on function public.rib_game_move(uuid,jsonb,uuid) from public, anon, authenticated;
revoke execute on function public.rib_game_report(uuid,uuid)     from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Cut-over (once): refund everything that started under the client-driven flow.
-- ----------------------------------------------------------------------------
do $$
declare v_m public.game_matches;
begin
  if exists (select 1 from public.platform_settings where key = 'server_authoritative_games_cutover') then
    return;
  end if;

  for v_m in
    select * from public.game_matches
     where status in ('active','disputed') or (status = 'open' and game = 'eights')
     order by id
     for update
  loop
    if v_m.guest_id is not null then
      perform public.rib_lock_wallets(v_m.host_id, v_m.guest_id);
    end if;
    perform public.rib_apply(v_m.host_id, 'game_refund', v_m.stake_cents, -v_m.stake_cents, 'game', v_m.id, 'Match voided (rules upgrade), stake refunded');
    if v_m.guest_id is not null and v_m.status <> 'open' then
      perform public.rib_apply(v_m.guest_id, 'game_refund', v_m.stake_cents, -v_m.stake_cents, 'game', v_m.id, 'Match voided (rules upgrade), stake refunded');
    end if;
    update public.game_matches set status = 'cancelled', settled_at = now() where id = v_m.id;
  end loop;

  insert into public.platform_settings (key, value) values ('server_authoritative_games_cutover', to_jsonb(now()));
end;
$$;
