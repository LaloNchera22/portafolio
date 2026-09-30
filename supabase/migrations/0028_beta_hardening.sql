-- ============================================================================
-- Runinback — beta hardening (2026-09-30).
--
--   1) Validate the check constraints 0027 added NOT VALID.
--   2) Signed-out previews of a private tournament hide the champion too.
--
-- 1) 0027 added the constraints NOT VALID so that migration never scanned the big tables
-- under its locks. New and updated rows have been checked since; this
-- validates the existing rows too. VALIDATE CONSTRAINT takes only a
-- SHARE UPDATE EXCLUSIVE lock (reads and writes keep going), so it is safe to
-- run on a live database. Idempotent: already-valid constraints are skipped.
-- ============================================================================

-- 1) Validate.
do $$
declare c record;
begin
  for c in
    select con.conrelid::regclass as tbl, con.conname
      from pg_constraint con
     where con.contype = 'c'
       and not con.convalidated
       and (con.conrelid, con.conname) in (
         ('public.tournaments'::regclass,         'tournaments_mode_check'),
         ('public.tournaments'::regclass,         'tournaments_visibility_check'),
         ('public.tournaments'::regclass,         'tournaments_invite_code_check'),
         ('public.tournaments'::regclass,         'tournaments_rules_check'),
         ('public.tournaments'::regclass,         'tournaments_host_fee_cents_check'),
         ('public.match_rooms'::regclass,         'match_rooms_host_note_check'),
         ('public.match_rooms'::regclass,         'match_rooms_status_check'),
         ('public.room_messages'::regclass,       'room_messages_kind_check'),
         ('public.room_messages'::regclass,       'room_messages_image_path_check'),
         ('public.tournament_disputes'::regclass, 'tournament_disputes_status_check'),
         ('public.tournament_disputes'::regclass, 'tournament_disputes_deposit_cents_check'),
         ('public.tournament_disputes'::regclass, 'tournament_disputes_resolution_note_check'),
         ('public.wallet_ledger'::regclass,       'wallet_ledger_kind_check')
       )
  loop
    execute format('alter table %s validate constraint %I', c.tbl, c.conname);
  end loop;
end;
$$;

-- 2) A signed-out preview of a private tournament shows no usernames at all
--    (host and rules were already hidden; the champion leaked).
create or replace function public.rib_tournament_preview(p_code text)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_t public.tournaments; v_code text := upper(btrim(coalesce(p_code, ''))); v_host text; v_winner text;
        v_hide boolean;
begin
  if v_uid is not null and public.rib_invite_lookups_exceeded(v_uid) then
    raise exception 'too many invite codes tried: wait a few minutes' using hint = 'rate_limited';
  end if;
  if v_code ~ '^[A-HJ-NP-Z2-9]{10}$' then
    select * into v_t from public.tournaments where invite_code = v_code and mode = 'hosted';
  end if;
  if v_t.id is null then
    if v_uid is not null then perform public.rib_rate_limit_hit('invite_lookup', v_uid, 20, 600); end if;
    return null;
  end if;
  v_hide := v_uid is null and v_t.visibility = 'private';
  select username into v_host from public.profiles where id = v_t.creator_id and not v_hide;
  select username into v_winner from public.profiles where id = v_t.winner_id and not v_hide;
  return jsonb_build_object(
    'id', v_t.id, 'name', v_t.name, 'host_username', v_host, 'mode', v_t.mode, 'visibility', v_t.visibility,
    'status', v_t.status, 'size', v_t.max_players, 'entrants', v_t.entrants,
    'min_entrants', public.rib_tournament_min_entrants(), 'entry_fee_cents', v_t.entry_fee_cents,
    'rules', case when v_hide then null else v_t.rules end,
    'created_at', v_t.created_at, 'started_at', v_t.started_at, 'payout_at', v_t.payout_at,
    'winner_username', v_winner,
    'prize_now',  public.rib_hosted_split(v_t.entry_fee_cents * v_t.entrants),
    'prize_full', public.rib_hosted_split(v_t.entry_fee_cents * v_t.max_players),
    'is_host', case when v_uid is null then null else v_t.creator_id = v_uid end,
    'joined',  case when v_uid is null then null
                    else exists (select 1 from public.tournament_entries e where e.tournament_id = v_t.id and e.user_id = v_uid) end);
end;
$$;
