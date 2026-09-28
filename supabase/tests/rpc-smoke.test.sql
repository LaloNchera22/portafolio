-- ============================================================================
-- Regression tests for the money RPCs. Run after every migration on a scratch
-- database (scripts/verify-migrations.sh). Any failed expectation raises and
-- aborts the run (psql ON_ERROR_STOP).
-- ============================================================================
\set ON_ERROR_STOP 1

insert into auth.users (id, email, raw_user_meta_data) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'alice@example.test', '{"username":"alice"}'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'bob@example.test',   '{"username":"bob"}'),
  ('cccccccc-0000-0000-0000-000000000003', 'carol@example.test', '{"username":"carol","role":"dev"}');

-- Run a statement as a signed-in user; returns the SQL error hint (or 'ok').
create function pg_temp.as_user(p_uid uuid, p_sql text) returns text
language plpgsql as $$
declare v_hint text;
begin
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  execute 'set local role authenticated';
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    execute 'reset role';
    return coalesce(nullif(v_hint, ''), sqlstate);
  end;
  execute 'reset role';
  return 'ok';
end;
$$;

create function pg_temp.expect(p_actual text, p_expected text, p_label text) returns void
language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'FAIL %: expected %, got %', p_label, p_expected, p_actual;
  end if;
  raise notice 'pass: %', p_label;
end;
$$;

create function pg_temp.balance(p_uid uuid) returns bigint
language sql as $$ select test_balance_cents from public.wallets where user_id = p_uid $$;

do $$
declare
  a uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  b uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
  c uuid := 'cccccccc-0000-0000-0000-000000000003';
  v_challenge uuid;
  v_tournament uuid;
begin
  -- Sign-up never trusts a client-supplied role.
  perform pg_temp.expect((select role from public.profiles where id = c), 'player', 'signup ignores client role');

  -- Test top-ups are off by default: nobody can mint rcoin for free.
  perform pg_temp.expect(pg_temp.as_user(a, 'select public.rib_buy_rcoin_test(10000)'), 'test_payments_disabled', 'test buy disabled by default');
  perform pg_temp.expect(pg_temp.as_user(a, 'select public.rib_deposit_test(10000)'), 'test_payments_disabled', 'test deposit disabled by default');

  -- Internal functions and money tables are not reachable from the client.
  perform pg_temp.expect(pg_temp.as_user(a, $q$select public.rib_apply('aaaaaaaa-0000-0000-0000-000000000001', 'deposit', 100000, 0, null, null, 'x')$q$), '42501', 'rib_apply not executable');
  perform pg_temp.expect(pg_temp.as_user(a, $q$select public.rib_credit_rcoin_purchase('aaaaaaaa-0000-0000-0000-000000000001', 'cs_x', 10000)$q$), '42501', 'credit function not executable');
  perform pg_temp.expect(pg_temp.as_user(a, 'update public.wallets set test_balance_cents = 1'), '42501', 'wallets not writable');
  perform pg_temp.expect(pg_temp.as_user(a, $q$update public.profiles set role = 'dev'$q$), '42501', 'profile role not writable');
  perform pg_temp.expect(pg_temp.as_user(a, $q$update public.profiles set display_name = 'Alice' where id = 'aaaaaaaa-0000-0000-0000-000000000001'$q$), 'ok', 'display name writable');
  perform pg_temp.expect(
    (select string_agg(p.proname, ',') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')),
    null, 'anon cannot execute any public function');

  -- Fund the three players (staging behaviour).
  update public.platform_settings set value = 'true' where key = 'test_payments_enabled';
  perform pg_temp.expect(pg_temp.as_user(a, 'select public.rib_buy_rcoin_test(10000)'), 'ok', 'alice buys');
  perform pg_temp.expect(pg_temp.as_user(b, 'select public.rib_buy_rcoin_test(10000)'), 'ok', 'bob buys');
  perform pg_temp.expect(pg_temp.as_user(c, 'select public.rib_buy_rcoin_test(10000)'), 'ok', 'carol buys');
  perform pg_temp.expect(pg_temp.balance(a)::text, '9500', '5% entry fee applied');

  -- Challenge escrow: create, accept, agree on the winner, settle.
  perform pg_temp.as_user(a, 'select public.rib_challenge_create(''chess'', ''1v1'', 1000, null)');
  select id into v_challenge from public.challenges where creator_id = a order by created_at desc limit 1;
  perform pg_temp.expect(pg_temp.as_user(b, format('select public.rib_challenge_accept(%L)', v_challenge)), 'ok', 'bob accepts');
  perform pg_temp.expect(pg_temp.as_user(a, format('select public.rib_challenge_report(%L, null)', v_challenge)), 'invalid_winner', 'null winner rejected');
  perform pg_temp.expect(pg_temp.as_user(a, format('select public.rib_challenge_report(%L, %L)', v_challenge, a)), 'ok', 'alice reports');
  perform pg_temp.expect(pg_temp.as_user(b, format('select public.rib_challenge_report(%L, %L)', v_challenge, a)), 'ok', 'bob reports');
  perform pg_temp.expect((select status from public.challenges where id = v_challenge), 'settled', 'challenge settled');
  perform pg_temp.expect(pg_temp.balance(a)::text, '10500', 'winner takes the pot');
  perform pg_temp.expect(pg_temp.balance(b)::text, '8500', 'loser pays the stake');

  -- Overdraw is a clean, coded error (no raw CHECK violation).
  perform pg_temp.expect(pg_temp.as_user(b, 'select public.rib_withdraw_test(999999)'), 'insufficient_balance', 'overdraw rejected');
  perform pg_temp.expect(pg_temp.as_user(b, 'select public.rib_challenge_create(''chess'', ''1v1'', 100000, null)'), 'insufficient_balance', 'stake above balance rejected');

  -- Tournaments: the organizer can't award the pool to themself.
  perform pg_temp.as_user(a, 'select public.rib_tournament_create(''Cup'', ''chess'', 1000, 4, null)');
  select id into v_tournament from public.tournaments where creator_id = a order by created_at desc limit 1;
  perform pg_temp.expect(pg_temp.as_user(a, format('select public.rib_tournament_join(%L)', v_tournament)), 'ok', 'organizer joins');
  perform pg_temp.expect(pg_temp.as_user(c, format('select public.rib_tournament_join(%L)', v_tournament)), 'ok', 'carol joins');
  perform pg_temp.expect(pg_temp.as_user(a, format('select public.rib_tournament_finish(%L, %L)', v_tournament, a)), 'organizer_cannot_win', 'organizer cannot win');
  perform pg_temp.expect(pg_temp.as_user(a, format('select public.rib_tournament_finish(%L, %L)', v_tournament, c)), 'ok', 'organizer awards carol');
  perform pg_temp.expect(pg_temp.balance(c)::text, '10500', 'carol receives the pool');

  -- Ledger integrity: every balance equals the sum of its ledger rows.
  perform pg_temp.expect(
    (select count(*)::text from public.wallets w
      where w.test_balance_cents <> coalesce((select sum(amount_cents) from public.wallet_ledger l where l.user_id = w.user_id), 0)),
    '0', 'ledger reconciles with balances');
end;
$$;

\echo 'rpc-smoke: all expectations passed'
