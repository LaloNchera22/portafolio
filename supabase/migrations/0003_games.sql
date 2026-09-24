-- ============================================================================
-- Runinback — games + rcoin (Phase 2.2): casual multiplayer games on the
-- dashboard, and the rcoin currency layer on top of the test-mode wallet.
--
-- TEST MODE. Real money on Runinback is NON-CUSTODIAL and lives on-chain on
-- Base (escrow contracts + audit, Phase 3+). Until then this schema runs the
-- WHOLE flow end-to-end on an off-chain test balance. No real funds move here.
--
-- rcoin model (transparent, never hidden): the 5% commission is charged ONCE,
-- when money comes IN. It is shown as a clear rate ($100 = 95 rcoin). Inside
-- the platform 1 rcoin = 1 USD, so withdrawals pay out 1:1 with no exit fee.
-- Game pots carry NO rake: both players stake, the winner takes the full pot.
--
-- Zero-trust, same as 0001/0002: RLS enabled and DENY by default on every
-- table. The client NEVER writes balances or match rows directly; all money and
-- all match state move through SECURITY DEFINER RPCs with a fixed empty
-- search_path that derive identity from auth.uid() and are atomic.
--
-- Additive and idempotent: safe to run after 0001_init.sql and 0002_arena.sql.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Extend the ledger's kind check to cover rcoin purchases and game escrow.
-- Dropped and re-added so the migration is re-runnable.
-- ----------------------------------------------------------------------------
alter table public.wallet_ledger drop constraint if exists wallet_ledger_kind_check;
alter table public.wallet_ledger add constraint wallet_ledger_kind_check
  check (kind in (
    'deposit','withdrawal',
    'challenge_lock','challenge_win','challenge_settled','challenge_refund',
    'tournament_entry','tournament_prize',
    'rcoin_purchase',
    'game_lock','game_win','game_settled','game_refund'
  ));

-- ----------------------------------------------------------------------------
-- game_matches : one staked casual game between two players. Escrow works like
-- challenges. 'open' = waiting in the lobby (host stake locked); 'active' =
-- both stakes locked, game in progress; 'settled' = paid; 'disputed' =
-- conflicting reports; 'cancelled' = host cancelled before anyone joined.
--
-- `state` holds the serialized board so the game survives a reload and syncs
-- over Supabase Realtime. `turn_id` is whose move it is. Board rules are
-- enforced client-side; MONEY is protected server-side by the same
-- both-players-must-agree settlement the arena challenges use, so no single
-- player can pay themselves — a lie only pushes the match to 'disputed'.
-- ----------------------------------------------------------------------------
create table if not exists public.game_matches (
  id            uuid primary key default gen_random_uuid(),
  game          text not null check (game in (
                  'tictactoe','connect4','reversi','checkers','dots','mancala','eights'
                )),
  host_id       uuid not null references auth.users (id) on delete cascade,
  guest_id      uuid references auth.users (id) on delete set null,
  stake_cents   bigint not null check (stake_cents >= 100 and stake_cents <= 100000),
  status        text not null default 'open'
                  check (status in ('open','active','settled','disputed','cancelled')),
  turn_id       uuid references auth.users (id) on delete set null,
  state         jsonb not null default '{}'::jsonb,
  host_report   uuid,           -- reported winner; equals host_id or guest_id, or draw sentinel
  guest_report  uuid,
  host_draw     boolean not null default false,
  guest_draw    boolean not null default false,
  winner_id     uuid references auth.users (id) on delete set null,
  is_draw       boolean not null default false,
  created_at    timestamptz not null default now(),
  matched_at    timestamptz,
  settled_at    timestamptz,
  updated_at    timestamptz not null default now()
);
create index if not exists game_matches_lobby_idx  on public.game_matches (game, status, created_at desc);
create index if not exists game_matches_host_idx   on public.game_matches (host_id, created_at desc);
create index if not exists game_matches_guest_idx  on public.game_matches (guest_id, created_at desc);
comment on table public.game_matches is 'Staked casual game matches (TEST MODE). Escrow via RPC; state synced over Realtime. Winner takes the full pot, no rake.';

-- ============================================================================
-- Row Level Security — deny by default, then grant the minimum.
-- ============================================================================
alter table public.game_matches enable row level security;

-- Lobby: anyone authenticated sees OPEN matches; participants see their own.
drop policy if exists "game_matches: select visible" on public.game_matches;
create policy "game_matches: select visible"
  on public.game_matches for select to authenticated
  using (
    status = 'open'
    or host_id  = (select auth.uid())
    or guest_id = (select auth.uid())
  );

-- No direct INSERT/UPDATE/DELETE: everything goes through the RPCs below.
grant select on public.game_matches to authenticated;

