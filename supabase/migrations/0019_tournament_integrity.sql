-- ============================================================================
-- Runinback — tournament integrity (2026-09-29).
--
-- Closes the organizer-collusion hole (an organizer could let strangers pay
-- in, then declare a second account the winner and take the pool):
--   * the organizer can't enter their own paid tournament;
--   * a tournament needs at least 3 entrants to be finished;
--   * declaring a winner no longer pays out: the prize is held for a 24-hour
--     review window (status 'payout_pending') during which any other entrant
--     can dispute it (status 'disputed');
--   * rib_tournament_payouts() pays undisputed prizes after the window
--     (pg_cron every 10 minutes);
--   * disputes are resolved by an operator with rib_tournament_resolve():
--     pay the declared winner, pay another entrant, or refund every entry.
-- Idempotent.
-- ============================================================================

alter table public.tournaments add column if not exists winner_id uuid references auth.users (id) on delete set null;
alter table public.tournaments add column if not exists payout_at timestamptz;

alter table public.tournaments drop constraint if exists tournaments_status_check;
alter table public.tournaments add constraint tournaments_status_check
  check (status in ('open','full','active','payout_pending','disputed','finished','cancelled')) not valid;
alter table public.tournaments validate constraint tournaments_status_check;

create index if not exists tournaments_payout_due_idx
  on public.tournaments (payout_at) where status = 'payout_pending';

create table if not exists public.tournament_disputes (
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  reason        text check (char_length(reason) <= 500),
  created_at    timestamptz not null default now(),
  primary key (tournament_id, user_id)
);
alter table public.tournament_disputes enable row level security;
revoke all on public.tournament_disputes from anon, authenticated;

-- Rules kept in one place for the RPCs and the UI copy.
create or replace function public.rib_tournament_min_entrants()
returns int language sql immutable set search_path = '' as $$ select 3 $$;
create or replace function public.rib_tournament_review_hours()
returns int language sql immutable set search_path = '' as $$ select 24 $$;

-- ---- Join: organizers can't buy into their own paid tournament -------------
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
  if v_t.creator_id = v_uid and v_t.entry_fee_cents > 0 then
    raise exception 'organizers cannot enter their own paid tournament' using hint = 'organizer_cannot_join';
  end if;
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
grant execute on function public.rib_tournament_join(uuid) to authenticated;

-- ---- Finish: declare a winner; the prize waits out the review window -------
create or replace function public.rib_tournament_finish(p_tournament_id uuid, p_winner_id uuid)
returns public.tournaments
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_t public.tournaments; v_entrants int;
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
  select count(*) into v_entrants from public.tournament_entries where tournament_id = v_t.id;
  if v_entrants < public.rib_tournament_min_entrants() then
    raise exception 'not enough entrants to finish (minimum %)', public.rib_tournament_min_entrants()
      using hint = 'not_enough_entrants';
  end if;

  update public.tournament_entries set placement = 1 where tournament_id = v_t.id and user_id = p_winner_id;
  update public.tournaments
     set status = 'payout_pending', winner_id = p_winner_id,
         payout_at = now() + make_interval(hours => public.rib_tournament_review_hours())
   where id = v_t.id
   returning * into v_t;
  return v_t;
end;
$$;
grant execute on function public.rib_tournament_finish(uuid,uuid) to authenticated;

-- ---- Dispute: any other entrant, during the review window ------------------
create or replace function public.rib_tournament_dispute(p_tournament_id uuid, p_reason text default null)
returns public.tournaments
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_t public.tournaments;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  select * into v_t from public.tournaments where id = p_tournament_id for update;
  if v_t.id is null then raise exception 'tournament not found' using hint = 'tournament_not_found'; end if;
  if not exists (select 1 from public.tournament_entries where tournament_id = v_t.id and user_id = v_uid) then
    raise exception 'only entrants can dispute' using hint = 'not_an_entrant';
  end if;
  if v_uid = v_t.winner_id then raise exception 'the winner cannot dispute' using hint = 'not_an_entrant'; end if;
  if v_t.status = 'disputed' then
    insert into public.tournament_disputes (tournament_id, user_id, reason)
    values (v_t.id, v_uid, left(nullif(trim(p_reason), ''), 500)) on conflict do nothing;
    return v_t;
  end if;
  if v_t.status <> 'payout_pending' or v_t.payout_at <= now() then
    raise exception 'the review window is closed' using hint = 'dispute_window_closed';
  end if;

  insert into public.tournament_disputes (tournament_id, user_id, reason)
  values (v_t.id, v_uid, left(nullif(trim(p_reason), ''), 500)) on conflict do nothing;
  update public.tournaments set status = 'disputed' where id = v_t.id returning * into v_t;
  return v_t;
