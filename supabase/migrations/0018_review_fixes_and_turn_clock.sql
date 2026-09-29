-- ============================================================================
-- Runinback — review fixes + turn clock (2026-09-29).
--
-- From the multi-agent audit of 0014-0017:
--   1) Materialized rankings (0016/0017): the refresh no longer runs twice at
--      once, only rewrites rows whose rank changed, clears ranks that are no
--      longer valid (weekly rollover), and is not reachable by client roles.
--      rib_my_standing falls back to a live count for players who aren't in
--      the snapshot yet, so a new player sees a rank immediately.
--   2) Ranking integrity: only server-validated results count. Challenges and
--      tournament prizes are self-reported/organizer-declared, so two accounts
--      could farm rank; staked games (validated move by move by game-move)
--      are the only source. Stats are rebuilt from the ledger once.
--   3) Turn clock for staked games: each turn has a 10-minute deadline. A
--      player who stops moving loses (the waiting player claims the pot, or the
--      forfeit job awards it) instead of stalling for a refund via void.
--   4) rib_expire_stale isolates each row, so one bad row can't abort the
--      whole sweep; rib_open_challenges caps the search term.
-- Idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Materialized rankings
-- ----------------------------------------------------------------------------
drop policy if exists "Users can read their own rank" on public.player_rankings;
revoke all on public.player_rankings from anon, authenticated;
alter table public.player_rankings set (fillfactor = 80);

create or replace function public.refresh_player_rankings()
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  -- One refresh at a time; a concurrent cron tick simply skips.
  if not pg_try_advisory_xact_lock(hashtextextended('rib_refresh_player_rankings', 0)) then
    return;
  end if;

  create temp table if not exists _rib_ranks (user_id uuid primary key, rank_all bigint, rank_week bigint) on commit drop;
  truncate _rib_ranks;

  insert into _rib_ranks (user_id, rank_all, rank_week)
  select coalesce(a.user_id, w.user_id), coalesce(a.rn, 0), coalesce(w.rn, 0)
    from (select user_id, row_number() over (order by net_cents desc, wins desc, user_id) as rn
            from public.player_stats where wins + losses > 0) a
    full join (select user_id, row_number() over (order by net_cents desc, wins desc, user_id) as rn
                 from public.player_stats_weekly
                where week_start = public.rib_week_start(now()) and wins + losses > 0) w
      on w.user_id = a.user_id;

  insert into public.player_rankings as r (user_id, rank_all, rank_week, updated_at)
  select k.user_id, k.rank_all, k.rank_week, now()
    from _rib_ranks k join public.profiles p on p.id = k.user_id
  on conflict (user_id) do update
    set rank_all = excluded.rank_all, rank_week = excluded.rank_week, updated_at = now()
    where (r.rank_all, r.rank_week) is distinct from (excluded.rank_all, excluded.rank_week);

  -- Players who dropped off a board (e.g. the weekly rollover) lose that rank.
  update public.player_rankings r
     set rank_all = 0, rank_week = 0, updated_at = now()
   where (r.rank_all <> 0 or r.rank_week <> 0)
     and not exists (select 1 from _rib_ranks k where k.user_id = r.user_id);
end;
$$;
revoke execute on function public.refresh_player_rankings() from public, anon, authenticated;
grant execute on function public.refresh_player_rankings() to service_role;

create or replace function public.rib_my_standing(p_period text default 'week')
returns table (rank bigint, net_cents bigint, won_cents bigint, wins int, losses int)
language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  if p_period = 'all' then
    return query
      select coalesce(nullif(r.rank_all, 0),
               (select count(*) + 1 from public.player_stats o
                 where o.wins + o.losses > 0
                   and ((o.net_cents, o.wins) > (s.net_cents, s.wins)
                        or ((o.net_cents, o.wins) = (s.net_cents, s.wins) and o.user_id < s.user_id)))),
             s.net_cents, s.won_cents, s.wins, s.losses
        from public.player_stats s
        left join public.player_rankings r on r.user_id = s.user_id
       where s.user_id = v_uid and s.wins + s.losses > 0;
  else
    return query
      select coalesce(nullif(r.rank_week, 0),
               (select count(*) + 1 from public.player_stats_weekly o
                 where o.week_start = s.week_start and o.wins + o.losses > 0
                   and ((o.net_cents, o.wins) > (s.net_cents, s.wins)
                        or ((o.net_cents, o.wins) = (s.net_cents, s.wins) and o.user_id < s.user_id)))),
             s.net_cents, s.won_cents, s.wins, s.losses
        from public.player_stats_weekly s
        left join public.player_rankings r on r.user_id = s.user_id
       where s.user_id = v_uid and s.week_start = public.rib_week_start(now()) and s.wins + s.losses > 0;
  end if;
