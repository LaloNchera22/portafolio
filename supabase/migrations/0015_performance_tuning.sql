-- ============================================================================
-- Runinback — query and architecture optimizations.
--
-- 1) rib_leaderboard: Ported to plpgsql to isolate period plans (avoiding UNION
--    ALL planner overhead) and removed redundant re-sorting over the page limit.
-- 2) rib_open_challenges: Optimized substring search with standard ilike.
-- ============================================================================

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
      with page as (
        select s.user_id, s.net_cents, s.won_cents, s.wins, s.losses,
               row_number() over (order by s.net_cents desc, s.wins desc, s.user_id) as rn
          from public.player_stats s
         where s.wins + s.losses > 0
         order by s.net_cents desc, s.wins desc, s.user_id
         limit v_limit offset v_offset
      )
      select v_offset + page.rn, page.user_id, p.username,
             page.net_cents, page.won_cents, page.wins, page.losses
        from page
        join public.profiles p on p.id = page.user_id
       order by page.rn;
  else
    return query
      with page as (
        select w.user_id, w.net_cents, w.won_cents, w.wins, w.losses,
               row_number() over (order by w.net_cents desc, w.wins desc, w.user_id) as rn
          from public.player_stats_weekly w
         where w.week_start = public.rib_week_start(now()) and w.wins + w.losses > 0
         order by w.net_cents desc, w.wins desc, w.user_id
         limit v_limit offset v_offset
      )
      select v_offset + page.rn, page.user_id, p.username,
             page.net_cents, page.won_cents, page.wins, page.losses
        from page
        join public.profiles p on p.id = page.user_id
       order by page.rn;
  end if;
end;
$$;

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
     and (p_game is null or p_game = '' or c.game ilike '%' || replace(replace(replace(p_game, '\', '\\'), '%', '\%'), '_', '\_') || '%')
     and (p_min_cents is null or c.stake_cents >= p_min_cents)
     and (p_max_cents is null or c.stake_cents <= p_max_cents)
     and (p_before is null or (c.created_at, c.id) < (p_before, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
   order by c.created_at desc, c.id desc
   limit least(greatest(coalesce(p_limit, 30), 1), 60);
$$;

grant execute on function public.rib_leaderboard(text,int,int) to authenticated;
grant execute on function public.rib_open_challenges(text,bigint,bigint,timestamptz,int,uuid) to authenticated;
