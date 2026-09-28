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
  raw_user_meta_data jsonb default '{}'::jsonb
);
create function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant execute on function auth.uid() to anon, authenticated, service_role;
