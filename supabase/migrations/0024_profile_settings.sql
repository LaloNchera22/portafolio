-- ============================================================================
-- Runinback — profile, settings and responsible play (2026-09-29).
--
--   1) Profile: bio, country, avatar, and username rules enforced in one
--      place (rib_profile_update): 30-day cooldown between handle changes,
--      reserved names, case-insensitive uniqueness. Direct UPDATEs on
--      profiles are revoked.
--   2) profile_settings (1:1, created lazily): notifications, privacy
--      (leaderboard, linked game accounts) and responsible-play limits.
--      Limits tighten at once and loosen only after a delay: raising or
--      removing the monthly entry cap waits 24 hours, ending a cool-off
--      early waits 7 days. Pending changes settle on read, no cron needed.
--   3) rib_paid_entry_limits enforces the cap and the cool-off on every paid
--      entry, serialized per player so two joins can't both pass the cap.
--   4) rib_public_profile: a player's public card, honoring their privacy.
--   5) rib_my_data_export: everything we hold about the caller, bounded.
--   6) avatars bucket: public read, owner-only write of <uid>/avatar.webp.
--   7) rib_close_account also clears the new fields, linked game accounts
--      and settings, and refuses while the player is in a live tournament
--      or match room. A closed account can't enter paid tournaments or
--      recreate settings.
-- Tournaments are the only paid entries (friendlies and game tables are
-- free since 0022), so the limits live on the tournament entry path.
-- Idempotent.
-- ============================================================================

-- ---- 1) Profile fields and username rules ----------------------------------
alter table public.profiles add column if not exists bio text;
alter table public.profiles add column if not exists country text;
alter table public.profiles add column if not exists avatar_version int not null default 0;
alter table public.profiles add column if not exists username_changed_at timestamptz;

-- NOT VALID then VALIDATE: the check doesn't hold an exclusive lock while it
-- scans a large table.
alter table public.profiles drop constraint if exists profiles_bio_check;
alter table public.profiles add constraint profiles_bio_check check (bio is null or char_length(bio) <= 160) not valid;
alter table public.profiles validate constraint profiles_bio_check;
alter table public.profiles drop constraint if exists profiles_country_check;
alter table public.profiles add constraint profiles_country_check check (country is null or country ~ '^[A-Z]{2}$') not valid;
alter table public.profiles validate constraint profiles_country_check;
alter table public.profiles drop constraint if exists profiles_avatar_version_check;
alter table public.profiles add constraint profiles_avatar_version_check check (avatar_version >= 0) not valid;
alter table public.profiles validate constraint profiles_avatar_version_check;

-- ISO 3166-1 alpha-2 (the client's list in src/scripts/lib/countries.js matches).
create or replace function public.rib_country_valid(p_code text)
returns boolean
language sql immutable set search_path = ''
as $$
  select p_code = any (string_to_array(
    'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ '
    'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR '
    'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP '
    'KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT '
    'MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW '
    'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG '
    'UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW', ' '));
$$;

-- Names nobody may take: staff-looking handles (also as a prefix, and with
-- separators or spaces removed, so "Runinback Support" and "admin_help" are
-- caught), and the prefix account closure uses for anonymized handles.
create or replace function public.rib_username_reserved(p_username text)
returns boolean
language sql immutable set search_path = ''
as $$
  select lower(coalesce(p_username, '')) like 'closed\_%'
      or regexp_replace(lower(coalesce(p_username, '')), '[^a-z0-9]', '', 'g') in
           ('root','mod','ops','help','team','system','billing','payments','null','undefined')
      or regexp_replace(lower(coalesce(p_username, '')), '[^a-z0-9]', '', 'g')
           ~ '^(runinback|admin|administrator|support|staff|moderator|official|security)';
$$;

-- Text players write: drop control, zero-width and bidi-override characters
-- (they can make a name or bio read as something else), then trim.
create or replace function public.rib_clean_text(p text)
returns text
language sql immutable set search_path = ''
as $$
  select nullif(trim(regexp_replace(regexp_replace(coalesce(p, ''),
    '[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]', '', 'g'), '[[:cntrl:]]+', ' ', 'g')), '');
$$;

-- Guard every path that sets a handle (sign-up trigger, the RPC, operators):
-- only account closure may write a closed_ handle.
-- A sign-up asking for a reserved handle gets a neutral one it can change
-- later (failing the sign-up would only show "database error"); a later
-- change to a reserved handle is refused.
create or replace function public.rib_guard_username()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.closed_at is null and public.rib_username_reserved(new.username) then
    if tg_op = 'INSERT' then
      new.username := 'player_' || substr(md5(new.id::text), 1, 12);
    elsif new.username is distinct from old.username then
      raise exception 'that username is reserved' using hint = 'username_reserved';
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function public.rib_guard_username() from public, anon, authenticated;
drop trigger if exists guard_username on public.profiles;
create trigger guard_username before insert or update of username on public.profiles
  for each row execute function public.rib_guard_username();

-- The case-insensitive index is what makes "taken" reliable; 0013 created it
-- only when the data allowed. Create it now or say loudly why not.
do $$
begin
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'profiles_username_lower_uidx') then
    if exists (select lower(username) from public.profiles group by lower(username) having count(*) > 1) then
      raise warning 'profiles_username_lower_uidx missing: usernames differ only by case; resolve them and re-run';
    else
      create unique index profiles_username_lower_uidx on public.profiles (lower(username));
    end if;
  end if;