-- Realtime: participants get board/turn updates via postgres_changes. Needs the
-- full row image so UPDATEs carry the new state through RLS.
alter table public.game_matches replica identity full;
do $$
begin
  alter publication supabase_realtime add table public.game_matches;
exception
  when duplicate_object then null;   -- already in the publication
  when undefined_object then null;   -- publication not present in this environment
end;
$$;

-- keep updated_at fresh (touch_updated_at defined in 0001).
drop trigger if exists game_matches_touch_updated_at on public.game_matches;
create trigger game_matches_touch_updated_at
  before update on public.game_matches
  for each row execute function public.touch_updated_at();

-- ============================================================================
-- rcoin: buy (test). Charges the 5% entry commission transparently and credits
-- the resulting rcoin (1 rcoin = 1 USD = 100 cents) to the test balance.
-- ============================================================================
create or replace function public.rib_buy_rcoin_test(p_pay_cents bigint)
returns public.wallets
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_credit bigint;
  v_rcoin  bigint;
  v_row    public.wallets;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  if p_pay_cents is null or p_pay_cents < 100 or p_pay_cents > 200000 then
    raise exception 'invalid amount (between $1 and $2000)';
  end if;
  -- 5% entry commission, shown on screen. Credit = 95% of what came in.
  v_credit := round(p_pay_cents * 0.95);
  v_rcoin  := v_credit / 100;
  perform public.rib_apply(
    v_uid, 'rcoin_purchase', v_credit, 0, null, null,
    'Bought ' || v_rcoin::text || ' rcoin (5% entry fee)'
  );
  select * into v_row from public.wallets where user_id = v_uid;
  return v_row;
end;
$$;

-- ============================================================================
-- Game RPCs. Each derives identity from auth.uid(), validates state, is atomic.
-- ============================================================================

-- ---- Game: create (locks the host stake, opens the match) ------------------
create or replace function public.rib_game_create(
  p_game text, p_stake_cents bigint, p_state jsonb default '{}'::jsonb
) returns public.game_matches
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_bal bigint; v_row public.game_matches;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  if p_game not in ('tictactoe','connect4','reversi','checkers','dots','mancala','eights') then
    raise exception 'unknown game';
  end if;
  if p_stake_cents is null or p_stake_cents < 100 or p_stake_cents > 100000 then
    raise exception 'invalid stake (between $1 and $1000)';
  end if;
  select test_balance_cents into v_bal from public.wallets where user_id = v_uid;
  if v_bal is null or v_bal < p_stake_cents then raise exception 'not enough balance for the stake'; end if;

  insert into public.game_matches (game, host_id, stake_cents, status, state)
  values (p_game, v_uid, p_stake_cents, 'open', coalesce(p_state, '{}'::jsonb))
  returning * into v_row;

  perform public.rib_apply(v_uid, 'game_lock', -p_stake_cents, p_stake_cents, 'game', v_row.id, 'Stake locked');
  return v_row;
end;
$$;

-- ---- Game: join (locks the guest stake, starts the game) -------------------
create or replace function public.rib_game_join(p_match_id uuid, p_state jsonb default null)
returns public.game_matches
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_m public.game_matches; v_bal bigint;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select * into v_m from public.game_matches where id = p_match_id for update;
  if v_m.id is null then raise exception 'match not found'; end if;
  if v_m.host_id = v_uid then raise exception 'you cannot join your own match'; end if;
  if v_m.status <> 'open' then raise exception 'this match is no longer open'; end if;

  select test_balance_cents into v_bal from public.wallets where user_id = v_uid;
  if v_bal is null or v_bal < v_m.stake_cents then raise exception 'not enough balance to join'; end if;

  perform public.rib_apply(v_uid, 'game_lock', -v_m.stake_cents, v_m.stake_cents, 'game', v_m.id, 'Stake locked');

  update public.game_matches
     set guest_id = v_uid, status = 'active', matched_at = now(),
         turn_id = v_m.host_id,                       -- host moves first
         state = coalesce(p_state, v_m.state)
   where id = v_m.id
   returning * into v_m;
  return v_m;
end;
$$;

-- ---- Game: submit a move (updates board + passes the turn) ------------------
create or replace function public.rib_game_move(
  p_match_id uuid, p_state jsonb, p_next_turn uuid
) returns public.game_matches
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_m public.game_matches;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select * into v_m from public.game_matches where id = p_match_id for update;
  if v_m.id is null then raise exception 'match not found'; end if;
  if v_m.status <> 'active' then raise exception 'match is not in progress'; end if;
  if v_uid <> v_m.host_id and v_uid <> v_m.guest_id then raise exception 'you are not in this match'; end if;
  if v_m.turn_id is not null and v_m.turn_id <> v_uid then raise exception 'not your turn'; end if;
  if p_next_turn is not null and p_next_turn <> v_m.host_id and p_next_turn <> v_m.guest_id then
    raise exception 'invalid next turn';
  end if;

  update public.game_matches
     set state = coalesce(p_state, state), turn_id = p_next_turn
   where id = v_m.id
   returning * into v_m;
  return v_m;
