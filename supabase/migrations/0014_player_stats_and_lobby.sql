-- ============================================================================
-- Runinback — player stats, global leaderboard and challenge lobby (2026-09-28).
--
--   1) player_stats / player_stats_weekly: per-player play results, maintained
--      incrementally by a trigger on wallet_ledger (O(1) per settlement; the
--      leaderboard never aggregates the ledger at read time).
--        net_cents  = sum of every play movement (stakes, pots, prizes, refunds)
--        won_cents  = gross USD won (pots and prizes)
--        wins/losses = settled results (tournament entrants who don't win
--                      add no loss; their entry fee still counts in net)
--      Stakes count in net when locked and are refunded on void/cancel, so a
--      player's net dips while a stake is in play and nets to zero on refunds.
--   2) rib_leaderboard(period, limit, offset) and rib_my_standing(period).
--   3) rib_open_challenges(...): the public challenge lobby with filters and
--      keyset pagination, creator handle included (no N+1 lookups).
-- Idempotent; backfills stats from the existing ledger once.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Stats tables (server-only; read through the RPCs below)
-- ----------------------------------------------------------------------------
create table if not exists public.player_stats (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  net_cents  bigint not null default 0,
  won_cents  bigint not null default 0,
  wins       int    not null default 0,
  losses     int    not null default 0,
  updated_at timestamptz not null default now()
);
create table if not exists public.player_stats_weekly (
  week_start date   not null,
  user_id    uuid   not null references auth.users (id) on delete cascade,
  net_cents  bigint not null default 0,
  won_cents  bigint not null default 0,
  wins       int    not null default 0,
  losses     int    not null default 0,
  primary key (week_start, user_id)
);
alter table public.player_stats        enable row level security;
alter table public.player_stats_weekly enable row level security;
revoke all on public.player_stats, public.player_stats_weekly from anon, authenticated;

-- Ranking order everywhere: net desc, wins desc, user_id asc (stable ties).
create index if not exists player_stats_rank_idx
  on public.player_stats (net_cents desc, wins desc, user_id) where wins + losses > 0;
create index if not exists player_stats_weekly_rank_idx
  on public.player_stats_weekly (week_start, net_cents desc, wins desc, user_id) where wins + losses > 0;

-- Weeks start on Monday 00:00 UTC regardless of the session time zone.
create or replace function public.rib_week_start(p_at timestamptz)
returns date
language sql immutable set search_path = ''
as $$ select date_trunc('week', p_at at time zone 'utc')::date $$;

-- Which ledger kinds count as play, and how.
create or replace function public.rib_play_delta(p_kind text, p_amount bigint,
  out net bigint, out won bigint, out win int, out loss int)
language sql immutable set search_path = ''
as $$
  select
    case when p_kind in ('challenge_lock','challenge_win','challenge_settled','challenge_refund',
                         'game_lock','game_win','game_settled','game_refund',
                         'tournament_entry','tournament_prize','tournament_refund') then p_amount else 0 end,
    case when p_kind in ('challenge_win','game_win','tournament_prize') then p_amount else 0 end,
    case when p_kind in ('challenge_win','game_win','tournament_prize') then 1 else 0 end,
    case when p_kind in ('challenge_settled','game_settled') then 1 else 0 end;
$$;

create or replace function public.rib_track_play()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare d record;
begin
  select * into d from public.rib_play_delta(new.kind, new.amount_cents);
  if d.net = 0 and d.won = 0 and d.win = 0 and d.loss = 0 then
    return new;
  end if;

  insert into public.player_stats as s (user_id, net_cents, won_cents, wins, losses)
  values (new.user_id, d.net, d.won, d.win, d.loss)
  on conflict (user_id) do update
    set net_cents = s.net_cents + excluded.net_cents,
        won_cents = s.won_cents + excluded.won_cents,
        wins      = s.wins + excluded.wins,
        losses    = s.losses + excluded.losses,
        updated_at = now();

  insert into public.player_stats_weekly as w (week_start, user_id, net_cents, won_cents, wins, losses)
  values (public.rib_week_start(new.created_at), new.user_id, d.net, d.won, d.win, d.loss)
  on conflict (week_start, user_id) do update
    set net_cents = w.net_cents + excluded.net_cents,
        won_cents = w.won_cents + excluded.won_cents,
        wins      = w.wins + excluded.wins,
        losses    = w.losses + excluded.losses;
  return new;
end;
$$;
revoke execute on function public.rib_track_play() from public, anon, authenticated;
revoke execute on function public.rib_play_delta(text,bigint) from public, anon, authenticated;

drop trigger if exists wallet_ledger_track_play on public.wallet_ledger;
create trigger wallet_ledger_track_play
  after insert on public.wallet_ledger
  for each row execute function public.rib_track_play();