end;
$$;

-- All profile writes go through rib_profile_update / rib_avatar_set; the new
-- columns are read through rib_my_profile / rib_public_profile only (the
-- column grant from 0013 stays id, username, display_name, created_at).
revoke update on public.profiles from authenticated;

-- ---- 2) Settings ------------------------------------------------------------
create table if not exists public.profile_settings (
  user_id                 uuid primary key references auth.users (id) on delete cascade,
  -- notifications
  match_toasts            boolean not null default true,   -- in-app pop-ups when a match needs me
  product_emails          boolean not null default false,  -- news and offers (consent, opt-in)
  -- privacy
  show_on_leaderboard     boolean not null default true,
  show_game_accounts      boolean not null default false,
  -- responsible play (effective values)
  monthly_cap_cents       bigint check (monthly_cap_cents is null or monthly_cap_cents between 0 and 10000000),
  cooloff_until           timestamptz,
  -- deferred loosening
  pending_cap_set         boolean not null default false,  -- a cap change is waiting
  pending_cap_cents       bigint check (pending_cap_cents is null or pending_cap_cents between 0 and 10000000),
  pending_cap_at          timestamptz,
  pending_cooloff_end_at  timestamptz,
  last_export_at          timestamptz,
  updated_at              timestamptz not null default now()
);
alter table public.profile_settings enable row level security;
revoke all on public.profile_settings from anon, authenticated;
comment on table public.profile_settings is 'Per-player settings, 1:1 with profiles, created on first use. RPC access only.';
create index if not exists profile_settings_hidden_idx on public.profile_settings (user_id) where not show_on_leaderboard;

create or replace function public.rib_assert_open_account(p_uid uuid)
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if exists (select 1 from public.profiles where id = p_uid and closed_at is not null) then
    raise exception 'this account is closed' using hint = 'account_closed';
  end if;
end;
$$;
revoke execute on function public.rib_assert_open_account(uuid) from public, anon, authenticated;

-- Get (creating on first use) and settle: loosening that has waited long
-- enough is promoted, expired cool-offs are cleared.
create or replace function public.rib_settings_row(p_uid uuid)
returns public.profile_settings
language plpgsql security definer set search_path = ''
as $$
declare v public.profile_settings;
begin
  insert into public.profile_settings (user_id) values (p_uid) on conflict (user_id) do nothing;
  update public.profile_settings s
     set monthly_cap_cents = case when s.pending_cap_set and s.pending_cap_at <= now() then s.pending_cap_cents else s.monthly_cap_cents end,
         pending_cap_set   = s.pending_cap_set and s.pending_cap_at > now(),
         pending_cap_cents = case when s.pending_cap_set and s.pending_cap_at > now() then s.pending_cap_cents end,
         pending_cap_at    = case when s.pending_cap_set and s.pending_cap_at > now() then s.pending_cap_at end,
         cooloff_until     = case when s.pending_cooloff_end_at <= now() or s.cooloff_until <= now() then null else s.cooloff_until end,
         pending_cooloff_end_at = case when s.pending_cooloff_end_at > now() and s.cooloff_until > now() then s.pending_cooloff_end_at end,
         updated_at = now()
   where s.user_id = p_uid
     and ((s.pending_cap_set and s.pending_cap_at <= now())
          or s.pending_cooloff_end_at <= now()
          or s.cooloff_until <= now());
  select * into v from public.profile_settings where user_id = p_uid;
  return v;
