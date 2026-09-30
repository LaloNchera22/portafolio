-- ============================================================================
-- Runinback — social profile (2026-09-29).
--
--   1) Profile "about": favorite games (up to 5), social handles (Twitch,
--      YouTube, X, Discord) and a banner color, via rib_profile_about_update.
--   2) Friends: requests (accept/decline/cancel), a symmetric friendships
--      table (two rows per pair, so "my friends" is one index range), caps
--      of 1,000 friends and 100 pending sent requests.
--   3) Blocks: a block removes the friendship and any request both ways,
--      hides the blocker's card from the blocked player, and stops friend
--      requests and direct friendlies between them.
--   4) Privacy: who sees my full card (everyone | friends), who can send me
--      friend requests (everyone | nobody), who can challenge me directly
--      (everyone | friends | nobody). Enforced in the RPCs and in a trigger
--      on challenges, so every path to a direct friendly obeys it.
--   5) rib_public_profile gains relationship, counts, achievements and the
--      about section, and honors blocks and visibility.
-- Idempotent.
-- ============================================================================

-- ---- 1) About -----------------------------------------------------------------
alter table public.profiles add column if not exists favorite_games text[] not null default '{}';
alter table public.profiles add column if not exists links jsonb not null default '{}'::jsonb;
alter table public.profiles add column if not exists banner text not null default 'ink';

alter table public.profiles drop constraint if exists profiles_favorite_games_check;
alter table public.profiles add constraint profiles_favorite_games_check
  check (cardinality(favorite_games) <= 5) not valid;
alter table public.profiles validate constraint profiles_favorite_games_check;
alter table public.profiles drop constraint if exists profiles_banner_check;
alter table public.profiles add constraint profiles_banner_check
  check (banner in ('ink','match','escrow','settle','sdk','good')) not valid;
alter table public.profiles validate constraint profiles_banner_check;
alter table public.profiles drop constraint if exists profiles_links_check;
alter table public.profiles add constraint profiles_links_check
  check (jsonb_typeof(links) = 'object' and octet_length(links::text) <= 600) not valid;
alter table public.profiles validate constraint profiles_links_check;

-- Handles only, never URLs: the client builds the link, so nothing a player
-- types can become a javascript: or phishing URL.
create or replace function public.rib_link_valid(p_kind text, p_handle text)
returns boolean
language sql immutable set search_path = ''
as $$
  select case p_kind
    when 'twitch'  then p_handle ~ '^[A-Za-z0-9_]{4,25}$'
    when 'youtube' then p_handle ~ '^@?[A-Za-z0-9._-]{3,30}$'
    when 'x'       then p_handle ~ '^[A-Za-z0-9_]{1,15}$'
    when 'discord' then p_handle ~ '^[a-z0-9_.]{2,32}$'
    else false end;
$$;

create or replace function public.rib_profile_about_update(
  p_favorite_games text[] default '{}', p_links jsonb default '{}'::jsonb, p_banner text default 'ink'
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_games text[] := '{}';
  g text;
  k text;
  v_links jsonb := '{}'::jsonb;
  v_handle text;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  perform public.rib_assert_open_account(v_uid);
  if not public.rib_rate_limit_hit('profile_update', v_uid, 20, 3600) then
    raise exception 'too many changes, try again later' using hint = 'rate_limited';
  end if;
  if cardinality(coalesce(p_favorite_games, '{}')) > 10 then raise exception 'pick up to 5 games' using hint = 'invalid_favorite_games'; end if;
  -- Games: cleaned, 1-30 characters, no duplicates (any case), max 5.
  foreach g in array coalesce(p_favorite_games, '{}') loop
    g := public.rib_clean_text(g);
    if g is null then continue; end if;
    if char_length(g) > 30 then raise exception 'game names are up to 30 characters' using hint = 'invalid_favorite_games'; end if;
    if exists (select 1 from unnest(v_games) x where lower(x) = lower(g)) then continue; end if;
    v_games := v_games || g;
  end loop;
  if cardinality(v_games) > 5 then raise exception 'pick up to 5 games' using hint = 'invalid_favorite_games'; end if;

  if p_links is null or jsonb_typeof(p_links) <> 'object' then raise exception 'invalid links' using hint = 'invalid_link'; end if;
  for k in select jsonb_object_keys(p_links) loop
    if k not in ('twitch','youtube','x','discord') then raise exception 'unknown link %', k using hint = 'invalid_link'; end if;
    if jsonb_typeof(p_links -> k) <> 'string' then continue; end if;
    v_handle := nullif(trim(p_links ->> k), '');
    if v_handle is null then continue; end if;
    if not public.rib_link_valid(k, v_handle) then raise exception 'that % name isn''t valid', k using hint = 'invalid_link'; end if;
    v_links := v_links || jsonb_build_object(k, v_handle);
  end loop;

  if coalesce(p_banner, 'ink') not in ('ink','match','escrow','settle','sdk','good') then
    raise exception 'unknown banner' using hint = 'invalid_banner';
  end if;

  update public.profiles
     set favorite_games = v_games, links = v_links, banner = coalesce(p_banner, 'ink'), updated_at = now()
   where id = v_uid;
  return jsonb_build_object('favorite_games', to_jsonb(v_games), 'links', v_links, 'banner', coalesce(p_banner, 'ink'));
end;
$$;

-- ---- 2) Friends and 3) blocks ------------------------------------------------------
create table if not exists public.friend_requests (
  from_id    uuid not null references auth.users (id) on delete cascade,
  to_id      uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (from_id, to_id),
  check (from_id <> to_id)
);
create index if not exists friend_requests_to_idx on public.friend_requests (to_id, created_at desc);

