-- ============================================================================
-- Runinback — one account type (2026-09-28).
--
-- Sign-up no longer asks "Player or Developer": every account can play and use
-- the developer portal. The role used to come from client-supplied user
-- metadata, which the server must not trust; new accounts now always start as
-- 'player'. Existing rows are untouched. Idempotent.
-- ============================================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare desired_username text;
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
    'player'   -- never taken from client metadata
  ) on conflict (id) do nothing;

  insert into public.wallets (user_id) values (new.id) on conflict (user_id) do nothing;
  return new;
end;
$$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