end;
$$;
revoke execute on function public.rib_settings_row(uuid) from public, anon, authenticated;

-- Entry fees paid this UTC month, net of refunds for entries made this
-- month (a refund for last month's entry doesn't free room in this one).
-- Served by wallet_ledger_user_idx.
create or replace function public.rib_month_entry_spend(p_uid uuid)
returns bigint
language sql stable security definer set search_path = ''
as $$
  with m as (select (date_trunc('month', now() at time zone 'utc') at time zone 'utc') as start),
  rows as (
    select l.kind, l.amount_cents, l.ref_id
      from public.wallet_ledger l, m
     where l.user_id = p_uid and l.created_at >= m.start
       and l.kind in ('tournament_entry', 'tournament_refund'))
  select greatest(0,
    coalesce((select -sum(amount_cents) from rows where kind = 'tournament_entry'), 0)
    - coalesce((select sum(r.amount_cents) from rows r
                 where r.kind = 'tournament_refund'
                   and exists (select 1 from rows e where e.kind = 'tournament_entry' and e.ref_id = r.ref_id)), 0))::bigint;
$$;
revoke execute on function public.rib_month_entry_spend(uuid) from public, anon, authenticated;

create or replace function public.rib_settings_json(p public.profile_settings)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'match_toasts', p.match_toasts,
    'product_emails', p.product_emails,
    'show_on_leaderboard', p.show_on_leaderboard,
    'show_game_accounts', p.show_game_accounts,
    'monthly_cap_cents', p.monthly_cap_cents,
    'month_spent_cents', public.rib_month_entry_spend(p.user_id),
    'cooloff_until', p.cooloff_until,
    'pending_cap', case when p.pending_cap_set then jsonb_build_object('cents', p.pending_cap_cents, 'at', p.pending_cap_at) end,
    'pending_cooloff_end_at', p.pending_cooloff_end_at,
    'next_export_at', case when p.last_export_at > now() - interval '1 hour' then p.last_export_at + interval '1 hour' end
  );
$$;
revoke execute on function public.rib_settings_json(public.profile_settings) from public, anon, authenticated;

create or replace function public.rib_settings_get()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  perform public.rib_assert_open_account(v_uid);
  return public.rib_settings_json(public.rib_settings_row(v_uid));
end;
$$;

