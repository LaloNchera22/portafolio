-- ============================================================================
-- Runinback — scalability for 1M users (Materialized Rankings for Leaderboard).
--
-- rib_leaderboard originally used OFFSET pagination on live stats which is O(N)
-- per query. We migrate it to use the materialized player_rankings table and 
-- Keyset Pagination (using rank > p_offset).
-- ============================================================================

create index if not exists player_rankings_rank_all_idx on public.player_rankings (rank_all) where rank_all > 0;
create index if not exists player_rankings_rank_week_idx on public.player_rankings (rank_week) where rank_week > 0;

create or replace function public.rib_leaderboard(p_period text default 'week', p_limit int default 50, p_offset int default 0)
returns table (rank bigint, user_id uuid, username text, net_cents bigint, won_cents bigint, wins int, losses int)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
begin
  if p_period = 'all' then
    return query
      select r.rank_all, r.user_id, p.username, s.net_cents, s.won_cents, s.wins, s.losses
        from public.player_rankings r
        join public.player_stats s on s.user_id = r.user_id
        join public.profiles p on p.id = r.user_id
       where r.rank_all > v_offset
       order by r.rank_all asc
       limit v_limit;
  else
    return query
      select r.rank_week, r.user_id, p.username, s.net_cents, s.won_cents, s.wins, s.losses
        from public.player_rankings r
        join public.player_stats_weekly s on s.user_id = r.user_id
        join public.profiles p on p.id = r.user_id
       where r.rank_week > v_offset and s.week_start = public.rib_week_start(now())
       order by r.rank_week asc
       limit v_limit;
  end if;
end;
$$;