end;
$$;
revoke execute on function public.rib_my_standing(text) from public, anon;
grant execute on function public.rib_my_standing(text) to authenticated;

-- ----------------------------------------------------------------------------
-- 2) Only server-validated results feed the ranking; rebuild once.
-- ----------------------------------------------------------------------------
create or replace function public.rib_play_delta(p_kind text, p_amount bigint,
  out net bigint, out won bigint, out win int, out loss int)
language sql immutable set search_path = ''
as $$
  select
    case when p_kind in ('game_lock','game_win','game_settled','game_refund') then p_amount else 0 end,
    case when p_kind = 'game_win' then p_amount else 0 end,
    case when p_kind = 'game_win' then 1 else 0 end,
    case when p_kind = 'game_settled' then 1 else 0 end;
$$;
revoke execute on function public.rib_play_delta(text,bigint) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from public.platform_settings where key = 'player_stats_verified_only') then
    return;
  end if;
  delete from public.player_stats;
  delete from public.player_stats_weekly;
  insert into public.player_stats (user_id, net_cents, won_cents, wins, losses)
  select l.user_id, sum(d.net), sum(d.won), sum(d.win), sum(d.loss)
    from public.wallet_ledger l, lateral public.rib_play_delta(l.kind, l.amount_cents) d
   group by l.user_id
  having sum(abs(d.net)) + sum(d.win) + sum(d.loss) > 0;
  insert into public.player_stats_weekly (week_start, user_id, net_cents, won_cents, wins, losses)
  select public.rib_week_start(l.created_at), l.user_id, sum(d.net), sum(d.won), sum(d.win), sum(d.loss)
    from public.wallet_ledger l, lateral public.rib_play_delta(l.kind, l.amount_cents) d
   group by 1, 2
  having sum(abs(d.net)) + sum(d.win) + sum(d.loss) > 0;
  insert into public.platform_settings (key, value) values ('player_stats_verified_only', to_jsonb(now()));
end;
$$;

-- ----------------------------------------------------------------------------
-- 3) Turn clock
-- ----------------------------------------------------------------------------
alter table public.game_matches add column if not exists turn_deadline timestamptz;
create index if not exists game_matches_turn_deadline_idx
  on public.game_matches (turn_deadline) where status = 'active';

-- Seconds a player has to move. Kept in one place for the RPCs and the UI copy.
create or replace function public.rib_turn_seconds()
returns int language sql immutable set search_path = '' as $$ select 600 $$;

-- Award an active match to p_winner (internal: callers have already locked
-- and validated the row).
create or replace function public.rib_game_award(p_match public.game_matches, p_winner uuid, p_memo text)
returns public.game_matches
language plpgsql security definer set search_path = ''
as $$
declare v_m public.game_matches; v_loser uuid;
begin
  v_loser := case when p_winner = p_match.host_id then p_match.guest_id else p_match.host_id end;
  perform public.rib_lock_wallets(p_match.host_id, p_match.guest_id);
  perform public.rib_apply(p_winner, 'game_win',     p_match.stake_cents * 2, -p_match.stake_cents, 'game', p_match.id, p_memo);
  perform public.rib_apply(v_loser,  'game_settled', 0,                       -p_match.stake_cents, 'game', p_match.id, 'Game lost (' || lower(p_memo) || ')');
  update public.game_matches
     set status = 'settled', winner_id = p_winner, is_draw = false, turn_id = null, turn_deadline = null,
         move_seq = move_seq + 1, settled_at = now()
   where id = p_match.id
   returning * into v_m;
  return v_m;
