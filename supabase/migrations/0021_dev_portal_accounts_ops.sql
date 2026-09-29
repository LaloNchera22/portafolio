-- ============================================================================
-- Runinback — developer API, account closure, ops health (2026-09-29).
--
--   1) Developer API keys now authenticate something: rib_api_verify_key()
--      resolves a key hash for the public `api` Edge Function (service role),
--      records last use, and never returns revoked keys. Live keys can't be
--      issued while the platform is in test mode (platform_settings.live_mode).
--   2) Deleting a project revokes its keys instead of silently deleting them.
--   3) Account closure: rib_close_account() anonymizes the profile, revokes
--      API keys and removes the player from rankings, while financial records
--      stay intact for audit. It refuses while money is in play.
--   4) rib_ops_health(): counters the ops-alerts function watches.
-- Idempotent.
-- ============================================================================

insert into public.platform_settings (key, value) values ('live_mode', 'false'::jsonb) on conflict (key) do nothing;

-- ---- 1) API key verification ------------------------------------------------
create or replace function public.rib_api_verify_key(p_key_hash text)
returns table (key_id uuid, owner_id uuid, project_id uuid, project_name text, environment text, key_prefix text)
language plpgsql security definer set search_path = ''
as $$
begin
  return query
    update public.api_keys k
       set last_used_at = now()
     where k.key_hash = p_key_hash and k.revoked_at is null
    returning k.id, k.owner_id, k.project_id,
              (select p.name from public.projects p where p.id = k.project_id),
              k.environment, k.key_prefix;
end;
$$;
revoke execute on function public.rib_api_verify_key(text) from public, anon, authenticated;
grant execute on function public.rib_api_verify_key(text) to service_role;

create or replace function public.rib_live_mode()
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce((select value = 'true'::jsonb from public.platform_settings where key = 'live_mode'), false) $$;
revoke execute on function public.rib_live_mode() from public, anon, authenticated;
grant execute on function public.rib_live_mode() to service_role;

-- ---- 2) Projects: deleting one revokes (not deletes) its keys ---------------
alter table public.api_keys drop constraint if exists api_keys_project_id_fkey;
alter table public.api_keys add constraint api_keys_project_id_fkey
  foreign key (project_id) references public.projects (id) on delete set null;

create or replace function public.rib_revoke_project_keys()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  update public.api_keys set revoked_at = coalesce(revoked_at, now()) where project_id = old.id;
  return old;
end;
$$;
revoke execute on function public.rib_revoke_project_keys() from public, anon, authenticated;
drop trigger if exists projects_revoke_keys on public.projects;
create trigger projects_revoke_keys
  before delete on public.projects
  for each row execute function public.rib_revoke_project_keys();

-- ---- 3) Account closure -------------------------------------------------------
alter table public.profiles add column if not exists closed_at timestamptz;

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
                 where creator_id = v_uid and status in ('open','full','active','payout_pending','disputed')) then
    raise exception 'finish or cancel your open games, challenges and tournaments first' using hint = 'close_account_blocked';
  end if;
  if v_w.frozen_at is not null then
    raise exception 'a wallet on hold cannot be closed' using hint = 'close_account_blocked';
  end if;

  update public.profiles
     set username = 'closed_' || substr(md5(v_uid::text), 1, 12), display_name = null, closed_at = now()
   where id = v_uid;
  update public.api_keys set revoked_at = coalesce(revoked_at, now()) where owner_id = v_uid;
  delete from public.player_rankings where user_id = v_uid;
  delete from public.player_stats where user_id = v_uid;
  delete from public.player_stats_weekly where user_id = v_uid;
end;
$$;
revoke execute on function public.rib_close_account() from public, anon;
grant execute on function public.rib_close_account() to authenticated;

-- ---- 4) Ops health ----------------------------------------------------------
create or replace function public.rib_ops_health()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'client_errors_last_hour', (select count(*) from public.client_errors where created_at > now() - interval '1 hour'),
    'overdue_tournament_payouts', (select count(*) from public.tournaments where status = 'payout_pending' and payout_at < now() - interval '30 minutes'),
    'disputed_tournaments', (select count(*) from public.tournaments where status = 'disputed'),
    'overdue_turn_clocks', (select count(*) from public.game_matches where status = 'active' and turn_deadline < now() - interval '10 minutes'),
    'frozen_wallets', (select count(*) from public.wallets where frozen_at is not null),
    'checked_at', now()
  );
$$;
revoke execute on function public.rib_ops_health() from public, anon, authenticated;
grant execute on function public.rib_ops_health() to service_role;