-- One patch, whitelisted keys only. Unknown keys are an error, not ignored,
-- so a typo in the client can't silently not save.
--   match_toasts, product_emails, show_on_leaderboard, show_game_accounts: boolean
--   monthly_cap_cents: whole rcoin in cents (0..10,000,000), or null to remove the cap
--   cancel_pending_cap: true
--   cooloff_days: 1 | 7 | 30 | 90 | 180 | 365 (starts or extends a cool-off)
--   end_cooloff: true (ends it 7 days from now) | cancel_end_cooloff: true
create or replace function public.rib_settings_update(p_patch jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v public.profile_settings;
  k text;
  v_cap bigint;
  v_days int;
  v_until timestamptz;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  perform public.rib_assert_open_account(v_uid);
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'invalid settings' using hint = 'invalid_setting'; end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('match_toasts','product_emails','show_on_leaderboard','show_game_accounts','monthly_cap_cents',
                 'cancel_pending_cap','cooloff_days','end_cooloff','cancel_end_cooloff') then
      raise exception 'unknown setting %', k using hint = 'invalid_setting';
    end if;
    if k in ('match_toasts','product_emails','show_on_leaderboard','show_game_accounts','cancel_pending_cap','end_cooloff','cancel_end_cooloff')
       and jsonb_typeof(p_patch -> k) <> 'boolean' then
      raise exception 'setting % must be true or false', k using hint = 'invalid_setting';
    end if;
  end loop;
  if not public.rib_rate_limit_hit('settings_update', v_uid, 60, 3600) then
    raise exception 'too many changes, try again later' using hint = 'rate_limited';
  end if;

  perform public.rib_lock_user(v_uid);
  v := public.rib_settings_row(v_uid);

  update public.profile_settings set
    match_toasts        = coalesce((p_patch ->> 'match_toasts')::boolean, match_toasts),
    product_emails      = coalesce((p_patch ->> 'product_emails')::boolean, product_emails),
    show_on_leaderboard = coalesce((p_patch ->> 'show_on_leaderboard')::boolean, show_on_leaderboard),
    show_game_accounts  = coalesce((p_patch ->> 'show_game_accounts')::boolean, show_game_accounts),
    updated_at = now()
  where user_id = v_uid;

  -- Leaving the board takes effect at once; the next ranking refresh closes the gap.
  if (p_patch ->> 'show_on_leaderboard')::boolean is false then
    update public.player_rankings set rank_all = 0, rank_week = 0, updated_at = now() where user_id = v_uid;
  end if;

  -- Monthly entry cap: tighten now, loosen in 24 hours.
  if p_patch ? 'monthly_cap_cents' then
    if jsonb_typeof(p_patch -> 'monthly_cap_cents') = 'null' then
      v_cap := null;
    elsif jsonb_typeof(p_patch -> 'monthly_cap_cents') = 'number' then
      v_cap := (p_patch ->> 'monthly_cap_cents')::numeric::bigint;
      if v_cap < 0 or v_cap > 10000000 or v_cap % 100 <> 0 then
        raise exception 'the monthly limit is whole rcoin between 0 and 100,000' using hint = 'invalid_entry_cap';
      end if;
    else
      raise exception 'the monthly limit must be a number' using hint = 'invalid_entry_cap';
    end if;
    if v_cap is not null and (v.monthly_cap_cents is null or v_cap <= v.monthly_cap_cents) then
      update public.profile_settings
         set monthly_cap_cents = v_cap, pending_cap_set = false, pending_cap_cents = null, pending_cap_at = null, updated_at = now()
       where user_id = v_uid;
    elsif v_cap is distinct from v.monthly_cap_cents then
      update public.profile_settings
         set pending_cap_set = true, pending_cap_cents = v_cap, pending_cap_at = now() + interval '24 hours', updated_at = now()
       where user_id = v_uid;
    else
      update public.profile_settings set pending_cap_set = false, pending_cap_cents = null, pending_cap_at = null where user_id = v_uid;
    end if;
  end if;
  if coalesce((p_patch ->> 'cancel_pending_cap')::boolean, false) then
    update public.profile_settings set pending_cap_set = false, pending_cap_cents = null, pending_cap_at = null where user_id = v_uid;
  end if;

  -- Cool-off: start or extend now; ending early waits 7 days.
  if p_patch ? 'cooloff_days' then
    if jsonb_typeof(p_patch -> 'cooloff_days') <> 'number' then raise exception 'invalid cool-off' using hint = 'invalid_cooloff'; end if;
    v_days := (p_patch ->> 'cooloff_days')::numeric::int;
    if v_days not in (1, 7, 30, 90, 180, 365) then raise exception 'invalid cool-off' using hint = 'invalid_cooloff'; end if;
    v_until := now() + make_interval(days => v_days);
    update public.profile_settings
       set cooloff_until = greatest(coalesce(cooloff_until, v_until), v_until), pending_cooloff_end_at = null, updated_at = now()
     where user_id = v_uid;
  end if;
  if coalesce((p_patch ->> 'end_cooloff')::boolean, false) then
    update public.profile_settings
       set pending_cooloff_end_at = least(cooloff_until, now() + interval '7 days'), updated_at = now()
     where user_id = v_uid and cooloff_until > now() and pending_cooloff_end_at is null;
  end if;
  if coalesce((p_patch ->> 'cancel_end_cooloff')::boolean, false) then
    update public.profile_settings set pending_cooloff_end_at = null, updated_at = now() where user_id = v_uid;
  end if;

  select * into v from public.profile_settings where user_id = v_uid;
  return public.rib_settings_json(v);
end;
$$;

-- ---- 3) Enforcement on every paid entry ------------------------------------
create or replace function public.rib_paid_entry_limits(p_uid uuid, p_fee_cents bigint)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare v_rep public.player_reputation; v_s public.profile_settings;
begin
  if p_fee_cents <= 0 then return; end if;
  perform public.rib_assert_open_account(p_uid);
  select * into v_rep from public.player_reputation where user_id = p_uid;
  if coalesce(v_rep.disputes_lost, 0) >= 3 or coalesce(v_rep.no_shows, 0) >= 5 then
    raise exception 'paid tournaments are paused on this account; contact support' using hint = 'account_restricted';
  end if;
  if coalesce(v_rep.matches_completed, 0) < 3 and p_fee_cents > 2500 then
    raise exception 'new accounts can enter up to 25 rcoin until they finish 3 matches' using hint = 'new_account_limit';
  end if;

  -- Serialize this player's paid entries so concurrent joins see each other's spend.
  perform public.rib_lock_user(p_uid);
  if not exists (select 1 from public.profile_settings where user_id = p_uid) then return; end if;
  v_s := public.rib_settings_row(p_uid);
  if v_s.cooloff_until > now() then
    raise exception 'paid entries are paused by your cool-off' using hint = 'cooloff_active';
  end if;
  if v_s.monthly_cap_cents is not null
     and public.rib_month_entry_spend(p_uid) + p_fee_cents > v_s.monthly_cap_cents then
    raise exception 'this entry fee would pass your monthly limit' using hint = 'entry_cap_reached';
  end if;