end;
$$;
revoke execute on function public.rib_game_award(public.game_matches,uuid,text) from public, anon, authenticated;

-- Same as 0012, plus: a move after the deadline is refused, and every
-- committed move starts the next player's clock.
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
  if v_m.turn_deadline is not null and v_m.turn_deadline < now() then
    raise exception 'time ran out for this turn' using hint = 'turn_timed_out';
  end if;
  if p_state is null or octet_length(p_state::text) > 16384 then
    raise exception 'board state too large' using hint = 'state_too_large';
  end if;
  if p_winner_id is not null and p_winner_id <> v_m.host_id and p_winner_id <> v_m.guest_id then
    raise exception 'invalid winner' using hint = 'invalid_winner';
  end if;

  if not p_over then
    update public.game_matches
       set state = p_state, turn_id = p_next_turn, move_seq = move_seq + 1,
           turn_deadline = now() + make_interval(secs => public.rib_turn_seconds())
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
     set state = p_state, turn_id = null, turn_deadline = null, move_seq = move_seq + 1,
         status = 'settled', winner_id = p_winner_id, is_draw = (p_winner_id is null), settled_at = now()
   where id = v_m.id
   returning * into v_m;
  return v_m;
end;
$$;
revoke execute on function public.rib_game_commit_move(uuid,int,jsonb,uuid,boolean,uuid) from public, anon, authenticated;
grant execute on function public.rib_game_commit_move(uuid,int,jsonb,uuid,boolean,uuid) to service_role;

-- Same as 0004, plus: the host's clock starts when the guest joins.
create or replace function public.rib_game_join(p_match_id uuid, p_state jsonb default null)
returns public.game_matches
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_m public.game_matches;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  if p_state is not null and octet_length(p_state::text) > 16384 then
    raise exception 'board state too large' using hint = 'state_too_large';
  end if;
  select * into v_m from public.game_matches where id = p_match_id for update;
  if v_m.id is null then raise exception 'match not found' using hint = 'match_not_found'; end if;
  if v_m.host_id = v_uid then raise exception 'you cannot join your own match' using hint = 'cannot_join_own_match'; end if;
  if v_m.status <> 'open' then raise exception 'this match is no longer open' using hint = 'match_not_open'; end if;

  perform public.rib_apply(v_uid, 'game_lock', -v_m.stake_cents, v_m.stake_cents, 'game', v_m.id, 'Stake locked');

  update public.game_matches
     set guest_id = v_uid, status = 'active', matched_at = now(),
         turn_id = v_m.host_id,                       -- host moves first
         turn_deadline = now() + make_interval(secs => public.rib_turn_seconds()),
         state = coalesce(p_state, v_m.state)
   where id = v_m.id
   returning * into v_m;
  return v_m;
end;
$$;
grant execute on function public.rib_game_join(uuid,jsonb) to authenticated;

-- The waiting player claims the pot once the opponent's clock has run out.
create or replace function public.rib_game_claim_timeout(p_match_id uuid)
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
  if v_m.status <> 'active' then raise exception 'match is not in progress' using hint = 'match_not_in_progress'; end if;
  if v_m.turn_id = v_uid or v_m.turn_deadline is null or v_m.turn_deadline >= now() then
    raise exception 'your opponent still has time' using hint = 'not_timed_out';
  end if;
  return public.rib_game_award(v_m, v_uid, 'Won on time');
end;
$$;
revoke execute on function public.rib_game_claim_timeout(uuid) from public, anon;
grant execute on function public.rib_game_claim_timeout(uuid) to authenticated;

