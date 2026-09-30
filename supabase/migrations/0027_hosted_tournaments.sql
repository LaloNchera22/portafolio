-- ============================================================================
-- Runinback — hosted tournaments (2026-09-30).
-- Contract: docs/hosted-tournaments.md ("Database").
--
-- Anyone signed in can host a Wild Rift tournament: they share an invite
-- link, players join (entry fee taken as today), the host starts it (or it
-- starts when full), posts the custom-lobby code in every match room and
-- decides every match. The host never plays. Player reports and screenshots
-- are advisory in hosted rooms: only the host, an operator (rib_host_decide,
-- rib_host_void_room, rib_room_resolve) or the abandon sweep end a hosted room.
--
--   1) Rules as functions: host fee (5%), appeal window (24 h), host decide
--      window (60 min), host abandon window (24 h).
--   2) Columns: tournaments.mode / visibility / invite_code / rules /
--      host_fee_cents / last_progress_at; match_rooms 'setup' status and
--      host_note; room_messages.kind / image_path; appeals on
--      tournament_disputes; host record on player_reputation.
--   3) Privacy: private tournaments are hidden from the lobby and from other
--      players' direct reads; nobody but the host reads an invite code. The
--      host sees and chats in every room of their tournaments.
--   4) Bracket: early start with byes (next power of two >= entrants, byes as
--      walkovers), brackets of 16 and 32. Hosted rooms open in 'setup'.
--   5) Money: the hosted final goes to 'payout_pending' for the appeal
--      window; the payout job pays 85% winner / 5% host / 10% platform of
--      entry_fee x entrants. Appeals hold a deposit and wait for an operator.
--   6) Jobs: rib_hosted_sweep (decide-window flags, abandoned tournaments) and
--      the chat purge used by the room-cleanup Edge Function.
-- Quick Play (mode 'quick') keeps its behaviour: every hosted rule branches on
-- tournaments.mode = 'hosted'.
-- Idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Rules
-- ----------------------------------------------------------------------------
create or replace function public.rib_host_fee_percent()
returns int language sql immutable set search_path = '' as $$ select 5 $$;

create or replace function public.rib_appeal_window()
returns interval language sql immutable set search_path = '' as $$ select interval '24 hours' $$;

create or replace function public.rib_host_decide_window()
returns interval language sql immutable set search_path = '' as $$ select interval '60 minutes' $$;

create or replace function public.rib_host_abandon_window()
returns interval language sql immutable set search_path = '' as $$ select interval '24 hours' $$;

-- A hosted tournament that is still open this long after creation is cancelled.
create or replace function public.rib_host_open_window()
returns interval language sql immutable set search_path = '' as $$ select interval '7 days' $$;

-- A walkover or a void needs the room to have waited this long in setup/live.
create or replace function public.rib_host_walkover_wait()
returns interval language sql immutable set search_path = '' as $$ select interval '10 minutes' $$;

-- A decision sooner than this after the room went live is flagged for review.
create or replace function public.rib_host_min_match_minutes()
returns int language sql immutable set search_path = '' as $$ select 8 $$;

-- A host counts as experienced after this many hosted tournaments paid out
-- without a strike (fee cap, shorter appeal window).
create or replace function public.rib_host_min_completed()
returns int language sql immutable set search_path = '' as $$ select 3 $$;

-- Bracket depth by bracket size (Quick Play: 4 and 8; hosted up to 32).
create or replace function public.rib_tournament_rounds(p_size int)
returns int language sql immutable set search_path = ''
as $$ select case p_size when 4 then 2 when 8 then 3 when 16 then 4 when 32 then 5 else 0 end $$;

-- ----------------------------------------------------------------------------
-- 2) Columns, constraints, indexes
-- ----------------------------------------------------------------------------
alter table public.tournaments add column if not exists mode             text not null default 'quick';
alter table public.tournaments add column if not exists visibility       text not null default 'public';
alter table public.tournaments add column if not exists invite_code      text;
alter table public.tournaments add column if not exists rules            text;
alter table public.tournaments add column if not exists host_fee_cents   bigint not null default 0;
alter table public.tournaments add column if not exists last_progress_at timestamptz;

alter table public.match_rooms add column if not exists host_note      text;
alter table public.match_rooms add column if not exists chat_purged_at timestamptz;
-- When a hosted room entered 'setup' (walkover / void waiting time).
alter table public.match_rooms add column if not exists setup_at       timestamptz;

alter table public.room_messages add column if not exists kind       text not null default 'chat';
alter table public.room_messages add column if not exists image_path text;

alter table public.tournament_disputes add column if not exists room_id         uuid references public.match_rooms (id) on delete set null;
alter table public.tournament_disputes add column if not exists status          text not null default 'open';
alter table public.tournament_disputes add column if not exists deposit_cents   bigint not null default 0;
alter table public.tournament_disputes add column if not exists resolved_at     timestamptz;
alter table public.tournament_disputes add column if not exists resolution_note text;

alter table public.player_reputation add column if not exists hosted_completed int not null default 0;
alter table public.player_reputation add column if not exists host_strikes     int not null default 0;

-- Disputes filed before appeals existed (0019) are closed once their
-- tournament is no longer 'disputed': refunded events upheld them, paid ones
-- rejected them.
update public.tournament_disputes d
   set status = case when t.status = 'cancelled' then 'upheld' else 'rejected' end,
       resolved_at = coalesce(d.resolved_at, t.finished_at, now())
  from public.tournaments t
 where t.id = d.tournament_id and d.status = 'open' and t.status <> 'disputed';

-- New and changed check constraints are added NOT VALID: they hold for every
-- new or updated row at once, without scanning the existing tables here.
-- Follow-up: VALIDATE them in a later migration, off-peak.
do $$
declare c record;
begin
  for c in
    select * from (values
      ('public.tournaments'::regclass, 'tournaments_mode_check',
       $c$check (mode in ('quick','hosted'))$c$),
      ('public.tournaments'::regclass, 'tournaments_visibility_check',
       $c$check (visibility in ('public','private'))$c$),
      ('public.tournaments'::regclass, 'tournaments_invite_code_check',
       $c$check (invite_code is null or invite_code ~ '^[A-HJ-NP-Z2-9]{10}$')$c$),
      ('public.tournaments'::regclass, 'tournaments_rules_check',
       $c$check (rules is null or char_length(rules) <= 1000)$c$),
      ('public.tournaments'::regclass, 'tournaments_host_fee_cents_check',
       $c$check (host_fee_cents >= 0)$c$),
      ('public.match_rooms'::regclass, 'match_rooms_host_note_check',
       $c$check (host_note is null or char_length(host_note) <= 300)$c$),
      ('public.room_messages'::regclass, 'room_messages_kind_check',
       $c$check (kind in ('chat','lobby','system'))$c$),
      ('public.room_messages'::regclass, 'room_messages_image_path_check',
       $c$check (image_path is null or char_length(image_path) <= 200)$c$),
      ('public.tournament_disputes'::regclass, 'tournament_disputes_status_check',
       $c$check (status in ('open','upheld','rejected'))$c$),
      ('public.tournament_disputes'::regclass, 'tournament_disputes_deposit_cents_check',
       $c$check (deposit_cents >= 0)$c$),
      ('public.tournament_disputes'::regclass, 'tournament_disputes_resolution_note_check',
       $c$check (resolution_note is null or char_length(resolution_note) <= 500)$c$)
    ) v (tbl, name, def)
  loop
    if not exists (select 1 from pg_constraint where conrelid = c.tbl and conname = c.name) then
      execute format('alter table %s add constraint %I %s not valid', c.tbl, c.name, c.def);
    end if;
  end loop;

  -- Rooms gain 'setup' (a hosted room waiting for the host's lobby).
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.match_rooms'::regclass and conname = 'match_rooms_status_check'
                    and pg_get_constraintdef(oid) like '%setup%') then
    alter table public.match_rooms drop constraint if exists match_rooms_status_check;
    alter table public.match_rooms add constraint match_rooms_status_check
      check (status in ('waiting','setup','ready_check','live','disputed','done','void')) not valid;
  end if;

  -- Ledger kind for the host commission.
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.wallet_ledger'::regclass and conname = 'wallet_ledger_kind_check'
                    and pg_get_constraintdef(oid) like '%host_commission%') then
    alter table public.wallet_ledger drop constraint if exists wallet_ledger_kind_check;
    alter table public.wallet_ledger add constraint wallet_ledger_kind_check
      check (kind in (
        'deposit','withdrawal',
        'challenge_lock','challenge_win','challenge_settled','challenge_refund',
        'tournament_entry','tournament_prize','tournament_refund',
        'rcoin_purchase','rcoin_reversal',
        'game_lock','game_win','game_settled','game_refund',
        'dispute_deposit','dispute_refund','dispute_forfeit','dispute_award',
        'host_commission'
      )) not valid;
  end if;
end;
$$;

create unique index if not exists tournaments_invite_code_key on public.tournaments (invite_code) where invite_code is not null;
-- A host's tournaments (dashboard, the 3-live cap).
create index if not exists tournaments_host_idx on public.tournaments (creator_id, created_at desc) where mode = 'hosted';
-- Abandon sweep and never-started hosted events.
create index if not exists tournaments_hosted_open_idx on public.tournaments (created_at) where mode = 'hosted' and status = 'open';
create index if not exists tournaments_hosted_active_idx on public.tournaments (last_progress_at) where mode = 'hosted' and status = 'active';
-- Rooms waiting on a host decision (SLA flag).
create index if not exists match_rooms_live_unflagged_idx on public.match_rooms (started_at) where status = 'live' and not review_flag;
-- Rooms whose chat may be purged.
create index if not exists match_rooms_purge_idx on public.match_rooms (finished_at) where status in ('done','void') and chat_purged_at is null;
-- A player's rooms that need them, including hosted rooms in setup.
create index if not exists match_rooms_player_a_open_idx on public.match_rooms (player_a) where status in ('setup','ready_check','live','disputed');
create index if not exists match_rooms_player_b_open_idx on public.match_rooms (player_b) where status in ('setup','ready_check','live','disputed');
-- Covered by the two above.
drop index if exists public.match_rooms_player_a_idx;
drop index if exists public.match_rooms_player_b_idx;
-- Open appeals (ops queue).
create index if not exists tournament_disputes_open_idx on public.tournament_disputes (created_at) where status = 'open';

-- ----------------------------------------------------------------------------
-- 3) Helpers
-- ----------------------------------------------------------------------------
-- 10 characters from ABCDEFGHJKLMNPQRSTUVWXYZ23456789 (no I, O, 0, 1). Each
-- character takes the low 5 bits of a fully random byte of a v4 UUID.
create or replace function public.rib_invite_code()
returns text
language plpgsql volatile set search_path = ''
as $$
declare v_alpha constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; v_bytes bytea; v_code text; i int;
begin
  loop
    v_bytes := uuid_send(gen_random_uuid());
    v_code := '';
    foreach i in array array[0, 1, 2, 3, 4, 5, 10, 11, 12, 13] loop
      v_code := v_code || substr(v_alpha, 1 + (get_byte(v_bytes, i) & 31), 1);
    end loop;
    exit when not exists (select 1 from public.tournaments where invite_code = v_code);
  end loop;
  return v_code;
end;
$$;

-- The split of a hosted prize pool (integer cents; the winner absorbs rounding).
-- p_host_paid = false when the host commission is forfeited (overturned appeal).
create or replace function public.rib_hosted_split(p_pool bigint, p_host_paid boolean default true)
returns jsonb
language sql immutable set search_path = ''
as $$
  select jsonb_build_object(
    'pool_cents',     p_pool,
    'platform_cents', p_pool * public.rib_platform_fee_percent() / 100,
    'host_cents',     case when p_host_paid then p_pool * public.rib_host_fee_percent() / 100 else 0 end,
    'winner_cents',   p_pool - p_pool * public.rib_platform_fee_percent() / 100
                             - case when p_host_paid then p_pool * public.rib_host_fee_percent() / 100 else 0 end)
$$;

-- Appeal window of a tournament: 72 hours for a paid event whose host has
-- fewer than rib_host_min_completed() clean hosted payouts, else 24 hours.
create or replace function public.rib_appeal_window_for(p_tournament_id uuid)
returns interval
language sql stable security definer set search_path = ''
as $$
  select case when t.mode = 'hosted' and t.entry_fee_cents > 0
                   and coalesce((select r.hosted_completed from public.player_reputation r where r.user_id = t.creator_id), 0)
                       < public.rib_host_min_completed()
              then interval '72 hours' else public.rib_appeal_window() end
    from public.tournaments t where t.id = p_tournament_id;
$$;