end;
$$;
revoke execute on function public.rib_paid_entry_limits(uuid,bigint) from public, anon, authenticated;

-- Hidden players are left out when the ranking is rebuilt.
create or replace function public.refresh_player_rankings()
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not pg_try_advisory_xact_lock(hashtextextended('rib_refresh_player_rankings', 0)) then
    return;
  end if;

  create temp table if not exists _rib_ranks (user_id uuid primary key, rank_all bigint, rank_week bigint) on commit drop;
  truncate _rib_ranks;

  insert into _rib_ranks (user_id, rank_all, rank_week)
  select coalesce(a.user_id, w.user_id), coalesce(a.rn, 0), coalesce(w.rn, 0)
    from (select s.user_id, row_number() over (order by s.net_cents desc, s.wins desc, s.user_id) as rn
            from public.player_stats s
           where s.wins + s.losses > 0
             and not exists (select 1 from public.profile_settings h where h.user_id = s.user_id and not h.show_on_leaderboard)) a
    full join (select s.user_id, row_number() over (order by s.net_cents desc, s.wins desc, s.user_id) as rn
                 from public.player_stats_weekly s
                where s.week_start = public.rib_week_start(now()) and s.wins + s.losses > 0
                  and not exists (select 1 from public.profile_settings h where h.user_id = s.user_id and not h.show_on_leaderboard)) w
      on w.user_id = a.user_id;

  insert into public.player_rankings as r (user_id, rank_all, rank_week, updated_at)
  select k.user_id, k.rank_all, k.rank_week, now()
    from _rib_ranks k join public.profiles p on p.id = k.user_id
  on conflict (user_id) do update
    set rank_all = excluded.rank_all, rank_week = excluded.rank_week, updated_at = now()
    where (r.rank_all, r.rank_week) is distinct from (excluded.rank_all, excluded.rank_week);

  update public.player_rankings r
     set rank_all = 0, rank_week = 0, updated_at = now()
   where (r.rank_all <> 0 or r.rank_week <> 0)
     and not exists (select 1 from _rib_ranks k where k.user_id = r.user_id);
end;
$$;
revoke execute on function public.refresh_player_rankings() from public, anon, authenticated;
grant execute on function public.refresh_player_rankings() to service_role;

-- ---- 1b) Profile RPCs --------------------------------------------------------
create or replace function public.rib_profile_json(p public.profiles)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'username', p.username, 'display_name', p.display_name, 'bio', p.bio, 'country', p.country,
    'avatar_version', p.avatar_version, 'created_at', p.created_at,
    'username_next_change_at', case when p.username_changed_at > now() - interval '30 days'
                                    then p.username_changed_at + interval '30 days' end);
$$;
revoke execute on function public.rib_profile_json(public.profiles) from public, anon, authenticated;

create or replace function public.rib_my_profile()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v public.profiles;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  select * into v from public.profiles where id = v_uid;
  if v.id is null then raise exception 'profile not found' using hint = 'profile_not_found'; end if;
  return public.rib_profile_json(v);
end;
$$;

