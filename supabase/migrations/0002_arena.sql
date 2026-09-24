-- ============================================================================
-- Runinback — arena schema (Fase 2.1): cartera, retos PvP y torneos.
--
-- MODO DE PRUEBA (test-mode). El movimiento de dinero REAL de Runinback es
-- NO CUSTODIAL y vive on-chain sobre Base; exige contratos de escrow + auditoría
-- (Fase 3+). Mientras tanto, este esquema implementa TODO el flujo de extremo a
-- extremo con un saldo de prueba off-chain: depósitos de prueba, escrow real en
-- la base de datos, liquidación de retos y bolsas de torneo. Ningún fondo real
-- se mueve aquí y se etiqueta como "prueba" en la interfaz.
--
-- Zero-trust, igual que 0001: RLS habilitada y DENY por defecto en cada tabla.
-- Las lecturas pasan por PostgREST (parámetros ligados, sin SQL concatenado).
-- Todo movimiento de saldo pasa por funciones SECURITY DEFINER con search_path
-- fijo y vacío, que validan la identidad con auth.uid() y son atómicas: el saldo
-- y el libro mayor (ledger) nunca quedan descuadrados. El cliente NUNCA escribe
-- saldos directamente (no hay policy de INSERT/UPDATE sobre wallets ni ledger).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- wallets : un saldo de prueba por usuario. test_balance = disponible;
-- test_locked = retenido en escrow por retos/torneos abiertos.
-- ----------------------------------------------------------------------------
create table if not exists public.wallets (
  user_id            uuid primary key references auth.users (id) on delete cascade,
  test_balance_cents bigint not null default 0 check (test_balance_cents >= 0),
  test_locked_cents  bigint not null default 0 check (test_locked_cents  >= 0),
  currency           text   not null default 'USD',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
comment on table public.wallets is 'Saldo de PRUEBA (off-chain). Los fondos reales son no custodiales on-chain sobre Base. RLS: owner-only lectura; escritura solo vía RPC SECURITY DEFINER.';

-- ----------------------------------------------------------------------------
-- wallet_ledger : cada movimiento de saldo, inmutable, con el saldo resultante.
-- ----------------------------------------------------------------------------
create table if not exists public.wallet_ledger (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  kind               text not null check (kind in (
                       'deposit','withdrawal',
                       'challenge_lock','challenge_win','challenge_settled','challenge_refund',
                       'tournament_entry','tournament_prize')),
  amount_cents       bigint not null,       -- con signo: + entra, - sale del disponible
  balance_after_cents bigint not null,
  ref_type           text,                  -- 'challenge' | 'tournament' | null
  ref_id             uuid,
  memo               text check (char_length(memo) <= 140),
  created_at         timestamptz not null default now()
);
create index if not exists wallet_ledger_user_idx on public.wallet_ledger (user_id, created_at desc);

-- ----------------------------------------------------------------------------
-- challenges : retos 1v1 con escrow. 'open' = lobby abierto; 'pending' = dirigido
-- a target_id; 'active' = ambos con stake bloqueado; 'settled' = pagado;
-- 'disputed' = reportes en conflicto; 'cancelled' = anulado antes de aceptar.
-- ----------------------------------------------------------------------------
create table if not exists public.challenges (
  id              uuid primary key default gen_random_uuid(),
  creator_id      uuid not null references auth.users (id) on delete cascade,
  opponent_id     uuid references auth.users (id) on delete set null,
  target_id       uuid references auth.users (id) on delete set null,
  game            text not null check (char_length(game) between 1 and 40),
  mode            text not null default '1v1' check (char_length(mode) between 1 and 40),
  stake_cents     bigint not null check (stake_cents between 100 and 100000),
  status          text not null default 'open'
                    check (status in ('open','pending','active','settled','disputed','cancelled')),
  winner_id       uuid references auth.users (id) on delete set null,
  creator_report  uuid references auth.users (id) on delete set null,
  opponent_report uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  matched_at      timestamptz,
  settled_at      timestamptz
);
create index if not exists challenges_creator_idx  on public.challenges (creator_id);
create index if not exists challenges_opponent_idx on public.challenges (opponent_id);
create index if not exists challenges_status_idx   on public.challenges (status, created_at desc);

-- ----------------------------------------------------------------------------
-- tournaments + entries : cuota de inscripción hacia una bolsa de premios.
-- ----------------------------------------------------------------------------
create table if not exists public.tournaments (
  id               uuid primary key default gen_random_uuid(),
  creator_id       uuid not null references auth.users (id) on delete cascade,
  name             text not null check (char_length(name) between 1 and 80),
  game             text not null check (char_length(game) between 1 and 40),
  entry_fee_cents  bigint not null check (entry_fee_cents between 0 and 50000),
  max_players      int  not null check (max_players between 2 and 128),
  prize_pool_cents bigint not null default 0 check (prize_pool_cents >= 0),
  status           text not null default 'open'
                     check (status in ('open','full','active','finished','cancelled')),
  starts_at        timestamptz,
  created_at       timestamptz not null default now(),
  finished_at      timestamptz
);
create index if not exists tournaments_status_idx on public.tournaments (status, created_at desc);

create table if not exists public.tournament_entries (
  id            uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  placement     int,
  created_at    timestamptz not null default now(),
  unique (tournament_id, user_id)
);
create index if not exists tournament_entries_t_idx on public.tournament_entries (tournament_id);
create index if not exists tournament_entries_u_idx on public.tournament_entries (user_id);

-- ============================================================================
-- Row Level Security — deny por defecto, luego se concede lo mínimo.
-- ============================================================================
alter table public.wallets            enable row level security;
alter table public.wallet_ledger      enable row level security;
alter table public.challenges         enable row level security;
alter table public.tournaments        enable row level security;
alter table public.tournament_entries enable row level security;

-- wallets: solo el dueño lee. No hay policy de escritura => el cliente no puede
-- alterar su saldo; solo las funciones RPC (service role del definer) lo hacen.
create policy "wallets: select own"
  on public.wallets for select to authenticated
  using ( user_id = (select auth.uid()) );

-- wallet_ledger: el dueño lee su historial. Sin escritura desde el cliente.
create policy "ledger: select own"
  on public.wallet_ledger for select to authenticated
  using ( user_id = (select auth.uid()) );

-- challenges: se ven los retos ABIERTOS del lobby y los propios (como creador,
-- rival o destinatario). Sin INSERT/UPDATE directos: todo pasa por las RPC.
create policy "challenges: select visible"
  on public.challenges for select to authenticated
  using (
    status = 'open'
    or creator_id  = (select auth.uid())
    or opponent_id = (select auth.uid())
    or target_id   = (select auth.uid())
  );

-- tournaments: catálogo visible para cualquier autenticado (lobby). Sin escritura.
create policy "tournaments: select all"
  on public.tournaments for select to authenticated
  using ( true );

-- tournament_entries: se ven las inscripciones de torneos (para brackets) y las
-- propias. Sin escritura directa.
create policy "entries: select"
  on public.tournament_entries for select to authenticated
  using ( true );

-- ----------------------------------------------------------------------------
-- profiles: los usuarios son handles públicos (tipo gamertag) y esta tabla no
-- guarda datos sensibles (el email vive en auth.users). Para el lobby de retos
-- y los brackets de torneos, cualquier autenticado puede leer usuario/nombre.
-- La policy "profiles: select own" de 0001 sigue existiendo; esta se suma (OR).
-- ----------------------------------------------------------------------------
drop policy if exists "profiles: select handles" on public.profiles;
create policy "profiles: select handles"
  on public.profiles for select to authenticated
  using ( true );

-- ----------------------------------------------------------------------------
-- Privilegios de tabla: authenticated solo LEE estas tablas (la RLS de arriba
-- decide qué filas). TODA escritura pasa por las RPC SECURITY DEFINER, así que
-- no se concede INSERT/UPDATE/DELETE al cliente sobre saldos ni escrow.
-- ----------------------------------------------------------------------------
grant select on public.wallets            to authenticated;
grant select on public.wallet_ledger      to authenticated;
grant select on public.challenges         to authenticated;
grant select on public.tournaments        to authenticated;
grant select on public.tournament_entries to authenticated;

-- ============================================================================
-- Helper interno: aplica un movimiento a la wallet y escribe el ledger.
-- No expuesto a los clientes (revoke execute). Lo llaman las RPC definer.
-- ============================================================================
create or replace function public.rib_apply(
  p_uid          uuid,
  p_kind         text,
  p_balance_delta bigint,   -- cambio en el saldo disponible (con signo)
  p_locked_delta  bigint,   -- cambio en lo retenido (con signo)
  p_ref_type     text,
  p_ref_id       uuid,
  p_memo         text
) returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance bigint;
begin
  insert into public.wallets (user_id) values (p_uid)
    on conflict (user_id) do nothing;

  update public.wallets
     set test_balance_cents = test_balance_cents + p_balance_delta,
         test_locked_cents  = test_locked_cents  + p_locked_delta,
         updated_at = now()
   where user_id = p_uid
   returning test_balance_cents into v_balance;

  if v_balance is null then
    raise exception 'wallet no encontrada';
  end if;

  insert into public.wallet_ledger
    (user_id, kind, amount_cents, balance_after_cents, ref_type, ref_id, memo)
  values
    (p_uid, p_kind, p_balance_delta, v_balance, p_ref_type, p_ref_id, p_memo);

  return v_balance;
end;
$$;
revoke all on function public.rib_apply(uuid,text,bigint,bigint,text,uuid,text) from public;

-- ============================================================================
-- RPC públicas (rol authenticated). Cada una deriva la identidad de auth.uid(),
-- valida saldo y estado, y es atómica.
-- ============================================================================

-- ---- Cartera: depósito de prueba -------------------------------------------
create or replace function public.rib_deposit_test(p_amount_cents bigint)
returns public.wallets
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_row public.wallets;
begin
  if v_uid is null then raise exception 'no autenticado'; end if;
  if p_amount_cents is null or p_amount_cents < 100 or p_amount_cents > 100000 then
    raise exception 'monto de prueba inválido (entre $1 y $1000)';
  end if;
  perform public.rib_apply(v_uid, 'deposit', p_amount_cents, 0, null, null, 'Depósito de prueba');
  select * into v_row from public.wallets where user_id = v_uid;
  return v_row;
end;
$$;

-- ---- Cartera: retiro de prueba ---------------------------------------------
create or replace function public.rib_withdraw_test(p_amount_cents bigint)
returns public.wallets
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_bal bigint; v_row public.wallets;
begin
  if v_uid is null then raise exception 'no autenticado'; end if;
  if p_amount_cents is null or p_amount_cents < 100 then
    raise exception 'monto inválido';
  end if;
  select test_balance_cents into v_bal from public.wallets where user_id = v_uid;
  if v_bal is null or v_bal < p_amount_cents then raise exception 'saldo insuficiente'; end if;
  perform public.rib_apply(v_uid, 'withdrawal', -p_amount_cents, 0, null, null, 'Retiro de prueba');
  select * into v_row from public.wallets where user_id = v_uid;
  return v_row;
end;
$$;

-- ---- Reto: crear (bloquea el stake del creador) ----------------------------
create or replace function public.rib_challenge_create(
  p_game text, p_mode text, p_stake_cents bigint, p_target_username text default null
) returns public.challenges
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid(); v_bal bigint; v_target uuid; v_status text; v_row public.challenges;
begin
  if v_uid is null then raise exception 'no autenticado'; end if;
  if p_game is null or char_length(trim(p_game)) < 1 then raise exception 'indica el juego'; end if;
  if p_stake_cents is null or p_stake_cents < 100 or p_stake_cents > 100000 then
    raise exception 'apuesta inválida (entre $1 y $1000)';
  end if;

  if p_target_username is not null and char_length(trim(p_target_username)) > 0 then
    select id into v_target from public.profiles where username = trim(p_target_username);
    if v_target is null then raise exception 'no existe el usuario %', p_target_username; end if;
    if v_target = v_uid then raise exception 'no puedes retarte a ti mismo'; end if;
    v_status := 'pending';
  else
    v_status := 'open';
  end if;

  select test_balance_cents into v_bal from public.wallets where user_id = v_uid;
  if v_bal is null or v_bal < p_stake_cents then raise exception 'saldo insuficiente para la apuesta'; end if;

  insert into public.challenges (creator_id, target_id, game, mode, stake_cents, status)
  values (v_uid, v_target, trim(p_game), coalesce(nullif(trim(p_mode),''),'1v1'), p_stake_cents, v_status)
  returning * into v_row;

  perform public.rib_apply(v_uid, 'challenge_lock', -p_stake_cents, p_stake_cents, 'challenge', v_row.id, 'Apuesta bloqueada');
  return v_row;
end;
$$;

-- ---- Reto: aceptar (bloquea el stake del rival) ----------------------------
create or replace function public.rib_challenge_accept(p_challenge_id uuid)
returns public.challenges
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_c public.challenges; v_bal bigint;
begin
  if v_uid is null then raise exception 'no autenticado'; end if;
  select * into v_c from public.challenges where id = p_challenge_id for update;
  if v_c.id is null then raise exception 'reto no encontrado'; end if;
  if v_c.creator_id = v_uid then raise exception 'no puedes aceptar tu propio reto'; end if;
  if v_c.status not in ('open','pending') then raise exception 'este reto ya no está disponible'; end if;
  if v_c.status = 'pending' and v_c.target_id <> v_uid then raise exception 'este reto es para otro jugador'; end if;

  select test_balance_cents into v_bal from public.wallets where user_id = v_uid;
  if v_bal is null or v_bal < v_c.stake_cents then raise exception 'saldo insuficiente para aceptar'; end if;

  perform public.rib_apply(v_uid, 'challenge_lock', -v_c.stake_cents, v_c.stake_cents, 'challenge', v_c.id, 'Apuesta bloqueada');

  update public.challenges
     set opponent_id = v_uid, status = 'active', matched_at = now()
   where id = v_c.id
   returning * into v_c;
  return v_c;
end;
$$;

-- ---- Reto: reportar resultado (y liquidar si ambos coinciden) --------------
create or replace function public.rib_challenge_report(p_challenge_id uuid, p_winner_id uuid)
returns public.challenges
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_c public.challenges; v_pot bigint; v_loser uuid;
begin
  if v_uid is null then raise exception 'no autenticado'; end if;
  select * into v_c from public.challenges where id = p_challenge_id for update;
  if v_c.id is null then raise exception 'reto no encontrado'; end if;
  if v_c.status <> 'active' and v_c.status <> 'disputed' then raise exception 'el reto no está en juego'; end if;
  if v_uid <> v_c.creator_id and v_uid <> v_c.opponent_id then raise exception 'no participas en este reto'; end if;
  if p_winner_id <> v_c.creator_id and p_winner_id <> v_c.opponent_id then raise exception 'ganador inválido'; end if;

  if v_uid = v_c.creator_id then
    update public.challenges set creator_report = p_winner_id where id = v_c.id returning * into v_c;
  else
    update public.challenges set opponent_report = p_winner_id where id = v_c.id returning * into v_c;
  end if;

  -- ambos reportaron
  if v_c.creator_report is not null and v_c.opponent_report is not null then
    if v_c.creator_report = v_c.opponent_report then
      v_pot   := v_c.stake_cents * 2;
      v_loser := case when v_c.creator_report = v_c.creator_id then v_c.opponent_id else v_c.creator_id end;
      -- ganador: libera su retención y cobra el bote completo
      perform public.rib_apply(v_c.creator_report, 'challenge_win', v_pot, -v_c.stake_cents, 'challenge', v_c.id, 'Reto ganado');
      -- perdedor: se le libera la retención (el stake ya salió del disponible)
      perform public.rib_apply(v_loser, 'challenge_settled', 0, -v_c.stake_cents, 'challenge', v_c.id, 'Reto perdido');
      update public.challenges set status = 'settled', winner_id = v_c.creator_report, settled_at = now()
        where id = v_c.id returning * into v_c;
    else
      update public.challenges set status = 'disputed' where id = v_c.id returning * into v_c;
    end if;
  end if;
  return v_c;
end;
$$;

-- ---- Reto: cancelar (solo antes de aceptarse; reembolsa al creador) --------
create or replace function public.rib_challenge_cancel(p_challenge_id uuid)
returns public.challenges
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_c public.challenges;
begin
  if v_uid is null then raise exception 'no autenticado'; end if;
  select * into v_c from public.challenges where id = p_challenge_id for update;
  if v_c.id is null then raise exception 'reto no encontrado'; end if;
  if v_c.creator_id <> v_uid then raise exception 'solo el creador puede cancelar'; end if;
  if v_c.status not in ('open','pending') then raise exception 'ya no se puede cancelar'; end if;

  perform public.rib_apply(v_uid, 'challenge_refund', v_c.stake_cents, -v_c.stake_cents, 'challenge', v_c.id, 'Reto cancelado, reembolso');
  update public.challenges set status = 'cancelled' where id = v_c.id returning * into v_c;
  return v_c;
end;
$$;

-- ---- Torneo: crear ---------------------------------------------------------
create or replace function public.rib_tournament_create(
  p_name text, p_game text, p_entry_fee_cents bigint, p_max_players int, p_starts_at timestamptz default null
) returns public.tournaments
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_row public.tournaments;
begin
  if v_uid is null then raise exception 'no autenticado'; end if;
  if p_name is null or char_length(trim(p_name)) < 1 then raise exception 'ponle nombre al torneo'; end if;
  if p_entry_fee_cents is null or p_entry_fee_cents < 0 or p_entry_fee_cents > 50000 then
    raise exception 'cuota inválida (entre $0 y $500)';
  end if;
  if p_max_players is null or p_max_players < 2 or p_max_players > 128 then
    raise exception 'jugadores máximos entre 2 y 128';
  end if;
  insert into public.tournaments (creator_id, name, game, entry_fee_cents, max_players, starts_at)
  values (v_uid, trim(p_name), trim(p_game), p_entry_fee_cents, p_max_players, p_starts_at)
  returning * into v_row;
  return v_row;
end;
$$;

-- ---- Torneo: inscribirse (cuota -> bolsa de premios) -----------------------
create or replace function public.rib_tournament_join(p_tournament_id uuid)
returns public.tournaments
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_t public.tournaments; v_bal bigint; v_count int;
begin
  if v_uid is null then raise exception 'no autenticado'; end if;
  select * into v_t from public.tournaments where id = p_tournament_id for update;
  if v_t.id is null then raise exception 'torneo no encontrado'; end if;
  if v_t.status <> 'open' then raise exception 'las inscripciones están cerradas'; end if;
  if exists (select 1 from public.tournament_entries where tournament_id = v_t.id and user_id = v_uid) then
    raise exception 'ya estás inscrito';
  end if;

  if v_t.entry_fee_cents > 0 then
    select test_balance_cents into v_bal from public.wallets where user_id = v_uid;
    if v_bal is null or v_bal < v_t.entry_fee_cents then raise exception 'saldo insuficiente para la cuota'; end if;
    perform public.rib_apply(v_uid, 'tournament_entry', -v_t.entry_fee_cents, 0, 'tournament', v_t.id, 'Inscripción a torneo');
  end if;

  insert into public.tournament_entries (tournament_id, user_id) values (v_t.id, v_uid);
  update public.tournaments set prize_pool_cents = prize_pool_cents + v_t.entry_fee_cents where id = v_t.id;

  select count(*) into v_count from public.tournament_entries where tournament_id = v_t.id;
  if v_count >= v_t.max_players then
    update public.tournaments set status = 'full' where id = v_t.id;
  end if;

  select * into v_t from public.tournaments where id = v_t.id;
  return v_t;
end;
$$;

-- ---- Torneo: finalizar (el creador declara ganador; premia la bolsa) -------
create or replace function public.rib_tournament_finish(p_tournament_id uuid, p_winner_id uuid)
returns public.tournaments
language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_t public.tournaments;
begin
  if v_uid is null then raise exception 'no autenticado'; end if;
  select * into v_t from public.tournaments where id = p_tournament_id for update;
  if v_t.id is null then raise exception 'torneo no encontrado'; end if;
  if v_t.creator_id <> v_uid then raise exception 'solo el organizador puede finalizar'; end if;
  if v_t.status not in ('open','full','active') then raise exception 'el torneo ya terminó'; end if;
  if not exists (select 1 from public.tournament_entries where tournament_id = v_t.id and user_id = p_winner_id) then
    raise exception 'el ganador debe estar inscrito';
  end if;

  if v_t.prize_pool_cents > 0 then
    perform public.rib_apply(p_winner_id, 'tournament_prize', v_t.prize_pool_cents, 0, 'tournament', v_t.id, 'Premio de torneo');
  end if;
  update public.tournament_entries set placement = 1 where tournament_id = v_t.id and user_id = p_winner_id;
  update public.tournaments set status = 'finished', finished_at = now() where id = v_t.id returning * into v_t;
  return v_t;
end;
$$;

-- ----------------------------------------------------------------------------
-- Permisos: solo el rol authenticated puede invocar las RPC públicas.
-- (rib_apply queda revocada arriba: solo la usan las funciones definer.)
-- ----------------------------------------------------------------------------
grant execute on function public.rib_deposit_test(bigint)                              to authenticated;
grant execute on function public.rib_withdraw_test(bigint)                             to authenticated;
grant execute on function public.rib_challenge_create(text,text,bigint,text)           to authenticated;
grant execute on function public.rib_challenge_accept(uuid)                            to authenticated;
grant execute on function public.rib_challenge_report(uuid,uuid)                       to authenticated;
grant execute on function public.rib_challenge_cancel(uuid)                            to authenticated;
grant execute on function public.rib_tournament_create(text,text,bigint,int,timestamptz) to authenticated;
grant execute on function public.rib_tournament_join(uuid)                             to authenticated;
grant execute on function public.rib_tournament_finish(uuid,uuid)                      to authenticated;

-- ----------------------------------------------------------------------------
-- Aprovisiona una wallet junto con el perfil al crearse el usuario.
-- Reemplaza handle_new_user de 0001 añadiendo el insert de wallet.
-- ----------------------------------------------------------------------------
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
    coalesce(nullif(new.raw_user_meta_data ->> 'role', ''), 'player')
  ) on conflict (id) do nothing;

  insert into public.wallets (user_id) values (new.id) on conflict (user_id) do nothing;
  return new;
end;
$$;

-- Rellena wallets para usuarios que ya existían antes de esta migración.
insert into public.wallets (user_id)
  select id from auth.users on conflict (user_id) do nothing;

-- keep updated_at fresh on wallets.
drop trigger if exists wallets_touch_updated_at on public.wallets;
create trigger wallets_touch_updated_at
  before update on public.wallets
  for each row execute function public.touch_updated_at();
