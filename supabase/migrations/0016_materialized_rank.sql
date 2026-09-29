-- ============================================================================
-- Runinback — scalability for 1M users (Materialized Rankings).
--
-- rib_my_standing originally used a correlated COUNT(*) which is O(N) per query.
-- At 1 million users, this would cause heavy database load.
-- Here we introduce a player_rankings table updated asynchronously via pg_cron
-- using O(N log N) window functions, dropping the query cost to O(1).
-- ============================================================================

create table if not exists public.player_rankings (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  rank_all bigint,
  rank_week bigint,
  updated_at timestamptz default now()
);

alter table public.player_rankings enable row level security;
create policy "Users can read their own rank" on public.player_rankings
  for select to authenticated using (user_id = auth.uid());

create or replace function public.refresh_player_rankings()
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  with all_ranks as (
    select user_id, row_number() over (order by net_cents desc, wins desc, user_id asc) as rn
    from public.player_stats
    where wins + losses > 0
  ),
  week_ranks as (
    select user_id, row_number() over (order by net_cents desc, wins desc, user_id asc) as rn
    from public.player_stats_weekly
    where week_start = public.rib_week_start(now()) and wins + losses > 0
  )
  insert into public.player_rankings (user_id, rank_all, rank_week, updated_at)
  select p.id, coalesce(a.rn, 0), coalesce(w.rn, 0), now()
  from public.profiles p
  left join all_ranks a on a.user_id = p.id
  left join week_ranks w on w.user_id = p.id
  where a.rn is not null or w.rn is not null
  on conflict (user_id) do update set
    rank_all = excluded.rank_all,
    rank_week = excluded.rank_week,
    updated_at = excluded.updated_at;
end;
$$;

create or replace function public.rib_my_standing(p_period text default 'week')
returns table (rank bigint, net_cents bigint, won_cents bigint, wins int, losses int)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  
  if p_period = 'all' then
    return query
      select nullif(r.rank_all, 0), s.net_cents, s.won_cents, s.wins, s.losses
        from public.player_stats s
        left join public.player_rankings r on r.user_id = s.user_id
       where s.user_id = v_uid and s.wins + s.losses > 0;
  else
    return query
      select nullif(r.rank_week, 0), s.net_cents, s.won_cents, s.wins, s.losses
        from public.player_stats_weekly s
        left join public.player_rankings r on r.user_id = s.user_id
       where s.user_id = v_uid and s.week_start = public.rib_week_start(now()) and s.wins + s.losses > 0;
  end if;
end;
$$;

grant execute on function public.refresh_player_rankings() to service_role;
grant execute on function public.rib_my_standing(text) to authenticated;

-- If pg_cron is enabled in this Supabase instance, schedule the refresh every 5 minutes.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('refresh-player-rankings', '*/5 * * * *', 'select public.refresh_player_rankings()');
  end if;
end;
$$;