-- The whole form in one call. p_username null keeps the handle; blank bio,
-- display name or country clear them.
create or replace function public.rib_profile_update(
  p_username text default null, p_display_name text default null, p_bio text default null, p_country text default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v public.profiles;
  v_username text := nullif(trim(coalesce(p_username, '')), '');
  v_display text := public.rib_clean_text(p_display_name);
  v_bio text := public.rib_clean_text(p_bio);
  v_country text := nullif(upper(trim(coalesce(p_country, ''))), '');
  v_changed_at timestamptz;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  select * into v from public.profiles where id = v_uid for update;
  if v.id is null then raise exception 'profile not found' using hint = 'profile_not_found'; end if;
  if v.closed_at is not null then raise exception 'this account is closed' using hint = 'account_closed'; end if;
  if not public.rib_rate_limit_hit('profile_update', v_uid, 20, 3600) then
    raise exception 'too many changes, try again later' using hint = 'rate_limited';
  end if;

  if v_display is not null and char_length(v_display) > 60 then raise exception 'display name too long' using hint = 'invalid_display_name'; end if;
  if v_display is not null and v_display is distinct from v.display_name and public.rib_username_reserved(v_display) then
    raise exception 'that display name is reserved' using hint = 'display_name_reserved';
  end if;
  if v_bio is not null and char_length(v_bio) > 160 then raise exception 'bio too long' using hint = 'bio_too_long'; end if;
  if v_country is not null and not public.rib_country_valid(v_country) then raise exception 'unknown country' using hint = 'invalid_country'; end if;

  v_changed_at := v.username_changed_at;
  if v_username is not null and v_username <> v.username then
    if v_username !~ '^[a-zA-Z0-9_]{3,24}$' then raise exception 'invalid username' using hint = 'invalid_username'; end if;
    if public.rib_username_reserved(v_username) then raise exception 'that username is reserved' using hint = 'username_reserved'; end if;
    -- A case-only change (neo -> Neo) is free; a new handle waits 30 days.
    if lower(v_username) <> lower(v.username) then
      if v.username_changed_at > now() - interval '30 days' then
        raise exception 'you can change your username again on %', to_char(v.username_changed_at + interval '30 days', 'YYYY-MM-DD')
          using hint = 'username_cooldown';
      end if;
      if exists (select 1 from public.profiles where lower(username) = lower(v_username) and id <> v_uid) then
        raise exception 'that username is taken' using hint = 'username_taken';
      end if;
      v_changed_at := now();
    end if;
  else
    v_username := v.username;
  end if;

  begin
    update public.profiles
       set username = v_username, display_name = v_display, bio = v_bio, country = v_country,
           username_changed_at = v_changed_at, updated_at = now()
     where id = v_uid
    returning * into v;
  exception when unique_violation then
    raise exception 'that username is taken' using hint = 'username_taken';
  end;
  return public.rib_profile_json(v);
end;
$$;

-- The avatar lives at avatars/<uid>/avatar.webp; the version busts caches.
create or replace function public.rib_avatar_set(p_present boolean)
returns int
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_version int;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  if not public.rib_rate_limit_hit('avatar_set', v_uid, 20, 3600) then
    raise exception 'too many changes, try again later' using hint = 'rate_limited';
  end if;
  update public.profiles
     set avatar_version = case when coalesce(p_present, false) then avatar_version + 1 else 0 end, updated_at = now()
   where id = v_uid and closed_at is null
  returning avatar_version into v_version;
  if v_version is null then raise exception 'profile not found' using hint = 'profile_not_found'; end if;
  return v_version;
end;
$$;

-- ---- 4) Public profile --------------------------------------------------------
-- Bounded: one row by the lower(username) index, stats by primary key,
-- linked accounts (at most one per network) and the last 10 tournaments.
-- Rate-limited per viewer (120 cards a minute) so the directory can't be
-- scraped by walking usernames.
create or replace function public.rib_public_profile(p_username text)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare v public.profiles; v_s public.profile_settings; v_ranked boolean; v_me boolean;
begin
  if auth.uid() is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  if not public.rib_rate_limit_hit('profile_lookup', auth.uid(), 120, 60) then
    raise exception 'too many profile views, slow down' using hint = 'rate_limited';
  end if;
  if p_username is null or char_length(trim(p_username)) not between 3 and 24 then return null; end if;
  select * into v from public.profiles where lower(username) = lower(trim(p_username));
  if v.id is null or v.closed_at is not null then return null; end if;
  select * into v_s from public.profile_settings where user_id = v.id;
  v_me := v.id = auth.uid();
  v_ranked := coalesce(v_s.show_on_leaderboard, true);
  return jsonb_build_object(
    'username', v.username, 'display_name', v.display_name, 'bio', v.bio, 'country', v.country,
    'avatar', case when v.avatar_version > 0 then v.id::text || '/avatar.webp?v=' || v.avatar_version end,
    'created_at', v.created_at, 'is_me', v_me, 'ranked', v_ranked,
    'stats', case when v_ranked or v_me then (
      select jsonb_build_object('net_cents', s.net_cents, 'won_cents', s.won_cents, 'wins', s.wins, 'losses', s.losses,
                                'rank_all', nullif(r.rank_all, 0))
        from public.player_stats s left join public.player_rankings r on r.user_id = s.user_id
       where s.user_id = v.id) end,
    'game_accounts', case when coalesce(v_s.show_game_accounts, false) or v_me then (
      select coalesce(jsonb_agg(jsonb_build_object('network', g.network, 'handle', g.handle) order by g.network), '[]'::jsonb)
        from public.game_accounts g where g.user_id = v.id) end,
    'tournaments', case when v_ranked or v_me then (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.finished_at desc), '[]'::jsonb) from (
        select t.name, t.game, t.max_players as size, e.placement, t.finished_at
          from public.tournament_entries e join public.tournaments t on t.id = e.tournament_id
         where e.user_id = v.id and t.status = 'finished' and t.format = 'bracket'
         order by t.finished_at desc limit 10) x) end
  );
