-- ============================================================================
-- Runinback — client error reports (2026-09-29).
--
-- The console reports uncaught browser errors so production failures are
-- visible without a third-party service. Reports are capped per user (rate
-- limit), truncated, server-only to read, and kept for 14 days.
-- Idempotent.
-- ============================================================================

create table if not exists public.client_errors (
  id         bigint generated always as identity primary key,
  user_id    uuid references auth.users (id) on delete set null,
  message    text not null,
  source     text,
  url        text,
  stack      text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists client_errors_created_idx on public.client_errors (created_at desc);
alter table public.client_errors enable row level security;
revoke all on public.client_errors from anon, authenticated;
comment on table public.client_errors is 'Uncaught browser errors reported by the console (14-day retention). Server-only.';

create or replace function public.rib_log_client_error(
  p_message text, p_source text default null, p_url text default null, p_stack text default null, p_user_agent text default null
) returns void
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null or p_message is null or char_length(trim(p_message)) = 0 then return; end if;
  -- At most 30 reports per user per hour; extra reports are dropped silently.
  if not public.rib_rate_limit_hit('client_error', v_uid, 30, 3600) then return; end if;
  insert into public.client_errors (user_id, message, source, url, stack, user_agent)
  values (v_uid, left(p_message, 500), left(p_source, 200), left(p_url, 300), left(p_stack, 4000), left(p_user_agent, 300));
end;
$$;
revoke execute on function public.rib_log_client_error(text,text,text,text,text) from public, anon;
grant execute on function public.rib_log_client_error(text,text,text,text,text) to authenticated;

create or replace function public.rib_client_errors_gc()
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare v_deleted bigint;
begin
  delete from public.client_errors where created_at < now() - interval '14 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;
revoke execute on function public.rib_client_errors_gc() from public, anon, authenticated;
grant execute on function public.rib_client_errors_gc() to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('rib-client-errors-gc', '23 4 * * *', 'select public.rib_client_errors_gc()');
  end if;
end;
$$;