create table if not exists public.friendships (
  user_id    uuid not null references auth.users (id) on delete cascade,
  friend_id  uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, friend_id),
  check (user_id <> friend_id)
);

create table if not exists public.user_blocks (
  blocker_id uuid not null references auth.users (id) on delete cascade,
  blocked_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index if not exists user_blocks_blocked_idx on public.user_blocks (blocked_id);

alter table public.friend_requests enable row level security;
alter table public.friendships enable row level security;
alter table public.user_blocks enable row level security;
revoke all on public.friend_requests, public.friendships, public.user_blocks from anon, authenticated;
comment on table public.friendships is 'Two rows per friendship (one per side). RPC access only.';

-- rib_my_profile / rib_profile_update return the about fields and friend count.
create or replace function public.rib_profile_json(p public.profiles)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'username', p.username, 'display_name', p.display_name, 'bio', p.bio, 'country', p.country,
    'avatar_version', p.avatar_version, 'created_at', p.created_at,
    'favorite_games', to_jsonb(p.favorite_games), 'links', p.links, 'banner', p.banner,
    'friend_count', (select count(*) from public.friendships f where f.user_id = p.id),
    'username_next_change_at', case when p.username_changed_at > now() - interval '30 days'
                                    then p.username_changed_at + interval '30 days' end);
$$;

-- Privacy settings (profile_settings rows are created lazily; defaults are open).
alter table public.profile_settings add column if not exists profile_visibility text not null default 'everyone';
alter table public.profile_settings add column if not exists friend_requests_from text not null default 'everyone';
alter table public.profile_settings add column if not exists challenges_from text not null default 'everyone';
alter table public.profile_settings drop constraint if exists profile_settings_social_check;
alter table public.profile_settings add constraint profile_settings_social_check check (
  profile_visibility in ('everyone','friends')
  and friend_requests_from in ('everyone','nobody')
  and challenges_from in ('everyone','friends','nobody'));

create or replace function public.rib_blocked_between(p_a uuid, p_b uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.user_blocks
                  where (blocker_id = p_a and blocked_id = p_b) or (blocker_id = p_b and blocked_id = p_a));
$$;

create or replace function public.rib_are_friends(p_a uuid, p_b uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.friendships where user_id = p_a and friend_id = p_b);
$$;

-- Resolve a username to an open account (null when missing or closed).
create or replace function public.rib_user_by_name(p_username text)
returns uuid
language sql stable security definer set search_path = ''
as $$
  select id from public.profiles
   where lower(username) = lower(trim(coalesce(p_username, ''))) and closed_at is null;
$$;

create or replace function public.rib_relationship(p_me uuid, p_other uuid)
returns text
language sql stable security definer set search_path = ''
as $$
  select case
    when p_me = p_other then 'me'
    when exists (select 1 from public.user_blocks where blocker_id = p_me and blocked_id = p_other) then 'blocked'
    when exists (select 1 from public.friendships where user_id = p_me and friend_id = p_other) then 'friends'
    when exists (select 1 from public.friend_requests where from_id = p_me and to_id = p_other) then 'requested'
    when exists (select 1 from public.friend_requests where from_id = p_other and to_id = p_me) then 'incoming'
    else 'none' end;