-- Background forfeit for matches nobody claimed (pg_cron, every minute).
create or replace function public.rib_forfeit_timeouts(p_batch int default 200)
returns int
language plpgsql security definer set search_path = ''
as $$
declare v_m public.game_matches; v_count int := 0;
begin
  for v_m in
    select * from public.game_matches
     where status = 'active' and turn_deadline < now() - interval '30 seconds'
     order by turn_deadline limit p_batch
     for update skip locked
  loop
    begin
      perform public.rib_game_award(v_m, case when v_m.turn_id = v_m.host_id then v_m.guest_id else v_m.host_id end, 'Won on time');
      v_count := v_count + 1;
    exception when others then
      raise warning 'rib_forfeit_timeouts: match % failed: %', v_m.id, sqlerrm;
    end;
  end loop;
  return v_count;
end;
$$;
revoke execute on function public.rib_forfeit_timeouts(int) from public, anon, authenticated;
grant execute on function public.rib_forfeit_timeouts(int) to service_role;

-- Void (both refunded) stays only for matches without a clock (pre-0018).
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
  if v_m.turn_deadline is not null then
    raise exception 'timed matches are decided by the turn clock' using hint = 'use_timeout_claim';
  end if;
  if v_m.updated_at > now() - interval '2 hours' then
    raise exception 'too soon: a match can only be voided after 2 hours of inactivity' using hint = 'void_too_soon';
  end if;

  perform public.rib_lock_wallets(v_m.host_id, v_m.guest_id);
  perform public.rib_apply(v_m.host_id, 'game_refund', v_m.stake_cents, -v_m.stake_cents, 'game', v_m.id, 'Match voided (inactivity), stake refunded');
  if v_m.guest_id is not null then
    perform public.rib_apply(v_m.guest_id, 'game_refund', v_m.stake_cents, -v_m.stake_cents, 'game', v_m.id, 'Match voided (inactivity), stake refunded');
  end if;
  update public.game_matches set status = 'cancelled', settled_at = now() where id = v_m.id returning * into v_m;
  return v_m;