end;
$$;
revoke execute on function public.rib_tournament_dispute(uuid,text) from public, anon;
grant execute on function public.rib_tournament_dispute(uuid,text) to authenticated;

-- ---- Payout job: undisputed prizes after the window (pg_cron) --------------
create or replace function public.rib_tournament_payouts(p_batch int default 200)
returns int
language plpgsql security definer set search_path = ''
as $$
declare v_t public.tournaments; v_count int := 0;
begin
  for v_t in
    select * from public.tournaments
     where status = 'payout_pending' and payout_at <= now()
     order by payout_at limit p_batch
     for update skip locked
  loop
    begin
      if v_t.prize_pool_cents > 0 then
        perform public.rib_apply(v_t.winner_id, 'tournament_prize', v_t.prize_pool_cents, 0, 'tournament', v_t.id, 'Tournament prize');
      end if;
      update public.tournaments set status = 'finished', finished_at = now() where id = v_t.id;
      v_count := v_count + 1;
    exception when others then
      raise warning 'rib_tournament_payouts: tournament % failed: %', v_t.id, sqlerrm;
    end;
  end loop;
  return v_count;
end;
$$;
revoke execute on function public.rib_tournament_payouts(int) from public, anon, authenticated;
grant execute on function public.rib_tournament_payouts(int) to service_role;

-- ---- Operator resolution of a disputed prize (service role only) ----------
-- p_action: 'pay' (to p_winner_id, or the declared winner when null) or
-- 'refund' (every entry fee back to its player).
create or replace function public.rib_tournament_resolve(p_tournament_id uuid, p_action text, p_winner_id uuid default null)
returns public.tournaments
language plpgsql security definer set search_path = ''
as $$
declare v_t public.tournaments; v_winner uuid; r record;
begin
  select * into v_t from public.tournaments where id = p_tournament_id for update;
  if v_t.id is null then raise exception 'tournament not found' using hint = 'tournament_not_found'; end if;
  if v_t.status not in ('payout_pending','disputed') then
    raise exception 'nothing to resolve' using hint = 'tournament_finished';
  end if;

  if p_action = 'pay' then
    v_winner := coalesce(p_winner_id, v_t.winner_id);
    if v_winner = v_t.creator_id
       or not exists (select 1 from public.tournament_entries where tournament_id = v_t.id and user_id = v_winner) then
      raise exception 'invalid winner' using hint = 'invalid_winner';
    end if;
    update public.tournament_entries set placement = null where tournament_id = v_t.id;
    update public.tournament_entries set placement = 1 where tournament_id = v_t.id and user_id = v_winner;
    if v_t.prize_pool_cents > 0 then
      perform public.rib_apply(v_winner, 'tournament_prize', v_t.prize_pool_cents, 0, 'tournament', v_t.id, 'Tournament prize (reviewed)');
    end if;
    update public.tournaments set status = 'finished', winner_id = v_winner, finished_at = now()
     where id = v_t.id returning * into v_t;
  elsif p_action = 'refund' then
    if v_t.entry_fee_cents > 0 then
      for r in select user_id from public.tournament_entries where tournament_id = v_t.id order by user_id loop
        perform public.rib_apply(r.user_id, 'tournament_refund', v_t.entry_fee_cents, 0, 'tournament', v_t.id, 'Tournament voided after review, entry refunded');
      end loop;
    end if;
    update public.tournament_entries set placement = null where tournament_id = v_t.id;
    update public.tournaments set status = 'cancelled', winner_id = null, prize_pool_cents = 0, finished_at = now()
     where id = v_t.id returning * into v_t;
  else
    raise exception 'action must be pay or refund' using hint = 'invalid_amount';
  end if;
  return v_t;
end;
$$;
revoke execute on function public.rib_tournament_resolve(uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.rib_tournament_resolve(uuid,text,uuid) to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('rib-tournament-payouts', '*/10 * * * *', 'select public.rib_tournament_payouts()');
  else
    raise warning 'pg_cron not installed: schedule rib_tournament_payouts() externally';
  end if;
end;
$$;