$$;

create or replace function public.rib_make_friends(p_a uuid, p_b uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if (select count(*) from public.friendships where user_id = p_a) >= 1000
     or (select count(*) from public.friendships where user_id = p_b) >= 1000 then
    raise exception 'friend list is full (1,000 max)' using hint = 'friend_limit';
  end if;
  delete from public.friend_requests where (from_id = p_a and to_id = p_b) or (from_id = p_b and to_id = p_a);
  insert into public.friendships (user_id, friend_id) values (p_a, p_b), (p_b, p_a) on conflict do nothing;
end;
$$;

-- Send a request; if they already asked me, we become friends.
create or replace function public.rib_friend_request(p_username text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_to uuid; v_pref text;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  perform public.rib_assert_open_account(v_uid);
  if not public.rib_rate_limit_hit('friend_request', v_uid, 30, 3600) then
    raise exception 'too many requests, try again later' using hint = 'rate_limited';
  end if;
  v_to := public.rib_user_by_name(p_username);
  if v_to is null or public.rib_blocked_between(v_uid, v_to) then raise exception 'user not found' using hint = 'user_not_found'; end if;
  if v_to = v_uid then raise exception 'that''s you' using hint = 'cannot_friend_self'; end if;
  -- Both players, in a fixed order, so crossing requests can't deadlock.
  perform public.rib_lock_user(least(v_uid, v_to));
  perform public.rib_lock_user(greatest(v_uid, v_to));
  if public.rib_are_friends(v_uid, v_to) then return 'friends'; end if;
  if exists (select 1 from public.friend_requests where from_id = v_to and to_id = v_uid) then
    perform public.rib_make_friends(v_uid, v_to);
    return 'friends';
  end if;
  if exists (select 1 from public.friend_requests where from_id = v_uid and to_id = v_to) then return 'requested'; end if;
  select friend_requests_from into v_pref from public.profile_settings where user_id = v_to;
  if coalesce(v_pref, 'everyone') = 'nobody' then
    raise exception 'this player isn''t accepting friend requests' using hint = 'friend_requests_closed';
  end if;
  if (select count(*) from public.friend_requests where from_id = v_uid) >= 100 then
    raise exception 'too many pending requests (100 max)' using hint = 'too_many_requests';
  end if;
  insert into public.friend_requests (from_id, to_id) values (v_uid, v_to);
  return 'requested';
end;
$$;

create or replace function public.rib_friend_respond(p_username text, p_accept boolean)
returns text
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_from uuid;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  perform public.rib_assert_open_account(v_uid);
  v_from := public.rib_user_by_name(p_username);
  if v_from is null or not exists (select 1 from public.friend_requests where from_id = v_from and to_id = v_uid) then
    raise exception 'that request is no longer there' using hint = 'request_not_found';
  end if;
  perform public.rib_lock_user(least(v_uid, v_from));
  perform public.rib_lock_user(greatest(v_uid, v_from));
  if coalesce(p_accept, false) then
    perform public.rib_make_friends(v_uid, v_from);
    return 'friends';
  end if;
  delete from public.friend_requests where from_id = v_from and to_id = v_uid;
  return 'none';
end;
$$;

create or replace function public.rib_friend_cancel(p_username text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  delete from public.friend_requests where from_id = v_uid and to_id = public.rib_user_by_name(p_username);
  return 'none';
end;
$$;

create or replace function public.rib_friend_remove(p_username text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_other uuid;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  v_other := public.rib_user_by_name(p_username);
  delete from public.friendships where (user_id = v_uid and friend_id = v_other) or (user_id = v_other and friend_id = v_uid);
  return 'none';
end;
$$;

-- My friends, alphabetical, keyset-paginated by lower(username).
create or replace function public.rib_friends(p_query text default null, p_after text default null, p_limit int default 50)
returns table (username text, display_name text, avatar text, country text, since timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_q text := nullif(replace(replace(replace(lower(left(trim(coalesce(p_query, '')), 24)), '\', '\\'), '%', '\%'), '_', '\_'), '');
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  return query
    select p.username, p.display_name,
           case when p.avatar_version > 0 then p.id::text || '/avatar.webp?v=' || p.avatar_version end,
           p.country, f.created_at
      from public.friendships f
      join public.profiles p on p.id = f.friend_id
     where f.user_id = v_uid and p.closed_at is null
       and (v_q is null or lower(p.username) like '%' || v_q || '%' or lower(coalesce(p.display_name, '')) like '%' || v_q || '%')
       and (p_after is null or lower(p.username) > lower(p_after))
     order by lower(p.username)
     limit least(greatest(coalesce(p_limit, 50), 1), 100);
end;
$$;

create or replace function public.rib_friend_requests()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  return jsonb_build_object(
    'incoming', (select coalesce(jsonb_agg(jsonb_build_object('username', p.username, 'display_name', p.display_name,
                   'avatar', case when p.avatar_version > 0 then p.id::text || '/avatar.webp?v=' || p.avatar_version end,
                   'at', r.created_at) order by r.created_at desc), '[]'::jsonb)
                   from (select * from public.friend_requests where to_id = v_uid order by created_at desc limit 100) r
                   join public.profiles p on p.id = r.from_id where p.closed_at is null),
    'outgoing', (select coalesce(jsonb_agg(jsonb_build_object('username', p.username, 'display_name', p.display_name,
                   'avatar', case when p.avatar_version > 0 then p.id::text || '/avatar.webp?v=' || p.avatar_version end,
                   'at', r.created_at) order by r.created_at desc), '[]'::jsonb)
                   from (select * from public.friend_requests where from_id = v_uid order by created_at desc limit 100) r
                   join public.profiles p on p.id = r.to_id where p.closed_at is null));
end;
$$;

create or replace function public.rib_block(p_username text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_other uuid;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  v_other := public.rib_user_by_name(p_username);
  if v_other is null then raise exception 'user not found' using hint = 'user_not_found'; end if;
  if v_other = v_uid then raise exception 'that''s you' using hint = 'cannot_block_self'; end if;
  if (select count(*) from public.user_blocks where blocker_id = v_uid) >= 1000 then
    raise exception 'block list is full (1,000 max)' using hint = 'block_limit';
  end if;
  perform public.rib_lock_user(least(v_uid, v_other));
  perform public.rib_lock_user(greatest(v_uid, v_other));
  insert into public.user_blocks (blocker_id, blocked_id) values (v_uid, v_other) on conflict do nothing;
  delete from public.friendships where (user_id = v_uid and friend_id = v_other) or (user_id = v_other and friend_id = v_uid);
  delete from public.friend_requests where (from_id = v_uid and to_id = v_other) or (from_id = v_other and to_id = v_uid);
  -- A direct friendly still waiting between them is withdrawn (friendlies are free: no money moves).
  update public.challenges set status = 'cancelled'
   where status = 'pending' and ((creator_id = v_uid and target_id = v_other) or (creator_id = v_other and target_id = v_uid));
  return 'blocked';
end;
$$;

create or replace function public.rib_unblock(p_username text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  delete from public.user_blocks
   where blocker_id = v_uid
     and blocked_id = (select id from public.profiles where lower(username) = lower(trim(coalesce(p_username, ''))));
  return 'none';
end;
$$;

create or replace function public.rib_blocked()
returns table (username text, since timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  return query
    select p.username, b.created_at
      from public.user_blocks b join public.profiles p on p.id = b.blocked_id
     where b.blocker_id = auth.uid()
     order by b.created_at desc
     limit 1000;
end;
$$;

-- ---- 4) Privacy ----------------------------------------------------------------------
create or replace function public.rib_settings_json(p public.profile_settings)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'match_toasts', p.match_toasts,
    'product_emails', p.product_emails,
    'show_on_leaderboard', p.show_on_leaderboard,
    'show_game_accounts', p.show_game_accounts,
    'profile_visibility', p.profile_visibility,
    'friend_requests_from', p.friend_requests_from,
    'challenges_from', p.challenges_from,
    'monthly_cap_cents', p.monthly_cap_cents,
    'month_spent_cents', public.rib_month_entry_spend(p.user_id),
    'cooloff_until', p.cooloff_until,
    'pending_cap', case when p.pending_cap_set then jsonb_build_object('cents', p.pending_cap_cents, 'at', p.pending_cap_at) end,
    'pending_cooloff_end_at', p.pending_cooloff_end_at,
    'next_export_at', case when p.last_export_at > now() - interval '1 hour' then p.last_export_at + interval '1 hour' end
  );
$$;

create or replace function public.rib_privacy_update(
  p_profile_visibility text default null, p_friend_requests_from text default null, p_challenges_from text default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v public.profile_settings;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  perform public.rib_assert_open_account(v_uid);
  if (p_profile_visibility is not null and p_profile_visibility not in ('everyone','friends'))
     or (p_friend_requests_from is not null and p_friend_requests_from not in ('everyone','nobody'))
     or (p_challenges_from is not null and p_challenges_from not in ('everyone','friends','nobody')) then
    raise exception 'invalid privacy setting' using hint = 'invalid_setting';
  end if;
  if not public.rib_rate_limit_hit('settings_update', v_uid, 60, 3600) then
    raise exception 'too many changes, try again later' using hint = 'rate_limited';
  end if;
  perform public.rib_settings_row(v_uid);
  update public.profile_settings
     set profile_visibility   = coalesce(p_profile_visibility, profile_visibility),
         friend_requests_from = coalesce(p_friend_requests_from, friend_requests_from),
         challenges_from      = coalesce(p_challenges_from, challenges_from),
         updated_at = now()
   where user_id = v_uid
  returning * into v;
  return public.rib_settings_json(v);
end;
$$;

-- Direct friendlies (a named opponent) and taking someone's open one obey
-- blocks and the target's "who can challenge me". A trigger covers every
-- RPC that writes challenges.
create or replace function public.rib_guard_challenge_people()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare v_pref text;
begin
  if new.target_id is not null and (tg_op = 'INSERT' or new.target_id is distinct from old.target_id) then
    if public.rib_blocked_between(new.creator_id, new.target_id) then
      raise exception 'user not found' using hint = 'user_not_found';
    end if;
    select challenges_from into v_pref from public.profile_settings where user_id = new.target_id;
    if coalesce(v_pref, 'everyone') = 'nobody'
       or (v_pref = 'friends' and not public.rib_are_friends(new.creator_id, new.target_id)) then
      raise exception 'this player isn''t taking direct friendlies from you' using hint = 'challenges_closed';
    end if;
  end if;
  if new.opponent_id is not null and tg_op = 'UPDATE' and new.opponent_id is distinct from old.opponent_id
     and public.rib_blocked_between(new.creator_id, new.opponent_id) then
    raise exception 'this friendly is not available' using hint = 'challenge_unavailable';
  end if;
  return new;
end;
$$;
revoke execute on function public.rib_guard_challenge_people() from public, anon, authenticated;
drop trigger if exists guard_challenge_people on public.challenges;
create trigger guard_challenge_people before insert or update of target_id, opponent_id on public.challenges
  for each row execute function public.rib_guard_challenge_people();

-- ---- 5) Public profile ---------------------------------------------------------------------
-- A player who blocked me reads as "not found". A card set to friends-only
-- shows just the name, photo and banner to others (like a private profile).
create or replace function public.rib_public_profile(p_username text)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v public.profiles; v_s public.profile_settings;
  v_ranked boolean; v_me boolean; v_rel text; v_full boolean;
  v_played int; v_titles int; v_finals int;
begin
  if v_uid is null then raise exception 'not signed in' using hint = 'not_authenticated'; end if;
  if not public.rib_rate_limit_hit('profile_lookup', v_uid, 120, 60) then
    raise exception 'too many profile views, slow down' using hint = 'rate_limited';
  end if;
  if p_username is null or char_length(trim(p_username)) not between 3 and 24 then return null; end if;
  select * into v from public.profiles where lower(username) = lower(trim(p_username));
  if v.id is null or v.closed_at is not null then return null; end if;
  if exists (select 1 from public.user_blocks where blocker_id = v.id and blocked_id = v_uid) then return null; end if;
  select * into v_s from public.profile_settings where user_id = v.id;
  v_me := v.id = v_uid;
  v_rel := public.rib_relationship(v_uid, v.id);
  v_full := v_me or (v_rel <> 'blocked' and (coalesce(v_s.profile_visibility, 'everyone') = 'everyone' or v_rel = 'friends'));
  v_ranked := coalesce(v_s.show_on_leaderboard, true);

  if v_full and (v_ranked or v_me) then
    select count(*), count(*) filter (where e.placement = 1), count(*) filter (where e.placement <= 2)
      into v_played, v_titles, v_finals
      from public.tournament_entries e join public.tournaments t on t.id = e.tournament_id
     where e.user_id = v.id and t.status = 'finished' and t.format = 'bracket';
  end if;

  return jsonb_build_object(
    'username', v.username, 'display_name', v.display_name,
    'avatar', case when v.avatar_version > 0 then v.id::text || '/avatar.webp?v=' || v.avatar_version end,
    'banner', v.banner, 'is_me', v_me, 'relationship', v_rel, 'full', v_full, 'ranked', v_ranked,
    'created_at', v.created_at,
    'friend_count', case when v_full then (select count(*) from public.friendships f where f.user_id = v.id) end,
    'can_challenge', not v_me and v_rel <> 'blocked' and case coalesce(v_s.challenges_from, 'everyone')
                       when 'everyone' then true when 'friends' then v_rel = 'friends' else false end,
    'can_request', not v_me and v_rel = 'none' and coalesce(v_s.friend_requests_from, 'everyone') = 'everyone',
    'bio', case when v_full then v.bio end,
    'country', case when v_full then v.country end,
    'favorite_games', case when v_full then to_jsonb(v.favorite_games) end,
    'links', case when v_full then v.links end,
    'achievements', case when v_full and (v_ranked or v_me) then
      jsonb_build_object('played', v_played, 'titles', v_titles, 'finals', v_finals,
                         'wins', coalesce((select s.wins from public.player_stats s where s.user_id = v.id), 0)) end,
    'stats', case when v_full and (v_ranked or v_me) then (
      select jsonb_build_object('net_cents', s.net_cents, 'won_cents', s.won_cents, 'wins', s.wins, 'losses', s.losses,
                                'rank_all', nullif(r.rank_all, 0))
        from public.player_stats s left join public.player_rankings r on r.user_id = s.user_id
       where s.user_id = v.id) end,
    'game_accounts', case when v_full and (coalesce(v_s.show_game_accounts, false) or v_me) then (
      select coalesce(jsonb_agg(jsonb_build_object('network', g.network, 'handle', g.handle) order by g.network), '[]'::jsonb)
        from public.game_accounts g where g.user_id = v.id) end,
    'tournaments', case when v_full and (v_ranked or v_me) then (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.finished_at desc), '[]'::jsonb) from (
        select t.name, t.game, t.max_players as size, e.placement, t.finished_at
          from public.tournament_entries e join public.tournaments t on t.id = e.tournament_id
         where e.user_id = v.id and t.status = 'finished' and t.format = 'bracket'
         order by t.finished_at desc limit 10) x) end
  );
end;
$$;

-- Closing an account also drops its social graph and about section.
create or replace function public.rib_on_profile_closed()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.closed_at is not null and old.closed_at is null then
    delete from public.friendships where user_id = new.id or friend_id = new.id;
    delete from public.friend_requests where from_id = new.id or to_id = new.id;
    delete from public.user_blocks where blocker_id = new.id or blocked_id = new.id;
    update public.profiles set favorite_games = '{}', links = '{}'::jsonb, banner = 'ink' where id = new.id;
  end if;
  return null;
end;
$$;
drop trigger if exists on_profile_closed on public.profiles;
create trigger on_profile_closed after update of closed_at on public.profiles
  for each row execute function public.rib_on_profile_closed();

-- ---- Grants ------------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array['rib_profile_about_update(text[],jsonb,text)', 'rib_friend_request(text)', 'rib_friend_respond(text,boolean)',
                           'rib_friend_cancel(text)', 'rib_friend_remove(text)', 'rib_friends(text,text,int)', 'rib_friend_requests()',
                           'rib_block(text)', 'rib_unblock(text)', 'rib_blocked()', 'rib_privacy_update(text,text,text)',
                           'rib_public_profile(text)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['rib_blocked_between(uuid,uuid)', 'rib_are_friends(uuid,uuid)', 'rib_user_by_name(text)',
                           'rib_relationship(uuid,uuid)', 'rib_make_friends(uuid,uuid)', 'rib_on_profile_closed()',
                           'rib_link_valid(text,text)', 'rib_profile_json(public.profiles)', 'rib_settings_json(public.profile_settings)'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
end;
$$;
