-- ============================================================================
-- Runinback — Wild Rift tournament engine (2026-09-29).
-- Contract: docs/wild-rift-engine.md ("Database").
--
-- Runinback runs Wild Rift tournaments only (network: riot). Wild Rift has no
-- public results API, so results are proven by the players. An automatic read
-- of the end-of-match screen (Edge Function verify-result) can only shorten
-- the confirm window or flag a room for review: a screenshot never settles,
-- voids or disputes a room by itself (images can be forged or replayed).
--
--   1) Rules as functions: the game, the ready (5 min), confirm (10 min) and
--      verified-confirm (3 min) windows, the check confidence (0.90), the
--      Quick Play tiers and the Riot ID format (same rules as the JS).
--   2) Riot accounts: every tournament needs a linked Riot ID (Name#TAG),
--      unique case-insensitively. It can't change while the player has an
--      open or active entry or a live room. Rooms snapshot both Riot IDs when
--      they open. The service role pins the puuid (account-v1).
--   3) Tournaments: custom ones are forced to Wild Rift / riot. Quick Play
--      (rib_quick_join) fills the oldest open event of a tier (SKIP LOCKED,
--      then a per-tier lock so concurrent joins don't fragment the tier).
--      tournaments.entrants is kept under the row lock. Every entry path
--      checks the account, the rate limit and one open entry per tier.
--   4) Evidence: a screenshot already used in another room is refused (client
--      hash) or marked duplicate (hash of the stored bytes). Players read
--      only the non-sensitive evidence columns.
--   5) Realtime: room_evidence (check results) and tournaments (fill).
--   6) Test-mode clean-up: open tournaments of other games are refunded and
--      cancelled (rcoin is simulated); finished history stays.
--   7) Operators: automatic reviews; my tournaments carry the tier.
-- Idempotent: constraints are added NOT VALID + VALIDATE only when missing.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Rules
-- ----------------------------------------------------------------------------
create or replace function public.rib_wild_rift_game()
returns text language sql immutable set search_path = '' as $$ select 'Wild Rift'::text $$;

create or replace function public.rib_ready_window()
returns interval language sql immutable set search_path = '' as $$ select interval '5 minutes' $$;

create or replace function public.rib_confirm_window()
returns interval language sql immutable set search_path = '' as $$ select interval '10 minutes' $$;

-- Confirm window after a clear screenshot that agrees with the uploader's report.
create or replace function public.rib_verified_confirm_window()
returns interval language sql immutable set search_path = '' as $$ select interval '3 minutes' $$;

create or replace function public.rib_auto_settle_confidence()
returns numeric language sql immutable set search_path = '' as $$ select 0.90::numeric $$;

-- Quick Play tiers: entry fee (cents) x size. Mirror of the tier grid in the console.
create or replace function public.rib_quick_fees()
returns bigint[] language sql immutable set search_path = '' as $$ select array[0, 100, 500, 1000, 2500, 5000]::bigint[] $$;

create or replace function public.rib_quick_tier_valid(p_entry_fee_cents bigint, p_size int)
returns boolean language sql immutable set search_path = ''
as $$ select coalesce(p_entry_fee_cents = any (public.rib_quick_fees()) and p_size in (4, 8), false) $$;

-- Riot ID, same rules as parseRiotId (src/scripts/lib/wild-rift.js) and
-- validateRiotId (supabase/functions/_shared/riot-id.js):
--   canonical form: NFC, "<name>#<tag>", each part trimmed of whitespace;
--   name: 3-16 code points, no '#', no control/format/private-use/unassigned
--         characters (\p{C}: zero-width and bidi marks included);
--   tag:  3-5 letters or digits.
-- Letters use the builtin, locale-independent pg_c_utf8 classes (PostgreSQL
-- 17+); on older servers the tag falls back to ASCII letters and digits.
create or replace function public.rib_riot_id_normalize(p_handle text)
returns text language plpgsql immutable set search_path = ''
as $$
declare v text := normalize(coalesce(p_handle, ''), nfc); v_cut int;
        -- JavaScript String.prototype.trim() whitespace.
        v_ws constant text := E' \t\n\r\u000b\u000c\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
begin
  v := btrim(v, v_ws);
  v_cut := char_length(v) - strpos(reverse(v), '#') + 1;   -- last '#', like parseRiotId
  if strpos(v, '#') = 0 then return v; end if;
  return btrim(left(v, v_cut - 1), v_ws) || '#' || btrim(substr(v, v_cut + 1), v_ws);
end;
$$;