-- Who may read a tournament's entries: anyone for a public tournament; for a
-- private one its host, its entrants and operators.
create or replace function public.rib_can_see_entries(p_tournament_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.tournaments t
                  where t.id = p_tournament_id and (t.visibility = 'public' or t.creator_id = auth.uid()))
      or exists (select 1 from public.tournament_entries e where e.tournament_id = p_tournament_id and e.user_id = auth.uid())
      or public.rib_is_operator();
$$;

-- The room of a storage path '<room uuid>/...', or null when the name has
-- another shape (never raises, so other buckets' names are safe).
create or replace function public.rib_path_room(p_name text)
returns uuid
language sql immutable set search_path = ''
as $$
  select case when p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
              then left(p_name, 36)::uuid end;
$$;

-- Lobby screenshot writes: '<room>/<uuid>.<ext>', by the host of the room's
-- tournament, while the room is in setup or live; inserts up to 10 per room.
create or replace function public.rib_room_lobby_write_ok(p_name text, p_insert boolean)
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare v_room uuid := public.rib_path_room(p_name);
begin
  if v_room is null
     or p_name !~ '^[0-9a-f-]{36}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpe?g|webp)$' then
    return false;
  end if;
  if not exists (select 1 from public.match_rooms r join public.tournaments t on t.id = r.tournament_id
                  where r.id = v_room and r.status in ('setup','live') and t.mode = 'hosted' and t.creator_id = auth.uid()) then
    return false;
  end if;
  if p_insert and (select count(*) from storage.objects o
                    where o.bucket_id = 'room-lobby' and o.name like v_room::text || '/%') >= 10 then
    return false;
  end if;
  return true;
end;
$$;

-- Evidence uploads: '<room>/<uid>/...' by one of the room's two players.
create or replace function public.rib_room_evidence_write_ok(p_name text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.match_rooms r
                  where r.id = public.rib_path_room(p_name)
                    and split_part(p_name, '/', 2) = auth.uid()::text
                    and auth.uid() in (r.player_a, r.player_b));
$$;

create or replace function public.rib_is_room_host(p_room_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.match_rooms r join public.tournaments t on t.id = r.tournament_id
                  where r.id = p_room_id and t.mode = 'hosted' and t.creator_id = auth.uid());
$$;

create or replace function public.rib_can_see_room(p_room_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.match_rooms r
                  where r.id = p_room_id and (r.player_a = auth.uid() or r.player_b = auth.uid()))
      or public.rib_is_room_host(p_room_id)
      or public.rib_is_operator();
$$;

create or replace function public.rib_host_strike(p_uid uuid)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.player_reputation as r (user_id, host_strikes) values (p_uid, 1)
  on conflict (user_id) do update set host_strikes = r.host_strikes + 1, updated_at = now();
$$;

-- Every entrant's and the host's wallet, locked once in a fixed order.
create or replace function public.rib_lock_tournament_wallets(p_tournament_id uuid)
returns void
language sql security definer set search_path = ''
as $$
  select 1 from public.wallets w
   where w.user_id in (select e.user_id from public.tournament_entries e where e.tournament_id = p_tournament_id
                       union select t.creator_id from public.tournaments t where t.id = p_tournament_id)
   order by w.user_id
   for update;
$$;

-- Platform revenue: one row per tournament, accumulated (fee + forfeited deposits).
create or replace function public.rib_platform_revenue_add(p_tournament_id uuid, p_cents bigint)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.platform_revenue as p (tournament_id, amount_cents)
  select p_tournament_id, p_cents where p_cents > 0
  on conflict (tournament_id) do update set amount_cents = p.amount_cents + excluded.amount_cents;
$$;

-- Refund every entry fee of a tournament whose wallets the caller has locked.
create or replace function public.rib_tournament_refund_all(p_tournament_id uuid, p_memo text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_fee bigint; r record;
begin
  select entry_fee_cents into v_fee from public.tournaments where id = p_tournament_id;
  if coalesce(v_fee, 0) > 0 then
    for r in select user_id from public.tournament_entries where tournament_id = p_tournament_id order by user_id loop
      perform public.rib_apply(r.user_id, 'tournament_refund', v_fee, 0, 'tournament', p_tournament_id, p_memo);
    end loop;
  end if;
end;
$$;

-- Close every open appeal of a tournament: 'upheld' returns the deposits,
-- 'rejected' forfeits them to platform revenue.
create or replace function public.rib_appeals_close(p_tournament_id uuid, p_status text, p_note text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare d record; v_forfeit bigint := 0;
begin
  for d in select * from public.tournament_disputes
            where tournament_id = p_tournament_id and status = 'open' order by user_id for update loop
    if d.deposit_cents > 0 then
      if p_status = 'upheld' then
        perform public.rib_apply(d.user_id, 'dispute_refund', d.deposit_cents, -d.deposit_cents, 'tournament', p_tournament_id, 'Appeal upheld, deposit returned');
      else
        perform public.rib_apply(d.user_id, 'dispute_forfeit', 0, -d.deposit_cents, 'tournament', p_tournament_id, 'Appeal rejected, deposit kept');
        v_forfeit := v_forfeit + d.deposit_cents;
      end if;
    end if;
    update public.tournament_disputes
       set status = p_status, resolved_at = now(), resolution_note = left(nullif(trim(coalesce(p_note, '')), ''), 500)
     where tournament_id = d.tournament_id and user_id = d.user_id;
  end loop;
  perform public.rib_platform_revenue_add(p_tournament_id, v_forfeit);
end;
$$;

-- Pay a hosted tournament whose row the caller holds FOR UPDATE:
-- pool = entry fee x entrants; platform 10%, host 5% (unless forfeited),
-- winner the remainder.
create or replace function public.rib_hosted_pay(p_tournament_id uuid, p_winner uuid, p_host_paid boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_t public.tournaments; v_split jsonb; v_platform bigint; v_host bigint; v_winner bigint;
begin
  select * into v_t from public.tournaments where id = p_tournament_id;
  v_split    := public.rib_hosted_split(v_t.entry_fee_cents * v_t.entrants, p_host_paid);
  v_platform := (v_split ->> 'platform_cents')::bigint;
  v_host     := (v_split ->> 'host_cents')::bigint;
  v_winner   := (v_split ->> 'winner_cents')::bigint;

  perform public.rib_lock_wallets(p_winner, v_t.creator_id);
  if v_winner > 0 then
    perform public.rib_apply(p_winner, 'tournament_prize', v_winner, 0, 'tournament', v_t.id, 'Tournament won');
  end if;
  if v_host > 0 then
    perform public.rib_apply(v_t.creator_id, 'host_commission', v_host, 0, 'tournament', v_t.id, 'Host commission');
  end if;
  perform public.rib_platform_revenue_add(v_t.id, v_platform);
  if p_host_paid then
    insert into public.player_reputation as r (user_id, hosted_completed) values (v_t.creator_id, 1)
    on conflict (user_id) do update set hosted_completed = r.hosted_completed + 1, updated_at = now();
  end if;
  update public.tournament_entries set placement = null where tournament_id = v_t.id and placement = 1 and user_id <> p_winner;
  update public.tournament_entries set placement = 1 where tournament_id = v_t.id and user_id = p_winner;
  update public.tournaments
     set status = 'finished', winner_id = p_winner, prize_pool_cents = v_winner,
         platform_fee_cents = v_platform, host_fee_cents = v_host, finished_at = now()
   where id = v_t.id;
end;
$$;

-- ----------------------------------------------------------------------------
-- 4) Privacy: private tournaments and invite codes
-- ----------------------------------------------------------------------------
drop policy if exists "tournaments: select all" on public.tournaments;
drop policy if exists "tournaments: visible" on public.tournaments;
create policy "tournaments: visible" on public.tournaments
  for select to authenticated
  using (visibility = 'public'
         or creator_id = (select auth.uid())
         or exists (select 1 from public.tournament_entries e
                     where e.tournament_id = tournaments.id and e.user_id = (select auth.uid()))
         or (select public.rib_is_operator()));

-- Table-level read (Realtime needs it); the policy above hides private rows,
-- so an invite code only reaches the host and the entrants.
revoke all on public.tournaments from anon;
grant select on public.tournaments to authenticated;

-- Entries of a private tournament: its host, its entrants and operators.
drop policy if exists "entries: select" on public.tournament_entries;
create policy "entries: select" on public.tournament_entries
  for select to authenticated
  using (user_id = (select auth.uid()) or public.rib_can_see_entries(tournament_id));

-- The host sees every room of their tournaments.
drop policy if exists "match_rooms: players and operators" on public.match_rooms;
drop policy if exists "match_rooms: players, host and operators" on public.match_rooms;
create policy "match_rooms: players, host and operators" on public.match_rooms
  for select to authenticated
  using (player_a = (select auth.uid()) or player_b = (select auth.uid())
         or (select public.rib_is_operator())
         or tournament_id in (select t.id from public.tournaments t
                               where t.creator_id = (select auth.uid()) and t.mode = 'hosted'));
-- room_messages / room_evidence policies call rib_can_see_room (host included above).

-- Lobby screenshots: private bucket, <room id>/<uuid>.<ext>, written only by
-- the host of the room's tournament, read by anyone who can see the room.
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('room-lobby', 'room-lobby', false, 5242880, array['image/png','image/jpeg','image/webp'])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
    execute 'drop policy if exists "room lobby: host uploads" on storage.objects';
    execute $p$create policy "room lobby: host uploads" on storage.objects
      for insert to authenticated with check (
        bucket_id = 'room-lobby' and public.rib_room_lobby_write_ok(name, true))$p$;
    execute 'drop policy if exists "room lobby: host removes" on storage.objects';
    execute $p$create policy "room lobby: host removes" on storage.objects
      for delete to authenticated using (
        bucket_id = 'room-lobby' and public.rib_room_lobby_write_ok(name, false))$p$;
    execute 'drop policy if exists "room lobby: read room" on storage.objects';
    execute $p$create policy "room lobby: read room" on storage.objects
      for select to authenticated using (
        bucket_id = 'room-lobby' and public.rib_can_see_room(public.rib_path_room(name)))$p$;
    -- Evidence (0022): only the room's two players upload; casts guarded.
    execute 'drop policy if exists "room evidence: upload own" on storage.objects';
    execute $p$create policy "room evidence: upload own" on storage.objects
      for insert to authenticated with check (
        bucket_id = 'room-evidence' and public.rib_room_evidence_write_ok(name))$p$;
    execute 'drop policy if exists "room evidence: read room" on storage.objects';
    execute $p$create policy "room evidence: read room" on storage.objects
      for select to authenticated using (
        bucket_id = 'room-evidence' and public.rib_can_see_room(public.rib_path_room(name)))$p$;
  else
    raise warning 'storage schema not present: create the room-lobby bucket and policies on Supabase';
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- 5) Rooms and bracket
-- ----------------------------------------------------------------------------
-- Both players are known. Quick Play: lobby details and the ready check.
-- Hosted: 'setup' until the host posts the Wild Rift lobby.
create or replace function public.rib_room_open(p_room_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_code text := public.rib_room_code(); v_hosted boolean;
begin
  select coalesce(t.mode = 'hosted', false) into v_hosted
    from public.match_rooms r left join public.tournaments t on t.id = r.tournament_id
   where r.id = p_room_id;
  if v_hosted then
    update public.match_rooms r
       set status = 'setup', room_code = v_code, lobby_name = null, lobby_password = null,
           a_riot_id = public.rib_riot_handle(r.player_a), b_riot_id = public.rib_riot_handle(r.player_b),
           ready_deadline = null, setup_at = now(), updated_at = now()
     where r.id = p_room_id and r.status = 'waiting';
  else
    update public.match_rooms r
       set status = 'ready_check', room_code = v_code, lobby_name = 'Runinback ' || v_code,
           lobby_password = lower(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
           a_riot_id = public.rib_riot_handle(r.player_a), b_riot_id = public.rib_riot_handle(r.player_b),
           ready_deadline = now() + public.rib_ready_window(), updated_at = now()
     where r.id = p_room_id and r.status = 'waiting';
  end if;
end;
$$;

-- A room ended with a winner: as in 0022, except that hosted matches don't
-- feed completed matches or the ranking (a host could farm them with alt
-- accounts). No-shows still count (recorded by the callers).
create or replace function public.rib_room_finish(p_room_id uuid, p_winner uuid, p_walkover boolean default false)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_r public.match_rooms; v_hosted boolean;
begin
  update public.match_rooms
     set status = 'done', winner_id = p_winner, walkover = p_walkover, confirm_deadline = null,
         finished_at = now(), updated_at = now()
   where id = p_room_id and status not in ('done','void')
  returning * into v_r;
  if v_r.id is null then return; end if;
  if v_r.kind = 'friendly' then
    update public.challenges set status = 'settled', winner_id = p_winner, settled_at = now() where room_id = v_r.id;
  else
    select coalesce(bool_or(t.mode = 'hosted'), false) into v_hosted from public.tournaments t where t.id = v_r.tournament_id;
    if not p_walkover and not v_hosted then
      perform public.rib_rep_bump(v_r.player_a, 1, 0, 0);
      perform public.rib_rep_bump(v_r.player_b, 1, 0, 0);
      perform public.rib_stats_record(p_winner, 1, 0);
      perform public.rib_stats_record(case when p_winner = v_r.player_a then v_r.player_b else v_r.player_a end, 0, 1);
    end if;
    perform public.rib_tournament_advance(v_r.id);
  end if;
end;
$$;

-- Seed the bracket. Size = next power of two >= entrants (Quick Play events
-- start full, so their size is unchanged). Missing players are byes, spread
-- over even slots first, and resolved as walkovers through the normal
-- advance logic.
create or replace function public.rib_tournament_start(p_tournament_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_t public.tournaments; v_players uuid[]; v_n int; v_size int := 4; v_rounds int; v_byes int;
        v_bye_slots int[]; v_round int; i int; k int := 1; v_a uuid; v_b uuid; r record;
begin
  select * into v_t from public.tournaments where id = p_tournament_id for update;
  select array_agg(user_id order by random()) into v_players from public.tournament_entries where tournament_id = v_t.id;
  v_n := coalesce(array_length(v_players, 1), 0);
  while v_size < v_n loop v_size := v_size * 2; end loop;
  v_rounds := public.rib_tournament_rounds(v_size);
  v_byes := v_size - v_n;
  select coalesce(array_agg(s order by s % 2, s), '{}') into v_bye_slots
    from (select s from generate_series(0, v_size / 2 - 1) s order by s % 2, s limit v_byes) x;

  for i in 0..v_size / 2 - 1 loop
    v_a := v_players[k];
    if i = any (v_bye_slots) then
      v_b := null; k := k + 1;
    else
      v_b := v_players[k + 1]; k := k + 2;
    end if;
    insert into public.match_rooms (kind, tournament_id, round, slot, game, network, player_a, player_b)
    values ('tournament', v_t.id, 1, i, v_t.game, v_t.network, v_a, v_b);
  end loop;
  for v_round in 2..v_rounds loop
    for i in 0..(v_size / (2 ^ v_round)::int) - 1 loop
      insert into public.match_rooms (kind, tournament_id, round, slot, game, network)
      values ('tournament', v_t.id, v_round, i, v_t.game, v_t.network);
    end loop;
  end loop;

  update public.tournaments
     set status = 'active', started_at = now(), max_players = v_size, last_progress_at = now()
   where id = v_t.id;
  perform public.rib_room_open(m.id) from public.match_rooms m
   where m.tournament_id = v_t.id and m.round = 1 and m.player_b is not null;
  for r in select m.id, m.player_a from public.match_rooms m
            where m.tournament_id = v_t.id and m.round = 1 and m.player_b is null order by m.slot loop
    perform public.rib_room_finish(r.id, r.player_a, true);
  end loop;
end;
$$;

-- Quick Play: pay at once (unchanged). Hosted: the result waits out the
-- appeal window in 'payout_pending'; no money moves here. A final with no
-- winner refunds every entry fee either way.
create or replace function public.rib_tournament_complete(p_tournament_id uuid, p_winner uuid, p_runner_up uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_t public.tournaments; v_pool bigint; v_fee bigint; v_prizes bigint; v_first bigint; v_second bigint; r record;
begin
  select * into v_t from public.tournaments where id = p_tournament_id for update;
  if v_t.status <> 'active' then return; end if;

  if p_winner is null then
    if v_t.entry_fee_cents > 0 then
      for r in select user_id from public.tournament_entries where tournament_id = v_t.id order by user_id loop
        perform public.rib_apply(r.user_id, 'tournament_refund', v_t.entry_fee_cents, 0, 'tournament', v_t.id, 'Tournament ended without a winner, entry refunded');
      end loop;
    end if;
    update public.tournaments set status = 'cancelled', prize_pool_cents = 0, finished_at = now() where id = v_t.id;
    return;
  end if;

  if v_t.mode = 'hosted' then
    update public.tournament_entries set placement = 1 where tournament_id = v_t.id and user_id = p_winner;
    if p_runner_up is not null then
      update public.tournament_entries set placement = 2 where tournament_id = v_t.id and user_id = p_runner_up;
    end if;
    update public.tournaments
       set status = 'payout_pending', winner_id = p_winner, runner_up_id = p_runner_up,
           payout_at = now() + public.rib_appeal_window_for(v_t.id), last_progress_at = now()
     where id = v_t.id;
    return;
  end if;

  v_pool   := v_t.entry_fee_cents * v_t.max_players;
  v_fee    := v_pool * public.rib_platform_fee_percent() / 100;
  v_prizes := v_pool - v_fee;
  if p_runner_up is null then
    v_first := v_prizes; v_second := 0;
  else
    v_first := v_prizes * 70 / 100; v_second := v_prizes - v_first;
  end if;

  perform public.rib_lock_wallets(p_winner, coalesce(p_runner_up, p_winner));
  if v_first > 0 then
    perform public.rib_apply(p_winner, 'tournament_prize', v_first, 0, 'tournament', v_t.id, 'Tournament won');
  end if;
  if v_second > 0 then
    perform public.rib_apply(p_runner_up, 'tournament_prize', v_second, 0, 'tournament', v_t.id, 'Tournament runner-up');
  end if;
  if v_fee > 0 then
    insert into public.platform_revenue (tournament_id, amount_cents) values (v_t.id, v_fee)
    on conflict (tournament_id) do nothing;
  end if;
  update public.tournament_entries set placement = 1 where tournament_id = v_t.id and user_id = p_winner;
  if p_runner_up is not null then
    update public.tournament_entries set placement = 2 where tournament_id = v_t.id and user_id = p_runner_up;
  end if;
  update public.tournaments
     set status = 'finished', winner_id = p_winner, runner_up_id = p_runner_up,
         prize_pool_cents = v_prizes, platform_fee_cents = v_fee, finished_at = now()
   where id = v_t.id;
end;
$$;

-- Reports: Quick Play as in 0026. In a hosted room a report is advisory
-- (shown to the host): it never settles the room nor opens a confirm window,
-- and the players may disagree.
create or replace function public.rib_room_report(p_room_id uuid, p_winner_id uuid)
returns public.match_rooms
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_r public.match_rooms; v_mine uuid; v_theirs uuid; v_hosted boolean;
begin
  v_r := public.rib_room_for_player(p_room_id, true);
  if v_r.status <> 'live' then
    raise exception 'both players must be ready before reporting' using hint = 'challenge_not_started';
  end if;
  if p_winner_id is null or (p_winner_id is distinct from v_r.player_a and p_winner_id is distinct from v_r.player_b) then
    raise exception 'invalid winner' using hint = 'invalid_winner';
  end if;
  v_mine   := case when v_uid = v_r.player_a then v_r.a_report else v_r.b_report end;
  v_theirs := case when v_uid = v_r.player_a then v_r.b_report else v_r.a_report end;
  if v_mine is not null then raise exception 'you already reported this result' using hint = 'already_reported'; end if;
  select coalesce(bool_or(t.mode = 'hosted'), false) into v_hosted from public.tournaments t where t.id = v_r.tournament_id;

  if v_hosted then
    update public.match_rooms
       set a_report = case when v_uid = player_a then p_winner_id else a_report end,
           b_report = case when v_uid = player_b then p_winner_id else b_report end,
           first_report_at = coalesce(first_report_at, now()), updated_at = now()
     where id = v_r.id returning * into v_r;
    return v_r;
  end if;

  if v_theirs is not null and v_theirs <> p_winner_id then
    raise exception 'your opponent reported a different winner: open a dispute' using hint = 'use_dispute';
  end if;
  if v_uid = v_r.player_a then
    update public.match_rooms set a_report = p_winner_id, updated_at = now() where id = v_r.id;
  else
    update public.match_rooms set b_report = p_winner_id, updated_at = now() where id = v_r.id;
  end if;
  if v_theirs is not null then
    perform public.rib_room_finish(v_r.id, p_winner_id, false);
  else
    update public.match_rooms set first_report_at = now(), confirm_deadline = now() + public.rib_confirm_window(), updated_at = now()
     where id = v_r.id;
  end if;
  select * into v_r from public.match_rooms where id = v_r.id;
  return v_r;
end;
$$;

-- Disputes: as in 0022; hosted matches are decided by the host and appealed
-- at the tournament level (rib_tournament_appeal).
create or replace function public.rib_room_dispute(p_room_id uuid, p_reason text)
returns public.match_rooms
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_r public.match_rooms; v_reason text := trim(coalesce(p_reason, '')); v_fee bigint := 0; v_deposit bigint := 0;
begin
  v_r := public.rib_room_for_player(p_room_id, true);
  if exists (select 1 from public.tournaments where id = v_r.tournament_id and mode = 'hosted') then
    raise exception 'the host decides this match; appeal the result when the tournament ends' using hint = 'host_decides';
  end if;
  if v_r.status <> 'live' then raise exception 'this match is not in play' using hint = 'challenge_not_active'; end if;
  if char_length(v_reason) < 10 or char_length(v_reason) > 500 then
    raise exception 'explain what happened (10 to 500 characters)' using hint = 'dispute_reason_required';
  end if;

  if v_r.kind = 'friendly' then
    update public.match_rooms set disputed_by = v_uid, disputed_at = now(), dispute_reason = v_reason where id = v_r.id;
    perform public.rib_room_void(v_r.id, 'No result: the players disagreed');
    select * into v_r from public.match_rooms where id = v_r.id;
    return v_r;
  end if;

  select entry_fee_cents into v_fee from public.tournaments where id = v_r.tournament_id;
  if v_fee > 0 then
    v_deposit := greatest(100, v_fee / 10);
    perform public.rib_apply(v_uid, 'dispute_deposit', -v_deposit, v_deposit, 'match_room', v_r.id, 'Dispute deposit held');
  end if;
  update public.match_rooms
     set status = 'disputed', disputed_by = v_uid, disputed_at = now(), dispute_reason = v_reason,
         dispute_deposit_cents = v_deposit, confirm_deadline = null,
         a_report = case when v_uid = player_a then v_uid else a_report end,
         b_report = case when v_uid = player_b then v_uid else b_report end,
         updated_at = now()
   where id = v_r.id returning * into v_r;
  return v_r;
end;
$$;

-- Chat: the two players, the host of a hosted tournament and operators.
create or replace function public.rib_room_message(p_room_id uuid, p_body text)
returns public.room_messages
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_r public.match_rooms; v_row public.room_messages; v_body text := trim(coalesce(p_body, ''));
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  select * into v_r from public.match_rooms where id = p_room_id;
  if v_r.id is null
     or (v_uid is distinct from v_r.player_a and v_uid is distinct from v_r.player_b
         and not public.rib_is_room_host(v_r.id) and not public.rib_is_operator()) then
    raise exception 'you are not in this match' using hint = 'not_a_participant';
  end if;
  if v_r.status not in ('setup','ready_check','live','disputed') then raise exception 'this room is closed' using hint = 'room_closed'; end if;
  if char_length(v_body) < 1 or char_length(v_body) > 500 then
    raise exception 'messages are 1 to 500 characters' using hint = 'invalid_message';
  end if;
  if not public.rib_rate_limit_hit('room_chat', v_uid, 20, 60) then
    raise exception 'slow down: too many messages' using hint = 'rate_limited';
  end if;
  insert into public.room_messages (room_id, user_id, body, kind) values (v_r.id, v_uid, v_body, 'chat') returning * into v_row;
  return v_row;
end;
$$;

-- Automatic screenshot check: as in 0026, except that a hosted room is never
-- fast-tracked (it has no confirm window; the host decides).
create or replace function public.rib_evidence_check_apply(
  p_evidence_id bigint, p_status text, p_winner uuid, p_confidence numeric, p_detail jsonb,
  p_content_sha256 text default null
) returns public.match_rooms
language plpgsql security definer set search_path = ''
as $$
declare v_room uuid; v_e public.room_evidence; v_r public.match_rooms; v_status text := p_status;
        v_content text := lower(nullif(trim(coalesce(p_content_sha256, '')), ''));
        v_mine uuid; v_theirs uuid; v_hosted boolean;
begin
  if p_status is null or p_status not in ('verified','contradicts','unreadable','duplicate','skipped') then
    raise exception 'unknown check status' using hint = 'evidence_invalid';
  end if;
  if p_confidence is not null and (p_confidence < 0 or p_confidence > 1) then
    raise exception 'confidence is between 0 and 1' using hint = 'evidence_invalid';
  end if;
  if p_detail is not null and octet_length(p_detail::text) > 16384 then
    raise exception 'check detail too large' using hint = 'evidence_invalid';
  end if;
  if v_content is not null and v_content !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid content hash' using hint = 'evidence_invalid';
  end if;

  select room_id into v_room from public.room_evidence where id = p_evidence_id;
  if v_room is null then raise exception 'evidence not found' using hint = 'evidence_invalid'; end if;
  select * into v_r from public.match_rooms where id = v_room for update;
  select * into v_e from public.room_evidence where id = p_evidence_id for update;
  if v_e.check_status <> 'pending' then
    raise exception 'this capture was already checked' using hint = 'evidence_not_pending';
  end if;
  select coalesce(bool_or(t.mode = 'hosted'), false) into v_hosted from public.tournaments t where t.id = v_r.tournament_id;

  if v_content is not null
     and (exists (select 1 from public.room_evidence where content_sha256 = v_content and room_id <> v_room)
          or exists (select 1 from public.room_evidence where sha256 = v_content and room_id <> v_room)) then
    v_status := 'duplicate';
  end if;
  if v_status = 'verified' and (p_winner is null or (p_winner is distinct from v_r.player_a and p_winner is distinct from v_r.player_b)) then
    raise exception 'invalid winner' using hint = 'invalid_winner';
  end if;

  update public.room_evidence
     set check_status = v_status,
         check_winner = case when v_status = 'verified' then p_winner end,
         check_confidence = p_confidence, check_detail = p_detail, content_sha256 = v_content, checked_at = now()
   where id = v_e.id;

  if v_status in ('contradicts','duplicate') then
    update public.match_rooms set review_flag = true, updated_at = now() where id = v_r.id and not review_flag;
  elsif v_status = 'verified' and not v_hosted and v_r.status = 'live' and v_e.user_id is not null
        and coalesce(p_confidence, 0) >= public.rib_auto_settle_confidence() then
    v_mine   := case when v_e.user_id = v_r.player_a then v_r.a_report when v_e.user_id = v_r.player_b then v_r.b_report end;
    v_theirs := case when v_e.user_id = v_r.player_a then v_r.b_report when v_e.user_id = v_r.player_b then v_r.a_report end;
    if v_mine = p_winner and v_theirs is null then
      update public.match_rooms
         set confirm_deadline = least(confirm_deadline, now() + public.rib_verified_confirm_window()),
             fast_tracked = true, updated_at = now()
       where id = v_r.id;
    end if;
  end if;
  select * into v_r from public.match_rooms where id = v_r.id;
  return v_r;
end;
$$;

-- Operator resolution: as in 0026; a hosted room can also be resolved while
-- it waits for the host ('setup' / 'live'), e.g. when the host is gone.
create or replace function public.rib_room_resolve(p_room_id uuid, p_action text, p_winner_id uuid default null, p_note text default null)
returns public.match_rooms
language plpgsql security definer set search_path = ''
as $$
declare v_r public.match_rooms; v_other uuid; v_dep bigint; v_loser uuid; v_hosted boolean;
begin
  perform public.rib_require_operator();
  -- Hosted rooms lock the tournament first (same order as every hosted path);
  -- Quick Play keeps the room-first order of its player actions.
  select coalesce(bool_or(t.mode = 'hosted'), false) into v_hosted
    from public.match_rooms r join public.tournaments t on t.id = r.tournament_id where r.id = p_room_id;
  if v_hosted then
    perform 1 from public.tournaments t
     where t.id = (select r.tournament_id from public.match_rooms r where r.id = p_room_id) for update;
  end if;
  select * into v_r from public.match_rooms where id = p_room_id for update;
  if v_r.id is null then raise exception 'match not found' using hint = 'challenge_not_found'; end if;
  if v_r.status <> 'disputed' and not (v_hosted and v_r.status in ('setup','live')) then
    raise exception 'this match is not in dispute' using hint = 'not_disputed';
  end if;
  v_other := case when v_r.disputed_by = v_r.player_a then v_r.player_b else v_r.player_a end;
  v_dep   := coalesce(v_r.dispute_deposit_cents, 0);
  update public.match_rooms set resolved_by = auth.uid(), resolution_note = nullif(trim(coalesce(p_note, '')), '') where id = v_r.id;
  if v_hosted then
    update public.tournaments set last_progress_at = now() where id = v_r.tournament_id;
  end if;

  if p_action = 'award' then
    if p_winner_id is null or (p_winner_id is distinct from v_r.player_a and p_winner_id is distinct from v_r.player_b) then
      raise exception 'invalid winner' using hint = 'invalid_winner';
    end if;
    v_loser := case when p_winner_id = v_r.player_a then v_r.player_b else v_r.player_a end;
    if v_dep > 0 then
      perform public.rib_lock_wallets(v_r.player_a, v_r.player_b);
      if p_winner_id = v_r.disputed_by then
        perform public.rib_apply(v_r.disputed_by, 'dispute_refund', v_dep, -v_dep, 'match_room', v_r.id, 'Dispute upheld, deposit returned');
      else
        perform public.rib_apply(v_r.disputed_by, 'dispute_forfeit', 0, -v_dep, 'match_room', v_r.id, 'Dispute rejected, deposit lost');
        perform public.rib_apply(v_other, 'dispute_award', v_dep, 0, 'match_room', v_r.id, 'Opponent''s dispute deposit');
      end if;
    end if;
    if v_r.disputed_by is not null
       or (v_loser = v_r.player_a and v_r.a_report = v_loser)
       or (v_loser = v_r.player_b and v_r.b_report = v_loser) then
      perform public.rib_rep_bump(v_loser, 0, 1, 0);
    end if;
    perform public.rib_room_finish(v_r.id, p_winner_id, false);
  elsif p_action = 'void' then
    if v_dep > 0 then
      perform public.rib_apply(v_r.disputed_by, 'dispute_refund', v_dep, -v_dep, 'match_room', v_r.id, 'Dispute closed, deposit returned');
    end if;
    perform public.rib_room_void(v_r.id, 'Voided after review');
  else
    raise exception 'unknown action' using hint = 'invalid_action';
  end if;
  select * into v_r from public.match_rooms where id = v_r.id;
  return v_r;
end;
$$;

-- Sweep (every minute): as in 0022, except that hosted rooms have no ready
-- check or confirm window to expire (rib_hosted_sweep watches them).
create or replace function public.rib_room_sweep(p_batch int default 500)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_r public.match_rooms; v_t public.tournaments; r record;
        v_ready int := 0; v_confirmed int := 0; v_stale int := 0; v_failed int := 0;
begin
  for v_r in
    select m.* from public.match_rooms m
     where m.status = 'ready_check' and m.ready_deadline < now()
       and not exists (select 1 from public.tournaments t where t.id = m.tournament_id and t.mode = 'hosted')
     order by m.ready_deadline limit p_batch for update of m skip locked
  loop
    begin
      if v_r.kind = 'friendly' then
        perform public.rib_room_void(v_r.id, 'The ready check expired');
      elsif v_r.a_ready_at is not null and v_r.b_ready_at is null then
        perform public.rib_rep_bump(v_r.player_b, 0, 0, 1);
        perform public.rib_room_finish(v_r.id, v_r.player_a, true);
      elsif v_r.b_ready_at is not null and v_r.a_ready_at is null then
        perform public.rib_rep_bump(v_r.player_a, 0, 0, 1);
        perform public.rib_room_finish(v_r.id, v_r.player_b, true);
      else
        perform public.rib_rep_bump(v_r.player_a, 0, 0, 1);
        perform public.rib_rep_bump(v_r.player_b, 0, 0, 1);
        perform public.rib_room_void(v_r.id, 'Neither player was ready');
      end if;
      v_ready := v_ready + 1;
    exception when others then
      v_failed := v_failed + 1;
      raise warning 'rib_room_sweep: ready % failed: %', v_r.id, sqlerrm;
    end;
  end loop;

  for v_r in
    select m.* from public.match_rooms m
     where m.status = 'live' and m.confirm_deadline < now()
       and not exists (select 1 from public.tournaments t where t.id = m.tournament_id and t.mode = 'hosted')
     order by m.confirm_deadline limit p_batch for update of m skip locked
  loop
    begin
      perform public.rib_room_finish(v_r.id, coalesce(v_r.a_report, v_r.b_report), false);
      v_confirmed := v_confirmed + 1;
    exception when others then
      v_failed := v_failed + 1;
      raise warning 'rib_room_sweep: confirm % failed: %', v_r.id, sqlerrm;
    end;
  end loop;

  -- A Quick Play or custom event that never started within 24 hours: refund
  -- everyone (hosted events: rib_hosted_sweep, after 7 days).
  for v_t in
    select * from public.tournaments
     where format = 'bracket' and status = 'open' and mode <> 'hosted' and created_at < now() - interval '24 hours'
     order by created_at limit p_batch for update skip locked
  loop
    begin
      if v_t.entry_fee_cents > 0 then
        for r in select user_id from public.tournament_entries where tournament_id = v_t.id order by user_id loop
          perform public.rib_apply(r.user_id, 'tournament_refund', v_t.entry_fee_cents, 0, 'tournament', v_t.id, 'Tournament did not fill, entry refunded');
        end loop;
      end if;
      update public.tournaments set status = 'cancelled', prize_pool_cents = 0, finished_at = now() where id = v_t.id;
      v_stale := v_stale + 1;
    exception when others then
      v_failed := v_failed + 1;
      raise warning 'rib_room_sweep: tournament % failed: %', v_t.id, sqlerrm;
    end;
  end loop;

  return jsonb_build_object('ready_expired', v_ready, 'auto_confirmed', v_confirmed, 'unfilled_tournaments', v_stale, 'failed', v_failed);
end;
$$;

-- The player's live rooms, now including hosted rooms in 'setup'.
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
     and r.status in ('setup','ready_check','live','disputed')
   order by 12 desc, coalesce(r.confirm_deadline, r.ready_deadline) nulls last
   limit 20;
$$;

-- ----------------------------------------------------------------------------
-- 6) Joining and leaving
-- ----------------------------------------------------------------------------
-- Checks on a tournament row the caller holds FOR UPDATE, then the entry.
create or replace function public.rib_tournament_join_locked(p_tournament_id uuid, p_uid uuid)
returns public.tournaments
language plpgsql security definer set search_path = ''
as $$
declare v_t public.tournaments;
begin
  select * into v_t from public.tournaments where id = p_tournament_id;
  if v_t.format <> 'bracket' or v_t.status <> 'open' then raise exception 'registration is closed' using hint = 'registration_closed'; end if;
  if v_t.mode = 'hosted' and v_t.creator_id = p_uid then
    raise exception 'the host cannot play in their own tournament' using hint = 'host_cannot_play';
  end if;
  if exists (select 1 from public.tournament_entries where tournament_id = v_t.id and user_id = p_uid) then
    raise exception 'already registered' using hint = 'already_registered';
  end if;
  perform public.rib_require_riot_account(p_uid);
  perform public.rib_paid_entry_limits(p_uid, v_t.entry_fee_cents);
  return public.rib_tournament_enter(v_t.id, p_uid);
end;
$$;

-- Invite-code guessing: failed lookups per signed-in player, 20 per 10 minutes.
-- Read-only check (a raised error would roll back the counter anyway).
create or replace function public.rib_invite_lookups_exceeded(p_uid uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((select hits from public.rate_limits
                    where bucket = 'invite_lookup' and subject = p_uid
                      and window_start = to_timestamp(floor(extract(epoch from now()) / 600) * 600)), 0) >= 20;
$$;

-- By id: public tournaments only (private ones need the invite code).
create or replace function public.rib_tournament_join(p_tournament_id uuid)
returns public.tournaments
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_t public.tournaments;
begin
  perform public.rib_entry_precheck(v_uid);
  perform public.rib_lock_user(v_uid);
  select * into v_t from public.tournaments where id = p_tournament_id for update;
  if v_t.id is null then raise exception 'tournament not found' using hint = 'tournament_not_found'; end if;
  if v_t.visibility = 'private' then
    raise exception 'this tournament is private: use its invite link' using hint = 'tournament_private';
  end if;
  return public.rib_tournament_join_locked(v_t.id, v_uid);
end;
$$;

create or replace function public.rib_tournament_join_by_code(p_code text)
returns public.tournaments
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_t public.tournaments; v_code text := upper(btrim(coalesce(p_code, '')));
begin
  perform public.rib_entry_precheck(v_uid);
  if public.rib_invite_lookups_exceeded(v_uid) then
    raise exception 'too many invite codes tried: wait a few minutes' using hint = 'rate_limited';
  end if;
  if v_code !~ '^[A-HJ-NP-Z2-9]{10}$' then raise exception 'invalid invite code' using hint = 'invite_invalid'; end if;
  perform public.rib_lock_user(v_uid);
  select * into v_t from public.tournaments where invite_code = v_code for update;
  if v_t.id is null then raise exception 'invalid invite code' using hint = 'invite_invalid'; end if;
  return public.rib_tournament_join_locked(v_t.id, v_uid);
end;
$$;

-- Leave before it starts: the entry fee comes back. An empty Quick Play or
-- custom event closes; a hosted one stays open for its host.
create or replace function public.rib_tournament_leave(p_tournament_id uuid)
returns public.tournaments
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_t public.tournaments; v_close boolean;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  select * into v_t from public.tournaments where id = p_tournament_id for update;
  if v_t.id is null then raise exception 'tournament not found' using hint = 'tournament_not_found'; end if;
  if v_t.status <> 'open' then raise exception 'the tournament has started' using hint = 'registration_closed'; end if;
  delete from public.tournament_entries where tournament_id = v_t.id and user_id = v_uid;
  if not found then raise exception 'you are not registered' using hint = 'not_an_entrant'; end if;
  if v_t.entry_fee_cents > 0 then
    perform public.rib_apply(v_uid, 'tournament_refund', v_t.entry_fee_cents, 0, 'tournament', v_t.id, 'Left the tournament, entry refunded');
  end if;
  v_close := v_t.mode <> 'hosted' and v_t.entrants <= 1;
  update public.tournaments
     set prize_pool_cents = prize_pool_cents - v_t.entry_fee_cents,
         entrants = greatest(entrants - 1, 0),
         status = case when v_close then 'cancelled' else status end,
         finished_at = case when v_close then now() else finished_at end
   where id = v_t.id
  returning * into v_t;
  return v_t;
end;
$$;

-- ----------------------------------------------------------------------------
-- 7) Hosting
-- ----------------------------------------------------------------------------
create or replace function public.rib_hosted_create(
  p_name text, p_size int, p_entry_fee_cents bigint, p_visibility text, p_rules text default null
) returns public.tournaments
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_t public.tournaments; v_live int; v_rep public.player_reputation;
        v_name text := btrim(coalesce(p_name, '')); v_rules text := nullif(btrim(coalesce(p_rules, '')), '');
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  perform public.rib_assert_open_account(v_uid);
  if char_length(v_name) < 1 or char_length(v_name) > 80 then
    raise exception 'name is required (up to 80 characters)' using hint = 'tournament_name_required';
  end if;
  if p_size is null or p_size not in (4, 8, 16, 32) then
    raise exception 'tournaments have 4, 8, 16 or 32 players' using hint = 'invalid_size';
  end if;
  if p_entry_fee_cents is null or p_entry_fee_cents < 0 or p_entry_fee_cents > 50000 or p_entry_fee_cents % 100 <> 0 then
    raise exception 'the entry fee is 0 to 500 whole rcoin' using hint = 'invalid_entry_fee';
  end if;
  if p_visibility is null or p_visibility not in ('public','private') then
    raise exception 'visibility is public or private' using hint = 'invalid_visibility';
  end if;
  if v_rules is not null and char_length(v_rules) > 1000 then
    raise exception 'rules are up to 1000 characters' using hint = 'invalid_rules';
  end if;

  perform public.rib_lock_user(v_uid);
  select count(*) into v_live from public.tournaments
   where creator_id = v_uid and mode = 'hosted' and status in ('open','full','active','payout_pending','disputed');
  if v_live >= 3 then raise exception 'you can host up to 3 tournaments at a time' using hint = 'host_limit'; end if;
  select * into v_rep from public.player_reputation where user_id = v_uid;
  if p_entry_fee_cents > 0 and coalesce(v_rep.host_strikes, 0) >= 3 then
    raise exception 'your hosting record allows free tournaments only' using hint = 'host_restricted';
  end if;
  if p_entry_fee_cents > 2500 and coalesce(v_rep.hosted_completed, 0) < public.rib_host_min_completed() then
    raise exception 'new hosts can set an entry fee up to 25 rcoin' using hint = 'host_fee_limit';
  end if;
  if not public.rib_rate_limit_hit('hosted_create', v_uid, 20, 3600) then
    raise exception 'slow down: too many tournaments created' using hint = 'rate_limited';
  end if;

  insert into public.tournaments (creator_id, name, game, entry_fee_cents, max_players, status, format, network,
                                  mode, visibility, invite_code, rules)
  values (v_uid, v_name, public.rib_wild_rift_game(), p_entry_fee_cents, p_size, 'open', 'bracket', 'riot',
          'hosted', p_visibility, public.rib_invite_code(), v_rules)
  returning * into v_t;
  return v_t;
end;
$$;

-- The hosted tournament a host (or, when allowed, an operator) acts on, locked.
create or replace function public.rib_hosted_for_host(p_tournament_id uuid, p_allow_operator boolean)
returns public.tournaments
language plpgsql security definer set search_path = ''
as $$
declare v_t public.tournaments;
begin
  if auth.uid() is null and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'not signed in' using hint = 'not_authenticated';
  end if;
  select * into v_t from public.tournaments where id = p_tournament_id for update;
  if v_t.id is null or v_t.mode <> 'hosted' then raise exception 'tournament not found' using hint = 'tournament_not_found'; end if;
  if v_t.creator_id is distinct from auth.uid()
     and not (p_allow_operator and (public.rib_is_operator() or coalesce(auth.role(), '') = 'service_role')) then
    raise exception 'only the host can do this' using hint = 'not_host';
  end if;
  return v_t;
end;
$$;

-- The hosted room a host (or operator) acts on, locked.
create or replace function public.rib_hosted_room_for_host(p_room_id uuid)
returns public.match_rooms
language plpgsql security definer set search_path = ''
as $$
declare v_r public.match_rooms; v_tid uuid; v_host uuid;
begin
  if auth.uid() is null and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'not signed in' using hint = 'not_authenticated';
  end if;
  -- Lock order on every hosted path: the tournament, then the room.
  select tournament_id into v_tid from public.match_rooms where id = p_room_id;
  select t.creator_id into v_host from public.tournaments t where t.id = v_tid and t.mode = 'hosted' for update;
  if v_host is null then raise exception 'match not found' using hint = 'match_not_found'; end if;
  select * into v_r from public.match_rooms where id = p_room_id for update;
  if v_host is distinct from auth.uid() and not public.rib_is_operator() and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'only the host can do this' using hint = 'not_host';
  end if;
  return v_r;
end;
$$;

create or replace function public.rib_host_rotate_invite(p_tournament_id uuid)
returns text
language plpgsql security definer set search_path = ''
as $$
declare v_t public.tournaments; v_code text;
begin
  v_t := public.rib_hosted_for_host(p_tournament_id, false);
  if v_t.status in ('finished','cancelled') then raise exception 'this tournament has ended' using hint = 'tournament_finished'; end if;
  v_code := public.rib_invite_code();
  update public.tournaments set invite_code = v_code where id = v_t.id;
  return v_code;
end;
$$;

create or replace function public.rib_host_start(p_tournament_id uuid)
returns public.tournaments
language plpgsql security definer set search_path = ''
as $$
declare v_t public.tournaments;
begin
  v_t := public.rib_hosted_for_host(p_tournament_id, false);
  if v_t.status <> 'open' then raise exception 'the tournament has already started' using hint = 'already_started'; end if;
  if v_t.entrants < public.rib_tournament_min_entrants() then
    raise exception 'at least % players are needed to start', public.rib_tournament_min_entrants() using hint = 'not_enough_players';
  end if;
  perform public.rib_tournament_start(v_t.id);
  select * into v_t from public.tournaments where id = v_t.id;
  return v_t;
end;
$$;

-- The host cancels before the start; an operator at any time before the
-- payout. Every entry fee and every open appeal deposit is returned.
create or replace function public.rib_host_cancel(p_tournament_id uuid)
returns public.tournaments
language plpgsql security definer set search_path = ''
as $$
declare v_t public.tournaments; v_operator boolean;
begin
  v_t := public.rib_hosted_for_host(p_tournament_id, true);
  v_operator := public.rib_is_operator() or coalesce(auth.role(), '') = 'service_role';
  if v_t.status in ('finished','cancelled') then raise exception 'this tournament has ended' using hint = 'tournament_finished'; end if;
  if v_t.status <> 'open' and not v_operator then
    raise exception 'the tournament has already started' using hint = 'already_started';
  end if;
  perform public.rib_lock_tournament_wallets(v_t.id);
  perform public.rib_tournament_refund_all(v_t.id, 'Tournament cancelled, entry refunded');
  perform public.rib_appeals_close(v_t.id, 'upheld', 'Tournament cancelled');
  update public.match_rooms
     set status = 'void', confirm_deadline = null, finished_at = now(), updated_at = now(),
         resolution_note = coalesce(resolution_note, 'Tournament cancelled')
   where tournament_id = v_t.id and status not in ('done','void');
  update public.tournaments
     set status = 'cancelled', prize_pool_cents = 0, finished_at = now()
   where id = v_t.id returning * into v_t;
  return v_t;
end;
$$;

-- Post (or re-post) the Wild Rift lobby: a 'lobby' message in the room chat;
-- 'setup' becomes 'live'.
create or replace function public.rib_host_room_lobby(
  p_room_id uuid, p_lobby_code text, p_lobby_password text default null, p_image_path text default null
) returns public.match_rooms
language plpgsql security definer set search_path = ''
as $$
declare v_r public.match_rooms; v_code text := nullif(btrim(coalesce(p_lobby_code, '')), '');
        v_pass text := nullif(btrim(coalesce(p_lobby_password, '')), ''); v_img text := nullif(btrim(coalesce(p_image_path, '')), '');
        v_body text; v_was_setup boolean;
begin
  v_r := public.rib_hosted_room_for_host(p_room_id);
  if not public.rib_is_room_host(v_r.id) then raise exception 'only the host can do this' using hint = 'not_host'; end if;
  if v_r.status not in ('setup','live') then raise exception 'this match is not waiting for a lobby' using hint = 'room_not_setup'; end if;
  if v_code is null and v_img is null then
    raise exception 'post the lobby code or a screenshot of the lobby' using hint = 'lobby_required';
  end if;
  if (v_code is not null and char_length(v_code) > 40) or (v_pass is not null and char_length(v_pass) > 40)
     or (v_img is not null and v_img !~ ('^' || v_r.id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpe?g|webp)$')) then
    raise exception 'invalid lobby details' using hint = 'invalid_lobby';
  end if;
  if not public.rib_rate_limit_hit('room_lobby', auth.uid(), 60, 60) then
    raise exception 'slow down: too many lobby posts' using hint = 'rate_limited';
  end if;

  v_was_setup := v_r.status = 'setup';
  v_body := case when v_code is not null then 'Lobby code: ' || v_code || coalesce(' · Password: ' || v_pass, '')
                 else 'Lobby screenshot posted' end;
  insert into public.room_messages (room_id, user_id, body, kind, image_path)
  values (v_r.id, auth.uid(), v_body, 'lobby', v_img);
  -- A re-post (screenshot only, or a new code alone) keeps what it doesn't replace.
  update public.match_rooms
     set lobby_name = coalesce(v_code, lobby_name), lobby_password = coalesce(v_pass, lobby_password),
         status = 'live', started_at = coalesce(started_at, now()), updated_at = now()
   where id = v_r.id returning * into v_r;
  if v_was_setup then
    update public.tournaments set last_progress_at = now() where id = v_r.tournament_id;
  end if;
  return v_r;
end;
$$;

-- The host (or an operator) decides a match. A walkover (the other player
-- didn't show) counts a no-show and can be given before the lobby is posted.
create or replace function public.rib_host_decide(p_room_id uuid, p_winner_id uuid, p_walkover boolean default false, p_note text default null)
returns public.match_rooms
language plpgsql security definer set search_path = ''
as $$
declare v_r public.match_rooms; v_walkover boolean := coalesce(p_walkover, false); v_loser uuid;
        v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_quick boolean := false;
begin
  v_r := public.rib_hosted_room_for_host(p_room_id);
  if not (v_r.status = 'live' or (v_walkover and v_r.status = 'setup')) then
    raise exception 'this match cannot be decided now' using hint = 'room_not_setup';
  end if;
  if p_winner_id is null or (p_winner_id is distinct from v_r.player_a and p_winner_id is distinct from v_r.player_b) then
    raise exception 'the winner must be one of the two players' using hint = 'invalid_winner';
  end if;
  if v_walkover then
    if v_note is null or char_length(v_note) < 3 then
      raise exception 'say why this is a walkover' using hint = 'note_required';
    end if;
    if coalesce(v_r.setup_at, v_r.created_at) > now() - public.rib_host_walkover_wait() then
      raise exception 'give the players % minutes to show up', extract(epoch from public.rib_host_walkover_wait())::int / 60
        using hint = 'walkover_too_early';
    end if;
  else
    -- Allowed, but a result sooner than a real match could take is reviewed.
    v_quick := v_r.started_at is null or v_r.started_at > now() - make_interval(mins => public.rib_host_min_match_minutes());
  end if;
  v_loser := case when p_winner_id = v_r.player_a then v_r.player_b else v_r.player_a end;
  update public.match_rooms
     set host_note = left(v_note, 300), resolved_by = auth.uid(), review_flag = review_flag or v_quick, updated_at = now()
   where id = v_r.id;
  update public.tournaments set last_progress_at = now() where id = v_r.tournament_id;
  if v_walkover then
    perform public.rib_rep_bump(v_loser, 0, 0, 1);
  end if;
  perform public.rib_room_finish(v_r.id, p_winner_id, v_walkover);
  select * into v_r from public.match_rooms where id = v_r.id;
  return v_r;
end;
$$;

-- Neither player showed: both are out (a no-show each).
create or replace function public.rib_host_void_room(p_room_id uuid, p_note text)
returns public.match_rooms
language plpgsql security definer set search_path = ''
as $$
declare v_r public.match_rooms; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  v_r := public.rib_hosted_room_for_host(p_room_id);
  if v_r.status not in ('setup','live') then raise exception 'this match cannot be voided now' using hint = 'room_not_setup'; end if;
  if v_note is null or char_length(v_note) < 3 then
    raise exception 'say why this match is void' using hint = 'note_required';
  end if;
  if coalesce(v_r.setup_at, v_r.created_at) > now() - public.rib_host_walkover_wait() then
    raise exception 'give the players % minutes to show up', extract(epoch from public.rib_host_walkover_wait())::int / 60
      using hint = 'walkover_too_early';
  end if;
  update public.match_rooms
     set host_note = left(v_note, 300), resolved_by = auth.uid(), updated_at = now()
   where id = v_r.id;
  update public.tournaments set last_progress_at = now() where id = v_r.tournament_id;
  perform public.rib_rep_bump(v_r.player_a, 0, 0, 1);
  perform public.rib_rep_bump(v_r.player_b, 0, 0, 1);
  perform public.rib_room_void(v_r.id, 'Neither player showed');
  select * into v_r from public.match_rooms where id = v_r.id;
  return v_r;
end;
$$;

-- ----------------------------------------------------------------------------
-- 8) Appeals
-- ----------------------------------------------------------------------------
create or replace function public.rib_tournament_appeal(p_tournament_id uuid, p_reason text, p_room_id uuid default null)
returns public.tournaments
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_t public.tournaments; v_reason text := btrim(coalesce(p_reason, '')); v_deposit bigint := 0;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  perform public.rib_lock_user(v_uid);
  select * into v_t from public.tournaments where id = p_tournament_id for update;
  if v_t.id is null or v_t.mode <> 'hosted' then raise exception 'tournament not found' using hint = 'tournament_not_found'; end if;
  if v_uid = v_t.winner_id
     or not exists (select 1 from public.tournament_entries where tournament_id = v_t.id and user_id = v_uid) then
    raise exception 'only other entrants can appeal' using hint = 'not_an_entrant';
  end if;
  if v_t.status not in ('payout_pending','disputed') or v_t.payout_at is null or v_t.payout_at <= now() then
    raise exception 'the appeal window is closed' using hint = 'appeal_closed';
  end if;
  if exists (select 1 from public.tournament_disputes where tournament_id = v_t.id and user_id = v_uid) then
    raise exception 'you already appealed this tournament' using hint = 'already_appealed';
  end if;
  if char_length(v_reason) < 10 or char_length(v_reason) > 500 then
    raise exception 'explain what happened (10 to 500 characters)' using hint = 'dispute_reason_required';
  end if;
  if p_room_id is not null and not exists (select 1 from public.match_rooms where id = p_room_id and tournament_id = v_t.id) then
    raise exception 'that match is not part of this tournament' using hint = 'match_not_found';
  end if;

  if v_t.entry_fee_cents > 0 then
    v_deposit := greatest(100, v_t.entry_fee_cents / 10);
    perform public.rib_apply(v_uid, 'dispute_deposit', -v_deposit, v_deposit, 'tournament', v_t.id, 'Appeal deposit held');
  end if;
  insert into public.tournament_disputes (tournament_id, user_id, reason, room_id, status, deposit_cents)
  values (v_t.id, v_uid, v_reason, p_room_id, 'open', v_deposit);
  update public.tournaments set status = 'disputed' where id = v_t.id returning * into v_t;
  return v_t;
end;
$$;

-- The 0019 dispute path: hosted tournaments go through the appeal (deposit).
create or replace function public.rib_tournament_dispute(p_tournament_id uuid, p_reason text default null)
returns public.tournaments
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_t public.tournaments;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  if exists (select 1 from public.tournaments where id = p_tournament_id and mode = 'hosted') then
    return public.rib_tournament_appeal(p_tournament_id, p_reason, null);
  end if;
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

-- The 0019 operator resolution stays for older events; hosted tournaments are
-- resolved with rib_appeal_resolve (split, deposits, strikes).
create or replace function public.rib_tournament_resolve(p_tournament_id uuid, p_action text, p_winner_id uuid default null)
returns public.tournaments
language plpgsql security definer set search_path = ''
as $$
declare v_t public.tournaments; v_winner uuid; r record;
begin
  select * into v_t from public.tournaments where id = p_tournament_id for update;
  if v_t.id is null then raise exception 'tournament not found' using hint = 'tournament_not_found'; end if;
  if v_t.mode = 'hosted' then raise exception 'use rib_appeal_resolve for hosted tournaments' using hint = 'invalid_action'; end if;
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
    perform public.rib_appeals_close(v_t.id, case when v_winner = v_t.winner_id then 'rejected' else 'upheld' end, 'Resolved by an operator');
    update public.tournaments set status = 'finished', winner_id = v_winner, finished_at = now()
     where id = v_t.id returning * into v_t;
  elsif p_action = 'refund' then
    if v_t.entry_fee_cents > 0 then
      for r in select user_id from public.tournament_entries where tournament_id = v_t.id order by user_id loop
        perform public.rib_apply(r.user_id, 'tournament_refund', v_t.entry_fee_cents, 0, 'tournament', v_t.id, 'Tournament voided after review, entry refunded');
      end loop;
    end if;
    perform public.rib_appeals_close(v_t.id, 'upheld', 'Resolved by an operator');
    update public.tournament_entries set placement = null where tournament_id = v_t.id;
    update public.tournaments set status = 'cancelled', winner_id = null, prize_pool_cents = 0, finished_at = now()
     where id = v_t.id returning * into v_t;
  else
    raise exception 'action must be pay or refund' using hint = 'invalid_amount';
  end if;
  return v_t;
end;
$$;

-- Operators (or the service role) resolve every open appeal of a tournament
-- and pay it at once:
--   uphold     the host's result stands: 85/5/10, appeal deposits forfeited;
--   overturn   p_winner_id wins with the host commission (90%), deposits
--              returned, the host gets a strike;
--   refund_all every entry fee back, deposits returned, the host gets a strike.
create or replace function public.rib_appeal_resolve(p_tournament_id uuid, p_action text, p_winner_id uuid default null, p_note text default null)
returns public.tournaments
language plpgsql security definer set search_path = ''
as $$
declare v_t public.tournaments;
begin
  perform public.rib_require_operator();
  select * into v_t from public.tournaments where id = p_tournament_id for update;
  if v_t.id is null or v_t.mode <> 'hosted' then raise exception 'tournament not found' using hint = 'tournament_not_found'; end if;
  if v_t.status <> 'disputed' then raise exception 'this tournament has no open appeal' using hint = 'not_disputed'; end if;
  if p_action is null or p_action not in ('uphold','overturn','refund_all') then
    raise exception 'action is uphold, overturn or refund_all' using hint = 'invalid_action';
  end if;
  if p_action = 'overturn'
     and (p_winner_id is null or p_winner_id = v_t.winner_id or p_winner_id = v_t.creator_id
          or not exists (select 1 from public.tournament_entries where tournament_id = v_t.id and user_id = p_winner_id)) then
    raise exception 'pick another entrant as the winner' using hint = 'invalid_winner';
  end if;

  perform public.rib_lock_tournament_wallets(v_t.id);
  if p_action = 'uphold' then
    perform public.rib_appeals_close(v_t.id, 'rejected', p_note);
    perform public.rib_hosted_pay(v_t.id, v_t.winner_id, true);
  elsif p_action = 'overturn' then
    perform public.rib_appeals_close(v_t.id, 'upheld', p_note);
    update public.tournament_entries set placement = null where tournament_id = v_t.id and user_id = p_winner_id;
    update public.tournaments
       set runner_up_id = case when runner_up_id = p_winner_id then winner_id else runner_up_id end
     where id = v_t.id;
    update public.tournament_entries set placement = 2
     where tournament_id = v_t.id and user_id = v_t.winner_id
       and exists (select 1 from public.tournaments where id = v_t.id and runner_up_id = v_t.winner_id);
    perform public.rib_hosted_pay(v_t.id, p_winner_id, false);
    perform public.rib_host_strike(v_t.creator_id);
  else
    perform public.rib_appeals_close(v_t.id, 'upheld', p_note);
    perform public.rib_tournament_refund_all(v_t.id, 'Tournament voided after appeal, entry refunded');
    update public.tournament_entries set placement = null where tournament_id = v_t.id;
    update public.tournaments
       set status = 'cancelled', winner_id = null, runner_up_id = null, prize_pool_cents = 0, finished_at = now()
     where id = v_t.id;
    perform public.rib_host_strike(v_t.creator_id);
  end if;
  select * into v_t from public.tournaments where id = v_t.id;
  return v_t;
end;
$$;

-- Payout job: undisputed results after the window. Hosted: 85/5/10 of
-- entry fee x entrants. Older (0019) events: the prize pool to the winner.
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
      if v_t.mode = 'hosted' then
        perform public.rib_hosted_pay(v_t.id, v_t.winner_id, true);
      else
        if v_t.prize_pool_cents > 0 then
          perform public.rib_apply(v_t.winner_id, 'tournament_prize', v_t.prize_pool_cents, 0, 'tournament', v_t.id, 'Tournament prize');
        end if;
        update public.tournaments set status = 'finished', finished_at = now() where id = v_t.id;
      end if;
      v_count := v_count + 1;
    exception when others then
      raise warning 'rib_tournament_payouts: tournament % failed: %', v_t.id, sqlerrm;
    end;
  end loop;
  return v_count;
end;
$$;

-- ----------------------------------------------------------------------------
-- 9) Hosted sweep (every 5 minutes): events that never started, host SLA
--    flags and abandoned events
-- ----------------------------------------------------------------------------
create or replace function public.rib_hosted_sweep()
returns int
language plpgsql security definer set search_path = ''
as $$
declare v_t public.tournaments; v_flagged int := 0; v_voided int := 0; v_expired int := 0;
begin
  -- Never started within rib_host_open_window(): cancel and refund, no strike.
  for v_t in
    select * from public.tournaments
     where mode = 'hosted' and status = 'open' and created_at < now() - public.rib_host_open_window()
     order by created_at limit 200
     for update skip locked
  loop
    begin
      perform public.rib_lock_tournament_wallets(v_t.id);
      perform public.rib_tournament_refund_all(v_t.id, 'Tournament never started, entry refunded');
      update public.tournaments set status = 'cancelled', prize_pool_cents = 0, finished_at = now() where id = v_t.id;
      v_expired := v_expired + 1;
    exception when others then
      raise warning 'rib_hosted_sweep: open tournament % failed: %', v_t.id, sqlerrm;
    end;
  end loop;

  -- A live hosted room the host hasn't decided within the window: flag it for operators.
  update public.match_rooms m
     set review_flag = true, updated_at = now()
   where m.id in (select r.id from public.match_rooms r
                    join public.tournaments t on t.id = r.tournament_id
                   where r.status = 'live' and not r.review_flag and t.mode = 'hosted'
                     and r.started_at < now() - public.rib_host_decide_window()
                   order by r.started_at limit 500
                   for update of r skip locked);
  get diagnostics v_flagged = row_count;

  -- No room opened or decided for the abandon window: void, refund, strike.
  for v_t in
    select * from public.tournaments
     where mode = 'hosted' and status = 'active'
       and coalesce(last_progress_at, started_at) < now() - public.rib_host_abandon_window()
     order by last_progress_at limit 200
     for update skip locked
  loop
    begin
      perform public.rib_lock_tournament_wallets(v_t.id);
      perform public.rib_tournament_refund_all(v_t.id, 'The host abandoned the tournament, entry refunded');
      update public.match_rooms
         set status = 'void', confirm_deadline = null, finished_at = now(), updated_at = now(),
             resolution_note = coalesce(resolution_note, 'The host abandoned the tournament')
       where tournament_id = v_t.id and status not in ('done','void');
      update public.tournament_entries set placement = null where tournament_id = v_t.id;
      update public.tournaments set status = 'cancelled', prize_pool_cents = 0, finished_at = now() where id = v_t.id;
      perform public.rib_host_strike(v_t.creator_id);
      v_voided := v_voided + 1;
    exception when others then
      raise warning 'rib_hosted_sweep: tournament % failed: %', v_t.id, sqlerrm;
    end;
  end loop;
  return v_flagged + v_voided + v_expired;
end;
$$;

-- ----------------------------------------------------------------------------
-- 10) Chat retention (Edge Function room-cleanup)
-- ----------------------------------------------------------------------------
-- A room's chat can go once its tournament is terminal (after the appeal
-- window and any appeal), or 24 hours after a friendly ends.
create or replace function public.rib_room_purgeable(p_room public.match_rooms)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_room.status in ('done','void') and p_room.chat_purged_at is null
     and case when p_room.kind = 'friendly' then p_room.finished_at < now() - interval '24 hours'
              else exists (select 1 from public.tournaments t
                            where t.id = p_room.tournament_id and t.status in ('finished','cancelled')) end;
$$;

create or replace function public.rib_room_purge_candidates(p_batch int default 100)
returns table (room_id uuid, image_paths text[])
language sql stable security definer set search_path = ''
as $$
  select r.id,
         coalesce((select array_agg(m.image_path order by m.id) from public.room_messages m
                    where m.room_id = r.id and m.image_path is not null), '{}'::text[])
    from public.match_rooms r
   where r.status in ('done','void') and r.chat_purged_at is null
     and public.rib_room_purgeable(r)
   order by r.finished_at
   limit least(greatest(coalesce(p_batch, 100), 1), 1000);
$$;

-- After the Edge Function removed the room's storage objects. Rooms that are
-- not (or no longer) purgeable are skipped. Returns the messages deleted.
create or replace function public.rib_room_messages_purge(p_room_ids uuid[])
returns int
language plpgsql security definer set search_path = ''
as $$
declare v_ids uuid[]; v_deleted int;
begin
  if coalesce(cardinality(p_room_ids), 0) > 1000 then
    raise exception 'up to 1000 rooms per call' using hint = 'invalid_amount';
  end if;
  select coalesce(array_agg(r.id), '{}') into v_ids
    from public.match_rooms r
   where r.id = any (coalesce(p_room_ids, '{}')) and public.rib_room_purgeable(r);
  delete from public.room_messages where room_id = any (v_ids);
  get diagnostics v_deleted = row_count;
  update public.match_rooms set chat_purged_at = now() where id = any (v_ids);
  return v_deleted;
end;
$$;

-- ----------------------------------------------------------------------------
-- 11) Read side
-- ----------------------------------------------------------------------------
-- Invite link preview. Callable before login (anon): then no caller flags,
-- and a private tournament hides its host and rules. An unknown code returns
-- null (not an error, so a signed-in caller's failed lookup is counted: 20
-- per 10 minutes, then hint rate_limited).
create or replace function public.rib_tournament_preview(p_code text)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_t public.tournaments; v_code text := upper(btrim(coalesce(p_code, ''))); v_host text; v_winner text;
        v_hide boolean;
begin
  if v_uid is not null and public.rib_invite_lookups_exceeded(v_uid) then
    raise exception 'too many invite codes tried: wait a few minutes' using hint = 'rate_limited';
  end if;
  if v_code ~ '^[A-HJ-NP-Z2-9]{10}$' then
    select * into v_t from public.tournaments where invite_code = v_code and mode = 'hosted';
  end if;
  if v_t.id is null then
    if v_uid is not null then perform public.rib_rate_limit_hit('invite_lookup', v_uid, 20, 600); end if;
    return null;
  end if;
  v_hide := v_uid is null and v_t.visibility = 'private';
  select username into v_host from public.profiles where id = v_t.creator_id and not v_hide;
  select username into v_winner from public.profiles where id = v_t.winner_id;
  return jsonb_build_object(
    'id', v_t.id, 'name', v_t.name, 'host_username', v_host, 'mode', v_t.mode, 'visibility', v_t.visibility,
    'status', v_t.status, 'size', v_t.max_players, 'entrants', v_t.entrants,
    'min_entrants', public.rib_tournament_min_entrants(), 'entry_fee_cents', v_t.entry_fee_cents,
    'rules', case when v_hide then null else v_t.rules end,
    'created_at', v_t.created_at, 'started_at', v_t.started_at, 'payout_at', v_t.payout_at,
    'winner_username', v_winner,
    'prize_now',  public.rib_hosted_split(v_t.entry_fee_cents * v_t.entrants),
    'prize_full', public.rib_hosted_split(v_t.entry_fee_cents * v_t.max_players),
    'is_host', case when v_uid is null then null else v_t.creator_id = v_uid end,
    'joined',  case when v_uid is null then null
                    else exists (select 1 from public.tournament_entries e where e.tournament_id = v_t.id and e.user_id = v_uid) end);
end;
$$;

-- The caller's hosted tournaments, live ones first.
create or replace function public.rib_host_dashboard(p_limit int default 20)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_rep public.player_reputation; v_list jsonb;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  select * into v_rep from public.player_reputation where user_id = v_uid;
  select coalesce(jsonb_agg(x.j order by x.live desc, x.created_at desc), '[]'::jsonb) into v_list
    from (
      select t.created_at, t.status not in ('finished','cancelled') as live,
             jsonb_build_object(
               'id', t.id, 'name', t.name, 'status', t.status, 'visibility', t.visibility,
               'invite_code', t.invite_code, 'size', t.max_players, 'entrants', t.entrants,
               'entry_fee_cents', t.entry_fee_cents, 'rules', t.rules,
               'created_at', t.created_at, 'started_at', t.started_at, 'payout_at', t.payout_at,
               'finished_at', t.finished_at, 'rounds', public.rib_tournament_rounds(t.max_players),
               'winner_username', w.username, 'host_fee_cents', t.host_fee_cents,
               'prize_now',  public.rib_hosted_split(t.entry_fee_cents * t.entrants),
               'prize_full', public.rib_hosted_split(t.entry_fee_cents * t.max_players),
               'open_appeals', (select count(*) from public.tournament_disputes d where d.tournament_id = t.id and d.status = 'open'),
               'entrants_list', coalesce((
                  select jsonb_agg(jsonb_build_object('user_id', e.user_id, 'username', p.username, 'riot_id', g.handle) order by e.created_at)
                    from public.tournament_entries e
                    left join public.profiles p on p.id = e.user_id
                    left join public.game_accounts g on g.user_id = e.user_id and g.network = 'riot'
                   where e.tournament_id = t.id), '[]'::jsonb),
               'rooms_needing_action', coalesce((
                  select jsonb_agg(jsonb_build_object(
                           'room_id', r.id, 'round', r.round, 'slot', r.slot, 'status', r.status, 'room_code', r.room_code,
                           'player_a', r.player_a, 'player_b', r.player_b, 'a_username', pa.username, 'b_username', pb.username,
                           'a_riot_id', r.a_riot_id, 'b_riot_id', r.b_riot_id, 'a_report', r.a_report, 'b_report', r.b_report,
                           'lobby_code', r.lobby_name, 'lobby_password', r.lobby_password,
                           'started_at', r.started_at, 'review_flag', r.review_flag,
                           'evidence', coalesce((
                              select jsonb_agg(jsonb_build_object('id', ev.id, 'user_id', ev.user_id, 'storage_path', ev.storage_path,
                                                                  'check_status', ev.check_status, 'created_at', ev.created_at) order by ev.id)
                                from public.room_evidence ev where ev.room_id = r.id), '[]'::jsonb))
                         order by r.round, r.slot)
                    from public.match_rooms r
                    left join public.profiles pa on pa.id = r.player_a
                    left join public.profiles pb on pb.id = r.player_b
                   where r.tournament_id = t.id and r.status in ('setup','live')), '[]'::jsonb)) as j
        from public.tournaments t
        left join public.profiles w on w.id = t.winner_id
       where t.creator_id = v_uid and t.mode = 'hosted'
       order by (t.status not in ('finished','cancelled')) desc, t.created_at desc
       limit least(greatest(coalesce(p_limit, 20), 1), 50)
    ) x;
  return jsonb_build_object(
    'host', jsonb_build_object(
      'hosted_completed', coalesce(v_rep.hosted_completed, 0),
      'host_strikes', coalesce(v_rep.host_strikes, 0),
      'live_limit', 3,
      'paid_allowed', coalesce(v_rep.host_strikes, 0) < 3,
      'max_entry_fee_cents', case when coalesce(v_rep.host_strikes, 0) >= 3 then 0
                                  when coalesce(v_rep.hosted_completed, 0) < public.rib_host_min_completed() then 2500 else 50000 end),
    'tournaments', v_list);
end;
$$;

-- The bracket: entrants, the host and operators; public tournaments to anyone signed in.
drop function if exists public.rib_tournament_bracket(uuid);
create or replace function public.rib_tournament_bracket(p_tournament_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_t public.tournaments; v_host text; v_winner text;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  select * into v_t from public.tournaments where id = p_tournament_id;
  if v_t.id is null
     or not (v_t.visibility = 'public' or v_t.creator_id = v_uid or public.rib_is_operator()
             or exists (select 1 from public.tournament_entries e where e.tournament_id = v_t.id and e.user_id = v_uid)) then
    raise exception 'tournament not found' using hint = 'tournament_not_found';
  end if;
  select username into v_host from public.profiles where id = v_t.creator_id and v_t.mode = 'hosted';
  select username into v_winner from public.profiles where id = v_t.winner_id;
  return jsonb_build_object(
    'tournament_id', v_t.id, 'name', v_t.name, 'mode', v_t.mode, 'visibility', v_t.visibility, 'status', v_t.status,
    'size', v_t.max_players, 'rounds', public.rib_tournament_rounds(v_t.max_players), 'entrants', v_t.entrants,
    'host_username', v_host, 'winner_id', v_t.winner_id, 'winner_username', v_winner, 'payout_at', v_t.payout_at,
    'rooms', coalesce((
      select jsonb_agg(jsonb_build_object(
               'room_id', r.id, 'round', r.round, 'slot', r.slot, 'player_a', r.player_a, 'player_b', r.player_b,
               'a_username', pa.username, 'b_username', pb.username, 'status', r.status,
               'winner_id', r.winner_id, 'winner_username', pw.username, 'walkover', r.walkover)
             order by r.round, r.slot)
        from public.match_rooms r
        left join public.profiles pa on pa.id = r.player_a
        left join public.profiles pb on pb.id = r.player_b
        left join public.profiles pw on pw.id = r.winner_id
       where r.tournament_id = v_t.id), '[]'::jsonb));
end;
$$;

-- Lobby: public tournaments waiting for players, fullest first.
drop function if exists public.rib_open_tournaments(text,int,int);
create or replace function public.rib_open_tournaments(p_game text default null, p_size int default null, p_limit int default 30)
returns table (id uuid, name text, game text, network text, entry_fee_cents bigint, size int,
               entrants int, created_at timestamptz, creator_username text, joined boolean,
               mode text, visibility text, host_username text, is_host boolean)
language sql stable security definer set search_path = ''
as $$
  select x.id, x.name, x.game, x.network, x.entry_fee_cents, x.size, x.entrants, x.created_at, x.creator_username, x.joined,
         x.mode, x.visibility, case when x.mode = 'hosted' then x.creator_username end,
         x.mode = 'hosted' and x.creator_id = auth.uid()
    from (
      select t.id, t.name, t.game, t.network, t.entry_fee_cents, t.max_players as size, t.entrants,
             t.created_at, p.username as creator_username, t.mode, t.visibility, t.creator_id,
             exists (select 1 from public.tournament_entries e where e.tournament_id = t.id and e.user_id = auth.uid()) as joined
        from public.tournaments t
        left join public.profiles p on p.id = t.creator_id
       where t.format = 'bracket' and t.status = 'open' and t.visibility = 'public'
         and (p_game is null or p_game = ''
              or t.game ilike '%' || replace(replace(replace(left(p_game, 40), '\', '\\'), '%', '\%'), '_', '\_') || '%')
         and (p_size is null or t.max_players = p_size)
    ) x
   order by (x.size - x.entrants) asc, x.created_at asc
   limit least(greatest(coalesce(p_limit, 30), 1), 60);
$$;

-- My tournaments (as a player), with the mode and the host.
drop function if exists public.rib_my_tournaments(int);
create or replace function public.rib_my_tournaments(p_limit int default 30)
returns table (id uuid, name text, game text, network text, entry_fee_cents bigint, size int, status text,
               entrants int, placement int, winner_username text, prize_pool_cents bigint, created_at timestamptz,
               my_room_id uuid, my_room_status text, my_round int, rounds int, eliminated boolean, prize_cents bigint,
               tier_key text, mode text, visibility text, host_username text, payout_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  with me as (select auth.uid() as uid),
  mine as (
    select e.tournament_id, e.placement, (t.status = 'active') as is_active, t.created_at
      from me
      join public.tournament_entries e on e.user_id = me.uid
      join public.tournaments t on t.id = e.tournament_id
     where t.format = 'bracket'
     order by (t.status = 'active') desc, t.created_at desc
     limit least(greatest(coalesce(p_limit, 30), 1), 60)
  )
  select t.id, t.name, t.game, t.network, t.entry_fee_cents, t.max_players, t.status,
         t.entrants, m.placement, w.username, t.prize_pool_cents, t.created_at,
         cur.id, cur.status, cur.round, public.rib_tournament_rounds(t.max_players),
         exists (select 1 from public.match_rooms o
                  where o.tournament_id = t.id and me.uid in (o.player_a, o.player_b)
                    and o.status in ('done','void') and o.winner_id is distinct from me.uid),
         coalesce((select sum(l.amount_cents) from public.wallet_ledger l
                    where l.user_id = me.uid and l.ref_id = t.id and l.kind = 'tournament_prize'), 0)::bigint,
         t.tier_key, t.mode, t.visibility, h.username, t.payout_at
    from mine m
    cross join me
    join public.tournaments t on t.id = m.tournament_id
    left join public.profiles w on w.id = t.winner_id
    left join public.profiles h on h.id = t.creator_id and t.mode = 'hosted'
    left join lateral (
      select r.id, r.status, r.round from public.match_rooms r
       where r.tournament_id = t.id and me.uid in (r.player_a, r.player_b)
       order by r.round desc limit 1
    ) cur on true
   order by m.is_active desc, m.created_at desc;
$$;

-- One tournament by id (older invite links): private ones only for their
-- host and entrants.
create or replace function public.rib_tournament_summary(p_tournament_id uuid)
returns table (id uuid, name text, game text, network text, entry_fee_cents bigint, size int, entrants int,
               status text, creator_username text, joined boolean)
language sql stable security definer set search_path = ''
as $$
  select t.id, t.name, t.game, t.network, t.entry_fee_cents, t.max_players, t.entrants,
         t.status, p.username,
         exists (select 1 from public.tournament_entries e where e.tournament_id = t.id and e.user_id = auth.uid())
    from public.tournaments t
    left join public.profiles p on p.id = t.creator_id
   where t.id = p_tournament_id and t.format = 'bracket'
     and (t.visibility = 'public' or t.creator_id = auth.uid()
          or exists (select 1 from public.tournament_entries e where e.tournament_id = t.id and e.user_id = auth.uid()));
$$;

-- Everything a room page needs (0022) plus the hosted context: mode, host
-- (id and username; null outside hosted rooms), whether I am the host, entrants.
drop function if exists public.rib_room_info(uuid);
create or replace function public.rib_room_info(p_room_id uuid)
returns table (
  a_username text, b_username text, a_handle text, b_handle text,
  a_matches int, a_disputes_lost int, a_no_shows int,
  b_matches int, b_disputes_lost int, b_no_shows int,
  tournament_name text, entry_fee_cents bigint, tournament_size int, rounds int,
  mode text, host_username text, is_host boolean, entrants int, host_id uuid
)
language plpgsql stable security definer set search_path = ''
as $$
declare v_r public.match_rooms;
begin
  select * into v_r from public.match_rooms where id = p_room_id;
  if v_r.id is null or not public.rib_can_see_room(v_r.id) then
    raise exception 'you are not in this match' using hint = 'not_a_participant';
  end if;
  return query
  select pa.username, pb.username, ga.handle, gb.handle,
         coalesce(ra.matches_completed, 0), coalesce(ra.disputes_lost, 0), coalesce(ra.no_shows, 0),
         coalesce(rb.matches_completed, 0), coalesce(rb.disputes_lost, 0), coalesce(rb.no_shows, 0),
         t.name, t.entry_fee_cents, t.max_players, public.rib_tournament_rounds(t.max_players),
         coalesce(t.mode, 'quick'), case when t.mode = 'hosted' then ph.username end,
         coalesce(t.mode = 'hosted' and t.creator_id = auth.uid(), false),
         t.entrants, case when t.mode = 'hosted' then t.creator_id end
    from (select 1) one
    left join public.profiles pa on pa.id = v_r.player_a
    left join public.profiles pb on pb.id = v_r.player_b
    left join public.game_accounts ga on ga.user_id = v_r.player_a and ga.network = v_r.network
    left join public.game_accounts gb on gb.user_id = v_r.player_b and gb.network = v_r.network
    left join public.player_reputation ra on ra.user_id = v_r.player_a
    left join public.player_reputation rb on rb.user_id = v_r.player_b
    left join public.tournaments t on t.id = v_r.tournament_id
    left join public.profiles ph on ph.id = t.creator_id;
end;
$$;

-- Operators: open appeals and hosted rooms flagged by the SLA sweep.
create or replace function public.rib_ops_hosted_queue()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform public.rib_require_operator();
  return jsonb_build_object(
    'appeals', coalesce((
      select jsonb_agg(jsonb_build_object(
               'tournament_id', t.id, 'name', t.name, 'status', t.status, 'host_id', t.creator_id, 'host_username', h.username,
               'winner_id', t.winner_id, 'winner_username', w.username, 'entry_fee_cents', t.entry_fee_cents,
               'entrants', t.entrants, 'payout_at', t.payout_at,
               'prize', public.rib_hosted_split(t.entry_fee_cents * t.entrants),
               'appeals', (select jsonb_agg(jsonb_build_object('user_id', d.user_id, 'username', p.username, 'reason', d.reason,
                                                               'room_id', d.room_id, 'deposit_cents', d.deposit_cents,
                                                               'created_at', d.created_at) order by d.created_at)
                             from public.tournament_disputes d left join public.profiles p on p.id = d.user_id
                            where d.tournament_id = t.id and d.status = 'open'))
             order by t.payout_at)
        from public.tournaments t
        left join public.profiles h on h.id = t.creator_id
        left join public.profiles w on w.id = t.winner_id
       where t.mode = 'hosted' and t.status = 'disputed'), '[]'::jsonb),
    'flagged_rooms', coalesce((
      select jsonb_agg(jsonb_build_object(
               'room_id', r.id, 'tournament_id', t.id, 'tournament_name', t.name, 'host_username', h.username,
               'round', r.round, 'slot', r.slot, 'status', r.status, 'started_at', r.started_at,
               'player_a', r.player_a, 'player_b', r.player_b, 'a_username', pa.username, 'b_username', pb.username, 'a_report', r.a_report, 'b_report', r.b_report)
             order by r.started_at)
        from public.match_rooms r
        join public.tournaments t on t.id = r.tournament_id and t.mode = 'hosted'
        left join public.profiles h on h.id = t.creator_id
        left join public.profiles pa on pa.id = r.player_a
        left join public.profiles pb on pb.id = r.player_b
       where r.review_flag and r.status in ('setup','live')), '[]'::jsonb));
end;
$$;

create or replace function public.rib_ops_health()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'client_errors_last_hour', (select count(*) from public.client_errors where created_at > now() - interval '1 hour'),
    'overdue_tournament_payouts', (select count(*) from public.tournaments where status = 'payout_pending' and payout_at < now() - interval '30 minutes'),
    'disputed_tournaments', (select count(*) from public.tournaments where status = 'disputed'),
    'disputed_matches', (select count(*) from public.match_rooms where status = 'disputed'),
    'overdue_match_disputes', (select count(*) from public.match_rooms where status = 'disputed' and disputed_at < now() - interval '24 hours'),
    'overdue_turn_clocks', (select count(*) from public.game_matches where status = 'active' and turn_deadline < now() - interval '10 minutes'),
    'frozen_wallets', (select count(*) from public.wallets where frozen_at is not null),
    'open_appeals', (select count(*) from public.tournament_disputes where status = 'open'),
    'stale_appeals', (select count(*) from public.tournament_disputes where status = 'open' and created_at < now() - interval '48 hours'),
    'flagged_hosted_rooms', (select count(*) from public.match_rooms where status = 'live' and review_flag),
    'checked_at', now()
  );
$$;

-- ----------------------------------------------------------------------------
-- 12) Grants and schedule
-- ----------------------------------------------------------------------------
do $$
declare f text;
begin
  -- Players.
  foreach f in array array[
    'rib_host_fee_percent()', 'rib_appeal_window()', 'rib_host_decide_window()', 'rib_host_abandon_window()',
    'rib_host_open_window()', 'rib_host_walkover_wait()', 'rib_host_min_match_minutes()', 'rib_host_min_completed()',
    'rib_room_info(uuid)',
    'rib_tournament_rounds(int)', 'rib_can_see_room(uuid)', 'rib_is_room_host(uuid)', 'rib_can_see_entries(uuid)', 'rib_path_room(text)',
    'rib_room_lobby_write_ok(text,boolean)', 'rib_room_evidence_write_ok(text)', 'rib_appeal_window_for(uuid)',
    'rib_room_report(uuid,uuid)', 'rib_room_dispute(uuid,text)', 'rib_room_message(uuid,text)', 'rib_my_rooms()',
    'rib_tournament_join(uuid)', 'rib_tournament_join_by_code(text)', 'rib_tournament_leave(uuid)',
    'rib_hosted_create(text,int,bigint,text,text)', 'rib_host_rotate_invite(uuid)', 'rib_host_start(uuid)',
    'rib_host_cancel(uuid)', 'rib_host_room_lobby(uuid,text,text,text)', 'rib_host_decide(uuid,uuid,boolean,text)',
    'rib_host_void_room(uuid,text)', 'rib_tournament_appeal(uuid,text,uuid)', 'rib_tournament_dispute(uuid,text)',
    'rib_host_dashboard(int)', 'rib_tournament_bracket(uuid)', 'rib_open_tournaments(text,int,int)',
    'rib_my_tournaments(int)', 'rib_tournament_summary(uuid)',
    'rib_room_resolve(uuid,text,uuid,text)', 'rib_appeal_resolve(uuid,text,uuid,text)', 'rib_ops_hosted_queue()'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  -- Operators act through rib_require_operator(); the service role too.
  foreach f in array array['rib_room_resolve(uuid,text,uuid,text)', 'rib_appeal_resolve(uuid,text,uuid,text)', 'rib_ops_hosted_queue()'] loop
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  -- Invite link preview: before login too.
  revoke execute on function public.rib_tournament_preview(text) from public;
  grant execute on function public.rib_tournament_preview(text) to anon, authenticated;
  -- Internal.
  foreach f in array array[
    'rib_invite_code()', 'rib_hosted_split(bigint,boolean)', 'rib_host_strike(uuid)', 'rib_lock_tournament_wallets(uuid)',
    'rib_platform_revenue_add(uuid,bigint)', 'rib_tournament_refund_all(uuid,text)', 'rib_appeals_close(uuid,text,text)',
    'rib_hosted_pay(uuid,uuid,boolean)', 'rib_room_open(uuid)', 'rib_tournament_start(uuid)',
    'rib_tournament_complete(uuid,uuid,uuid)', 'rib_tournament_join_locked(uuid,uuid)',
    'rib_hosted_for_host(uuid,boolean)', 'rib_hosted_room_for_host(uuid)', 'rib_room_purgeable(public.match_rooms)',
    'rib_room_finish(uuid,uuid,boolean)', 'rib_invite_lookups_exceeded(uuid)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
  -- Service role only (jobs and Edge Functions).
  foreach f in array array[
    'rib_hosted_sweep()', 'rib_tournament_payouts(int)', 'rib_tournament_resolve(uuid,text,uuid)',
    'rib_room_sweep(int)', 'rib_room_purge_candidates(int)', 'rib_room_messages_purge(uuid[])',
    'rib_evidence_check_apply(bigint,text,uuid,numeric,jsonb,text)', 'rib_ops_health()'
  ] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('rib-hosted-sweep', '*/5 * * * *', 'select public.rib_hosted_sweep()');
  else
    raise warning 'pg_cron not installed: schedule rib_hosted_sweep() every 5 minutes externally';
  end if;
end;
$$;