end;
$$;

-- ---- Game: report the result (settles when both players agree) --------------
-- p_winner_id = the winner's uuid, or NULL to report a draw. Payout only when
-- both reports match: winner takes the full pot, or a draw refunds both stakes.
-- Conflicting reports move the match to 'disputed' (funds stay parked).
create or replace function public.rib_game_report(p_match_id uuid, p_winner_id uuid default null)
returns public.game_matches
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_m public.game_matches; v_pot bigint; v_loser uuid; v_draw boolean;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select * into v_m from public.game_matches where id = p_match_id for update;
  if v_m.id is null then raise exception 'match not found'; end if;
  if v_m.status not in ('active','disputed') then raise exception 'match is not in progress'; end if;
  if v_uid <> v_m.host_id and v_uid <> v_m.guest_id then raise exception 'you are not in this match'; end if;
  v_draw := (p_winner_id is null);
  if not v_draw and p_winner_id <> v_m.host_id and p_winner_id <> v_m.guest_id then
    raise exception 'invalid winner';
  end if;

  if v_uid = v_m.host_id then
    update public.game_matches set host_report = p_winner_id, host_draw = v_draw where id = v_m.id returning * into v_m;
  else
    update public.game_matches set guest_report = p_winner_id, guest_draw = v_draw where id = v_m.id returning * into v_m;
  end if;

  -- both players reported?
  if (v_m.host_report is not null or v_m.host_draw)
     and (v_m.guest_report is not null or v_m.guest_draw) then

    if v_m.host_draw and v_m.guest_draw then
      -- agreed draw: refund both stakes (release their lock back to balance)
      perform public.rib_apply(v_m.host_id,  'game_refund', v_m.stake_cents, -v_m.stake_cents, 'game', v_m.id, 'Draw, stake refunded');
      perform public.rib_apply(v_m.guest_id, 'game_refund', v_m.stake_cents, -v_m.stake_cents, 'game', v_m.id, 'Draw, stake refunded');
      update public.game_matches set status = 'settled', is_draw = true, settled_at = now()
        where id = v_m.id returning * into v_m;

    elsif (not v_m.host_draw) and (not v_m.guest_draw) and v_m.host_report = v_m.guest_report then
      -- agreed winner: winner releases their lock and takes the whole pot
      v_pot   := v_m.stake_cents * 2;
      v_loser := case when v_m.host_report = v_m.host_id then v_m.guest_id else v_m.host_id end;
      perform public.rib_apply(v_m.host_report, 'game_win',      v_pot, -v_m.stake_cents, 'game', v_m.id, 'Game won');
      perform public.rib_apply(v_loser,         'game_settled',  0,     -v_m.stake_cents, 'game', v_m.id, 'Game lost');
      update public.game_matches set status = 'settled', winner_id = v_m.host_report, settled_at = now()
        where id = v_m.id returning * into v_m;

    else
      update public.game_matches set status = 'disputed' where id = v_m.id returning * into v_m;
    end if;
  end if;
  return v_m;
end;
$$;

-- ---- Game: cancel (host only, before anyone joins; refunds the host) --------
create or replace function public.rib_game_cancel(p_match_id uuid)
returns public.game_matches
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_m public.game_matches;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select * into v_m from public.game_matches where id = p_match_id for update;
  if v_m.id is null then raise exception 'match not found'; end if;
  if v_m.host_id <> v_uid then raise exception 'only the host can cancel'; end if;
  if v_m.status <> 'open' then raise exception 'this match can no longer be cancelled'; end if;

  perform public.rib_apply(v_uid, 'game_refund', v_m.stake_cents, -v_m.stake_cents, 'game', v_m.id, 'Match cancelled, refunded');
  update public.game_matches set status = 'cancelled' where id = v_m.id returning * into v_m;
  return v_m;
end;
$$;

-- ----------------------------------------------------------------------------
-- Privileges: only the authenticated role may call these RPCs.
-- ----------------------------------------------------------------------------
grant execute on function public.rib_buy_rcoin_test(bigint)              to authenticated;
grant execute on function public.rib_game_create(text,bigint,jsonb)      to authenticated;
grant execute on function public.rib_game_join(uuid,jsonb)               to authenticated;
grant execute on function public.rib_game_move(uuid,jsonb,uuid)          to authenticated;
grant execute on function public.rib_game_report(uuid,uuid)              to authenticated;
grant execute on function public.rib_game_cancel(uuid)                   to authenticated;