do $do$
declare v_tag text; v_assigned text;
begin
  if exists (select 1 from pg_collation where collname = 'pg_c_utf8') then
    v_tag := $q$(split_part(p_handle, '#', 2) collate "pg_c_utf8") ~ '^[[:alnum:]]{3,5}$'$q$;
  else
    v_tag := $q$split_part(p_handle, '#', 2) ~ '^[0-9A-Za-z]{3,5}$'$q$;
  end if;
  if current_setting('server_version_num')::int >= 170000 then
    v_assigned := $q$unicode_assigned(p_handle)$q$;
  else
    v_assigned := 'true';
  end if;
  execute format($f$
    create or replace function public.rib_riot_id_valid(p_handle text)
    returns boolean language sql immutable set search_path = ''
    as $b$
      select coalesce(
        p_handle ~ '^[^#]+#[^#]+$'
        and char_length(split_part(p_handle, '#', 1)) between 3 and 16
        and split_part(p_handle, '#', 1) !~ E'[\u0001-\u001f\u007f-\u009f\u00ad\u0600-\u0605\u061c\u06dd\u070f\u0890-\u0891\u08e2\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb\ue000-\uf8ff\U000110bd\U000110cd\U00013430-\U0001343f\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0001\U000e0020-\U000e007f\U000f0000-\U000ffffd\U00100000-\U0010fffd]'
        and %s
        and %s,
        false)
    $b$
  $f$, v_tag, v_assigned);
end;
$do$;

-- ----------------------------------------------------------------------------
-- 2) Columns, indexes, constraints
-- ----------------------------------------------------------------------------
-- Riot accounts.
alter table public.game_accounts add column if not exists riot_puuid  text;
alter table public.game_accounts add column if not exists verified_at timestamptz;

-- A Riot ID belongs to one player: keep the earliest link of any duplicate.
delete from public.game_accounts g
 using public.game_accounts k
 where g.network = 'riot' and k.network = 'riot'
   and lower(g.handle) = lower(k.handle) and g.user_id <> k.user_id
   and (k.created_at, k.user_id) < (g.created_at, g.user_id);
create unique index if not exists game_accounts_riot_handle_key on public.game_accounts (lower(handle)) where network = 'riot';
create unique index if not exists game_accounts_riot_puuid_key on public.game_accounts (riot_puuid) where riot_puuid is not null;

-- Tournaments.
alter table public.tournaments add column if not exists tier_key text;
alter table public.tournaments add column if not exists entrants int not null default 0;
update public.tournaments t set entrants = c.n
  from (select tournament_id, count(*)::int as n from public.tournament_entries group by tournament_id) c
 where c.tournament_id = t.id and t.entrants is distinct from c.n;
create index if not exists tournaments_quick_open_idx on public.tournaments (tier_key, created_at)
  where status = 'open' and tier_key is not null;
-- The custom-event cap (5 open per creator) without walking a creator's history.
create index if not exists tournaments_creator_open_idx on public.tournaments (creator_id)
  where status = 'open' and tier_key is null;
-- A player's recent entries (open-tier check, my tournaments).
create index if not exists tournament_entries_user_recent_idx on public.tournament_entries (user_id, created_at desc);
-- Prize lookups per player and tournament (rib_my_tournaments).
create index if not exists wallet_ledger_prize_idx on public.wallet_ledger (user_id, ref_id) where kind = 'tournament_prize';

-- Rooms.
alter table public.match_rooms drop column if exists auto_settled;   -- earlier draft of this migration
alter table public.match_rooms add column if not exists fast_tracked boolean not null default false;
alter table public.match_rooms add column if not exists review_flag  boolean not null default false;
alter table public.match_rooms add column if not exists a_riot_id    text;
alter table public.match_rooms add column if not exists b_riot_id    text;
create index if not exists match_rooms_review_idx on public.match_rooms (disputed_at) where status = 'disputed' and review_flag;

-- Evidence. Rows from before the automatic check read 'skipped' (the column
-- default at add time, metadata only); new rows start 'pending'.
alter table public.room_evidence add column if not exists check_status text not null default 'skipped';
alter table public.room_evidence alter column check_status set default 'pending';
alter table public.room_evidence add column if not exists check_winner     uuid references auth.users (id) on delete set null;
alter table public.room_evidence add column if not exists check_confidence numeric(4,3);
alter table public.room_evidence add column if not exists check_detail     jsonb;
alter table public.room_evidence add column if not exists checked_at       timestamptz;
alter table public.room_evidence add column if not exists content_sha256   text;
drop index if exists public.room_evidence_sha256_idx;   -- earlier draft
create index if not exists room_evidence_sha256_room_idx on public.room_evidence (sha256, room_id);
create index if not exists room_evidence_content_sha256_idx on public.room_evidence (content_sha256) where content_sha256 is not null;
create index if not exists room_evidence_check_winner_idx on public.room_evidence (check_winner) where check_winner is not null;
create index if not exists room_evidence_user_idx on public.room_evidence (user_id) where user_id is not null;

