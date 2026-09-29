-- ============================================================================
-- Runinback — console UX data (2026-09-29). Read-side only: what the console
-- needs to tell players what to do next, without extra round trips.
--
--   1) rib_my_rooms: whether the room needs me right now (needs_me), my
--      report, and the bracket depth, so the app can alert on any page.
--   2) rib_my_tournaments: my current room, my round, whether I'm out and
--      what I won, so "My tournaments" reads as my own progress.
--   3) rib_open_tournaments: fullest first (the ones about to start).
--   4) rib_tournament_summary: one tournament by id, for invite links.
--   5) Realtime: captures (room_evidence) reach the other player live.
-- Idempotent.
-- ============================================================================

drop function if exists public.rib_my_rooms();
create or replace function public.rib_my_rooms()
returns table (id uuid, kind text, game text, status text, round int, rounds int, tournament_id uuid, tournament_name text,
               opponent_username text, ready_deadline timestamptz, confirm_deadline timestamptz,
               needs_me boolean, my_report uuid)
language sql stable security definer set search_path = ''
as $$
  select r.id, r.kind, r.game, r.status, r.round, public.rib_tournament_rounds(t.max_players), r.tournament_id, t.name,
         p.username, r.ready_deadline, r.confirm_deadline,
         case
           when r.status = 'ready_check' then (case when r.player_a = auth.uid() then r.a_ready_at else r.b_ready_at end) is null
           when r.status = 'live' then (case when r.player_a = auth.uid() then r.a_report else r.b_report end) is null
           else false
         end,
         case when r.player_a = auth.uid() then r.a_report else r.b_report end
    from public.match_rooms r
    left join public.tournaments t on t.id = r.tournament_id
    left join public.profiles p on p.id = case when r.player_a = auth.uid() then r.player_b else r.player_a end
   where (r.player_a = auth.uid() or r.player_b = auth.uid())
     and r.status in ('ready_check','live','disputed')
   order by 12 desc, coalesce(r.confirm_deadline, r.ready_deadline) nulls last
   limit 20;
$$;

drop function if exists public.rib_my_tournaments(int);
create or replace function public.rib_my_tournaments(p_limit int default 30)
returns table (id uuid, name text, game text, network text, entry_fee_cents bigint, size int, status text,
               entrants int, placement int, winner_username text, prize_pool_cents bigint, created_at timestamptz,
               my_room_id uuid, my_room_status text, my_round int, rounds int, eliminated boolean, prize_cents bigint)
language sql stable security definer set search_path = ''
as $$
  select t.id, t.name, t.game, t.network, t.entry_fee_cents, t.max_players, t.status,
         (select count(*)::int from public.tournament_entries x where x.tournament_id = t.id),
         e.placement, w.username, t.prize_pool_cents, t.created_at,
         cur.id, cur.status, cur.round, public.rib_tournament_rounds(t.max_players),
         exists (select 1 from public.match_rooms o
                  where o.tournament_id = t.id and auth.uid() in (o.player_a, o.player_b)
                    and o.status in ('done','void') and o.winner_id is distinct from auth.uid()),
         coalesce((select sum(l.amount_cents) from public.wallet_ledger l
                    where l.user_id = auth.uid() and l.ref_id = t.id and l.kind = 'tournament_prize'), 0)::bigint
    from public.tournament_entries e
    join public.tournaments t on t.id = e.tournament_id
    left join public.profiles w on w.id = t.winner_id
    left join lateral (
      select r.id, r.status, r.round from public.match_rooms r
       where r.tournament_id = t.id and auth.uid() in (r.player_a, r.player_b)
       order by r.round desc limit 1
    ) cur on true
   where e.user_id = auth.uid() and t.format = 'bracket'
   order by (t.status = 'active') desc, t.created_at desc
   limit least(greatest(coalesce(p_limit, 30), 1), 60);
$$;

drop function if exists public.rib_open_tournaments(text,int,int);
create or replace function public.rib_open_tournaments(p_game text default null, p_size int default null, p_limit int default 30)
returns table (id uuid, name text, game text, network text, entry_fee_cents bigint, size int,
               entrants int, created_at timestamptz, creator_username text, joined boolean)
language sql stable security definer set search_path = ''
as $$
  select x.id, x.name, x.game, x.network, x.entry_fee_cents, x.size, x.entrants, x.created_at, x.creator_username, x.joined
    from (
      select t.id, t.name, t.game, t.network, t.entry_fee_cents, t.max_players as size,
             (select count(*)::int from public.tournament_entries e where e.tournament_id = t.id) as entrants,
             t.created_at, p.username as creator_username,
             exists (select 1 from public.tournament_entries e where e.tournament_id = t.id and e.user_id = auth.uid()) as joined
        from public.tournaments t
        left join public.profiles p on p.id = t.creator_id
       where t.format = 'bracket' and t.status = 'open'
         and (p_game is null or p_game = ''
              or t.game ilike '%' || replace(replace(replace(left(p_game, 40), '\', '\\'), '%', '\%'), '_', '\_') || '%')
         and (p_size is null or t.max_players = p_size)
    ) x
   order by (x.size - x.entrants) asc, x.created_at asc
   limit least(greatest(coalesce(p_limit, 30), 1), 60);
$$;

create or replace function public.rib_tournament_summary(p_tournament_id uuid)
returns table (id uuid, name text, game text, network text, entry_fee_cents bigint, size int, entrants int,
               status text, creator_username text, joined boolean)
language sql stable security definer set search_path = ''
as $$
  select t.id, t.name, t.game, t.network, t.entry_fee_cents, t.max_players,
         (select count(*)::int from public.tournament_entries e where e.tournament_id = t.id),
         t.status, p.username,
         exists (select 1 from public.tournament_entries e where e.tournament_id = t.id and e.user_id = auth.uid())
    from public.tournaments t
    left join public.profiles p on p.id = t.creator_id
   where t.id = p_tournament_id and t.format = 'bracket';
$$;

do $$
begin
  alter publication supabase_realtime add table public.room_evidence;
exception when duplicate_object then null; when undefined_object then null;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array['rib_my_rooms()', 'rib_my_tournaments(int)', 'rib_open_tournaments(text,int,int)', 'rib_tournament_summary(uuid)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end;
$$;