-- One-time backfill from the ledger written before this migration.
do $$
begin
  if exists (select 1 from public.platform_settings where key = 'player_stats_backfilled') then
    return;
  end if;
  insert into public.player_stats (user_id, net_cents, won_cents, wins, losses)
  select l.user_id, sum(d.net), sum(d.won), sum(d.win), sum(d.loss)
    from public.wallet_ledger l, lateral public.rib_play_delta(l.kind, l.amount_cents) d
   group by l.user_id
  having sum(abs(d.net)) + sum(d.win) + sum(d.loss) > 0
  on conflict (user_id) do nothing;

  insert into public.player_stats_weekly (week_start, user_id, net_cents, won_cents, wins, losses)
  select public.rib_week_start(l.created_at), l.user_id, sum(d.net), sum(d.won), sum(d.win), sum(d.loss)
    from public.wallet_ledger l, lateral public.rib_play_delta(l.kind, l.amount_cents) d
   group by 1, 2
  having sum(abs(d.net)) + sum(d.win) + sum(d.loss) > 0
  on conflict (week_start, user_id) do nothing;

  insert into public.platform_settings (key, value) values ('player_stats_backfilled', to_jsonb(now()));
end;
$$;

-- ----------------------------------------------------------------------------
-- 2) Leaderboard
-- ----------------------------------------------------------------------------
create or replace function public.rib_leaderboard(p_period text default 'week', p_limit int default 50, p_offset int default 0)
returns table (rank bigint, user_id uuid, username text, net_cents bigint, won_cents bigint, wins int, losses int)
language sql stable security definer set search_path = ''
as $$
  -- Page on the rank index first (O(limit + offset)), then join handles.
  with page as (
    select s.user_id, s.net_cents, s.won_cents, s.wins, s.losses
      from public.player_stats s
     where p_period = 'all' and s.wins + s.losses > 0
     order by s.net_cents desc, s.wins desc, s.user_id
     limit least(greatest(coalesce(p_limit, 50), 1), 100)
    offset greatest(coalesce(p_offset, 0), 0)
  ), week_page as (
    select w.user_id, w.net_cents, w.won_cents, w.wins, w.losses
      from public.player_stats_weekly w
     where p_period = 'week' and w.week_start = public.rib_week_start(now()) and w.wins + w.losses > 0
     order by w.net_cents desc, w.wins desc, w.user_id
     limit least(greatest(coalesce(p_limit, 50), 1), 100)
    offset greatest(coalesce(p_offset, 0), 0)
  ), board as (
    select * from page union all select * from week_page
  )
  select greatest(coalesce(p_offset, 0), 0) + row_number() over (order by b.net_cents desc, b.wins desc, b.user_id) as rank,
         b.user_id, p.username, b.net_cents, b.won_cents, b.wins, b.losses
    from board b
    join public.profiles p on p.id = b.user_id
   order by b.net_cents desc, b.wins desc, b.user_id;
$$;

create or replace function public.rib_my_standing(p_period text default 'week')
returns table (rank bigint, net_cents bigint, won_cents bigint, wins int, losses int)
language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  if p_period = 'all' then
    return query
      select (select count(*) + 1 from public.player_stats o
               where o.wins + o.losses > 0
                 and ((o.net_cents, o.wins) > (s.net_cents, s.wins)
                      or ((o.net_cents, o.wins) = (s.net_cents, s.wins) and o.user_id < s.user_id))),
             s.net_cents, s.won_cents, s.wins, s.losses
        from public.player_stats s where s.user_id = v_uid and s.wins + s.losses > 0;
  else
    return query
      select (select count(*) + 1 from public.player_stats_weekly o
               where o.week_start = s.week_start and o.wins + o.losses > 0
                 and ((o.net_cents, o.wins) > (s.net_cents, s.wins)
                      or ((o.net_cents, o.wins) = (s.net_cents, s.wins) and o.user_id < s.user_id))),
             s.net_cents, s.won_cents, s.wins, s.losses
        from public.player_stats_weekly s
       where s.user_id = v_uid and s.week_start = public.rib_week_start(now()) and s.wins + s.losses > 0;
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- 3) Challenge lobby
-- ----------------------------------------------------------------------------
-- Serves the lobby order (and its keyset) directly; the game filter is a
-- substring match applied on top of the newest open rows.
create index if not exists challenges_open_lobby_idx
  on public.challenges (created_at desc, id desc) where status = 'open';

-- Keyset pagination on (created_at, id): no skipped or repeated rows even when
-- several challenges share a timestamp.
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
          or lower(c.game) like '%' || replace(replace(replace(lower(p_game), '\', '\\'), '%', '\%'), '_', '\_') || '%')
     and (p_min_cents is null or c.stake_cents >= p_min_cents)
     and (p_max_cents is null or c.stake_cents <= p_max_cents)
     and (p_before is null or (c.created_at, c.id) < (p_before, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
   order by c.created_at desc, c.id desc
   limit least(greatest(coalesce(p_limit, 30), 1), 60);
$$;

revoke execute on function public.rib_week_start(timestamptz) from public, anon, authenticated;
revoke execute on function public.rib_leaderboard(text,int,int) from public, anon;
revoke execute on function public.rib_my_standing(text) from public, anon;
revoke execute on function public.rib_open_challenges(text,bigint,bigint,timestamptz,int,uuid) from public, anon;
grant execute on function public.rib_leaderboard(text,int,int) to authenticated;
grant execute on function public.rib_my_standing(text) to authenticated;
grant execute on function public.rib_open_challenges(text,bigint,bigint,timestamptz,int,uuid) to authenticated;