do $$
declare c record;
begin
  for c in
    select * from (values
      ('public.game_accounts'::regclass, 'game_accounts_riot_puuid_check',
       $c$check (riot_puuid is null or (network = 'riot' and char_length(riot_puuid) between 1 and 128))$c$),
      ('public.tournaments'::regclass, 'tournaments_tier_key_check',
       $c$check (tier_key is null or tier_key = entry_fee_cents::text || ':' || max_players::text)$c$),
      ('public.tournaments'::regclass, 'tournaments_entrants_check',
       $c$check (entrants >= 0)$c$),
      ('public.room_evidence'::regclass, 'room_evidence_check_status_check',
       $c$check (check_status in ('pending','verified','contradicts','unreadable','duplicate','skipped'))$c$),
      ('public.room_evidence'::regclass, 'room_evidence_check_confidence_check',
       $c$check (check_confidence is null or check_confidence between 0 and 1)$c$),
      ('public.room_evidence'::regclass, 'room_evidence_content_sha256_check',
       $c$check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$')$c$)
    ) v (tbl, name, def)
  loop
    if not exists (select 1 from pg_constraint where conrelid = c.tbl and conname = c.name) then
      execute format('alter table %s add constraint %I %s not valid', c.tbl, c.name, c.def);
      execute format('alter table %s validate constraint %I', c.tbl, c.name);
    end if;
  end loop;
end;
$$;

-- Players read the evidence list, not the hashes or the checker's output.
revoke all on public.room_evidence from authenticated;
grant select (id, room_id, user_id, storage_path, source, created_at, check_status, checked_at)
  on public.room_evidence to authenticated;

-- ----------------------------------------------------------------------------
-- 3) Rooms: windows and Riot ID snapshot
-- ----------------------------------------------------------------------------
create or replace function public.rib_riot_handle(p_uid uuid)
returns text language sql stable security definer set search_path = ''
as $$ select handle from public.game_accounts where user_id = p_uid and network = 'riot' $$;

