-- ============================================================================
-- Regression tests for the money RPCs. Run after every migration on a scratch
-- database (scripts/verify-migrations.sh). Any failed expectation raises and
-- aborts the run (psql ON_ERROR_STOP).
-- ============================================================================
\set ON_ERROR_STOP 1

insert into auth.users (id, email, raw_user_meta_data) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'alice@example.test', '{"username":"alice"}'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'bob@example.test',   '{"username":"bob"}'),
  ('cccccccc-0000-0000-0000-000000000003', 'carol@example.test', '{"username":"carol","role":"dev"}'),
  ('dddddddd-0000-0000-0000-000000000005', 'dave@example.test',  '{"username":"dave"}'),
  ('eeeeeeee-0000-0000-0000-000000000006', 'erin@example.test',  '{"username":"erin"}'),
  ('f1000000-0000-0000-0000-000000000001', 'p1@example.test', '{"username":"player_one"}'),
  ('f2000000-0000-0000-0000-000000000002', 'p2@example.test', '{"username":"player_two"}'),
  ('f3000000-0000-0000-0000-000000000003', 'p3@example.test', '{"username":"player_three"}'),
  ('f4000000-0000-0000-0000-000000000004', 'p4@example.test', '{"username":"player_four"}'),
  ('99999999-0000-0000-0000-000000000009', 'grace@example.test', '{"username":"grace"}');

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

-- Run a scalar query as a signed-in user (RLS applies); returns it as text.
create function pg_temp.scalar_as(p_uid uuid, p_sql text) returns text
language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  execute 'set local role authenticated';
  execute p_sql into v;
  execute 'reset role';
  return v;
end;
$$;

create function pg_temp.balance(p_uid uuid) returns bigint
language sql as $$ select test_balance_cents from public.wallets where user_id = p_uid $$;

