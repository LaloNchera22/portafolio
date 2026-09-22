-- ============================================================================
-- Runinback — initial schema (Fase 2)
-- Zero-trust model: Row Level Security is ENABLED on every table and DENIES by
-- default. Access is granted only through the explicit policies below, all keyed
-- to the authenticated user's own id (auth.uid()). The browser talks to the
-- database only through PostgREST + supabase-js, which send every value as a
-- bound parameter — there is no string-concatenated SQL, so the client SQL
-- injection surface does not exist. The functions below are hardened with a
-- fixed, empty search_path so they cannot be hijacked either.
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;

-- ----------------------------------------------------------------------------
-- profiles : one row per auth user, created automatically on sign-up.
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  username     text unique not null
                 check (char_length(username) between 3 and 24
                        and username ~ '^[a-zA-Z0-9_]+$'),
  display_name text check (char_length(display_name) <= 60),
  role         text not null default 'player' check (role in ('player', 'dev')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.profiles is 'Public profile, 1:1 with auth.users. RLS: owner-only.';

-- ----------------------------------------------------------------------------
-- projects : a developer''s project (groups API keys, metrics, payouts).
-- ----------------------------------------------------------------------------
create table if not exists public.projects (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 80),
  environment text not null default 'test' check (environment in ('live', 'test')),
  created_at  timestamptz not null default now()
);

create index if not exists projects_owner_idx on public.projects (owner_id);

-- ----------------------------------------------------------------------------
-- api_keys : only the HASH of a key is ever stored. The plaintext key is shown
-- to the developer exactly once, by the issue-api-key Edge Function, and never
-- persisted. Direct INSERT from the client is denied on purpose (see policies):
-- keys can only be minted server-side where hashing happens.
-- ----------------------------------------------------------------------------
create table if not exists public.api_keys (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users (id) on delete cascade,
  project_id   uuid references public.projects (id) on delete cascade,
  name         text not null default 'default' check (char_length(name) <= 60),
  environment  text not null default 'test' check (environment in ('live', 'test')),
  key_prefix   text not null,          -- e.g. rib_live_ + first 4 chars, safe to show
  key_hash     text not null,          -- sha-256 of the full key, never reversible
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

create index if not exists api_keys_owner_idx on public.api_keys (owner_id);

-- ----------------------------------------------------------------------------
-- Row Level Security — deny by default, then grant owner-only access.
-- ----------------------------------------------------------------------------
alter table public.profiles  enable row level security;
alter table public.projects  enable row level security;
alter table public.api_keys  enable row level security;

-- profiles: a user may read and edit only their own profile.
create policy "profiles: select own"
  on public.profiles for select to authenticated
  using ( id = (select auth.uid()) );

create policy "profiles: update own"
  on public.profiles for update to authenticated
  using ( id = (select auth.uid()) )
  with check ( id = (select auth.uid()) );

-- projects: full owner-only CRUD.
create policy "projects: select own"
  on public.projects for select to authenticated
  using ( owner_id = (select auth.uid()) );

create policy "projects: insert own"
  on public.projects for insert to authenticated
  with check ( owner_id = (select auth.uid()) );

create policy "projects: update own"
  on public.projects for update to authenticated
  using ( owner_id = (select auth.uid()) )
  with check ( owner_id = (select auth.uid()) );

create policy "projects: delete own"
  on public.projects for delete to authenticated
  using ( owner_id = (select auth.uid()) );

-- api_keys: owner may LIST and REVOKE (update revoked_at) their own keys.
-- No INSERT policy => client inserts are rejected by RLS; keys are minted only
-- by the Edge Function using the service role, which bypasses RLS by design.
create policy "api_keys: select own"
  on public.api_keys for select to authenticated
  using ( owner_id = (select auth.uid()) );

create policy "api_keys: revoke own"
  on public.api_keys for update to authenticated
  using ( owner_id = (select auth.uid()) )
  with check ( owner_id = (select auth.uid()) );

-- ----------------------------------------------------------------------------
-- Auto-provision a profile when a new auth user is created.
-- SECURITY DEFINER + a pinned empty search_path: the function runs with its
-- owner''s rights but cannot be tricked into resolving an attacker''s objects.
-- ----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  desired_username text;
begin
  desired_username := coalesce(
    nullif(new.raw_user_meta_data ->> 'username', ''),
    'player_' || substr(new.id::text, 1, 8)
  );

  insert into public.profiles (id, username, display_name, role)
  values (
    new.id,
    desired_username,
    nullif(new.raw_user_meta_data ->> 'display_name', ''),
    coalesce(nullif(new.raw_user_meta_data ->> 'role', ''), 'player')
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------------
-- keep updated_at fresh on profiles.
-- ----------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();