-- Both players are known: hand out the lobby details, snapshot the Riot IDs
-- and start the ready check.
create or replace function public.rib_room_open(p_room_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_code text := public.rib_room_code();
begin
  update public.match_rooms r
     set status = 'ready_check', room_code = v_code, lobby_name = 'Runinback ' || v_code,
         lobby_password = lower(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
         a_riot_id = public.rib_riot_handle(r.player_a), b_riot_id = public.rib_riot_handle(r.player_b),
         ready_deadline = now() + public.rib_ready_window(), updated_at = now()
   where r.id = p_room_id and r.status = 'waiting';
end;
$$;

-- Same as 0022, plus the Riot ID snapshot of the player moved up.
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
      update public.match_rooms set player_a = v_r.winner_id, a_riot_id = public.rib_riot_handle(v_r.winner_id), updated_at = now()
       where tournament_id = v_t.id and round = v_r.round + 1 and slot = v_r.slot / 2;
    else
      update public.match_rooms set player_b = v_r.winner_id, b_riot_id = public.rib_riot_handle(v_r.winner_id), updated_at = now()
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

-- The first report opens the confirm window (silence confirms); a matching
-- report settles at once; a different winner has to go through a dispute.
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
    update public.match_rooms set first_report_at = now(), confirm_deadline = now() + public.rib_confirm_window(), updated_at = now()
     where id = v_r.id;
  end if;
  select * into v_r from public.match_rooms where id = v_r.id;
  return v_r;
end;
$$;

-- ----------------------------------------------------------------------------
-- 4) Riot accounts
-- ----------------------------------------------------------------------------
-- The Riot ID is part of the player's identity in their live events and rooms.
create or replace function public.rib_riot_id_locked(p_uid uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.match_rooms where player_a = p_uid and status in ('ready_check','live','disputed'))
      or exists (select 1 from public.match_rooms where player_b = p_uid and status in ('ready_check','live','disputed'))
      or exists (select 1 from public.tournament_entries e join public.tournaments t on t.id = e.tournament_id
                  where e.user_id = p_uid and t.status in ('open','active'));
$$;

-- Checks shared by the player (set) and the service role (verified) paths.
-- A case-only change is not a change.
create or replace function public.rib_riot_id_change_check(p_uid uuid, p_handle text)
returns void
language plpgsql stable security definer set search_path = ''
as $$
declare v_current text := public.rib_riot_handle(p_uid);
begin
  if v_current is not null and lower(v_current) = lower(p_handle) then return; end if;
  if exists (select 1 from public.game_accounts
              where network = 'riot' and lower(handle) = lower(p_handle) and user_id <> p_uid) then
    raise exception 'this Riot ID is linked to another player' using hint = 'riot_account_taken';
  end if;
  if public.rib_riot_id_locked(p_uid) then
    raise exception 'your Riot ID can''t change during a tournament or match' using hint = 'riot_id_locked';
  end if;
end;
$$;

-- A different handle drops the verification (a case-only change keeps it).
create or replace function public.rib_game_account_set(p_network text, p_handle text)
returns public.game_accounts
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_row public.game_accounts; v_handle text := trim(coalesce(p_handle, ''));
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  if not public.rib_network_valid(p_network) then raise exception 'unknown network' using hint = 'invalid_network'; end if;
  if p_network = 'riot' then
    v_handle := public.rib_riot_id_normalize(v_handle);
    if not public.rib_riot_id_valid(v_handle) then
      raise exception 'enter your Riot ID as Name#TAG' using hint = 'invalid_riot_id';
    end if;
    perform public.rib_lock_user(v_uid);
    perform public.rib_riot_id_change_check(v_uid, v_handle);
  end if;
  if char_length(v_handle) < 2 or char_length(v_handle) > 64 then
    raise exception 'enter the handle you use in the game' using hint = 'invalid_handle';
  end if;
  begin
    insert into public.game_accounts as g (user_id, network, handle)
    values (v_uid, p_network, v_handle)
    on conflict (user_id, network) do update
       set handle      = excluded.handle,
           riot_puuid  = case when lower(g.handle) = lower(excluded.handle) then g.riot_puuid end,
           verified_at = case when lower(g.handle) = lower(excluded.handle) then g.verified_at end,
           updated_at  = now()
    returning * into v_row;
  exception when unique_violation then
    raise exception 'this Riot ID is linked to another player' using hint = 'riot_account_taken';
  end;
  return v_row;
end;
$$;

-- Service role (Edge Function riot-account) after Riot account-v1 answered
-- 200: pin the puuid and store the canonical Riot ID.
create or replace function public.rib_riot_account_verified(p_user_id uuid, p_puuid text, p_game_name text, p_tag_line text)
returns public.game_accounts
language plpgsql security definer set search_path = ''
as $$
declare v_row public.game_accounts; v_puuid text := trim(coalesce(p_puuid, ''));
        v_handle text := public.rib_riot_id_normalize(coalesce(p_game_name, '') || '#' || ltrim(coalesce(p_tag_line, ''), '#'));
begin
  if p_user_id is null or not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'user not found' using hint = 'user_not_found';
  end if;
  if char_length(v_puuid) < 1 or char_length(v_puuid) > 128 or not public.rib_riot_id_valid(v_handle) then
    raise exception 'invalid Riot account' using hint = 'invalid_riot_id';
  end if;
  perform public.rib_lock_user(p_user_id);
  perform public.rib_riot_id_change_check(p_user_id, v_handle);
  if exists (select 1 from public.game_accounts where riot_puuid = v_puuid and user_id <> p_user_id) then
    raise exception 'this Riot account is linked to another player' using hint = 'riot_account_taken';
  end if;
  begin
    insert into public.game_accounts (user_id, network, handle, riot_puuid, verified_at)
    values (p_user_id, 'riot', v_handle, v_puuid, now())
    on conflict (user_id, network) do update
       set handle = excluded.handle, riot_puuid = excluded.riot_puuid, verified_at = excluded.verified_at, updated_at = now()
    returning * into v_row;
  exception when unique_violation then
    raise exception 'this Riot account is linked to another player' using hint = 'riot_account_taken';
  end;
  return v_row;
end;
$$;

-- ----------------------------------------------------------------------------
-- 5) Tournaments: Wild Rift only, Quick Play tiers
-- ----------------------------------------------------------------------------
create or replace function public.rib_require_riot_account(p_uid uuid)
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not exists (select 1 from public.game_accounts where user_id = p_uid and network = 'riot') then
    raise exception 'link your Riot ID first' using hint = 'riot_account_required';
  end if;
end;
$$;