do $$
declare
  a uuid := 'aaaaaaaa-0000-0000-0000-000000000001';
  b uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
  c uuid := 'cccccccc-0000-0000-0000-000000000003';
  d uuid := 'dddddddd-0000-0000-0000-000000000005';
  e uuid := 'eeeeeeee-0000-0000-0000-000000000006';
  g uuid := '99999999-0000-0000-0000-000000000009';
  v_challenge uuid;
  v_tournament uuid;
  v_match uuid;
  v_before_a bigint;
  v_before_c bigint;
  v_hint text;
  v_room uuid;
  v_opp uuid;
  v_ya uuid;
  v_yb uuid;
  v_token text;
  v_before_d bigint;
  u uuid;
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
  perform pg_temp.expect(pg_temp.as_user(a, $q$update public.profiles set display_name = 'Alice' where id = 'aaaaaaaa-0000-0000-0000-000000000001'$q$), '42501', 'profiles only change through rib_profile_update');
  perform pg_temp.expect(pg_temp.as_user(a, $q$select public.rib_profile_update(null, 'Alice', null, null)$q$), 'ok', 'display name writable');
  perform pg_temp.expect(
    (select string_agg(p.proname, ',') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')),
    null, 'anon cannot execute any public function');

  -- Fund the three players (staging behaviour).
  update public.platform_settings set value = 'true' where key = 'test_payments_enabled';
  perform pg_temp.expect(pg_temp.as_user(a, 'select public.rib_buy_rcoin_test(10000)'), 'ok', 'alice buys');
  perform pg_temp.expect(pg_temp.as_user(b, 'select public.rib_buy_rcoin_test(10000)'), 'ok', 'bob buys');
  perform pg_temp.expect(pg_temp.as_user(c, 'select public.rib_buy_rcoin_test(10000)'), 'ok', 'carol buys');
  perform pg_temp.as_user(d, 'select public.rib_buy_rcoin_test(10000)');
  perform pg_temp.as_user(e, 'select public.rib_buy_rcoin_test(10000)');
  perform pg_temp.expect(pg_temp.balance(a)::text, '9500', '5% entry fee applied');

  -- Friendlies (0022): free 1v1 challenges played in a room, no money moves.
  perform pg_temp.expect(pg_temp.as_user(a, 'select public.rib_challenge_create(''chess'', ''1v1'')'), 'ok', 'a friendly is free to post');
  select id into v_challenge from public.challenges where creator_id = a order by created_at desc limit 1;
  perform pg_temp.expect(pg_temp.as_user(b, format('select public.rib_challenge_accept(%L)', v_challenge)), 'ok', 'bob accepts the friendly');
  select room_id into v_room from public.challenges where id = v_challenge;
  perform pg_temp.expect((select status || ':' || (room_code like 'RB-%')::text from public.match_rooms where id = v_room), 'ready_check:true', 'accepting opens a room with a match code');
  perform pg_temp.expect(pg_temp.as_user(a, format('select public.rib_room_report(%L, %L)', v_room, a)), 'challenge_not_started', 'no report before the ready check');
  perform pg_temp.as_user(a, format('select public.rib_room_ready(%L)', v_room));
  perform pg_temp.expect((select status from public.match_rooms where id = v_room), 'ready_check', 'one ready player does not start the match');
  perform pg_temp.as_user(b, format('select public.rib_room_ready(%L)', v_room));
  perform pg_temp.expect((select status from public.match_rooms where id = v_room), 'live', 'both ready starts the match');
  perform pg_temp.expect(pg_temp.as_user(a, format('select public.rib_room_report(%L, null)', v_room)), 'invalid_winner', 'null winner rejected');
  perform pg_temp.expect(pg_temp.as_user(a, format('select public.rib_room_report(%L, %L)', v_room, a)), 'ok', 'alice reports');
  perform pg_temp.expect(pg_temp.as_user(a, format('select public.rib_room_report(%L, %L)', v_room, b)), 'already_reported', 'a report cannot be changed');
  perform pg_temp.expect(pg_temp.as_user(b, format('select public.rib_room_report(%L, %L)', v_room, b)), 'use_dispute', 'a conflicting report must be a dispute');
  perform pg_temp.expect(pg_temp.as_user(b, format('select public.rib_room_dispute(%L, ''I won on the last move'')', v_room)), 'ok', 'bob disputes the friendly');
  perform pg_temp.expect((select r.status || ':' || c.status from public.match_rooms r join public.challenges c on c.room_id = r.id where r.id = v_room), 'void:cancelled', 'a disputed friendly ends with no result');
  perform pg_temp.as_user(a, 'select public.rib_challenge_create(''chess'', ''1v1'')');
  select id into v_challenge from public.challenges where creator_id = a and status = 'open' order by created_at desc limit 1;
  perform pg_temp.as_user(b, format('select public.rib_challenge_accept(%L)', v_challenge));
  select room_id into v_room from public.challenges where id = v_challenge;
  perform pg_temp.as_user(a, format('select public.rib_room_ready(%L)', v_room));
  perform pg_temp.as_user(b, format('select public.rib_room_ready(%L)', v_room));
  perform pg_temp.as_user(a, format('select public.rib_room_report(%L, %L)', v_room, a));
  perform pg_temp.expect(pg_temp.as_user(b, format('select public.rib_room_report(%L, %L)', v_room, a)), 'ok', 'bob confirms');
  perform pg_temp.expect((select status || ':' || (winner_id = a)::text from public.challenges where id = v_challenge), 'settled:true', 'matching reports settle the friendly');
  perform pg_temp.expect(pg_temp.balance(a)::text || '/' || pg_temp.balance(b)::text, '9500/9500', 'friendlies never move money');

  -- Overdraw is a clean, coded error (no raw CHECK violation).
  perform pg_temp.expect(pg_temp.as_user(b, 'select public.rib_withdraw_test(999999)'), 'insufficient_balance', 'overdraw rejected');

  -- Tournaments (0022): sit & go of 4 or 8, random bracket, rooms per match,
  -- 10% platform fee, 70/30 prizes, deposits on disputes, walkovers.
  perform pg_temp.expect(pg_temp.as_user(c, 'select public.rib_tournament_create(''Cup'', ''Valorant'', 1000, 5, null)'), 'invalid_tournament_size', 'tournaments have 4 or 8 players');
  perform pg_temp.expect(pg_temp.as_user(c, 'select public.rib_tournament_create(''Cup'', ''Valorant'', 50, 4, null)'), 'invalid_entry_fee', 'entry fee is 0 or at least 1 rcoin');
  perform pg_temp.expect(pg_temp.as_user(b, 'select public.rib_tournament_create(''Cup'', ''Valorant'', 3000, 4, null)'), 'new_account_limit', 'new accounts are capped at 25 rcoin');
  perform pg_temp.expect(pg_temp.as_user(c, 'select public.rib_tournament_create(''Cup'', ''Valorant'', 1000, 4, ''riot'')'), 'game_account_required', 'a network tournament needs a linked account');
  perform pg_temp.expect(pg_temp.as_user(c, 'select public.rib_game_account_set(''steam-ish'', ''Carol'')'), 'invalid_network', 'unknown networks are rejected');
  perform pg_temp.as_user(c, 'select public.rib_game_account_set(''riot'', ''Carol#NA1'')');
  perform pg_temp.expect(pg_temp.as_user(c, 'select public.rib_tournament_create(''Cup'', ''Valorant'', 1000, 4, ''riot'')'), 'ok', 'carol creates a 4-player cup');
  select id into v_tournament from public.tournaments where creator_id = c and name = 'Cup';
  perform pg_temp.expect((select count(*)::text from public.tournament_entries where tournament_id = v_tournament and user_id = c), '1', 'the creator is the first entrant');
  perform pg_temp.expect(pg_temp.as_user(d, format('select public.rib_tournament_join(%L)', v_tournament)), 'game_account_required', 'joining needs the same network');
  perform pg_temp.as_user(a, 'select public.rib_game_account_set(''riot'', ''Alice#NA1'')');
  perform pg_temp.as_user(b, 'select public.rib_game_account_set(''riot'', ''Bob#NA1'')');
  perform pg_temp.as_user(d, 'select public.rib_game_account_set(''riot'', ''Dave#NA1'')');
  perform pg_temp.expect(pg_temp.as_user(c, format('select public.rib_tournament_join(%L)', v_tournament)), 'already_registered', 'no double entry');
  perform pg_temp.expect(pg_temp.as_user(a, format('select public.rib_tournament_join(%L)', v_tournament)), 'ok', 'alice joins');
  perform pg_temp.expect(pg_temp.as_user(b, format('select public.rib_tournament_join(%L)', v_tournament)), 'ok', 'bob joins');
  perform pg_temp.expect(pg_temp.as_user(b, format('select public.rib_tournament_leave(%L)', v_tournament)), 'ok', 'bob leaves before it starts');
  perform pg_temp.expect(pg_temp.balance(b)::text, '9500', 'leaving refunds the entry fee');
  perform pg_temp.as_user(b, format('select public.rib_tournament_join(%L)', v_tournament));
  perform pg_temp.expect((select status from public.tournaments where id = v_tournament), 'open', 'three entrants do not start a 4-player cup');
  perform pg_temp.expect(pg_temp.as_user(d, format('select public.rib_tournament_join(%L)', v_tournament)), 'ok', 'dave fills the cup');
  perform pg_temp.expect((select status from public.tournaments where id = v_tournament), 'active', 'a full cup starts');
  perform pg_temp.expect((select string_agg(round || ':' || status, ',' order by round, slot) from public.match_rooms where tournament_id = v_tournament), '1:ready_check,1:ready_check,2:waiting', 'the bracket has two semifinals and a final');
  perform pg_temp.expect(pg_temp.scalar_as(b, 'select needs_me::text || '':'' || tournament_name from public.rib_my_rooms() limit 1'), 'true:Cup', 'my rooms flag a ready check that needs me');
  perform pg_temp.expect(pg_temp.as_user(e, format('select public.rib_tournament_join(%L)', v_tournament)), 'registration_closed', 'a started cup is closed');

  -- Semifinal X (bob's): bob claims a win he didn't get; his opponent disputes.
  select id, case when player_a = b then player_b else player_a end into v_room, v_opp
    from public.match_rooms where tournament_id = v_tournament and round = 1 and b in (player_a, player_b);
  perform pg_temp.as_user(b, format('select public.rib_room_ready(%L)', v_room));
  perform pg_temp.as_user(v_opp, format('select public.rib_room_ready(%L)', v_room));
  perform pg_temp.expect(pg_temp.as_user(v_opp, format('select public.rib_room_message(%L, ''gg, lobby is up'')', v_room)), 'ok', 'players chat in the room');
  perform pg_temp.expect(pg_temp.as_user(e, format('select public.rib_room_message(%L, ''hi'')', v_room)), 'not_a_participant', 'outsiders cannot chat');
  perform pg_temp.expect(pg_temp.scalar_as(e, format('select count(*) from public.room_messages where room_id = %L', v_room)), '0', 'outsiders cannot read the chat');
  perform pg_temp.expect(pg_temp.scalar_as(b, format('select b_handle is not null and a_handle is not null from public.rib_room_info(%L)', v_room)), 'true', 'the room shows both handles');
  perform pg_temp.as_user(b, format('select public.rib_room_report(%L, %L)', v_room, b));
  perform pg_temp.expect(pg_temp.as_user(v_opp, format('select public.rib_room_dispute(%L, ''no'')', v_room)), 'dispute_reason_required', 'a dispute needs a reason');
  v_before_d := pg_temp.balance(v_opp);
  perform pg_temp.expect(pg_temp.as_user(v_opp, format('select public.rib_room_dispute(%L, ''I won 13-9, bob left the lobby'')', v_room)), 'ok', 'the opponent disputes');
  perform pg_temp.expect((select status || ':' || dispute_deposit_cents from public.match_rooms where id = v_room), 'disputed:100', 'a paid dispute holds a 10% deposit');
  perform pg_temp.expect((v_before_d - pg_temp.balance(v_opp))::text, '100', 'the deposit leaves the disputer''s balance');
  perform set_config('request.jwt.claim.sub', v_opp::text, true);
  select t.token into v_token from public.rib_room_evidence_token(v_room) t;
  perform pg_temp.expect(pg_temp.as_user(v_opp, format('select public.rib_room_evidence_add(%L, %L, %L, %L, ''screen'')', v_room, v_token, 'elsewhere/x.jpg', repeat('a', 64))), 'evidence_invalid', 'evidence must live in the player''s room folder');
  perform pg_temp.expect(pg_temp.as_user(v_opp, format('select public.rib_room_evidence_add(%L, %L, %L, %L, ''screen'')', v_room, v_token, v_room || '/' || v_opp || '/end.jpg', repeat('a', 64))), 'ok', 'evidence is added with a fresh token');
  perform pg_temp.expect(pg_temp.as_user(v_opp, format('select public.rib_room_evidence_add(%L, %L, %L, %L, ''screen'')', v_room, v_token, v_room || '/' || v_opp || '/again.jpg', repeat('b', 64))), 'evidence_token_invalid', 'a capture token works once');
  perform pg_temp.expect(pg_temp.as_user(c, 'select * from public.rib_ops_room_disputes()'), 'not_operator', 'only operators see the dispute queue');
  perform pg_temp.expect(pg_temp.as_user(c, format('select public.rib_room_resolve(%L, ''award'', %L)', v_room, v_opp)), 'not_operator', 'only operators resolve');
  insert into public.operators (user_id) values (e);
  perform pg_temp.expect(pg_temp.scalar_as(e, 'select count(*) from public.rib_ops_room_disputes()'), '1', 'the operator sees the dispute');
  perform pg_temp.expect(pg_temp.scalar_as(e, format('select count(*) from public.room_evidence where room_id = %L', v_room)), '1', 'the operator sees the evidence');
  perform pg_temp.expect(pg_temp.as_user(e, format('select public.rib_room_resolve(%L, ''award'', %L, ''scoreboard shows the opponent won'')', v_room, v_opp)), 'ok', 'the operator awards the opponent');
  perform pg_temp.expect((v_before_d - pg_temp.balance(v_opp))::text, '0', 'an upheld dispute returns the deposit');
  perform pg_temp.expect((select disputes_lost::text from public.player_reputation where user_id = b), '1', 'a false claim counts against the player');
  perform pg_temp.expect(pg_temp.balance(b)::text, '8500', 'bob lost his entry fee');
  delete from public.operators where user_id = e;

  -- Semifinal Y: one player never gets ready and loses by walkover.
  select id, player_a, player_b into v_room, v_ya, v_yb
    from public.match_rooms where tournament_id = v_tournament and round = 1 and b not in (player_a, player_b);
  perform pg_temp.as_user(v_ya, format('select public.rib_room_ready(%L)', v_room));
  update public.match_rooms set ready_deadline = now() - interval '1 minute' where id = v_room;
  perform pg_temp.expect(pg_temp.as_user(v_yb, format('select public.rib_room_ready(%L)', v_room)), 'ready_expired', 'no ready after the deadline');
  perform public.rib_room_sweep();
  perform pg_temp.expect((select status || ':' || (winner_id = v_ya)::text || ':' || walkover::text from public.match_rooms where id = v_room), 'done:true:true', 'the ready player advances by walkover');
  perform pg_temp.expect((select no_shows::text from public.player_reputation where user_id = v_yb), '1', 'the absent player counts a no-show');

  -- Final: opens once both semifinals are decided; silence confirms the report.
  select id into v_room from public.match_rooms where tournament_id = v_tournament and round = 2;
  perform pg_temp.expect((select status from public.match_rooms where id = v_room), 'ready_check', 'the final opens when both finalists are known');
  perform pg_temp.as_user(v_opp, format('select public.rib_room_ready(%L)', v_room));
  perform pg_temp.as_user(v_ya, format('select public.rib_room_ready(%L)', v_room));
  perform pg_temp.as_user(v_opp, format('select public.rib_room_report(%L, %L)', v_room, v_opp));
  update public.match_rooms set confirm_deadline = now() - interval '1 minute' where id = v_room;
  perform public.rib_room_sweep();
  perform pg_temp.expect((select status || ':' || (winner_id = v_opp)::text || ':' || (runner_up_id = v_ya)::text from public.tournaments where id = v_tournament), 'finished:true:true', 'silence confirms the final and the cup finishes');
  perform pg_temp.expect((select sum(amount_cents)::text from public.wallet_ledger where ref_id = v_tournament and kind = 'tournament_prize' and user_id = v_opp), '2520', 'the champion gets 70% of 90% of the pool');
  perform pg_temp.expect((select sum(amount_cents)::text from public.wallet_ledger where ref_id = v_tournament and kind = 'tournament_prize' and user_id = v_ya), '1080', 'the runner-up gets 30%');
  perform pg_temp.expect((select amount_cents::text from public.platform_revenue where tournament_id = v_tournament), '400', 'the platform keeps 10%');
  perform pg_temp.expect(pg_temp.scalar_as(v_opp, format('select prize_cents::text || '':'' || eliminated::text from public.rib_my_tournaments() where id = %L', v_tournament)), '2520:false', 'my tournaments show what I won');
  perform pg_temp.expect(pg_temp.scalar_as(b, format('select prize_cents::text || '':'' || eliminated::text || '':'' || my_round from public.rib_my_tournaments() where id = %L', v_tournament)), '0:true:1', 'my tournaments show where I went out');
  perform pg_temp.expect(pg_temp.scalar_as(e, format('select name from public.rib_tournament_summary(%L)', v_tournament)), 'Cup', 'a tournament can be looked up for an invite link');
  perform pg_temp.expect((select count(*)::text from public.rib_tournament_bracket(v_tournament)), '3', 'the bracket is public');
  perform pg_temp.as_user(c, 'select public.rib_tournament_create(''Cup R'', ''Valorant'', 0, 4, ''riot'')');
  perform pg_temp.expect(pg_temp.as_user(c, 'select public.rib_game_account_remove(''riot'')'), 'game_account_in_use', 'a linked account in use cannot be removed');
  perform pg_temp.as_user(c, format('select public.rib_tournament_leave(%L)', (select id from public.tournaments where name = 'Cup R')));
  perform pg_temp.expect(pg_temp.as_user(c, 'select public.rib_game_account_remove(''riot'')'), 'ok', 'an unused account can be removed');

  -- A sit & go that never fills is refunded after 24 hours.
  perform pg_temp.as_user(d, 'select public.rib_tournament_create(''Cup 2'', ''chess'', 500, 8, null)');
  select id into v_tournament from public.tournaments where creator_id = d and name = 'Cup 2';
  v_before_d := pg_temp.balance(d);
  update public.tournaments set created_at = now() - interval '25 hours' where id = v_tournament;
  perform pg_temp.expect(pg_temp.as_user(d, 'select public.rib_room_sweep()'), '42501', 'the sweep is not callable by clients');
  perform public.rib_room_sweep();
  perform pg_temp.expect((select status from public.tournaments where id = v_tournament), 'cancelled', 'an unfilled cup is cancelled');
  perform pg_temp.expect((pg_temp.balance(d) - v_before_d)::text, '500', 'its entry fees are refunded');
  update public.player_reputation set disputes_lost = 3 where user_id = d;
  perform pg_temp.expect(pg_temp.as_user(d, 'select public.rib_tournament_create(''Cup 3'', ''chess'', 100, 4, null)'), 'account_restricted', 'players with 3 lost disputes are paused');
  update public.player_reputation set disputes_lost = 0 where user_id = d;
  perform pg_temp.expect(pg_temp.as_user(d, 'select public.rib_tournament_create(''Cup 4'', ''chess'', 0, 4, null)'), 'ok', 'free tournaments skip paid limits');

  -- An 8-player bracket runs three rounds; an empty semifinal cascades into
  -- a walkover final and a champion with no runner-up.
  perform pg_temp.as_user('f1000000-0000-0000-0000-000000000001', 'select public.rib_tournament_create(''Big cup'', ''chess'', 0, 8, null)');
  select id into v_tournament from public.tournaments where name = 'Big cup';
  foreach u in array array[a, b, c, 'f2000000-0000-0000-0000-000000000002'::uuid, 'f3000000-0000-0000-0000-000000000003'::uuid,
                           'f4000000-0000-0000-0000-000000000004'::uuid, d] loop
    perform pg_temp.as_user(u, format('select public.rib_tournament_join(%L)', v_tournament));
  end loop;
  perform pg_temp.expect((select count(*)::text || '/' || max(round)::text from public.match_rooms where tournament_id = v_tournament), '7/3', 'an 8-player bracket has 7 matches over 3 rounds');
  for v_room, v_ya, v_yb in select id, player_a, player_b from public.match_rooms where tournament_id = v_tournament and round = 1 order by slot loop
    perform pg_temp.as_user(v_ya, format('select public.rib_room_ready(%L)', v_room));
    perform pg_temp.as_user(v_yb, format('select public.rib_room_ready(%L)', v_room));
    perform pg_temp.as_user(v_ya, format('select public.rib_room_report(%L, %L)', v_room, v_ya));
    perform pg_temp.as_user(v_yb, format('select public.rib_room_report(%L, %L)', v_room, v_ya));
  end loop;
  perform pg_temp.expect((select string_agg(status, ',' order by slot) from public.match_rooms where tournament_id = v_tournament and round = 2), 'ready_check,ready_check', 'quarterfinal winners meet in the semifinals');
  select id into v_room from public.match_rooms where tournament_id = v_tournament and round = 2 and slot = 0;
  update public.match_rooms set ready_deadline = now() - interval '1 minute' where tournament_id = v_tournament and round = 2 and slot = 1;
  perform public.rib_room_sweep();
  perform pg_temp.expect((select status from public.match_rooms where tournament_id = v_tournament and round = 2 and slot = 1), 'void', 'a semifinal where nobody is ready is void');
  select player_a, player_b into v_ya, v_yb from public.match_rooms where id = v_room;
  perform pg_temp.as_user(v_ya, format('select public.rib_room_ready(%L)', v_room));
  perform pg_temp.as_user(v_yb, format('select public.rib_room_ready(%L)', v_room));
  perform pg_temp.as_user(v_ya, format('select public.rib_room_report(%L, %L)', v_room, v_yb));
  perform pg_temp.as_user(v_yb, format('select public.rib_room_report(%L, %L)', v_room, v_yb));
  perform pg_temp.expect((select status || ':' || walkover::text from public.match_rooms where tournament_id = v_tournament and round = 3), 'done:true', 'the lone finalist wins the final by walkover');
  perform pg_temp.expect((select status || ':' || (winner_id = v_yb)::text || ':' || (runner_up_id is null)::text from public.tournaments where id = v_tournament), 'finished:true:true', 'the champion has no runner-up after a walkover final');

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
  perform pg_temp.expect(pg_temp.as_user(b, 'select public.rib_tournament_create(''Frozen cup'', ''chess'', 100, 4, null)'), 'wallet_frozen', 'frozen wallet cannot pay an entry fee');

  -- Server-authoritative games (0012), free friendlies since 0022.
  perform pg_temp.expect(pg_temp.as_user(a, 'select public.rib_game_create(''eights'', 100, ''{}'')'), 'unknown_game', 'crazy eights is not a server-verified game');
  perform pg_temp.expect(pg_temp.as_user(a, 'select public.rib_game_create(''tictactoe'', 100, ''{}'')'), 'ok', 'alice opens a table');
  select id into v_match from public.game_matches where host_id = a and status = 'open' order by created_at desc limit 1;
  perform pg_temp.expect((select stake_cents::text from public.game_matches where id = v_match), '0', 'tables are free even if a fee is sent');
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
  perform pg_temp.expect((select status || ':' || (winner_id = a)::text from public.game_matches where id = v_match), 'settled:true', 'the server settles the game');
  perform pg_temp.expect((pg_temp.balance(a) - v_before_a)::text || '/' || (pg_temp.balance(c) - v_before_c)::text, '0/0', 'a free table moves no money');

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
  perform pg_temp.expect(pg_temp.as_user(a, $q$select public.rib_profile_update('BOB', 'Alice', null, null)$q$), 'username_taken', 'usernames unique regardless of case');
  perform pg_temp.expect(pg_temp.as_user(a, 'select role from public.profiles limit 1'), '42501', 'role column not readable by players');
  perform pg_temp.expect(pg_temp.as_user(a, 'select id, username, display_name from public.profiles limit 1'), 'ok', 'handles readable by players');

  -- Leaderboard (0022): tournaments rank. Net rcoin = prizes minus entry fees;
  --   the record counts confirmed tournament matches (walkovers don't).
  --   Cup (4 x 10 rcoin): the champion nets +15.20; bob paid 10 and lost.
  perform public.refresh_player_rankings();
  perform pg_temp.expect((select net_cents::text from public.player_stats where user_id = v_opp), '1520', 'the champion ranks by net tournament winnings');
  perform pg_temp.expect((select net_cents::text from public.player_stats where user_id = b), '-1000', 'entry fees count against the player');
  perform pg_temp.expect((select (wins >= 2)::text from public.player_stats where user_id = v_opp), 'true', 'confirmed tournament matches build the record');
  perform pg_temp.expect((select username from public.rib_leaderboard('all', 1, 0)), (select username from public.profiles where id = v_opp), 'the biggest net winner tops the board');
  perform pg_temp.expect((select count(*)::text from public.rib_leaderboard('week', 50, 0)), (select count(*)::text from public.rib_leaderboard('all', 50, 0)), 'this week''s board has the same players');
  perform set_config('request.jwt.claim.sub', v_opp::text, true);
  perform pg_temp.expect((select rank::text from public.rib_my_standing('all')), '1', 'my standing shows my rank');
  perform pg_temp.expect(pg_temp.as_user(a, 'select * from public.player_rankings'), '42501', 'ranking snapshot not readable by clients');
  perform pg_temp.expect(pg_temp.as_user(a, 'select public.refresh_player_rankings()'), '42501', 'ranking refresh not callable by clients');
  perform pg_temp.expect(pg_temp.as_user(a, 'select * from public.player_stats'), '42501', 'raw stats not readable by clients');

  -- Challenge lobby (0014).
  perform pg_temp.as_user(a, 'select public.rib_challenge_create(''Valorant'', ''1v1'')');
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
  perform pg_temp.as_user(a, 'select public.rib_challenge_create(''Chess'', ''1v1'')');
  update public.challenges set created_at = '2026-09-01T00:00:00Z' where status = 'open' and creator_id = a;
  perform set_config('request.jwt.claim.sub', c::text, true);
  select id into v_match from public.rib_open_challenges(null, null, null, null, 1);
  perform pg_temp.expect(
    (select count(*)::text from public.rib_open_challenges(null, null, null, '2026-09-01T00:00:00Z', 1, v_match)),
    '1', 'second page returns the tied row');
  perform pg_temp.expect(
    (select count(*)::text from public.rib_open_challenges('%', null, null, null, 30)), '0', 'search treats % literally');

  -- Turn clock (0018): a player who stops moving loses on time.
  perform pg_temp.expect(pg_temp.as_user(a, 'select public.rib_game_create(''connect4'', 100, ''{}'')'), 'ok', 'alice opens a timed table');
  select id into v_match from public.game_matches where host_id = a and status = 'open' order by created_at desc limit 1;
  perform pg_temp.expect(pg_temp.as_user(c, format('select public.rib_game_join(%L, null)', v_match)), 'ok', 'carol joins the timed table');
  perform pg_temp.expect((select (turn_deadline > now())::text from public.game_matches where id = v_match), 'true', 'joining starts the host''s clock');
  perform pg_temp.expect(pg_temp.as_user(c, format('select public.rib_game_claim_timeout(%L)', v_match)), 'not_timed_out', 'cannot claim while the clock runs');
  perform pg_temp.expect(pg_temp.as_user(c, format('select public.rib_game_void(%L)', v_match)), 'use_timeout_claim', 'timed matches cannot be voided for a refund');
  update public.game_matches set turn_deadline = now() - interval '1 minute' where id = v_match;
  begin
    perform public.rib_game_commit_move(v_match, 0, '{"turn":1}', c, false, null);
    raise exception 'FAIL late move accepted';
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    perform pg_temp.expect(v_hint, 'turn_timed_out', 'a move after the deadline is refused');
  end;
  perform pg_temp.expect(pg_temp.as_user(a, format('select public.rib_game_claim_timeout(%L)', v_match)), 'not_timed_out', 'the late player cannot claim');
  v_before_c := pg_temp.balance(c);
  perform pg_temp.expect(pg_temp.as_user(c, format('select public.rib_game_claim_timeout(%L)', v_match)), 'ok', 'the waiting player claims on time');
  perform pg_temp.expect((select status || ':' || (winner_id = c)::text from public.game_matches where id = v_match), 'settled:true', 'the claim settles the game');
  perform pg_temp.expect((pg_temp.balance(c) - v_before_c)::text, '0', 'a free game lost on time moves no money');
  -- The background job does the same for unclaimed matches.
  perform pg_temp.as_user(c, 'select public.rib_game_create(''tictactoe'', 100, ''{}'')');
  select id into v_match from public.game_matches where host_id = c and status = 'open' order by created_at desc limit 1;
  perform pg_temp.as_user(a, format('select public.rib_game_join(%L, null)', v_match));
  update public.game_matches set turn_deadline = now() - interval '5 minutes' where id = v_match;
  perform pg_temp.expect(public.rib_forfeit_timeouts()::text, '1', 'forfeit job resolves the timed-out match');
  perform pg_temp.expect((select (winner_id = a)::text from public.game_matches where id = v_match), 'true', 'the player on move forfeits');

  -- Client error reports (0020).
  perform pg_temp.expect(pg_temp.as_user(a, 'select public.rib_log_client_error(''TypeError: x is undefined'', ''console.js:1'', ''/console.html'', null, null)'), 'ok', 'signed-in users can report errors');
  perform pg_temp.expect((select count(*)::text from public.client_errors where user_id = a), '1', 'error report stored');
  perform pg_temp.expect(pg_temp.as_user(a, 'select * from public.client_errors'), '42501', 'error reports are server-only');

  -- Developer API keys, projects, account closure, ops (0021).
  insert into public.projects (id, owner_id, name, environment) values ('f0000000-0000-0000-0000-000000000001', e, 'Game', 'test');
  insert into public.api_keys (owner_id, project_id, name, environment, key_prefix, key_hash)
  values (e, 'f0000000-0000-0000-0000-000000000001', 'k', 'test', 'rib_test_abcd', 'hash-1');
  perform pg_temp.expect((select project_name from public.rib_api_verify_key('hash-1')), 'Game', 'a live key resolves to its project');
  perform pg_temp.expect((select (last_used_at is not null)::text from public.api_keys where key_hash = 'hash-1'), 'true', 'key use is recorded');
  perform pg_temp.expect(pg_temp.as_user(e, 'select * from public.rib_api_verify_key(''hash-1'')'), '42501', 'key verification is server-only');
  perform pg_temp.expect(pg_temp.as_user(e, $q$delete from public.projects where id = 'f0000000-0000-0000-0000-000000000001'$q$), 'ok', 'owner deletes the project');
  perform pg_temp.expect((select (revoked_at is not null)::text from public.api_keys where key_hash = 'hash-1'), 'true', 'deleting a project revokes its keys');
  perform pg_temp.expect((select count(*)::text from public.rib_api_verify_key('hash-1')), '0', 'revoked keys no longer authenticate');
  perform pg_temp.expect(pg_temp.as_user(a, 'select public.rib_close_account()'), 'close_account_blocked', 'cannot close with an open challenge');
  perform pg_temp.expect(pg_temp.as_user(e, 'select public.rib_close_account()'), 'ok', 'an idle account closes');
  perform pg_temp.expect((select (username like 'closed_%' and closed_at is not null)::text from public.profiles where id = e), 'true', 'closed profile is anonymized');
  perform pg_temp.expect(pg_temp.as_user(e, 'select public.rib_settings_get()'), 'account_closed', 'a closed account has no settings to recreate');
  perform pg_temp.expect((select (count(*) > 0)::text from public.wallet_ledger where user_id = e), 'true', 'financial history is kept');
  perform pg_temp.expect((public.rib_ops_health() ? 'disputed_tournaments')::text, 'true', 'ops health reports counters');

  -- Profile, settings and responsible play (0024).
  perform pg_temp.as_user(g, 'select public.rib_buy_rcoin_test(10000)');
  perform pg_temp.expect(pg_temp.as_user(g, $q$select public.rib_profile_update('grace_x', 'Grace', E'Hi\tthere', 'mx')$q$), 'ok', 'first username change is free');
  perform pg_temp.expect((select username || '|' || bio || '|' || country from public.profiles where id = g), 'grace_x|Hi there|MX', 'bio is cleaned and country normalized');
  perform pg_temp.expect(pg_temp.as_user(g, $q$select public.rib_profile_update('grace_y', 'Grace', null, null)$q$), 'username_cooldown', 'a second handle change waits 30 days');
  perform pg_temp.expect(pg_temp.as_user(g, $q$select public.rib_profile_update('Grace_X', 'Grace', 'Hi', 'MX')$q$), 'ok', 'a case-only change is always allowed');
  perform pg_temp.expect(pg_temp.as_user(g, $q$select public.rib_profile_update(null, null, null, 'ZZ')$q$), 'invalid_country', 'country must be ISO 3166');
  update public.profiles set username_changed_at = null where id = g;
  perform pg_temp.expect(pg_temp.as_user(g, $q$select public.rib_profile_update('Admin', null, null, null)$q$), 'username_reserved', 'staff handles are reserved');
  perform pg_temp.expect(pg_temp.as_user(g, $q$select public.rib_profile_update('closed_abc', null, null, null)$q$), 'username_reserved', 'the closure prefix is reserved');
  perform pg_temp.expect(pg_temp.as_user(g, $q$select public.rib_profile_update('Grace_X', 'Grace', 'Hi', 'MX')$q$), 'ok', 'profile saved');
  perform pg_temp.expect(pg_temp.as_user(g, 'select public.rib_avatar_set(true)'), 'ok', 'avatar set');
  perform pg_temp.expect(pg_temp.scalar_as(a, $q$select public.rib_public_profile('grace_x') ->> 'avatar'$q$), g::text || '/avatar.webp?v=1', 'public card carries a versioned avatar');
  perform pg_temp.expect(pg_temp.scalar_as(a, $q$select (public.rib_public_profile('grace_x') -> 'game_accounts')::text$q$), 'null', 'linked accounts are private by default');
  perform pg_temp.expect(pg_temp.scalar_as(a, $q$select coalesce(public.rib_public_profile('nobody_here')::text, 'none')$q$), 'none', 'unknown player returns nothing');

  perform pg_temp.expect(pg_temp.as_user(g, $q$select public.rib_settings_update('{"nope": true}')$q$), 'invalid_setting', 'unknown settings are rejected');
  perform pg_temp.expect(pg_temp.as_user(g, $q$select public.rib_settings_update('{"monthly_cap_cents": 1050}')$q$), 'invalid_entry_cap', 'the cap is whole rcoin');
  perform pg_temp.expect(pg_temp.as_user(g, $q$select public.rib_settings_update('{"monthly_cap_cents": 1500}')$q$), 'ok', 'set a monthly entry cap');
  perform pg_temp.expect(pg_temp.as_user(g, $q$select public.rib_tournament_create('Grace Cup', 'CS2', 1000, 4, null)$q$), 'ok', 'an entry under the cap goes through');
  perform pg_temp.expect(pg_temp.as_user(g, $q$select public.rib_tournament_create('Grace Cup 2', 'CS2', 1000, 4, null)$q$), 'entry_cap_reached', 'an entry past the cap is refused');
  perform pg_temp.expect(pg_temp.scalar_as(g, $q$select public.rib_settings_get() ->> 'month_spent_cents'$q$), '1000', 'this month''s entry fees are counted');
  perform pg_temp.expect(pg_temp.as_user(g, $q$select public.rib_settings_update('{"monthly_cap_cents": 5000}')$q$), 'ok', 'ask to raise the cap');
  perform pg_temp.expect(pg_temp.scalar_as(g, $q$select (public.rib_settings_get() ->> 'monthly_cap_cents') || ':' || (public.rib_settings_get() -> 'pending_cap' ->> 'cents')$q$), '1500:5000', 'raising the cap waits');
  update public.profile_settings set pending_cap_at = now() - interval '1 second' where user_id = g;
  perform pg_temp.expect(pg_temp.scalar_as(g, $q$select public.rib_settings_get() ->> 'monthly_cap_cents'$q$), '5000', 'the raise applies after 24 hours');
  perform pg_temp.expect(pg_temp.as_user(g, $q$select public.rib_settings_update('{"monthly_cap_cents": 2000}')$q$), 'ok', 'lower the cap');
  perform pg_temp.expect(pg_temp.scalar_as(g, $q$select public.rib_settings_get() ->> 'monthly_cap_cents'$q$), '2000', 'lowering applies at once');
  perform pg_temp.expect(pg_temp.as_user(g, $q$select public.rib_settings_update('{"cooloff_days": 7}')$q$), 'ok', 'start a cool-off');
  perform pg_temp.expect(pg_temp.as_user(g, $q$select public.rib_tournament_create('Grace Cup 3', 'CS2', 500, 4, null)$q$), 'cooloff_active', 'a cool-off pauses paid entries');
  perform pg_temp.expect(pg_temp.as_user(g, $q$select public.rib_tournament_create('Free Cup', 'CS2', 0, 4, null)$q$), 'ok', 'free tournaments stay open during a cool-off');
  perform pg_temp.expect(pg_temp.as_user(g, $q$select public.rib_settings_update('{"end_cooloff": true}')$q$), 'ok', 'ask to end the cool-off');
  perform pg_temp.expect(pg_temp.as_user(g, $q$select public.rib_tournament_create('Grace Cup 4', 'CS2', 500, 4, null)$q$), 'cooloff_active', 'ending early waits 7 days');
  update public.profile_settings set pending_cooloff_end_at = now() - interval '1 second' where user_id = g;
  perform pg_temp.expect(pg_temp.scalar_as(g, $q$select coalesce(public.rib_settings_get() ->> 'cooloff_until', 'none')$q$), 'none', 'the cool-off ends after the wait');

  perform public.refresh_player_rankings();
  perform pg_temp.expect(pg_temp.as_user(a, $q$select public.rib_settings_update('{"show_on_leaderboard": false}')$q$), 'ok', 'hide from the ranking');
  perform pg_temp.expect((select count(*)::text from public.rib_leaderboard('all', 100, 0) where user_id = a), '0', 'hidden players leave the board at once');
  perform public.refresh_player_rankings();
  perform pg_temp.expect((select count(*)::text from public.rib_leaderboard('all', 100, 0) where user_id = a), '0', 'and stay off after a refresh');
  perform pg_temp.expect((select min(rank)::text from public.rib_leaderboard('all', 100, 0)), '1', 'the board re-ranks without gaps');
  perform pg_temp.expect(pg_temp.scalar_as(b, $q$select coalesce(public.rib_public_profile('alice') -> 'stats', 'null')::text$q$), 'null', 'hidden stats stay off the public card');

  perform pg_temp.expect(pg_temp.scalar_as(b, $q$select (public.rib_public_profile('alice') -> 'tournaments')::text$q$), 'null', 'hidden players'' tournaments stay private too');
  perform pg_temp.expect(pg_temp.as_user(g, $q$select public.rib_profile_update(null, 'Runinback Support', null, null)$q$), 'display_name_reserved', 'official-looking display names are refused');
  perform pg_temp.expect(pg_temp.as_user(g, $q$select public.rib_profile_update('admin_help', null, null, null)$q$), 'username_reserved', 'staff prefixes are reserved');
  perform pg_temp.expect(pg_temp.as_user(g, $q$select public.rib_profile_update(null, E'Gr\u202Eace\u200B', null, 'MX')$q$), 'ok', 'save a name with hidden characters');
  perform pg_temp.expect((select display_name from public.profiles where id = g), 'Grace', 'bidi and zero-width characters are stripped');
  insert into auth.users (id, email, raw_user_meta_data) values ('98888888-0000-0000-0000-000000000008', 'fake@example.test', '{"username":"Runinback_Official"}');
  perform pg_temp.expect((select (username like 'player\_%')::text from public.profiles where id = '98888888-0000-0000-0000-000000000008'), 'true', 'a reserved handle at sign-up becomes a neutral one');
  -- A refund for last month's entry doesn't free room this month.
  insert into public.wallet_ledger (user_id, kind, amount_cents, balance_after_cents, ref_type, ref_id, created_at)
  values (g, 'tournament_entry', -700, 0, 'tournament', 'a0000000-0000-0000-0000-00000000000a', date_trunc('month', now()) - interval '1 day'),
         (g, 'tournament_refund', 700, 0, 'tournament', 'a0000000-0000-0000-0000-00000000000a', now());
  perform pg_temp.expect(public.rib_month_entry_spend(g)::text, '1000', 'old refunds don''t lower this month''s spend');
  delete from public.wallet_ledger where ref_id = 'a0000000-0000-0000-0000-00000000000a';

  perform pg_temp.expect(pg_temp.as_user(g, 'select public.rib_my_data_export()'), 'ok', 'download my data');
  perform pg_temp.expect(pg_temp.scalar_as(g, $q$select (public.rib_settings_get() ->> 'next_export_at') is not null$q$), 'true', 'the next download is scheduled');
  perform pg_temp.expect(pg_temp.as_user(g, 'select public.rib_my_data_export()'), 'export_rate_limited', 'data export is once an hour');
  perform pg_temp.expect(pg_temp.as_user(g, 'select * from public.profile_settings'), '42501', 'settings are RPC-only');
  perform pg_temp.expect(pg_temp.as_user(g, 'select public.rib_close_account()'), 'close_account_blocked', 'cannot close while entered in a tournament');
  perform pg_temp.expect(pg_temp.as_user(g, 'select public.rib_month_entry_spend(''99999999-0000-0000-0000-000000000009'')'), '42501', 'spend helper is server-only');

  -- Social profile: about, friends, blocks, privacy (0025).
  perform pg_temp.expect(pg_temp.as_user(g, $q$select public.rib_profile_about_update(array['Valorant', 'valorant', ' CS2 '], '{"twitch": "grace_tv", "discord": ""}', 'settle')$q$), 'ok', 'save favorite games and links');
  perform pg_temp.expect((select array_to_string(favorite_games, ',') || '|' || links::text || '|' || banner from public.profiles where id = g),
    'Valorant,CS2|{"twitch": "grace_tv"}|settle', 'games are de-duplicated and blank links dropped');
  perform pg_temp.expect(pg_temp.as_user(g, $q$select public.rib_profile_about_update('{}', '{"x": "javascript:alert(1)"}', 'ink')$q$), 'invalid_link', 'links are handles, never URLs');
  perform pg_temp.expect(pg_temp.as_user(g, $q$select public.rib_profile_about_update('{}', '{}', 'pink')$q$), 'invalid_banner', 'banner comes from the palette');

  perform pg_temp.expect(pg_temp.scalar_as(g, $q$select public.rib_friend_request('bob')$q$), 'requested', 'send a friend request');
  perform pg_temp.expect(pg_temp.scalar_as(b, $q$select public.rib_friend_requests() -> 'incoming' -> 0 ->> 'username'$q$), 'Grace_X', 'the request shows up for bob');
  perform pg_temp.expect(pg_temp.scalar_as(b, $q$select public.rib_friend_request('grace_x')$q$), 'friends', 'asking back makes friends');
  perform pg_temp.expect(pg_temp.scalar_as(g, $q$select string_agg(username, ',') from public.rib_friends()$q$), 'bob', 'friends list');
  perform pg_temp.expect(pg_temp.scalar_as(g, $q$select public.rib_public_profile('bob') ->> 'relationship'$q$), 'friends', 'card knows we are friends');
  perform pg_temp.expect(pg_temp.scalar_as(g, $q$select public.rib_my_profile() ->> 'friend_count'$q$), '1', 'friend count');
  perform pg_temp.expect(pg_temp.scalar_as(g, $q$select public.rib_friend_request('carol')$q$), 'requested', 'ask carol');
  perform pg_temp.expect(pg_temp.scalar_as(c, $q$select public.rib_friend_respond('grace_x', false)$q$), 'none', 'carol declines');
  perform pg_temp.expect(pg_temp.as_user(c, $q$select public.rib_privacy_update('friends', 'nobody', 'friends')$q$), 'ok', 'carol locks down her privacy');
  perform pg_temp.expect(pg_temp.as_user(g, $q$select public.rib_friend_request('carol')$q$), 'friend_requests_closed', 'requests can be turned off');
  perform pg_temp.expect(pg_temp.as_user(g, $q$select public.rib_challenge_create('Chess', '1v1', 'carol', null)$q$), 'challenges_closed', 'direct friendlies from friends only');
  perform pg_temp.expect(pg_temp.scalar_as(g, $q$select (public.rib_public_profile('carol') ->> 'full') || ':' || coalesce(public.rib_public_profile('carol') ->> 'bio', 'hidden')$q$), 'false:hidden', 'a friends-only card shows only the basics');
  perform pg_temp.expect(pg_temp.as_user(g, $q$select public.rib_privacy_update(null, null, 'friends')$q$), 'ok', 'grace takes friendlies from friends');
  perform pg_temp.expect(pg_temp.as_user(b, $q$select public.rib_challenge_create('Chess', '1v1', 'grace_x', null)$q$), 'ok', 'a friend can challenge her directly');

  perform pg_temp.expect(pg_temp.scalar_as(g, $q$select public.rib_block('dave')$q$), 'blocked', 'block a player');
  perform pg_temp.expect(pg_temp.scalar_as(d, $q$select coalesce(public.rib_public_profile('grace_x')::text, 'none')$q$), 'none', 'the blocked player can''t see her card');
  perform pg_temp.expect(pg_temp.as_user(d, $q$select public.rib_friend_request('grace_x')$q$), 'user_not_found', 'nor send a request');
  perform pg_temp.expect(pg_temp.as_user(d, $q$select public.rib_challenge_create('Chess', '1v1', 'grace_x', null)$q$), 'user_not_found', 'nor challenge her');
  perform pg_temp.expect(pg_temp.scalar_as(g, $q$select public.rib_public_profile('dave') ->> 'relationship'$q$), 'blocked', 'she can still open his card to unblock');
  perform pg_temp.expect(pg_temp.scalar_as(g, $q$select string_agg(username, ',') from public.rib_blocked()$q$), 'dave', 'block list');
  perform pg_temp.expect(pg_temp.scalar_as(g, $q$select public.rib_unblock('dave')$q$), 'none', 'unblock');
  perform pg_temp.expect(pg_temp.as_user(g, 'select * from public.friendships'), '42501', 'the social graph is RPC-only');

  -- Ledger integrity: every balance equals the sum of its ledger rows.
  perform pg_temp.expect(
    (select count(*)::text from public.wallets w
      where w.test_balance_cents <> coalesce((select sum(amount_cents) from public.wallet_ledger l where l.user_id = w.user_id), 0)),
    '0', 'ledger reconciles with balances');
end;
$$;

\echo 'rpc-smoke: all expectations passed'
