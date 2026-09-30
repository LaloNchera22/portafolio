-- ============================================================================
-- Runinback — tournament platform (2026-09-29).
--
-- Runinback becomes a tournament platform. Paid competition happens only in
-- tournaments of 4 or 8 players that start when full ("sit & go"); 1v1
-- challenges become free friendlies.
--
--   1) Game accounts: the handle each player uses per network (Riot ID,
--      Steam, Xbox, PSN, ...). A tournament or friendly can require one.
--   2) Match rooms: every bracket match and every friendly is a room with a
--      match code, a private-lobby name and password, a 15-minute ready check,
--      a chat, result reports with a 15-minute confirmation window (silence
--      confirms), disputes and evidence captured in the app.
--   3) Brackets: when a tournament fills, entrants are seeded at random into a
--      single-elimination bracket. Winners advance on their own; a no-show
--      loses by walkover. When the final is confirmed the prize is paid at
--      once: 10% platform fee, then 70% to the champion and 30% to the
--      runner-up (Riot requires >= 70% of entry fees to go to prizes: 90% do).
--   4) Disputes in paid matches hold a deposit (10% of the entry fee, min
--      1 rcoin) and wait for an operator; a false claim loses it to the other
--      player. Friendly disputes simply end the room with no result.
--   5) Reputation and limits: completed matches, disputes lost and no-shows;
--      new accounts can enter up to 25 rcoin until they finish 3 matches.
--   6) Test-mode clean-up: live paid challenges and old-format tournaments are
--      refunded and closed (rcoin is simulated; nobody loses anything).
-- Idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Game accounts
-- ----------------------------------------------------------------------------
create table if not exists public.game_accounts (
  user_id    uuid        not null references auth.users (id) on delete cascade,
  network    text        not null check (network in (
               'riot','steam','epic','xbox','playstation','nintendo',
               'battlenet','ea','activision','ubisoft','other')),
  handle     text        not null check (char_length(handle) between 2 and 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, network)
);
alter table public.game_accounts enable row level security;
revoke all on public.game_accounts from anon;
grant select on public.game_accounts to authenticated;
drop policy if exists "game_accounts: own" on public.game_accounts;
create policy "game_accounts: own" on public.game_accounts
  for select to authenticated using (user_id = (select auth.uid()));

create or replace function public.rib_network_valid(p_network text)
returns boolean language sql immutable set search_path = ''
as $$ select p_network in ('riot','steam','epic','xbox','playstation','nintendo','battlenet','ea','activision','ubisoft','other') $$;

create or replace function public.rib_game_account_set(p_network text, p_handle text)
returns public.game_accounts
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_row public.game_accounts; v_handle text := trim(coalesce(p_handle, ''));
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  if not public.rib_network_valid(p_network) then raise exception 'unknown network' using hint = 'invalid_network'; end if;
  if char_length(v_handle) < 2 or char_length(v_handle) > 64 then
    raise exception 'enter the handle you use in the game' using hint = 'invalid_handle';
  end if;
  insert into public.game_accounts (user_id, network, handle)
  values (v_uid, p_network, v_handle)
  on conflict (user_id, network) do update set handle = excluded.handle, updated_at = now()
  returning * into v_row;
  return v_row;
end;
$$;

-- The account can't be removed while a live event or room depends on it.
create or replace function public.rib_game_account_remove(p_network text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  if exists (select 1 from public.tournaments t join public.tournament_entries e on e.tournament_id = t.id
              where e.user_id = v_uid and t.network = p_network and t.status in ('open','active'))
     or exists (select 1 from public.challenges c
              where c.network = p_network and c.status in ('open','pending','active')
                and (c.creator_id = v_uid or c.opponent_id = v_uid)) then
    raise exception 'this account is used by a live tournament or friendly' using hint = 'game_account_in_use';
  end if;
  delete from public.game_accounts where user_id = v_uid and network = p_network;
end;
$$;

-- ----------------------------------------------------------------------------
-- 2) Reputation and paid-entry limits
-- ----------------------------------------------------------------------------
create table if not exists public.player_reputation (
  user_id           uuid primary key references auth.users (id) on delete cascade,
  matches_completed int not null default 0,
  disputes_lost     int not null default 0,
  no_shows          int not null default 0,
  updated_at        timestamptz not null default now()
);
alter table public.player_reputation enable row level security;
revoke all on public.player_reputation from anon, authenticated;

create or replace function public.rib_rep_bump(p_uid uuid, p_completed int, p_disputes int, p_no_shows int)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.player_reputation (user_id, matches_completed, disputes_lost, no_shows)
  values (p_uid, p_completed, p_disputes, p_no_shows)
  on conflict (user_id) do update set
    matches_completed = public.player_reputation.matches_completed + excluded.matches_completed,
    disputes_lost     = public.player_reputation.disputes_lost + excluded.disputes_lost,
    no_shows          = public.player_reputation.no_shows + excluded.no_shows,
    updated_at        = now();
$$;
revoke execute on function public.rib_rep_bump(uuid,int,int,int) from public, anon, authenticated;

create or replace function public.rib_player_reputation(p_uid uuid)
returns table (matches_completed int, disputes_lost int, no_shows int)
language sql stable security definer set search_path = ''
as $$
  select coalesce(r.matches_completed, 0), coalesce(r.disputes_lost, 0), coalesce(r.no_shows, 0)
    from (select p_uid as user_id) u
    left join public.player_reputation r on r.user_id = u.user_id;
$$;

-- New accounts are capped; players with a record of false claims or no-shows
-- are kept out of paid tournaments until an operator reviews them.
create or replace function public.rib_paid_entry_limits(p_uid uuid, p_fee_cents bigint)
returns void
language plpgsql stable security definer set search_path = ''
as $$
declare v_rep public.player_reputation;
begin
  if p_fee_cents <= 0 then return; end if;
  select * into v_rep from public.player_reputation where user_id = p_uid;
  if coalesce(v_rep.disputes_lost, 0) >= 3 or coalesce(v_rep.no_shows, 0) >= 5 then
    raise exception 'paid tournaments are paused on this account; contact support' using hint = 'account_restricted';
  end if;
  if coalesce(v_rep.matches_completed, 0) < 3 and p_fee_cents > 2500 then
    raise exception 'new accounts can enter up to 25 rcoin until they finish 3 matches' using hint = 'new_account_limit';
  end if;
end;
$$;
revoke execute on function public.rib_paid_entry_limits(uuid,bigint) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 3) Operators
-- ----------------------------------------------------------------------------
create table if not exists public.operators (
  user_id  uuid primary key references auth.users (id) on delete cascade,
  added_at timestamptz not null default now()
);
alter table public.operators enable row level security;
revoke all on public.operators from anon, authenticated;

create or replace function public.rib_is_operator()
returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.operators where user_id = auth.uid()) $$;

create or replace function public.rib_require_operator()
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.rib_is_operator() and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'operators only' using hint = 'not_operator';
  end if;
end;
$$;
revoke execute on function public.rib_require_operator() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 4) Tournaments: bracket format, fee, platform revenue
-- ----------------------------------------------------------------------------
alter table public.tournaments add column if not exists format             text not null default 'legacy';
alter table public.tournaments add column if not exists network            text;
alter table public.tournaments add column if not exists started_at         timestamptz;
alter table public.tournaments add column if not exists runner_up_id       uuid references auth.users (id) on delete set null;
alter table public.tournaments add column if not exists platform_fee_cents bigint not null default 0;
alter table public.tournaments drop constraint if exists tournaments_format_check;
alter table public.tournaments add constraint tournaments_format_check check (format in ('legacy','bracket'));
alter table public.tournaments drop constraint if exists tournaments_network_check;
alter table public.tournaments add constraint tournaments_network_check check (network is null or public.rib_network_valid(network));
create index if not exists tournaments_bracket_open_idx on public.tournaments (created_at desc) where format = 'bracket' and status = 'open';