end;
$$;
grant execute on function public.rib_game_void(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 4) Expiry sweep: per-row isolation; timed games are left to the clock.
-- ----------------------------------------------------------------------------
create or replace function public.rib_expire_stale(
  p_open_hours int default 24, p_idle_hours int default 48, p_batch int default 500
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_m public.game_matches;
  v_c public.challenges;
  v_open_games int := 0; v_open_challenges int := 0; v_idle_games int := 0; v_idle_challenges int := 0; v_failed int := 0;
begin
  for v_m in
    select * from public.game_matches
     where status = 'open' and created_at < now() - make_interval(hours => p_open_hours)
     order by created_at limit p_batch for update skip locked
  loop
    begin
      perform public.rib_apply(v_m.host_id, 'game_refund', v_m.stake_cents, -v_m.stake_cents, 'game', v_m.id, 'Open table expired, stake refunded');
      update public.game_matches set status = 'cancelled', settled_at = now() where id = v_m.id;
      v_open_games := v_open_games + 1;
    exception when others then
      v_failed := v_failed + 1;
      raise warning 'rib_expire_stale: open match % failed: %', v_m.id, sqlerrm;
    end;
  end loop;

  for v_c in
    select * from public.challenges
     where status in ('open','pending') and created_at < now() - make_interval(hours => p_open_hours)
     order by created_at limit p_batch for update skip locked
  loop
    begin
      perform public.rib_apply(v_c.creator_id, 'challenge_refund', v_c.stake_cents, -v_c.stake_cents, 'challenge', v_c.id, 'Open challenge expired, stake refunded');
      update public.challenges set status = 'cancelled', settled_at = now() where id = v_c.id;
      v_open_challenges := v_open_challenges + 1;
    exception when others then
      v_failed := v_failed + 1;
      raise warning 'rib_expire_stale: open challenge % failed: %', v_c.id, sqlerrm;
    end;
  end loop;

  -- Only matches without a turn clock (pre-0018); timed ones are forfeited.
  for v_m in
    select * from public.game_matches
     where status in ('active','disputed') and turn_deadline is null
       and updated_at < now() - make_interval(hours => p_idle_hours)
     order by updated_at limit p_batch for update skip locked
  loop
    begin
      perform public.rib_lock_wallets(v_m.host_id, v_m.guest_id);
      perform public.rib_apply(v_m.host_id, 'game_refund', v_m.stake_cents, -v_m.stake_cents, 'game', v_m.id, 'Match voided (inactivity), stake refunded');
      if v_m.guest_id is not null then
        perform public.rib_apply(v_m.guest_id, 'game_refund', v_m.stake_cents, -v_m.stake_cents, 'game', v_m.id, 'Match voided (inactivity), stake refunded');
      end if;
      update public.game_matches set status = 'cancelled', settled_at = now() where id = v_m.id;
      v_idle_games := v_idle_games + 1;
    exception when others then
      v_failed := v_failed + 1;
      raise warning 'rib_expire_stale: idle match % failed: %', v_m.id, sqlerrm;
    end;
  end loop;

  for v_c in
    select * from public.challenges
     where status in ('active','disputed') and matched_at < now() - make_interval(hours => p_idle_hours)
     order by matched_at limit p_batch for update skip locked
  loop
    begin
      perform public.rib_lock_wallets(v_c.creator_id, v_c.opponent_id);
      perform public.rib_apply(v_c.creator_id, 'challenge_refund', v_c.stake_cents, -v_c.stake_cents, 'challenge', v_c.id, 'Challenge voided (inactivity), stake refunded');
      if v_c.opponent_id is not null then
        perform public.rib_apply(v_c.opponent_id, 'challenge_refund', v_c.stake_cents, -v_c.stake_cents, 'challenge', v_c.id, 'Challenge voided (inactivity), stake refunded');
      end if;
      update public.challenges set status = 'cancelled', settled_at = now() where id = v_c.id;
      v_idle_challenges := v_idle_challenges + 1;
    exception when others then
      v_failed := v_failed + 1;
      raise warning 'rib_expire_stale: idle challenge % failed: %', v_c.id, sqlerrm;
    end;
  end loop;

  return jsonb_build_object(
    'open_games', v_open_games, 'open_challenges', v_open_challenges,
    'idle_games', v_idle_games, 'idle_challenges', v_idle_challenges, 'failed', v_failed
  );
end;
$$;
revoke execute on function public.rib_expire_stale(int,int,int) from public, anon, authenticated;
grant execute on function public.rib_expire_stale(int,int,int) to service_role;

-- ----------------------------------------------------------------------------
-- 5) Lobby search: bound the user-supplied term.
-- ----------------------------------------------------------------------------
create or replace function public.rib_open_challenges(
  p_game text default null, p_min_cents bigint default null, p_max_cents bigint default null,
  p_before timestamptz default null, p_limit int default 30, p_before_id uuid default null
) returns table (id uuid, game text, mode text, stake_cents bigint, created_at timestamptz,
                 creator_id uuid, creator_username text)
language sql stable security definer set search_path = ''
as $$
  select c.id, c.game, c.mode, c.stake_cents, c.created_at, c.creator_id, p.username
    from public.challenges c
    join public.profiles p on p.id = c.creator_id
   where c.status = 'open'
     and c.creator_id <> auth.uid()
     and (p_game is null or p_game = ''
          or c.game ilike '%' || replace(replace(replace(left(p_game, 40), '\', '\\'), '%', '\%'), '_', '\_') || '%')
     and (p_min_cents is null or c.stake_cents >= p_min_cents)
     and (p_max_cents is null or c.stake_cents <= p_max_cents)
     and (p_before is null or (c.created_at, c.id) < (p_before, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
   order by c.created_at desc, c.id desc
   limit least(greatest(coalesce(p_limit, 30), 1), 60);
$$;
revoke execute on function public.rib_open_challenges(text,bigint,bigint,timestamptz,int,uuid) from public, anon;
grant execute on function public.rib_open_challenges(text,bigint,bigint,timestamptz,int,uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Schedules (pg_cron where available) and an initial ranking snapshot.
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('rib-forfeit-timeouts', '* * * * *', 'select public.rib_forfeit_timeouts()');
  else
    raise warning 'pg_cron not installed: schedule rib_forfeit_timeouts(), refresh_player_rankings() and rib_expire_stale() externally';
  end if;
end;
$$;

select public.refresh_player_rankings();
