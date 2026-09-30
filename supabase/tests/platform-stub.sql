-- Minimal stand-in for the Supabase platform (roles + auth schema) so the
-- migrations can be applied to a plain Postgres in CI. Mirrors Supabase's
-- default privileges: new objects in public are granted to the API roles.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

create schema extensions;
create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (
  id                 uuid primary key,
  email              text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  raw_app_meta_data  jsonb default '{}'::jsonb
);
create function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant execute on function auth.uid() to anon, authenticated, service_role;
create function auth.role() returns text
language sql stable
as $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
grant execute on function auth.role() to anon, authenticated, service_role;

-- Supabase Storage (just what the migrations and policies use): buckets,
-- objects under RLS, and storage.foldername().
create schema storage;
grant usage on schema storage to anon, authenticated, service_role;
create table storage.buckets (
  id                 text primary key,
  name               text not null,
  public             boolean default false,
  file_size_limit    bigint,
  allowed_mime_types text[]
);
create table storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets (id),
  name       text not null,
  owner      uuid default auth.uid(),
  created_at timestamptz default now(),
  unique (bucket_id, name)
);
alter table storage.objects enable row level security;
grant select, insert, update, delete on storage.objects to authenticated, service_role;
create function storage.foldername(name text) returns text[]
language plpgsql immutable
as $$
declare _parts text[];
begin
  _parts := string_to_array(name, '/');
  return _parts[1:array_length(_parts, 1) - 1];
end;
$$;
grant execute on function storage.foldername(text) to anon, authenticated, service_role;