create table if not exists public.platform_revenue (
  tournament_id uuid primary key references public.tournaments (id) on delete restrict,
  amount_cents  bigint not null check (amount_cents >= 0),
  created_at    timestamptz not null default now()
);
alter table public.platform_revenue enable row level security;
revoke all on public.platform_revenue from anon, authenticated;

create or replace function public.rib_tournament_min_entrants()
returns int language sql immutable set search_path = '' as $$ select 4 $$;
create or replace function public.rib_platform_fee_percent()
returns int language sql immutable set search_path = '' as $$ select 10 $$;

-- ----------------------------------------------------------------------------
-- 5) Match rooms (bracket matches and friendlies)
-- ----------------------------------------------------------------------------
create table if not exists public.match_rooms (
  id                    uuid primary key default gen_random_uuid(),
  kind                  text not null check (kind in ('tournament','friendly')),
  tournament_id         uuid references public.tournaments (id) on delete cascade,
  round                 int,
  slot                  int,
  game                  text not null,
  network               text check (network is null or public.rib_network_valid(network)),
  player_a              uuid references auth.users (id) on delete set null,
  player_b              uuid references auth.users (id) on delete set null,
  status                text not null default 'waiting'
                          check (status in ('waiting','ready_check','live','disputed','done','void')),
  room_code             text,
  lobby_name            text,
  lobby_password        text,
  ready_deadline        timestamptz,
  a_ready_at            timestamptz,
  b_ready_at            timestamptz,
  started_at            timestamptz,
  a_report              uuid,
  b_report              uuid,
  first_report_at       timestamptz,
  confirm_deadline      timestamptz,
  winner_id             uuid references auth.users (id) on delete set null,
  walkover              boolean not null default false,
  disputed_by           uuid references auth.users (id) on delete set null,
  disputed_at           timestamptz,
  dispute_reason        text,
  dispute_deposit_cents bigint not null default 0,
  resolved_by           uuid references auth.users (id) on delete set null,
  resolution_note       text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  finished_at           timestamptz,
  unique (tournament_id, round, slot)
);
create index if not exists match_rooms_player_a_idx on public.match_rooms (player_a) where status in ('ready_check','live','disputed');
create index if not exists match_rooms_player_b_idx on public.match_rooms (player_b) where status in ('ready_check','live','disputed');
create index if not exists match_rooms_ready_idx on public.match_rooms (ready_deadline) where status = 'ready_check';
create index if not exists match_rooms_confirm_idx on public.match_rooms (confirm_deadline) where status = 'live' and confirm_deadline is not null;
create index if not exists match_rooms_disputed_idx on public.match_rooms (disputed_at) where status = 'disputed';

alter table public.challenges add column if not exists room_id uuid references public.match_rooms (id) on delete set null;
alter table public.challenges add column if not exists network text;
alter table public.challenges drop constraint if exists challenges_network_check;
alter table public.challenges add constraint challenges_network_check check (network is null or public.rib_network_valid(network));
-- Friendlies carry no entry fee.
alter table public.challenges drop constraint if exists challenges_stake_cents_check;
alter table public.challenges add constraint challenges_stake_cents_check check (stake_cents between 0 and 100000);

alter table public.match_rooms enable row level security;
revoke all on public.match_rooms from anon;
grant select on public.match_rooms to authenticated;

create or replace function public.rib_can_see_room(p_room_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.match_rooms r
                  where r.id = p_room_id and (r.player_a = auth.uid() or r.player_b = auth.uid()))
      or public.rib_is_operator();
$$;

drop policy if exists "match_rooms: players and operators" on public.match_rooms;
create policy "match_rooms: players and operators" on public.match_rooms
  for select to authenticated
  using (player_a = (select auth.uid()) or player_b = (select auth.uid()) or (select public.rib_is_operator()));

alter table public.match_rooms replica identity full;
do $$
begin
  alter publication supabase_realtime add table public.match_rooms;
exception when duplicate_object then null; when undefined_object then null;
end;
$$;

create table if not exists public.room_messages (
  id         bigint generated always as identity primary key,
  room_id    uuid        not null references public.match_rooms (id) on delete cascade,
  user_id    uuid        references auth.users (id) on delete set null,
  body       text        not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);
create index if not exists room_messages_room_idx on public.room_messages (room_id, id);
alter table public.room_messages enable row level security;
revoke all on public.room_messages from anon;
grant select on public.room_messages to authenticated;
drop policy if exists "room_messages: room" on public.room_messages;
create policy "room_messages: room" on public.room_messages
  for select to authenticated using (public.rib_can_see_room(room_id));
do $$
begin
  alter publication supabase_realtime add table public.room_messages;
exception when duplicate_object then null; when undefined_object then null;
end;
$$;

create table if not exists public.room_evidence_tokens (
  token     text        primary key,
  room_id   uuid        not null references public.match_rooms (id) on delete cascade,
  user_id   uuid        not null references auth.users (id) on delete cascade,
  issued_at timestamptz not null default now(),
  used_at   timestamptz
);
alter table public.room_evidence_tokens enable row level security;
revoke all on public.room_evidence_tokens from anon, authenticated;

create table if not exists public.room_evidence (
  id           bigint generated always as identity primary key,
  room_id      uuid        not null references public.match_rooms (id) on delete cascade,
  user_id      uuid        references auth.users (id) on delete set null,
  storage_path text        not null,
  sha256       text        not null check (sha256 ~ '^[0-9a-f]{64}$'),
  token        text        not null,
  source       text        not null check (source in ('screen','camera')),
  created_at   timestamptz not null default now()
);
create index if not exists room_evidence_room_idx on public.room_evidence (room_id, id);
alter table public.room_evidence enable row level security;
revoke all on public.room_evidence from anon;
grant select on public.room_evidence to authenticated;
drop policy if exists "room_evidence: room" on public.room_evidence;
create policy "room_evidence: room" on public.room_evidence
  for select to authenticated using (public.rib_can_see_room(room_id));

-- Evidence files: private bucket; players write only to <room id>/<user id>/.
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('room-evidence', 'room-evidence', false, 8388608, array['image/png','image/jpeg','image/webp'])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
    execute 'drop policy if exists "room evidence: upload own" on storage.objects';
    execute $p$create policy "room evidence: upload own" on storage.objects
      for insert to authenticated with check (
        bucket_id = 'room-evidence'
        and (storage.foldername(name))[2] = (select auth.uid())::text
        and public.rib_can_see_room(((storage.foldername(name))[1])::uuid))$p$;
    execute 'drop policy if exists "room evidence: read room" on storage.objects';
    execute $p$create policy "room evidence: read room" on storage.objects
      for select to authenticated using (
        bucket_id = 'room-evidence'
        and public.rib_can_see_room(((storage.foldername(name))[1])::uuid))$p$;
  else
    raise warning 'storage schema not present: create the room-evidence bucket and policies on Supabase';
  end if;
end;
$$;

-- Ledger kinds for dispute deposits.
alter table public.wallet_ledger drop constraint if exists wallet_ledger_kind_check;
alter table public.wallet_ledger add constraint wallet_ledger_kind_check
  check (kind in (
    'deposit','withdrawal',
    'challenge_lock','challenge_win','challenge_settled','challenge_refund',
    'tournament_entry','tournament_prize','tournament_refund',
    'rcoin_purchase','rcoin_reversal',
    'game_lock','game_win','game_settled','game_refund',
    'dispute_deposit','dispute_refund','dispute_forfeit','dispute_award'
  )) not valid;
