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
  v_match uuid;
  v_before_a bigint;
  v_before_c bigint;
  v_hint text;
  i int;
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

  -- Escrow expiry: an open challenge older than 24h is refunded by the sweep.
  perform pg_temp.as_user(b, 'select public.rib_challenge_create(''chess'', ''1v1'', 500, null)');
  select id into v_challenge from public.challenges where creator_id = b and status = 'open' order by created_at desc limit 1;
  perform pg_temp.expect(pg_temp.balance(b)::text, '8000', 'stake locked');
  update public.challenges set created_at = now() - interval '25 hours' where id = v_challenge;
  perform pg_temp.expect(pg_temp.as_user(b, 'select public.rib_expire_stale()'), '42501', 'sweep not callable by clients');
  perform public.rib_expire_stale();
  perform pg_temp.expect((select status from public.challenges where id = v_challenge), 'cancelled', 'stale challenge expired');
  perform pg_temp.expect(pg_temp.balance(b)::text, '8500', 'expired stake refunded');

  -- Chargeback: bob's card top-up is disputed after he spent part of it.
  perform public.rib_credit_rcoin_purchase(b, 'cs_test_bob', 10000);           -- +9500
  perform pg_temp.expect(pg_temp.balance(b)::text, '18000', 'stripe credit');
  perform pg_temp.expect(pg_temp.as_user(b, 'select public.rib_withdraw_test(12000)'), 'ok', 'bob withdraws most of it');
  perform pg_temp.expect(public.rib_reverse_rcoin_purchase('stripe', 'cs_test_bob', 'dispute')::text, '6000', 'reversal debits what is left');
  perform pg_temp.expect(public.rib_reverse_rcoin_purchase('stripe', 'cs_test_bob', 'dispute')::text, '0', 'reversal is idempotent');
  perform pg_temp.expect(pg_temp.balance(b)::text, '0', 'wallet emptied');
  perform pg_temp.expect((select (frozen_at is not null)::text from public.wallets where user_id = b), 'true', 'shortfall freezes the wallet');
  perform public.rib_credit_rcoin_purchase(b, 'cs_test_bob_2', 1000);
  perform pg_temp.expect(pg_temp.as_user(b, 'select public.rib_withdraw_test(100)'), 'wallet_frozen', 'frozen wallet cannot withdraw');
  perform pg_temp.expect(pg_temp.as_user(b, 'select public.rib_challenge_create(''chess'', ''1v1'', 100, null)'), 'wallet_frozen', 'frozen wallet cannot stake');

  -- Server-authoritative staked games (0012).
  perform pg_temp.expect(pg_temp.as_user(a, 'select public.rib_game_create(''eights'', 100, ''{}'')'), 'unknown_game', 'crazy eights not stakeable');
  perform pg_temp.expect(pg_temp.as_user(a, 'select public.rib_game_create(''tictactoe'', 100, ''{}'')'), 'ok', 'alice opens a table');
  select id into v_match from public.game_matches where host_id = a and status = 'open' order by created_at desc limit 1;
  perform pg_temp.expect(pg_temp.as_user(c, format('select public.rib_game_join(%L, null)', v_match)), 'ok', 'carol joins the table');
  perform pg_temp.expect(pg_temp.as_user(a, format('select public.rib_game_move(%L, ''{}'', null)', v_match)), '42501', 'client cannot write the board');
  perform pg_temp.expect(pg_temp.as_user(a, format('select public.rib_game_report(%L, %L)', v_match, a)), '42501', 'client cannot report results');
  perform pg_temp.expect(pg_temp.as_user(a, format('select public.rib_game_commit_move(%L, 0, ''{}'', null, true, %L)', v_match, a)), '42501', 'client cannot commit moves');
  v_before_a := pg_temp.balance(a);
  v_before_c := pg_temp.balance(c);
  perform public.rib_game_commit_move(v_match, 0, '{"turn":1}', c, false, null);
  perform pg_temp.expect((select move_seq::text from public.game_matches where id = v_match), '1', 'move committed');
  begin
    perform public.rib_game_commit_move(v_match, 0, '{"turn":1}', c, false, null);
    raise exception 'FAIL stale move accepted';
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    perform pg_temp.expect(v_hint, 'stale_move', 'stale move rejected');
  end;
  perform public.rib_game_commit_move(v_match, 1, '{"turn":0}', null, true, a);
  perform pg_temp.expect((select status || ':' || (winner_id = a)::text from public.game_matches where id = v_match), 'settled:true', 'server settles the pot');
  perform pg_temp.expect((pg_temp.balance(a) - v_before_a)::text, '200', 'winner receives the pot');
  perform pg_temp.expect((pg_temp.balance(c) - v_before_c)::text, '0', 'loser stake already spent');

  -- Abuse limits and identity (0013).
  for i in 1..3 loop
    perform pg_temp.expect(public.rib_rate_limit_hit('test', a, 3, 60)::text, 'true', 'hit within limit');
  end loop;
  perform pg_temp.expect(public.rib_rate_limit_hit('test', a, 3, 60)::text, 'false', 'hit over limit is refused');
  perform pg_temp.expect(pg_temp.as_user(a, format('select public.rib_rate_limit_hit(''test'', %L, 3, 60)', a)), '42501', 'rate limiter not callable by clients');
  begin
    insert into auth.users (id, email) values ('dddddddd-0000-0000-0000-000000000004', 'steam_76561197960287930@steam.local');
    raise exception 'FAIL reserved email accepted';
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    perform pg_temp.expect(v_hint, 'email_reserved', 'client cannot claim a steam.local e-mail');
  end;
  insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  values ('dddddddd-0000-0000-0000-000000000004', 'steam_76561197960287930@steam.local',
          '{"steamid":"76561197960287930"}', '{"username":"steam_76561197960287930"}');
  perform pg_temp.expect('ok', 'ok', 'steam-auth can create the steam.local account');
  perform pg_temp.expect(pg_temp.as_user(a, $q$update public.profiles set username = 'BOB' where id = 'aaaaaaaa-0000-0000-0000-000000000001'$q$), '23505', 'usernames unique regardless of case');
  perform pg_temp.expect(pg_temp.as_user(a, 'select role from public.profiles limit 1'), '42501', 'role column not readable by players');
  perform pg_temp.expect(pg_temp.as_user(a, 'select id, username, display_name from public.profiles limit 1'), 'ok', 'handles readable by players');

  -- Leaderboard (0014). From the games above:
  --   carol: tournament +1000, lost a 100 table     → net +900, 1W 1L
  --   alice: won challenge +1000, paid entry -1000, won table +100 → net +100, 2W
  --   bob:   lost challenge -1000                    → net -1000, 1L
  perform pg_temp.expect(
    (select string_agg(username || ':' || net_cents || ':' || wins || '-' || losses, ',' order by rank)
       from public.rib_leaderboard('all', 10, 0)),
    'carol:900:1-1,alice:100:2-0,bob:-1000:0-1', 'all-time leaderboard ranks by net winnings');
  perform pg_temp.expect(
    (select count(*)::text from public.rib_leaderboard('week', 10, 0)), '3', 'weekly board has this week''s players');
  perform set_config('request.jwt.claim.sub', a::text, true);
  perform pg_temp.expect((select rank::text from public.rib_my_standing('all')), '2', 'my standing shows my rank');
  perform pg_temp.expect(pg_temp.as_user(a, 'select * from public.player_stats'), '42501', 'raw stats not readable by clients');

  -- Challenge lobby (0014).
  perform pg_temp.as_user(a, 'select public.rib_challenge_create(''Valorant'', ''1v1'', 300, null)');
  perform set_config('request.jwt.claim.sub', c::text, true);
  perform pg_temp.expect(
    (select string_agg(game || ':' || creator_username, ',') from public.rib_open_challenges('valo', null, null, null, 30)),
    'Valorant:alice', 'lobby filters by game and shows the creator handle');
  perform pg_temp.expect(
    (select count(*)::text from public.rib_open_challenges(null, 500, null, null, 30)), '0', 'lobby filters by minimum stake');
  perform set_config('request.jwt.claim.sub', a::text, true);
  perform pg_temp.expect(
    (select count(*)::text from public.rib_open_challenges(null, null, null, null, 30)), '0', 'lobby hides my own challenges');

  -- Keyset pagination never skips rows that share a timestamp.
  perform pg_temp.as_user(a, 'select public.rib_challenge_create(''Chess'', ''1v1'', 100, null)');
  update public.challenges set created_at = '2026-09-01T00:00:00Z' where status = 'open' and creator_id = a;
  perform set_config('request.jwt.claim.sub', c::text, true);
  select id into v_match from public.rib_open_challenges(null, null, null, null, 1);
  perform pg_temp.expect(
    (select count(*)::text from public.rib_open_challenges(null, null, null, '2026-09-01T00:00:00Z', 1, v_match)),
    '1', 'second page returns the tied row');
  perform pg_temp.expect(
    (select count(*)::text from public.rib_open_challenges('%', null, null, null, 30)), '0', 'search treats % literally');

  -- Ledger integrity: every balance equals the sum of its ledger rows.
  perform pg_temp.expect(
    (select count(*)::text from public.wallets w
      where w.test_balance_cents <> coalesce((select sum(amount_cents) from public.wallet_ledger l where l.user_id = w.user_id), 0)),
    '0', 'ledger reconciles with balances');
end;
$$;

\echo 'rpc-smoke: all expectations passed'