end;
$$;

-- ---- 5) Data export -------------------------------------------------------------
create or replace function public.rib_my_data_export()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_s public.profile_settings; v_ledger jsonb; v_ledger_n int;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  perform public.rib_assert_open_account(v_uid);
  perform public.rib_lock_user(v_uid);
  v_s := public.rib_settings_row(v_uid);
  if v_s.last_export_at > now() - interval '1 hour' then
    raise exception 'you can download your data once an hour' using hint = 'export_rate_limited';
  end if;
  update public.profile_settings set last_export_at = now() where user_id = v_uid returning * into v_s;

  -- One scan: read one row past the cap to know whether the file is truncated.
  select count(*), coalesce(jsonb_agg(jsonb_build_object('kind', l.kind, 'amount_cents', l.amount_cents,
           'balance_after_cents', l.balance_after_cents, 'memo', l.memo, 'ref_type', l.ref_type, 'created_at', l.created_at)
           order by l.created_at desc) filter (where l.n <= 5000), '[]'::jsonb)
    into v_ledger_n, v_ledger
    from (select w.*, row_number() over (order by w.created_at desc) as n
            from (select * from public.wallet_ledger where user_id = v_uid order by created_at desc limit 5001) w) l;

  return jsonb_build_object(
    'exported_at', now(),
    'profile', (select to_jsonb(p) - 'id' from public.profiles p where p.id = v_uid),
    'email', (select u.email from auth.users u where u.id = v_uid),
    'settings', public.rib_settings_json(v_s),
    'wallet', (select jsonb_build_object('balance_cents', w.test_balance_cents, 'locked_cents', w.test_locked_cents)
                 from public.wallets w where w.user_id = v_uid),
    'game_accounts', (select coalesce(jsonb_agg(jsonb_build_object('network', g.network, 'handle', g.handle)), '[]'::jsonb)
                        from public.game_accounts g where g.user_id = v_uid),
    'tournaments', (select coalesce(jsonb_agg(jsonb_build_object('tournament_id', x.id, 'name', x.name, 'game', x.game,
                                    'entry_fee_cents', x.entry_fee_cents, 'status', x.status, 'placement', x.placement,
                                    'created_at', x.created_at) order by x.created_at desc), '[]'::jsonb)
                      from (select t.id, t.name, t.game, t.entry_fee_cents, t.status, e.placement, t.created_at
                              from public.tournament_entries e join public.tournaments t on t.id = e.tournament_id
                             where e.user_id = v_uid order by t.created_at desc limit 2000) x),
    'match_rooms', (select coalesce(jsonb_agg(jsonb_build_object('room_id', r.id, 'kind', r.kind, 'game', r.game, 'status', r.status,
                                    'round', r.round, 'won', r.winner_id = v_uid, 'created_at', r.created_at) order by r.created_at desc), '[]'::jsonb)
                      from (select * from public.match_rooms where v_uid in (player_a, player_b) order by created_at desc limit 2000) r),
    'friendlies', (select coalesce(jsonb_agg(jsonb_build_object('challenge_id', c.id, 'game', c.game, 'mode', c.mode, 'status', c.status,
                                    'created_by_me', c.creator_id = v_uid, 'created_at', c.created_at) order by c.created_at desc), '[]'::jsonb)
                      from (select * from public.challenges where v_uid in (creator_id, opponent_id) order by created_at desc limit 2000) c),
    'stats', (select to_jsonb(s) - 'user_id' from public.player_stats s where s.user_id = v_uid),
    'ledger', v_ledger,
    'ledger_truncated', v_ledger_n > 5000
  );