alter table public.wallet_ledger validate constraint wallet_ledger_kind_check;

-- ----------------------------------------------------------------------------
-- 6) Room internals
-- ----------------------------------------------------------------------------
create or replace function public.rib_room_code()
returns text
language sql volatile set search_path = ''
as $$
  select 'RB-' || upper(substr(translate(encode(sha256(gen_random_uuid()::text::bytea), 'base64'), '+/=0O1Il', ''), 1, 5));
$$;

-- Both players are known: hand out the lobby details and start the ready check.
create or replace function public.rib_room_open(p_room_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_code text := public.rib_room_code();
begin
  update public.match_rooms
     set status = 'ready_check', room_code = v_code, lobby_name = 'Runinback ' || v_code,
         lobby_password = lower(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
         ready_deadline = now() + interval '15 minutes', updated_at = now()
   where id = p_room_id and status = 'waiting';
end;
$$;

create or replace function public.rib_tournament_rounds(p_size int)
returns int language sql immutable set search_path = ''
as $$ select case p_size when 4 then 2 when 8 then 3 else 0 end $$;

-- Pay the tournament: 10% platform fee, then 70/30 between champion and
-- runner-up. With no winner at all, every entry fee is refunded.
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

-- A bracket room ended (winner or void): move the winner up, open the next
-- room when both of its feeders are decided, finish the tournament after
-- the final. Walkovers cascade (a room whose opponent never arrives).
create or replace function public.rib_tournament_advance(p_room_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_r public.match_rooms; v_t public.tournaments; v_next public.match_rooms; v_rounds int; v_pending int;
begin
  select * into v_r from public.match_rooms where id = p_room_id;
  if v_r.kind <> 'tournament' then return; end if;
  select * into v_t from public.tournaments where id = v_r.tournament_id;
  v_rounds := public.rib_tournament_rounds(v_t.max_players);

  if v_r.round >= v_rounds then
    perform public.rib_tournament_complete(v_t.id, v_r.winner_id,
      case when v_r.winner_id is null or v_r.walkover then null
           when v_r.winner_id = v_r.player_a then v_r.player_b else v_r.player_a end);
    return;
  end if;

  if v_r.winner_id is not null then
    if v_r.slot % 2 = 0 then
      update public.match_rooms set player_a = v_r.winner_id, updated_at = now()
       where tournament_id = v_t.id and round = v_r.round + 1 and slot = v_r.slot / 2;
    else
      update public.match_rooms set player_b = v_r.winner_id, updated_at = now()
       where tournament_id = v_t.id and round = v_r.round + 1 and slot = v_r.slot / 2;
    end if;
  end if;

  select count(*) into v_pending from public.match_rooms
   where tournament_id = v_t.id and round = v_r.round and slot / 2 = v_r.slot / 2 and status not in ('done','void');
  if v_pending > 0 then return; end if;

  select * into v_next from public.match_rooms
   where tournament_id = v_t.id and round = v_r.round + 1 and slot = v_r.slot / 2 for update;
  if v_next.player_a is not null and v_next.player_b is not null then
    perform public.rib_room_open(v_next.id);
  elsif coalesce(v_next.player_a, v_next.player_b) is not null then
    perform public.rib_room_finish(v_next.id, coalesce(v_next.player_a, v_next.player_b), true);
  else
    perform public.rib_room_void(v_next.id, 'Nobody reached this match');
  end if;
end;
$$;

create or replace function public.rib_room_finish(p_room_id uuid, p_winner uuid, p_walkover boolean default false)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_r public.match_rooms;
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
    if not p_walkover then
      perform public.rib_rep_bump(v_r.player_a, 1, 0, 0);
      perform public.rib_rep_bump(v_r.player_b, 1, 0, 0);
      -- The ranking record: confirmed tournament matches (rib_stats_record, 11c).
      perform public.rib_stats_record(p_winner, 1, 0);
      perform public.rib_stats_record(case when p_winner = v_r.player_a then v_r.player_b else v_r.player_a end, 0, 1);
    end if;
    perform public.rib_tournament_advance(v_r.id);
  end if;
end;
$$;

create or replace function public.rib_room_void(p_room_id uuid, p_note text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_r public.match_rooms;
begin
  update public.match_rooms
     set status = 'void', winner_id = null, confirm_deadline = null, finished_at = now(), updated_at = now(),
         resolution_note = coalesce(resolution_note, p_note)
   where id = p_room_id and status not in ('done','void')
  returning * into v_r;
  if v_r.id is null then return; end if;
  if v_r.kind = 'friendly' then
    update public.challenges set status = 'cancelled', settled_at = now() where room_id = v_r.id;
  else
    perform public.rib_tournament_advance(v_r.id);
  end if;
end;
$$;

revoke execute on function public.rib_room_code() from public, anon, authenticated;
revoke execute on function public.rib_room_open(uuid) from public, anon, authenticated;
revoke execute on function public.rib_tournament_complete(uuid,uuid,uuid) from public, anon, authenticated;
revoke execute on function public.rib_tournament_advance(uuid) from public, anon, authenticated;
revoke execute on function public.rib_room_finish(uuid,uuid,boolean) from public, anon, authenticated;
revoke execute on function public.rib_room_void(uuid,text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 7) Room actions (players)
-- ----------------------------------------------------------------------------
create or replace function public.rib_room_for_player(p_room_id uuid, p_lock boolean)
returns public.match_rooms
language plpgsql security definer set search_path = ''
as $$
declare v_r public.match_rooms;
begin
  if auth.uid() is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  if p_lock then
    select * into v_r from public.match_rooms where id = p_room_id for update;
  else
    select * into v_r from public.match_rooms where id = p_room_id;
  end if;
  if v_r.id is null or (auth.uid() is distinct from v_r.player_a and auth.uid() is distinct from v_r.player_b) then
    raise exception 'you are not in this match' using hint = 'not_a_participant';
  end if;
  return v_r;
end;
$$;
revoke execute on function public.rib_room_for_player(uuid,boolean) from public, anon, authenticated;

create or replace function public.rib_room_ready(p_room_id uuid)
returns public.match_rooms
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_r public.match_rooms;
begin
  v_r := public.rib_room_for_player(p_room_id, true);
  if v_r.status <> 'ready_check' then raise exception 'this room is not waiting for players' using hint = 'room_not_waiting'; end if;
  if v_r.ready_deadline < now() then raise exception 'the ready check has expired' using hint = 'ready_expired'; end if;
  if v_uid = v_r.player_a then
    update public.match_rooms set a_ready_at = coalesce(a_ready_at, now()), updated_at = now() where id = v_r.id returning * into v_r;
  else
    update public.match_rooms set b_ready_at = coalesce(b_ready_at, now()), updated_at = now() where id = v_r.id returning * into v_r;
  end if;
  if v_r.a_ready_at is not null and v_r.b_ready_at is not null then
    update public.match_rooms set status = 'live', started_at = now(), updated_at = now() where id = v_r.id returning * into v_r;
  end if;
  return v_r;
end;
$$;

-- The first report opens a 15-minute window; a matching report settles at
-- once; a different winner has to go through a dispute.
create or replace function public.rib_room_report(p_room_id uuid, p_winner_id uuid)
returns public.match_rooms
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_r public.match_rooms; v_mine uuid; v_theirs uuid;
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
    update public.match_rooms set first_report_at = now(), confirm_deadline = now() + interval '15 minutes', updated_at = now()
     where id = v_r.id;
  end if;
  select * into v_r from public.match_rooms where id = v_r.id;
  return v_r;
end;
$$;

-- Contest the result. Paid bracket matches hold a deposit and wait for an
-- operator; a friendly just ends with no result.
create or replace function public.rib_room_dispute(p_room_id uuid, p_reason text)
returns public.match_rooms
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_r public.match_rooms; v_reason text := trim(coalesce(p_reason, '')); v_fee bigint := 0; v_deposit bigint := 0;
begin
  v_r := public.rib_room_for_player(p_room_id, true);
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

create or replace function public.rib_room_message(p_room_id uuid, p_body text)
returns public.room_messages
language plpgsql security definer set search_path = ''
as $$
declare v_r public.match_rooms; v_row public.room_messages; v_body text := trim(coalesce(p_body, ''));
begin
  v_r := public.rib_room_for_player(p_room_id, false);
  if v_r.status not in ('ready_check','live','disputed') then raise exception 'this room is closed' using hint = 'room_closed'; end if;
  if char_length(v_body) < 1 or char_length(v_body) > 500 then
    raise exception 'messages are 1 to 500 characters' using hint = 'invalid_message';
  end if;
  if not public.rib_rate_limit_hit('room_chat', auth.uid(), 20, 60) then
    raise exception 'slow down: too many messages' using hint = 'rate_limited';
  end if;
  insert into public.room_messages (room_id, user_id, body) values (v_r.id, auth.uid(), v_body) returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.rib_room_evidence_token(p_room_id uuid)
returns table (token text, issued_at timestamptz, room_code text)
language plpgsql security definer set search_path = ''
as $$
declare v_r public.match_rooms; v_token text;
begin
  v_r := public.rib_room_for_player(p_room_id, false);
  if v_r.status not in ('live','disputed') then
    raise exception 'evidence can be added once the match has started' using hint = 'challenge_not_started';
  end if;
  if not public.rib_rate_limit_hit('evidence_token', auth.uid(), 20, 3600) then
    raise exception 'too many captures: try again later' using hint = 'rate_limited';
  end if;
  v_token := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  insert into public.room_evidence_tokens (token, room_id, user_id) values (v_token, v_r.id, auth.uid());
  return query select v_token, now(), v_r.room_code;
end;
$$;

create or replace function public.rib_room_evidence_add(p_room_id uuid, p_token text, p_path text, p_sha256 text, p_source text)
returns public.room_evidence
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_t public.room_evidence_tokens; v_row public.room_evidence; v_cnt int;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  select * into v_t from public.room_evidence_tokens
   where token = upper(coalesce(p_token, '')) and room_id = p_room_id and user_id = v_uid for update;
  if v_t.token is null or v_t.used_at is not null or v_t.issued_at < now() - interval '15 minutes' then
    raise exception 'this capture expired: take it again' using hint = 'evidence_token_invalid';
  end if;
  if p_path is null or p_path not like p_room_id::text || '/' || v_uid::text || '/%'
     or coalesce(p_sha256, '') !~ '^[0-9a-fA-F]{64}$' or p_source not in ('screen','camera') then
    raise exception 'invalid evidence file' using hint = 'evidence_invalid';
  end if;
  select count(*) into v_cnt from public.room_evidence where room_id = p_room_id and user_id = v_uid;
  if v_cnt >= 10 then raise exception 'up to 10 captures per player' using hint = 'evidence_limit'; end if;
  update public.room_evidence_tokens set used_at = now() where token = v_t.token;
  insert into public.room_evidence (room_id, user_id, storage_path, sha256, token, source)
  values (p_room_id, v_uid, p_path, lower(p_sha256), v_t.token, p_source)
  returning * into v_row;
  return v_row;
end;
$$;

-- Everything a room page needs: names, handles, records, tournament context.
create or replace function public.rib_room_info(p_room_id uuid)
returns table (
  a_username text, b_username text, a_handle text, b_handle text,
  a_matches int, a_disputes_lost int, a_no_shows int,
  b_matches int, b_disputes_lost int, b_no_shows int,
  tournament_name text, entry_fee_cents bigint, tournament_size int, rounds int
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
         t.name, t.entry_fee_cents, t.max_players, public.rib_tournament_rounds(t.max_players)
    from (select 1) one
    left join public.profiles pa on pa.id = v_r.player_a
    left join public.profiles pb on pb.id = v_r.player_b
    left join public.game_accounts ga on ga.user_id = v_r.player_a and ga.network = v_r.network
    left join public.game_accounts gb on gb.user_id = v_r.player_b and gb.network = v_r.network
    left join public.player_reputation ra on ra.user_id = v_r.player_a
    left join public.player_reputation rb on rb.user_id = v_r.player_b
    left join public.tournaments t on t.id = v_r.tournament_id;
end;
$$;

-- The player's live rooms (to show "you have a match waiting").
create or replace function public.rib_my_rooms()
returns table (id uuid, kind text, game text, status text, round int, tournament_id uuid, tournament_name text,
               opponent_username text, ready_deadline timestamptz, confirm_deadline timestamptz)
language sql stable security definer set search_path = ''
as $$
  select r.id, r.kind, r.game, r.status, r.round, r.tournament_id, t.name,
         p.username, r.ready_deadline, r.confirm_deadline
    from public.match_rooms r
    left join public.tournaments t on t.id = r.tournament_id
    left join public.profiles p on p.id = case when r.player_a = auth.uid() then r.player_b else r.player_a end
   where (r.player_a = auth.uid() or r.player_b = auth.uid())
     and r.status in ('ready_check','live','disputed')
   order by r.created_at desc
   limit 20;
$$;

-- ----------------------------------------------------------------------------
-- 8) Tournaments (players)
-- ----------------------------------------------------------------------------
drop function if exists public.rib_tournament_create(text,text,bigint,int,timestamptz);
drop function if exists public.rib_tournament_finish(uuid,uuid);

create or replace function public.rib_tournament_start(p_tournament_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_t public.tournaments; v_rounds int; v_round int; v_slots int; v_players uuid[]; i int;
begin
  select * into v_t from public.tournaments where id = p_tournament_id for update;
  v_rounds := public.rib_tournament_rounds(v_t.max_players);
  select array_agg(user_id order by random()) into v_players from public.tournament_entries where tournament_id = v_t.id;

  for v_round in 1..v_rounds loop
    v_slots := v_t.max_players / (2 ^ v_round)::int;
    for i in 0..v_slots - 1 loop
      insert into public.match_rooms (kind, tournament_id, round, slot, game, network, player_a, player_b)
      values ('tournament', v_t.id, v_round, i, v_t.game, v_t.network,
              case when v_round = 1 then v_players[2 * i + 1] end,
              case when v_round = 1 then v_players[2 * i + 2] end);
    end loop;
  end loop;
  update public.tournaments set status = 'active', started_at = now() where id = v_t.id;
  perform public.rib_room_open(r.id) from public.match_rooms r where r.tournament_id = v_t.id and r.round = 1;
end;
$$;
revoke execute on function public.rib_tournament_start(uuid) from public, anon, authenticated;

create or replace function public.rib_tournament_join(p_tournament_id uuid)
returns public.tournaments
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_t public.tournaments; v_count int;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  select * into v_t from public.tournaments where id = p_tournament_id for update;
  if v_t.id is null then raise exception 'tournament not found' using hint = 'tournament_not_found'; end if;
  if v_t.format <> 'bracket' or v_t.status <> 'open' then raise exception 'registration is closed' using hint = 'registration_closed'; end if;
  if exists (select 1 from public.tournament_entries where tournament_id = v_t.id and user_id = v_uid) then
    raise exception 'already registered' using hint = 'already_registered';
  end if;
  if v_t.network is not null and not exists (select 1 from public.game_accounts where user_id = v_uid and network = v_t.network) then
    raise exception 'link your account for this network first' using hint = 'game_account_required';
  end if;
  perform public.rib_paid_entry_limits(v_uid, v_t.entry_fee_cents);

  if v_t.entry_fee_cents > 0 then
    perform public.rib_apply(v_uid, 'tournament_entry', -v_t.entry_fee_cents, 0, 'tournament', v_t.id, 'Tournament entry');
  end if;
  insert into public.tournament_entries (tournament_id, user_id) values (v_t.id, v_uid);
  update public.tournaments set prize_pool_cents = prize_pool_cents + v_t.entry_fee_cents where id = v_t.id;

  select count(*) into v_count from public.tournament_entries where tournament_id = v_t.id;
  if v_count >= v_t.max_players then perform public.rib_tournament_start(v_t.id); end if;
  select * into v_t from public.tournaments where id = v_t.id;
  return v_t;
end;
$$;

-- Sit & go: the creator is the first entrant.
create or replace function public.rib_tournament_create(
  p_name text, p_game text, p_entry_fee_cents bigint, p_size int, p_network text default null
) returns public.tournaments
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_t public.tournaments; v_live int; v_network text := nullif(trim(coalesce(p_network, '')), '');
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  if p_name is null or char_length(trim(p_name)) < 1 then raise exception 'name is required' using hint = 'tournament_name_required'; end if;
  if p_game is null or char_length(trim(p_game)) < 1 then raise exception 'game is required' using hint = 'game_required'; end if;
  if p_size is null or p_size not in (4, 8) then raise exception 'tournaments have 4 or 8 players' using hint = 'invalid_tournament_size'; end if;
  if p_entry_fee_cents is null or not (p_entry_fee_cents = 0 or p_entry_fee_cents between 100 and 50000) then
    raise exception 'the entry fee must be 0 or between 1 and 500 rcoin' using hint = 'invalid_entry_fee';
  end if;
  if v_network is not null and not public.rib_network_valid(v_network) then raise exception 'unknown network' using hint = 'invalid_network'; end if;

  perform public.rib_lock_user(v_uid);
  select count(*) into v_live from public.tournaments where creator_id = v_uid and status = 'open';
  if v_live >= 5 then raise exception 'too many open tournaments (max 5)' using hint = 'too_many_open'; end if;

  insert into public.tournaments (creator_id, name, game, entry_fee_cents, max_players, status, format, network)
  values (v_uid, trim(p_name), trim(p_game), p_entry_fee_cents, p_size, 'open', 'bracket', v_network)
  returning * into v_t;
  return public.rib_tournament_join(v_t.id);
end;
$$;

-- Leave before it starts: the entry fee comes back; an empty event closes.
create or replace function public.rib_tournament_leave(p_tournament_id uuid)
returns public.tournaments
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_t public.tournaments;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  select * into v_t from public.tournaments where id = p_tournament_id for update;
  if v_t.id is null then raise exception 'tournament not found' using hint = 'tournament_not_found'; end if;
  if v_t.status <> 'open' then raise exception 'the tournament has started' using hint = 'registration_closed'; end if;
  if not exists (select 1 from public.tournament_entries where tournament_id = v_t.id and user_id = v_uid) then
    raise exception 'you are not registered' using hint = 'not_an_entrant';
  end if;
  delete from public.tournament_entries where tournament_id = v_t.id and user_id = v_uid;
  if v_t.entry_fee_cents > 0 then
    perform public.rib_apply(v_uid, 'tournament_refund', v_t.entry_fee_cents, 0, 'tournament', v_t.id, 'Left the tournament, entry refunded');
  end if;
  update public.tournaments set prize_pool_cents = prize_pool_cents - v_t.entry_fee_cents where id = v_t.id;
  if not exists (select 1 from public.tournament_entries where tournament_id = v_t.id) then
    update public.tournaments set status = 'cancelled', finished_at = now() where id = v_t.id;
  end if;
  select * into v_t from public.tournaments where id = v_t.id;
  return v_t;
end;
$$;

-- Lobby of tournaments waiting for players (newest first).
create or replace function public.rib_open_tournaments(p_game text default null, p_size int default null, p_limit int default 30)
returns table (id uuid, name text, game text, network text, entry_fee_cents bigint, size int,
               entrants int, created_at timestamptz, creator_username text, joined boolean)
language sql stable security definer set search_path = ''
as $$
  select t.id, t.name, t.game, t.network, t.entry_fee_cents, t.max_players,
         (select count(*)::int from public.tournament_entries e where e.tournament_id = t.id),
         t.created_at, p.username,
         exists (select 1 from public.tournament_entries e where e.tournament_id = t.id and e.user_id = auth.uid())
    from public.tournaments t
    left join public.profiles p on p.id = t.creator_id
   where t.format = 'bracket' and t.status = 'open'
     and (p_game is null or p_game = ''
          or t.game ilike '%' || replace(replace(replace(left(p_game, 40), '\', '\\'), '%', '\%'), '_', '\_') || '%')
     and (p_size is null or t.max_players = p_size)
   order by t.created_at desc
   limit least(greatest(coalesce(p_limit, 30), 1), 60);
$$;

-- Tournaments I'm in (any status), newest first.
create or replace function public.rib_my_tournaments(p_limit int default 30)
returns table (id uuid, name text, game text, network text, entry_fee_cents bigint, size int, status text,
               entrants int, placement int, winner_username text, prize_pool_cents bigint, created_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select t.id, t.name, t.game, t.network, t.entry_fee_cents, t.max_players, t.status,
         (select count(*)::int from public.tournament_entries x where x.tournament_id = t.id),
         e.placement, w.username, t.prize_pool_cents, t.created_at
    from public.tournament_entries e
    join public.tournaments t on t.id = e.tournament_id
    left join public.profiles w on w.id = t.winner_id
   where e.user_id = auth.uid() and t.format = 'bracket'
   order by t.created_at desc
   limit least(greatest(coalesce(p_limit, 30), 1), 60);
$$;

-- The bracket of a started tournament (public: names and results only).
create or replace function public.rib_tournament_bracket(p_tournament_id uuid)
returns table (room_id uuid, round int, slot int, player_a uuid, player_b uuid, a_username text, b_username text,
               status text, winner_id uuid, walkover boolean)
language sql stable security definer set search_path = ''
as $$
  select r.id, r.round, r.slot, r.player_a, r.player_b, pa.username, pb.username, r.status, r.winner_id, r.walkover
    from public.match_rooms r
    left join public.profiles pa on pa.id = r.player_a
    left join public.profiles pb on pb.id = r.player_b
   where r.tournament_id = p_tournament_id
   order by r.round, r.slot;
$$;

-- ----------------------------------------------------------------------------
-- 9) Friendlies: free 1v1 challenges with a room
-- ----------------------------------------------------------------------------
drop function if exists public.rib_challenge_create(text,text,bigint,text);
drop function if exists public.rib_challenge_report(uuid,uuid);
drop function if exists public.rib_challenge_void(uuid);

create or replace function public.rib_challenge_create(
  p_game text, p_mode text, p_target_username text default null, p_network text default null
) returns public.challenges
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_target uuid; v_status text; v_cnt int; v_row public.challenges;
        v_network text := nullif(trim(coalesce(p_network, '')), '');
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  if p_game is null or char_length(trim(p_game)) < 1 then raise exception 'game is required' using hint = 'game_required'; end if;
  if v_network is not null and not public.rib_network_valid(v_network) then raise exception 'unknown network' using hint = 'invalid_network'; end if;
  if v_network is not null and not exists (select 1 from public.game_accounts where user_id = v_uid and network = v_network) then
    raise exception 'link your account for this network first' using hint = 'game_account_required';
  end if;
  perform public.rib_lock_user(v_uid);
  select count(*) into v_cnt from public.challenges where creator_id = v_uid and status in ('open','pending','active');
  if v_cnt >= 20 then raise exception 'too many live challenges (max 20)' using hint = 'too_many_open'; end if;

  if p_target_username is not null and char_length(trim(p_target_username)) > 0 then
    select id into v_target from public.profiles where lower(username) = lower(trim(p_target_username));
    if v_target is null then raise exception 'user not found' using hint = 'user_not_found'; end if;
    if v_target = v_uid then raise exception 'you cannot challenge yourself' using hint = 'cannot_challenge_self'; end if;
    v_status := 'pending';
  else
    v_status := 'open';
  end if;

  insert into public.challenges (creator_id, target_id, game, mode, stake_cents, status, network)
  values (v_uid, v_target, trim(p_game), coalesce(nullif(trim(p_mode), ''), '1v1'), 0, v_status, v_network)
  returning * into v_row;
  return v_row;
end;
$$;

-- The friendlies lobby also says which game account a friendly requires.
drop function if exists public.rib_open_challenges(text,bigint,bigint,timestamptz,int,uuid);
create or replace function public.rib_open_challenges(
  p_game text default null, p_min_cents bigint default null, p_max_cents bigint default null,
  p_before timestamptz default null, p_limit int default 30, p_before_id uuid default null
) returns table (id uuid, game text, mode text, stake_cents bigint, created_at timestamptz,
                 creator_id uuid, creator_username text, network text)
language sql stable security definer set search_path = ''
as $$
  select c.id, c.game, c.mode, c.stake_cents, c.created_at, c.creator_id, p.username, c.network
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

create or replace function public.rib_challenge_accept(p_challenge_id uuid)
returns public.challenges
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_c public.challenges; v_room uuid;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  select * into v_c from public.challenges where id = p_challenge_id for update;
  if v_c.id is null then raise exception 'challenge not found' using hint = 'challenge_not_found'; end if;
  if v_c.creator_id = v_uid then raise exception 'you cannot accept your own challenge' using hint = 'cannot_accept_own'; end if;
  if v_c.status not in ('open','pending') then raise exception 'this challenge is no longer available' using hint = 'challenge_unavailable'; end if;
  if v_c.status = 'pending' and v_c.target_id <> v_uid then
    raise exception 'this challenge is for another player' using hint = 'challenge_not_for_you';
  end if;
  if v_c.network is not null and not exists (select 1 from public.game_accounts where user_id = v_uid and network = v_c.network) then
    raise exception 'link your account for this network first' using hint = 'game_account_required';
  end if;

  insert into public.match_rooms (kind, game, network, player_a, player_b)
  values ('friendly', v_c.game, v_c.network, v_c.creator_id, v_uid) returning id into v_room;
  perform public.rib_room_open(v_room);
  update public.challenges set opponent_id = v_uid, status = 'active', matched_at = now(), room_id = v_room
   where id = v_c.id returning * into v_c;
  return v_c;
end;
$$;

create or replace function public.rib_challenge_cancel(p_challenge_id uuid)
returns public.challenges
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_c public.challenges;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  select * into v_c from public.challenges where id = p_challenge_id for update;
  if v_c.id is null then raise exception 'challenge not found' using hint = 'challenge_not_found'; end if;
  if v_c.creator_id <> v_uid then raise exception 'only the creator can cancel' using hint = 'only_creator_can_cancel'; end if;
  if v_c.status not in ('open','pending') then raise exception 'this challenge can no longer be cancelled' using hint = 'cannot_cancel'; end if;
  if v_c.stake_cents > 0 then
    perform public.rib_apply(v_uid, 'challenge_refund', v_c.stake_cents, -v_c.stake_cents, 'challenge', v_c.id, 'Challenge cancelled, entry fee refunded');
  end if;
  update public.challenges set status = 'cancelled' where id = v_c.id returning * into v_c;
  return v_c;
end;
$$;

-- ----------------------------------------------------------------------------
-- 10) Disputes (operators)
-- ----------------------------------------------------------------------------
create or replace function public.rib_ops_room_disputes()
returns table (
  id uuid, game text, network text, room_code text, tournament_id uuid, tournament_name text, round int,
  entry_fee_cents bigint, player_a uuid, a_username text, player_b uuid, b_username text,
  a_report uuid, b_report uuid, disputed_by uuid, dispute_reason text, dispute_deposit_cents bigint,
  disputed_at timestamptz, evidence_count bigint
)
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform public.rib_require_operator();
  return query
  select r.id, r.game, r.network, r.room_code, r.tournament_id, t.name, r.round, t.entry_fee_cents,
         r.player_a, pa.username, r.player_b, pb.username, r.a_report, r.b_report,
         r.disputed_by, r.dispute_reason, r.dispute_deposit_cents, r.disputed_at,
         (select count(*) from public.room_evidence e where e.room_id = r.id)
    from public.match_rooms r
    left join public.tournaments t on t.id = r.tournament_id
    left join public.profiles pa on pa.id = r.player_a
    left join public.profiles pb on pb.id = r.player_b
   where r.status = 'disputed'
   order by r.disputed_at
   limit 200;
end;
$$;

-- p_action: 'award' (p_winner advances) or 'void' (both are eliminated).
create or replace function public.rib_room_resolve(p_room_id uuid, p_action text, p_winner_id uuid default null, p_note text default null)
returns public.match_rooms
language plpgsql security definer set search_path = ''
as $$
declare v_r public.match_rooms; v_other uuid; v_dep bigint; v_loser uuid;
begin
  perform public.rib_require_operator();
  select * into v_r from public.match_rooms where id = p_room_id for update;
  if v_r.id is null then raise exception 'match not found' using hint = 'challenge_not_found'; end if;
  if v_r.status <> 'disputed' then raise exception 'this match is not in dispute' using hint = 'not_disputed'; end if;
  v_other := case when v_r.disputed_by = v_r.player_a then v_r.player_b else v_r.player_a end;
  v_dep   := coalesce(v_r.dispute_deposit_cents, 0);
  update public.match_rooms set resolved_by = auth.uid(), resolution_note = nullif(trim(coalesce(p_note, '')), '') where id = v_r.id;

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
    perform public.rib_rep_bump(v_loser, 0, 1, 0);   -- the losing side made a false claim
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

-- ----------------------------------------------------------------------------
-- 11) Sweep (every minute): ready checks, silent confirmations, stale events
-- ----------------------------------------------------------------------------
create or replace function public.rib_room_sweep(p_batch int default 500)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_r public.match_rooms; v_t public.tournaments; r record;
        v_ready int := 0; v_confirmed int := 0; v_stale int := 0; v_failed int := 0;
begin
  for v_r in
    select * from public.match_rooms where status = 'ready_check' and ready_deadline < now()
     order by ready_deadline limit p_batch for update skip locked
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
    select * from public.match_rooms where status = 'live' and confirm_deadline < now()
     order by confirm_deadline limit p_batch for update skip locked
  loop
    begin
      perform public.rib_room_finish(v_r.id, coalesce(v_r.a_report, v_r.b_report), false);
      v_confirmed := v_confirmed + 1;
    exception when others then
      v_failed := v_failed + 1;
      raise warning 'rib_room_sweep: confirm % failed: %', v_r.id, sqlerrm;
    end;
  end loop;

  -- Sit & go that never filled within 24 hours: refund everyone.
  for v_t in
    select * from public.tournaments where format = 'bracket' and status = 'open' and created_at < now() - interval '24 hours'
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
revoke execute on function public.rib_room_sweep(int) from public, anon, authenticated;
grant execute on function public.rib_room_sweep(int) to service_role;

-- Open friendlies expire after 24h; paid legacy rows no longer exist.
create or replace function public.rib_expire_stale(
  p_open_hours int default 24, p_idle_hours int default 48, p_batch int default 500
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_m public.game_matches;
  v_c public.challenges;
  v_open_games int := 0; v_open_challenges int := 0; v_idle_games int := 0; v_failed int := 0;
begin
  for v_m in
    select * from public.game_matches
     where status = 'open' and created_at < now() - make_interval(hours => p_open_hours)
     order by created_at limit p_batch for update skip locked
  loop
    begin
      if v_m.stake_cents > 0 then
        perform public.rib_apply(v_m.host_id, 'game_refund', v_m.stake_cents, -v_m.stake_cents, 'game', v_m.id, 'Open table expired, stake refunded');
      end if;
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
      if v_c.stake_cents > 0 then
        perform public.rib_apply(v_c.creator_id, 'challenge_refund', v_c.stake_cents, -v_c.stake_cents, 'challenge', v_c.id, 'Open challenge expired, entry fee refunded');
      end if;
      update public.challenges set status = 'cancelled', settled_at = now() where id = v_c.id;
      v_open_challenges := v_open_challenges + 1;
    exception when others then
      v_failed := v_failed + 1;
      raise warning 'rib_expire_stale: open challenge % failed: %', v_c.id, sqlerrm;
    end;
  end loop;

  for v_m in
    select * from public.game_matches
     where status in ('active','disputed') and turn_deadline is null
       and updated_at < now() - make_interval(hours => p_idle_hours)
     order by updated_at limit p_batch for update skip locked
  loop
    begin
      perform public.rib_lock_wallets(v_m.host_id, v_m.guest_id);
      if v_m.stake_cents > 0 then
        perform public.rib_apply(v_m.host_id, 'game_refund', v_m.stake_cents, -v_m.stake_cents, 'game', v_m.id, 'Match voided (inactivity), stake refunded');
      end if;
      if v_m.guest_id is not null and v_m.stake_cents > 0 then
        perform public.rib_apply(v_m.guest_id, 'game_refund', v_m.stake_cents, -v_m.stake_cents, 'game', v_m.id, 'Match voided (inactivity), stake refunded');
      end if;
      update public.game_matches set status = 'cancelled', settled_at = now() where id = v_m.id;
      v_idle_games := v_idle_games + 1;
    exception when others then
      v_failed := v_failed + 1;
      raise warning 'rib_expire_stale: idle match % failed: %', v_m.id, sqlerrm;
    end;
  end loop;

  return jsonb_build_object('open_games', v_open_games, 'open_challenges', v_open_challenges,
    'idle_games', v_idle_games, 'failed', v_failed);
end;
$$;
revoke execute on function public.rib_expire_stale(int,int,int) from public, anon, authenticated;
grant execute on function public.rib_expire_stale(int,int,int) to service_role;

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
    'checked_at', now()
  );
$$;
revoke execute on function public.rib_ops_health() from public, anon, authenticated;
grant execute on function public.rib_ops_health() to service_role;

-- ----------------------------------------------------------------------------
-- 11b) Built-in game tables are free friendlies: no entry fee, no prize.
-- Money paths stay guarded by stake_cents > 0 so older paid rows (refunded
-- below) can never move money twice.
-- ----------------------------------------------------------------------------
alter table public.game_matches drop constraint if exists game_matches_stake_cents_check;
alter table public.game_matches add constraint game_matches_stake_cents_check check (stake_cents between 0 and 100000);

create or replace function public.rib_game_create(
  p_game text, p_stake_cents bigint default 0, p_state jsonb default '{}'::jsonb
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
  if p_state is not null and octet_length(p_state::text) > 16384 then
    raise exception 'board state too large' using hint = 'state_too_large';
  end if;
  perform public.rib_lock_user(v_uid);
  select count(*) into v_cnt from public.game_matches where host_id = v_uid and status in ('open','active');
  if v_cnt >= 20 then raise exception 'too many active games (max 20)' using hint = 'too_many_open'; end if;

  insert into public.game_matches (game, host_id, stake_cents, status, state)
  values (p_game, v_uid, 0, 'open', coalesce(p_state, '{}'::jsonb))
  returning * into v_row;
  return v_row;
end;
$$;

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
  if v_m.stake_cents > 0 then
    perform public.rib_apply(v_uid, 'game_lock', -v_m.stake_cents, v_m.stake_cents, 'game', v_m.id, 'Stake locked');
  end if;
  update public.game_matches
     set guest_id = v_uid, status = 'active', matched_at = now(), turn_id = v_m.host_id,
         turn_deadline = now() + make_interval(secs => public.rib_turn_seconds()),
         state = coalesce(p_state, v_m.state)
   where id = v_m.id
   returning * into v_m;
  return v_m;
end;
$$;

create or replace function public.rib_game_award(p_match public.game_matches, p_winner uuid, p_memo text)
returns public.game_matches
language plpgsql security definer set search_path = ''
as $$
declare v_m public.game_matches; v_loser uuid;
begin
  if p_match.stake_cents > 0 then
    v_loser := case when p_winner = p_match.host_id then p_match.guest_id else p_match.host_id end;
    perform public.rib_lock_wallets(p_match.host_id, p_match.guest_id);
    perform public.rib_apply(p_winner, 'game_win', p_match.stake_cents * 2, -p_match.stake_cents, 'game', p_match.id, p_memo);
    perform public.rib_apply(v_loser, 'game_settled', 0, -p_match.stake_cents, 'game', p_match.id, 'Game lost (' || lower(p_memo) || ')');
  end if;
  update public.game_matches
     set status = 'settled', winner_id = p_winner, is_draw = false, turn_id = null, turn_deadline = null,
         move_seq = move_seq + 1, settled_at = now()
   where id = p_match.id
   returning * into v_m;
  return v_m;
end;
$$;

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

  if v_m.stake_cents > 0 then
    perform public.rib_lock_wallets(v_m.host_id, v_m.guest_id);
    if p_winner_id is null then
      perform public.rib_apply(v_m.host_id,  'game_refund', v_m.stake_cents, -v_m.stake_cents, 'game', v_m.id, 'Draw, stake refunded');
      perform public.rib_apply(v_m.guest_id, 'game_refund', v_m.stake_cents, -v_m.stake_cents, 'game', v_m.id, 'Draw, stake refunded');
    else
      v_loser := case when p_winner_id = v_m.host_id then v_m.guest_id else v_m.host_id end;
      perform public.rib_apply(p_winner_id, 'game_win',     v_m.stake_cents * 2, -v_m.stake_cents, 'game', v_m.id, 'Game won');
      perform public.rib_apply(v_loser,     'game_settled', 0,                   -v_m.stake_cents, 'game', v_m.id, 'Game lost');
    end if;
  end if;

  update public.game_matches
     set state = p_state, turn_id = null, turn_deadline = null, move_seq = move_seq + 1,
         status = 'settled', winner_id = p_winner_id, is_draw = (p_winner_id is null), settled_at = now()
   where id = v_m.id
   returning * into v_m;
  return v_m;
end;
$$;

create or replace function public.rib_game_cancel(p_match_id uuid)
returns public.game_matches
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_m public.game_matches;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  select * into v_m from public.game_matches where id = p_match_id for update;
  if v_m.id is null then raise exception 'match not found' using hint = 'match_not_found'; end if;
  if v_m.host_id <> v_uid then raise exception 'only the host can cancel' using hint = 'cannot_cancel'; end if;
  if v_m.status <> 'open' then raise exception 'this match can no longer be cancelled' using hint = 'cannot_cancel'; end if;
  if v_m.stake_cents > 0 then
    perform public.rib_apply(v_uid, 'game_refund', v_m.stake_cents, -v_m.stake_cents, 'game', v_m.id, 'Match cancelled, refunded');
  end if;
  update public.game_matches set status = 'cancelled' where id = v_m.id returning * into v_m;
  return v_m;
end;
$$;

-- ----------------------------------------------------------------------------
-- 11c) Ranking = tournaments: net rcoin (prizes minus entry fees) from the
-- ledger, and the record (wins/losses) of confirmed tournament matches.
-- ----------------------------------------------------------------------------
create or replace function public.rib_play_delta(p_kind text, p_amount bigint,
  out net bigint, out won bigint, out win int, out loss int)
language sql immutable set search_path = ''
as $$
  select
    case when p_kind in ('tournament_entry','tournament_prize','tournament_refund') then p_amount else 0 end,
    case when p_kind = 'tournament_prize' then p_amount else 0 end,
    0,
    0;
$$;
revoke execute on function public.rib_play_delta(text,bigint) from public, anon, authenticated;

create or replace function public.rib_stats_record(p_uid uuid, p_win int, p_loss int)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.player_stats as s (user_id, net_cents, won_cents, wins, losses)
  values (p_uid, 0, 0, p_win, p_loss)
  on conflict (user_id) do update set wins = s.wins + excluded.wins, losses = s.losses + excluded.losses, updated_at = now();
  insert into public.player_stats_weekly as w (week_start, user_id, net_cents, won_cents, wins, losses)
  values (public.rib_week_start(now()), p_uid, 0, 0, p_win, p_loss)
  on conflict (week_start, user_id) do update set wins = w.wins + excluded.wins, losses = w.losses + excluded.losses;
$$;
revoke execute on function public.rib_stats_record(uuid,int,int) from public, anon, authenticated;

-- One-time rebuild of the ranking on the tournament definition.
do $$
begin
  if exists (select 1 from public.platform_settings where key = 'player_stats_tournaments') then
    return;
  end if;
  delete from public.player_stats;
  delete from public.player_stats_weekly;
  insert into public.player_stats (user_id, net_cents, won_cents, wins, losses)
  select l.user_id, sum(d.net), sum(d.won), 0, 0
    from public.wallet_ledger l, lateral public.rib_play_delta(l.kind, l.amount_cents) d
   group by l.user_id
  having sum(abs(d.net)) > 0;
  insert into public.player_stats_weekly (week_start, user_id, net_cents, won_cents, wins, losses)
  select public.rib_week_start(l.created_at), l.user_id, sum(d.net), sum(d.won), 0, 0
    from public.wallet_ledger l, lateral public.rib_play_delta(l.kind, l.amount_cents) d
   group by 1, 2
  having sum(abs(d.net)) > 0;
  insert into public.platform_settings (key, value) values ('player_stats_tournaments', to_jsonb(now()));
end;
$$;

-- ----------------------------------------------------------------------------
-- 12) Test-mode clean-up: close paid challenges and old-format tournaments
-- ----------------------------------------------------------------------------
do $$
declare v_c public.challenges; v_t public.tournaments; v_g public.game_matches; r record;
begin
  for v_c in select * from public.challenges
              where stake_cents > 0 and status in ('open','pending','active','disputed') order by id for update loop
    perform public.rib_apply(v_c.creator_id, 'challenge_refund', v_c.stake_cents, -v_c.stake_cents, 'challenge', v_c.id, 'Paid challenges ended: entry fee refunded');
    if v_c.opponent_id is not null and v_c.status in ('active','disputed') then
      perform public.rib_apply(v_c.opponent_id, 'challenge_refund', v_c.stake_cents, -v_c.stake_cents, 'challenge', v_c.id, 'Paid challenges ended: entry fee refunded');
    end if;
    update public.challenges set status = 'cancelled', settled_at = now() where id = v_c.id;
  end loop;

  for v_t in select * from public.tournaments
              where format = 'legacy' and status in ('open','full','active') order by id for update loop
    if v_t.entry_fee_cents > 0 then
      for r in select user_id from public.tournament_entries where tournament_id = v_t.id order by user_id loop
        perform public.rib_apply(r.user_id, 'tournament_refund', v_t.entry_fee_cents, 0, 'tournament', v_t.id, 'Tournament format changed, entry refunded');
      end loop;
    end if;
    update public.tournaments set status = 'cancelled', prize_pool_cents = 0, finished_at = now() where id = v_t.id;
  end loop;

  -- Paid game tables: refund every held stake; open tables and games in
  -- progress carry on as free friendlies.
  for v_g in select * from public.game_matches
              where stake_cents > 0 and status in ('open','active','disputed') order by id for update loop
    perform public.rib_apply(v_g.host_id, 'game_refund', v_g.stake_cents, -v_g.stake_cents, 'game', v_g.id, 'Tables are free now: stake refunded');
    if v_g.guest_id is not null and v_g.status in ('active','disputed') then
      perform public.rib_apply(v_g.guest_id, 'game_refund', v_g.stake_cents, -v_g.stake_cents, 'game', v_g.id, 'Tables are free now: stake refunded');
    end if;
    update public.game_matches set stake_cents = 0 where id = v_g.id;
  end loop;
end;
$$;

-- ----------------------------------------------------------------------------
-- 13) Grants and schedule
-- ----------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'rib_network_valid(text)', 'rib_game_account_set(text,text)', 'rib_game_account_remove(text)', 'rib_is_operator()', 'rib_can_see_room(uuid)',
    'rib_player_reputation(uuid)', 'rib_tournament_rounds(int)', 'rib_platform_fee_percent()', 'rib_tournament_min_entrants()',
    'rib_room_ready(uuid)', 'rib_room_report(uuid,uuid)', 'rib_room_dispute(uuid,text)', 'rib_room_message(uuid,text)',
    'rib_room_evidence_token(uuid)', 'rib_room_evidence_add(uuid,text,text,text,text)', 'rib_room_info(uuid)', 'rib_my_rooms()',
    'rib_tournament_create(text,text,bigint,int,text)', 'rib_tournament_join(uuid)', 'rib_tournament_leave(uuid)',
    'rib_open_tournaments(text,int,int)', 'rib_my_tournaments(int)', 'rib_tournament_bracket(uuid)',
    'rib_challenge_create(text,text,text,text)', 'rib_challenge_accept(uuid)', 'rib_challenge_cancel(uuid)',
    'rib_open_challenges(text,bigint,bigint,timestamptz,int,uuid)',
    'rib_ops_room_disputes()', 'rib_room_resolve(uuid,text,uuid,text)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end;
$$;
grant execute on function public.rib_ops_room_disputes() to service_role;
grant execute on function public.rib_room_resolve(uuid,text,uuid,text) to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('rib-room-sweep', '* * * * *', 'select public.rib_room_sweep()');
  else
    raise warning 'pg_cron not installed: schedule rib_room_sweep() every minute externally';
  end if;
end;
$$;
