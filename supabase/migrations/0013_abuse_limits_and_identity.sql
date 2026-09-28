-- ============================================================================
-- Runinback — abuse limits and identity hardening (2026-09-28).
--
--   1) Rate limits: a fixed-window counter the Edge Functions consult before
--      creating checkouts, issuing API keys or committing moves.
--   2) Reserved Steam identities: e-mails @steam.local can only be created by
--      the steam-auth function (it stamps app_metadata.steamid, which clients
--      can't write). Stops pre-registering a Steam player's account.
--   3) Usernames are unique case-insensitively ("Alice" vs "alice").
--   4) profiles: other players can read handles, not roles.
-- Idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Rate limits
-- ----------------------------------------------------------------------------
create table if not exists public.rate_limits (
  bucket       text        not null,
  subject      uuid        not null,
  window_start timestamptz not null,
  hits         int         not null default 0,
  primary key (bucket, subject, window_start)
);
alter table public.rate_limits enable row level security;
revoke all on public.rate_limits from anon, authenticated;
comment on table public.rate_limits is 'Fixed-window request counters for Edge Functions. Server-only.';

-- Count one hit; true while the subject is within p_max hits per window.
create or replace function public.rib_rate_limit_hit(
  p_bucket text, p_subject uuid, p_max int, p_window_seconds int
) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare v_window timestamptz; v_hits int;
begin
  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.rate_limits as rl (bucket, subject, window_start, hits)
  values (p_bucket, p_subject, v_window, 1)
  on conflict (bucket, subject, window_start) do update set hits = rl.hits + 1
  returning hits into v_hits;
  return v_hits <= p_max;
end;
$$;
revoke execute on function public.rib_rate_limit_hit(text,uuid,int,int) from public, anon, authenticated;
grant execute on function public.rib_rate_limit_hit(text,uuid,int,int) to service_role;

create or replace function public.rib_rate_limit_gc()
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare v_deleted bigint;
begin
  delete from public.rate_limits where window_start < now() - interval '1 day';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;
revoke execute on function public.rib_rate_limit_gc() from public, anon, authenticated;
grant execute on function public.rib_rate_limit_gc() to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('rib-rate-limit-gc', '41 * * * *', 'select public.rib_rate_limit_gc()');
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- 2) Reserved Steam identities
-- ----------------------------------------------------------------------------
create or replace function public.rib_guard_reserved_emails()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if lower(coalesce(new.email, '')) like '%@steam.local'
     and coalesce(new.raw_app_meta_data ->> 'steamid', '') = ''
     and (tg_op = 'INSERT' or new.email is distinct from old.email) then
    raise exception 'this e-mail domain is reserved' using hint = 'email_reserved';
  end if;
  return new;
end;
$$;
revoke execute on function public.rib_guard_reserved_emails() from public, anon, authenticated;
drop trigger if exists guard_reserved_emails on auth.users;
create trigger guard_reserved_emails
  before insert or update of email on auth.users
  for each row execute function public.rib_guard_reserved_emails();

-- ----------------------------------------------------------------------------
-- 3) Case-insensitive usernames (only if existing data allows it).
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select lower(username) from public.profiles group by lower(username) having count(*) > 1) then
    raise warning 'profiles has usernames that differ only by case; resolve them, then re-run to add profiles_username_lower_uidx';
  else
    create unique index if not exists profiles_username_lower_uidx on public.profiles (lower(username));
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- 4) profiles: readable columns for signed-in users (RLS still limits rows).
-- ----------------------------------------------------------------------------
revoke select on public.profiles from authenticated;
grant select (id, username, display_name, created_at) on public.profiles to authenticated;