-- Checks every entry path makes before touching a tournament row.
create or replace function public.rib_entry_precheck(p_uid uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  perform public.rib_assert_open_account(p_uid);
  if not public.rib_rate_limit_hit('tournament_entry', p_uid, 30, 60) then
    raise exception 'slow down: too many entries' using hint = 'rate_limited';
  end if;
end;
$$;

-- One open Quick Play entry per tier, read from the player's side: open
-- events are cancelled by the sweep after 24 hours, so only the player's
-- entries of the last two days can still be open.
create or replace function public.rib_assert_not_queued(p_uid uuid, p_tier_key text)
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if p_tier_key is null then return; end if;
  if exists (select 1 from public.tournament_entries e
               join public.tournaments t on t.id = e.tournament_id
              where e.user_id = p_uid and e.created_at > now() - interval '2 days'
                and t.tier_key = p_tier_key and t.status = 'open') then
    raise exception 'you are already waiting in this tier' using hint = 'already_queued';
  end if;
end;
$$;

-- Enter a tournament whose row the caller holds FOR UPDATE, after the entry
-- checks: one open entry per tier, charge the entry fee, register, keep the
-- entrant count, start the bracket when full.
create or replace function public.rib_tournament_enter(p_tournament_id uuid, p_uid uuid)
returns public.tournaments
language plpgsql security definer set search_path = ''
as $$
declare v_t public.tournaments;
begin
  select * into v_t from public.tournaments where id = p_tournament_id;
  perform public.rib_lock_user(p_uid);
  perform public.rib_assert_not_queued(p_uid, v_t.tier_key);
  if v_t.entry_fee_cents > 0 then
    perform public.rib_apply(p_uid, 'tournament_entry', -v_t.entry_fee_cents, 0, 'tournament', v_t.id, 'Tournament entry');
  end if;
  insert into public.tournament_entries (tournament_id, user_id) values (v_t.id, p_uid);
  update public.tournaments
     set prize_pool_cents = prize_pool_cents + v_t.entry_fee_cents, entrants = entrants + 1
   where id = v_t.id
  returning * into v_t;
  if v_t.entrants >= v_t.max_players then
    perform public.rib_tournament_start(v_t.id);
    select * into v_t from public.tournaments where id = v_t.id;
  end if;
  return v_t;
end;
$$;

-- Lock order on every entry path: the player (advisory), then the tournament row.
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
  if v_t.format <> 'bracket' or v_t.status <> 'open' then raise exception 'registration is closed' using hint = 'registration_closed'; end if;
  if exists (select 1 from public.tournament_entries where tournament_id = v_t.id and user_id = v_uid) then
    raise exception 'already registered' using hint = 'already_registered';
  end if;
  perform public.rib_require_riot_account(v_uid);
  perform public.rib_paid_entry_limits(v_uid, v_t.entry_fee_cents);
  return public.rib_tournament_enter(v_t.id, v_uid);
end;
$$;

-- Custom sit & go: always Wild Rift on riot (p_game / p_network are kept for
-- compatibility and ignored). The creator is the first entrant.
create or replace function public.rib_tournament_create(
  p_name text, p_game text, p_entry_fee_cents bigint, p_size int, p_network text default null
) returns public.tournaments
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_t public.tournaments; v_live int;
begin
  perform public.rib_entry_precheck(v_uid);
  if p_name is null or char_length(trim(p_name)) < 1 or char_length(trim(p_name)) > 80 then
    raise exception 'name is required' using hint = 'tournament_name_required';
  end if;
  if p_size is null or p_size not in (4, 8) then raise exception 'tournaments have 4 or 8 players' using hint = 'invalid_tournament_size'; end if;
  if p_entry_fee_cents is null or not (p_entry_fee_cents = 0 or p_entry_fee_cents between 100 and 50000) then
    raise exception 'the entry fee must be 0 or between 1 and 500 rcoin' using hint = 'invalid_entry_fee';
  end if;
  perform public.rib_require_riot_account(v_uid);

  perform public.rib_lock_user(v_uid);
  select count(*) into v_live from public.tournaments where creator_id = v_uid and status = 'open' and tier_key is null;
  if v_live >= 5 then raise exception 'too many open tournaments (max 5)' using hint = 'too_many_open'; end if;
  perform public.rib_paid_entry_limits(v_uid, p_entry_fee_cents);

  insert into public.tournaments (creator_id, name, game, entry_fee_cents, max_players, status, format, network)
  values (v_uid, trim(p_name), public.rib_wild_rift_game(), p_entry_fee_cents, p_size, 'open', 'bracket', 'riot')
  returning * into v_t;
  return public.rib_tournament_enter(v_t.id, v_uid);
end;
$$;

-- Quick Play: the oldest open event of the tier that nobody else is joining
-- right now (SKIP LOCKED). If every open event is busy, one joiner per tier
-- (advisory lock) opens a new event and the others wait for the oldest one
-- instead of each opening their own.
create or replace function public.rib_quick_join(p_entry_fee_cents bigint, p_size int)
returns public.tournaments
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_key text; v_t public.tournaments; v_found boolean;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  if not public.rib_quick_tier_valid(p_entry_fee_cents, p_size) then
    raise exception 'pick one of the Quick Play tiers' using hint = 'invalid_tier';
  end if;
  perform public.rib_entry_precheck(v_uid);
  perform public.rib_require_riot_account(v_uid);
  v_key := p_entry_fee_cents::text || ':' || p_size::text;

  perform public.rib_lock_user(v_uid);
  perform public.rib_assert_not_queued(v_uid, v_key);
  perform public.rib_paid_entry_limits(v_uid, p_entry_fee_cents);

  select * into v_t from public.tournaments
   where tier_key = v_key and status = 'open'
   order by created_at
   limit 1
   for update skip locked;
  v_found := v_t.id is not null;

  if not v_found then
    if not pg_try_advisory_xact_lock(hashtextextended('rib_tier:' || v_key, 0)) then
      -- Someone else is opening an event for this tier: wait for the oldest open one.
      select * into v_t from public.tournaments
       where tier_key = v_key and status = 'open'
       order by created_at
       limit 1
       for update;
      v_found := v_t.id is not null and v_t.status = 'open' and v_t.entrants < v_t.max_players;
    end if;
  end if;

  if not v_found then
    insert into public.tournaments (creator_id, name, game, entry_fee_cents, max_players, status, format, network, tier_key)
    values (v_uid,
            'Wild Rift ' || p_size || ' · ' || case when p_entry_fee_cents = 0 then 'Free' else (p_entry_fee_cents / 100)::text || ' rcoin' end,
            public.rib_wild_rift_game(), p_entry_fee_cents, p_size, 'open', 'bracket', 'riot', v_key)
    returning * into v_t;
  end if;
  return public.rib_tournament_enter(v_t.id, v_uid);
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
  delete from public.tournament_entries where tournament_id = v_t.id and user_id = v_uid;
  if not found then raise exception 'you are not registered' using hint = 'not_an_entrant'; end if;
  if v_t.entry_fee_cents > 0 then
    perform public.rib_apply(v_uid, 'tournament_refund', v_t.entry_fee_cents, 0, 'tournament', v_t.id, 'Left the tournament, entry refunded');
  end if;
  update public.tournaments
     set prize_pool_cents = prize_pool_cents - v_t.entry_fee_cents,
         entrants = greatest(entrants - 1, 0),
         status = case when entrants <= 1 then 'cancelled' else status end,
         finished_at = case when entrants <= 1 then now() else finished_at end
   where id = v_t.id
  returning * into v_t;
  return v_t;
end;
$$;

-- Play screen: every tier with players waiting and open events. One grouped
-- read of the open Quick Play events (tournaments_quick_open_idx).
create or replace function public.rib_quick_tiers()
returns table (entry_fee_cents bigint, size int, waiting int, open_events int)
language sql stable security definer set search_path = ''
as $$
  with open_events as (
    select t.tier_key, count(*)::int as events, sum(t.entrants)::int as waiting
      from public.tournaments t
     where t.status = 'open' and t.tier_key is not null
     group by t.tier_key
  )
  select f.fee, s.size, coalesce(o.waiting, 0), coalesce(o.events, 0)
    from unnest(public.rib_quick_fees()) as f(fee)
   cross join unnest(array[4, 8]) as s(size)
    left join open_events o on o.tier_key = f.fee::text || ':' || s.size::text
   order by s.size, f.fee;
$$;

-- ----------------------------------------------------------------------------
-- 6) Evidence: duplicates and the automatic check
-- ----------------------------------------------------------------------------
create or replace function public.rib_room_evidence_add(p_room_id uuid, p_token text, p_path text, p_sha256 text, p_source text)
returns public.room_evidence
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_t public.room_evidence_tokens; v_row public.room_evidence; v_cnt int;
        v_sha text := lower(coalesce(p_sha256, ''));
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  select * into v_t from public.room_evidence_tokens
   where token = upper(coalesce(p_token, '')) and room_id = p_room_id and user_id = v_uid for update;
  -- The capture token lives 15 minutes (independent of the room windows).
  if v_t.token is null or v_t.used_at is not null or v_t.issued_at < now() - interval '15 minutes' then
    raise exception 'this capture expired: take it again' using hint = 'evidence_token_invalid';
  end if;
  if p_path is null or p_path not like p_room_id::text || '/' || v_uid::text || '/%'
     or v_sha !~ '^[0-9a-f]{64}$' or p_source not in ('screen','camera') then
    raise exception 'invalid evidence file' using hint = 'evidence_invalid';
  end if;
  -- Same file in another room = a recycled screenshot. The lock makes two
  -- rooms racing with the same file see each other.
  perform pg_advisory_xact_lock(hashtextextended('rib_evidence:' || v_sha, 0));
  if exists (select 1 from public.room_evidence where sha256 = v_sha and room_id <> p_room_id)
     or exists (select 1 from public.room_evidence where content_sha256 = v_sha and room_id <> p_room_id) then
    raise exception 'this screenshot was already used in another match' using hint = 'evidence_duplicate';
  end if;
  select count(*) into v_cnt from public.room_evidence where room_id = p_room_id and user_id = v_uid;
  if v_cnt >= 10 then raise exception 'up to 10 captures per player' using hint = 'evidence_limit'; end if;
  update public.room_evidence_tokens set used_at = now() where token = v_t.token;
  insert into public.room_evidence (room_id, user_id, storage_path, sha256, token, source)
  values (p_room_id, v_uid, p_path, v_sha, v_t.token, p_source)
  returning * into v_row;
  return v_row;
