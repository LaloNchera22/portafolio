-- ============================================================================
-- Runinback — stuck-escrow resolution (scalability, 2026-09-26).
--
-- TEST MODE, same model as 0001–0005: RLS deny-by-default, every balance move
-- through SECURITY DEFINER RPCs with a fixed empty search_path, atomic.
--
-- Problem this closes: before this migration, escrow could stay locked forever.
-- If a player abandoned a game/challenge mid-way, or the two reports conflicted
-- (a dispute), the staked funds had no way back and the rows piled up. This adds
-- an inactivity VOID: after 2 hours with no progress, either participant can
-- void the match/challenge and BOTH stakes are refunded. A void never pays a
-- winner, so no one profits by stalling — you only get your own stake back.
-- It also adds a tournament cancel that refunds every entry fee (there was no
-- refund path for tournaments at all).
--
-- Inactivity clock: game_matches has updated_at (touched on every move), so an
-- abandoned game ages while an ongoing one stays fresh. challenges has no
-- updated_at, so they clock off matched_at (when the match started).
--
-- Additive and idempotent: CREATE OR REPLACE for the RPCs, drop-if-exists +
-- re-add for the ledger constraint. Safe to run after 0001–0005.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Extend the ledger's kind check to cover tournament refunds. Match voids reuse
-- the existing game_refund / challenge_refund kinds. Dropped and re-added so the
-- migration is re-runnable; the list mirrors 0003 plus 'tournament_refund'.
-- ----------------------------------------------------------------------------
alter table public.wallet_ledger drop constraint if exists wallet_ledger_kind_check;
alter table public.wallet_ledger add constraint wallet_ledger_kind_check
  check (kind in (
    'deposit','withdrawal',
    'challenge_lock','challenge_win','challenge_settled','challenge_refund',
    'tournament_entry','tournament_prize','tournament_refund',
    'rcoin_purchase',
    'game_lock','game_win','game_settled','game_refund'
  ));

-- ----------------------------------------------------------------------------
-- How long a match/challenge must sit with no progress before it can be voided.
-- Kept inline (2 hours) so the RPCs stay self-contained.
-- ----------------------------------------------------------------------------

-- ---- Game: void an abandoned or disputed match -----------------------------
-- Either participant may call it once the match has been idle for 2 hours while
-- 'active' or 'disputed'. Both stakes are released back to their owners; the
-- match is marked 'cancelled'. No winner is paid.
create or replace function public.rib_game_void(p_match_id uuid)
returns public.game_matches
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_m public.game_matches;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select * into v_m from public.game_matches where id = p_match_id for update;
  if v_m.id is null then raise exception 'match not found'; end if;
  if v_uid <> v_m.host_id and v_uid <> v_m.guest_id then raise exception 'you are not in this match'; end if;
  if v_m.status not in ('active','disputed') then raise exception 'this match cannot be voided'; end if;
  if v_m.updated_at > now() - interval '2 hours' then
    raise exception 'too soon: a match can only be voided after 2 hours of inactivity';
  end if;

  -- release both locks back to available balance (stake left the balance at lock time)
  perform public.rib_apply(v_m.host_id,  'game_refund', v_m.stake_cents, -v_m.stake_cents, 'game', v_m.id, 'Match voided (inactivity), stake refunded');
  if v_m.guest_id is not null then
    perform public.rib_apply(v_m.guest_id, 'game_refund', v_m.stake_cents, -v_m.stake_cents, 'game', v_m.id, 'Match voided (inactivity), stake refunded');
  end if;

  update public.game_matches set status = 'cancelled', settled_at = now()
    where id = v_m.id returning * into v_m;
  return v_m;
end;
$$;

-- ---- Challenge: void an abandoned or disputed challenge --------------------
-- Same rule, clocked off matched_at (challenges have no updated_at).
create or replace function public.rib_challenge_void(p_challenge_id uuid)
returns public.challenges
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_c public.challenges;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select * into v_c from public.challenges where id = p_challenge_id for update;
  if v_c.id is null then raise exception 'challenge not found'; end if;
  if v_uid <> v_c.creator_id and v_uid <> v_c.opponent_id then raise exception 'you are not in this challenge'; end if;
  if v_c.status not in ('active','disputed') then raise exception 'this challenge cannot be voided'; end if;
  if v_c.matched_at is null or v_c.matched_at > now() - interval '2 hours' then
    raise exception 'too soon: a challenge can only be voided after 2 hours of inactivity';
  end if;

  perform public.rib_apply(v_c.creator_id,  'challenge_refund', v_c.stake_cents, -v_c.stake_cents, 'challenge', v_c.id, 'Challenge voided (inactivity), stake refunded');
  if v_c.opponent_id is not null then
    perform public.rib_apply(v_c.opponent_id, 'challenge_refund', v_c.stake_cents, -v_c.stake_cents, 'challenge', v_c.id, 'Challenge voided (inactivity), stake refunded');
  end if;

  update public.challenges set status = 'cancelled', settled_at = now()
    where id = v_c.id returning * into v_c;
  return v_c;
end;
$$;

-- ---- Tournament: cancel and refund every entry -----------------------------
-- Organizer only, while still gathering players ('open' or 'full'). Every paid
-- entry fee is returned; the prize pool is zeroed and the tournament closed.
create or replace function public.rib_tournament_cancel(p_tournament_id uuid)
returns public.tournaments
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_t public.tournaments; r record;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select * into v_t from public.tournaments where id = p_tournament_id for update;
  if v_t.id is null then raise exception 'tournament not found'; end if;
  if v_t.creator_id <> v_uid then raise exception 'only the organizer can cancel'; end if;
  if v_t.status not in ('open','full') then raise exception 'this tournament can no longer be cancelled'; end if;

  if v_t.entry_fee_cents > 0 then
    for r in select user_id from public.tournament_entries where tournament_id = v_t.id loop
      perform public.rib_apply(r.user_id, 'tournament_refund', v_t.entry_fee_cents, 0, 'tournament', v_t.id, 'Tournament cancelled, entry refunded');
    end loop;
  end if;

  update public.tournaments set status = 'cancelled', prize_pool_cents = 0, finished_at = now()
    where id = v_t.id returning * into v_t;
  return v_t;
end;
$$;

-- ----------------------------------------------------------------------------
-- Privileges: only the authenticated role may call these RPCs.
-- ----------------------------------------------------------------------------
grant execute on function public.rib_game_void(uuid)          to authenticated;
grant execute on function public.rib_challenge_void(uuid)     to authenticated;
grant execute on function public.rib_tournament_cancel(uuid)  to authenticated;