end;
$$;

-- ---- 6) Avatars bucket -----------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('avatars', 'avatars', true, 524288, array['image/webp','image/png','image/jpeg'])
    on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
    -- Public URLs serve reads. Policies only let a player write (and see, which
    -- upsert needs) the one object at <uid>/avatar.webp: no listing of others.
    execute 'drop policy if exists "avatars: read own" on storage.objects';
    execute $p$create policy "avatars: read own" on storage.objects
      for select to authenticated using (bucket_id = 'avatars' and name = (select auth.uid())::text || '/avatar.webp')$p$;
    execute 'drop policy if exists "avatars: upload own" on storage.objects';
    execute $p$create policy "avatars: upload own" on storage.objects
      for insert to authenticated with check (bucket_id = 'avatars' and name = (select auth.uid())::text || '/avatar.webp')$p$;
    execute 'drop policy if exists "avatars: replace own" on storage.objects';
    execute $p$create policy "avatars: replace own" on storage.objects
      for update to authenticated using (bucket_id = 'avatars' and name = (select auth.uid())::text || '/avatar.webp')
      with check (bucket_id = 'avatars' and name = (select auth.uid())::text || '/avatar.webp')$p$;
    execute 'drop policy if exists "avatars: remove own" on storage.objects';
    execute $p$create policy "avatars: remove own" on storage.objects
      for delete to authenticated using (bucket_id = 'avatars' and name = (select auth.uid())::text || '/avatar.webp')$p$;
  else
    raise warning 'storage schema not present: create the avatars bucket and policies on Supabase';
  end if;
end;
$$;

-- ---- 7) Account closure -----------------------------------------------------------
create or replace function public.rib_close_account()
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_w public.wallets;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  select * into v_w from public.wallets where user_id = v_uid for update;
  if coalesce(v_w.test_locked_cents, 0) > 0
     or exists (select 1 from public.challenges
                 where status in ('open','pending','active','disputed') and (creator_id = v_uid or opponent_id = v_uid))
     or exists (select 1 from public.game_matches
                 where status in ('open','active','disputed') and (host_id = v_uid or guest_id = v_uid))
     or exists (select 1 from public.tournaments
                 where creator_id = v_uid and status in ('open','full','active','payout_pending','disputed'))
     or exists (select 1 from public.tournament_entries e join public.tournaments t on t.id = e.tournament_id
                 where e.user_id = v_uid and t.status in ('open','full','active','payout_pending','disputed'))
     or exists (select 1 from public.match_rooms
                 where status in ('waiting','ready_check','live','disputed') and v_uid in (player_a, player_b)) then
    raise exception 'finish or leave your open games, friendlies and tournaments first' using hint = 'close_account_blocked';
  end if;
  if v_w.frozen_at is not null then
    raise exception 'a wallet on hold cannot be closed' using hint = 'close_account_blocked';
  end if;

  update public.profiles
     set username = 'closed_' || substr(replace(v_uid::text, '-', ''), 1, 17), display_name = null, bio = null, country = null,
         avatar_version = 0, closed_at = now()
   where id = v_uid;
  update public.api_keys set revoked_at = coalesce(revoked_at, now()) where owner_id = v_uid;
  delete from public.game_accounts where user_id = v_uid;
  delete from public.profile_settings where user_id = v_uid;
  delete from public.player_rankings where user_id = v_uid;
  delete from public.player_stats where user_id = v_uid;
  delete from public.player_stats_weekly where user_id = v_uid;
end;
$$;

-- ---- Grants -------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array['rib_settings_get()', 'rib_settings_update(jsonb)', 'rib_my_profile()',
                           'rib_profile_update(text,text,text,text)', 'rib_avatar_set(boolean)',
                           'rib_public_profile(text)', 'rib_my_data_export()', 'rib_close_account()'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end;
$$;
revoke execute on function public.rib_country_valid(text) from public, anon;
revoke execute on function public.rib_username_reserved(text) from public, anon;
revoke execute on function public.rib_clean_text(text) from public, anon;