end;
$$;

-- Service role (Edge Function verify-result): what the checker needs. The
-- Riot IDs are the snapshot taken when the room opened. Null when the
-- capture doesn't exist.
create or replace function public.rib_evidence_for_check(p_evidence_id bigint)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'evidence_id',   e.id,
    'room_id',       r.id,
    'room_status',   r.status,
    'room_kind',     r.kind,
    'tournament_id', r.tournament_id,
    'fast_tracked',  r.fast_tracked,
    'uploader_id',   e.user_id,
    'storage_path',  e.storage_path,
    'sha256',        e.sha256,
    'source',        e.source,
    'check_status',  e.check_status,
    'player_a', jsonb_build_object('id', r.player_a, 'username', pa.username, 'riot_id', r.a_riot_id,
                                   'riot_verified', ga.verified_at is not null and lower(ga.handle) = lower(r.a_riot_id)),
    'player_b', jsonb_build_object('id', r.player_b, 'username', pb.username, 'riot_id', r.b_riot_id,
                                   'riot_verified', gb.verified_at is not null and lower(gb.handle) = lower(r.b_riot_id)),
    'reports',  jsonb_build_object('a', r.a_report, 'b', r.b_report))
    from public.room_evidence e
    join public.match_rooms r on r.id = e.room_id
    left join public.profiles pa on pa.id = r.player_a
    left join public.profiles pb on pb.id = r.player_b
    left join public.game_accounts ga on ga.user_id = r.player_a and ga.network = 'riot'
    left join public.game_accounts gb on gb.user_id = r.player_b and gb.network = 'riot'
   where e.id = p_evidence_id;
$$;

-- Service role: record the check (only from 'pending'). A screenshot never
-- settles, voids or disputes a room:
--   the stored bytes already used in another room   -> 'duplicate'
--   verified, confidence >= rib_auto_settle_confidence(), room live, the
--     uploader reported this winner and the opponent hasn't reported
--                                                  -> confirm window shrinks
--                                                     to 3 min, fast_tracked
--   contradicts / duplicate                        -> review_flag
--   anything else                                  -> nothing
drop function if exists public.rib_evidence_check_apply(bigint, text, uuid, numeric, jsonb);
create or replace function public.rib_evidence_check_apply(
  p_evidence_id bigint, p_status text, p_winner uuid, p_confidence numeric, p_detail jsonb,
  p_content_sha256 text default null
) returns public.match_rooms
language plpgsql security definer set search_path = ''
as $$
declare v_room uuid; v_e public.room_evidence; v_r public.match_rooms; v_status text := p_status;
        v_content text := lower(nullif(trim(coalesce(p_content_sha256, '')), ''));
        v_mine uuid; v_theirs uuid;
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
  -- Room first, then the capture: the same order as every room action.
  select * into v_r from public.match_rooms where id = v_room for update;
  select * into v_e from public.room_evidence where id = p_evidence_id for update;
  if v_e.check_status <> 'pending' then
    raise exception 'this capture was already checked' using hint = 'evidence_not_pending';
  end if;

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
  elsif v_status = 'verified' and v_r.status = 'live' and v_e.user_id is not null
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

-- ----------------------------------------------------------------------------
-- 7) Realtime. room_evidence: players hold column-level SELECT only; the
-- Realtime RLS check sends each subscriber the columns it may read.
-- ----------------------------------------------------------------------------
do $$
begin
  alter publication supabase_realtime add table public.room_evidence;
exception when duplicate_object then null; when undefined_object then null;
end;
$$;
do $$
begin
  alter publication supabase_realtime add table public.tournaments;
exception when duplicate_object then null; when undefined_object then null;
end;
$$;

-- ----------------------------------------------------------------------------
-- 8) Test-mode clean-up: open tournaments of other games are refunded
-- ----------------------------------------------------------------------------
do $$
declare v_t public.tournaments; r record;
begin
  -- Every wallet the refunds touch, locked once in a fixed order.
  perform 1 from public.wallets w
   where w.user_id in (select e.user_id from public.tournament_entries e
                         join public.tournaments t on t.id = e.tournament_id
                        where t.status = 'open' and t.entry_fee_cents > 0
                          and lower(btrim(t.game)) <> 'wild rift')
   order by w.user_id
   for update;
  for v_t in select * from public.tournaments
              where status = 'open' and lower(btrim(game)) <> 'wild rift'
              order by created_at for update loop
    if v_t.entry_fee_cents > 0 then
      for r in select user_id from public.tournament_entries where tournament_id = v_t.id order by user_id loop
        perform public.rib_apply(r.user_id, 'tournament_refund', v_t.entry_fee_cents, 0, 'tournament', v_t.id,
                                 'Runinback runs Wild Rift tournaments only now: entry refunded');
      end loop;
    end if;
    update public.tournaments set status = 'cancelled', prize_pool_cents = 0, finished_at = now() where id = v_t.id;
  end loop;
end;
$$;

-- ----------------------------------------------------------------------------
-- 9) Grants
-- ----------------------------------------------------------------------------
do $$
declare f text;
begin
  -- Players.
  foreach f in array array[
    'rib_wild_rift_game()', 'rib_ready_window()', 'rib_confirm_window()', 'rib_verified_confirm_window()',
    'rib_auto_settle_confidence()', 'rib_quick_fees()', 'rib_quick_tier_valid(bigint,int)',
    'rib_riot_id_valid(text)', 'rib_riot_id_normalize(text)',
    'rib_quick_join(bigint,int)', 'rib_quick_tiers()',
    'rib_game_account_set(text,text)', 'rib_tournament_join(uuid)', 'rib_tournament_create(text,text,bigint,int,text)',
    'rib_tournament_leave(uuid)', 'rib_room_report(uuid,uuid)', 'rib_room_evidence_add(uuid,text,text,text,text)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  -- Internal.
  foreach f in array array[
    'rib_room_open(uuid)', 'rib_tournament_advance(uuid)', 'rib_riot_handle(uuid)', 'rib_riot_id_locked(uuid)',
    'rib_riot_id_change_check(uuid,text)', 'rib_require_riot_account(uuid)', 'rib_entry_precheck(uuid)',
    'rib_assert_not_queued(uuid,text)', 'rib_tournament_enter(uuid,uuid)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
  -- Service role only (Edge Functions).
  foreach f in array array[
    'rib_riot_account_verified(uuid,text,text,text)', 'rib_evidence_for_check(bigint)',
    'rib_evidence_check_apply(bigint,text,uuid,numeric,jsonb,text)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;

-- ----------------------------------------------------------------------------
-- Operator resolution of automatic disputes (screenshot check). Same as 0022,
-- except that a lost dispute is only recorded against a player who made a
-- claim: the disputer, or a player who reported themselves the winner.
-- ----------------------------------------------------------------------------
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
    -- The losing side made a false claim. An automatic dispute (nobody
    -- disputed) only counts against a loser who reported themselves the winner.
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
-- Grants are unchanged (create or replace keeps them): operators call it
-- from the console and rib_require_operator() guards it.


-- ----------------------------------------------------------------------------
-- My tournaments carry the Quick Play tier, so the console knows which tiers
-- I'm already queued in without guessing from the event name. My entries are
-- picked and limited first; the per-row lookups run only for that page.
-- ----------------------------------------------------------------------------
drop function if exists public.rib_my_tournaments(int);
create or replace function public.rib_my_tournaments(p_limit int default 30)
returns table (id uuid, name text, game text, network text, entry_fee_cents bigint, size int, status text,
               entrants int, placement int, winner_username text, prize_pool_cents bigint, created_at timestamptz,
               my_room_id uuid, my_room_status text, my_round int, rounds int, eliminated boolean, prize_cents bigint,
               tier_key text)
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
         t.tier_key
    from mine m
    cross join me
    join public.tournaments t on t.id = m.tournament_id
    left join public.profiles w on w.id = t.winner_id
    left join lateral (
      select r.id, r.status, r.round from public.match_rooms r
       where r.tournament_id = t.id and me.uid in (r.player_a, r.player_b)
       order by r.round desc limit 1
    ) cur on true
   order by m.is_active desc, m.created_at desc;
$$;
revoke execute on function public.rib_my_tournaments(int) from public, anon;
grant execute on function public.rib_my_tournaments(int) to authenticated;
