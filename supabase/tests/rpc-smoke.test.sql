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
  ('99999999-0000-0000-0000-000000000009', 'grace@example.test', '{"username":"grace"}'),
  ('a1000000-0000-0000-0000-00000000000a', 'w1@example.test', '{"username":"wr_one"}'),
  ('a2000000-0000-0000-0000-00000000000a', 'w2@example.test', '{"username":"wr_two"}'),
  ('a3000000-0000-0000-0000-00000000000a', 'w3@example.test', '{"username":"wr_three"}'),
  ('a4000000-0000-0000-0000-00000000000a', 'w4@example.test', '{"username":"wr_four"}'),
  ('a5000000-0000-0000-0000-00000000000a', 'w5@example.test', '{"username":"wr_five"}'),
  ('c0000000-0000-0000-0000-0000000000c0', 'host@example.test', '{"username":"host_one"}'),
  ('c9000000-0000-0000-0000-0000000000c9', 'hop@example.test', '{"username":"hosted_ops"}'),
  ('c1000000-0000-0000-0000-0000000000c1', 'hp1@example.test', '{"username":"hp_one"}'),
  ('c2000000-0000-0000-0000-0000000000c2', 'hp2@example.test', '{"username":"hp_two"}'),
  ('c3000000-0000-0000-0000-0000000000c3', 'hp3@example.test', '{"username":"hp_three"}'),
  ('c4000000-0000-0000-0000-0000000000c4', 'hp4@example.test', '{"username":"hp_four"}'),
  ('c5000000-0000-0000-0000-0000000000c5', 'hp5@example.test', '{"username":"hp_five"}'),
  ('c6000000-0000-0000-0000-0000000000c6', 'hp6@example.test', '{"username":"hp_six"}'),
  ('c7000000-0000-0000-0000-0000000000c7', 'hp7@example.test', '{"username":"hp_seven"}');

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
  w1 uuid := 'a1000000-0000-0000-0000-00000000000a';
  w2 uuid := 'a2000000-0000-0000-0000-00000000000a';
  w3 uuid := 'a3000000-0000-0000-0000-00000000000a';
  w4 uuid := 'a4000000-0000-0000-0000-00000000000a';
  w5 uuid := 'a5000000-0000-0000-0000-00000000000a';
  v_za uuid;
  v_zb uuid;
  v_room2 uuid;
  v_ev bigint;
  v_json jsonb;
  v_before_za bigint;
  v_before_zb bigint;
  v_t2 uuid;
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
    'rib_tournament_preview', 'anon can execute only the invite preview');

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
  perform pg_temp.as_user(b, 'select public.rib_game_account_set(''riot'', ''Bob#NA1'')');
  perform pg_temp.expect(pg_temp.as_user(b, 'select public.rib_tournament_create(''Cup'', ''Valorant'', 3000, 4, null)'), 'new_account_limit', 'new accounts are capped at 25 rcoin');
  perform pg_temp.expect(pg_temp.as_user(c, 'select public.rib_tournament_create(''Cup'', ''Valorant'', 1000, 4, ''riot'')'), 'riot_account_required', 'a tournament needs a linked Riot ID');
  perform pg_temp.expect(pg_temp.as_user(c, 'select public.rib_game_account_set(''riot'', ''Carol'')'), 'invalid_riot_id', 'a Riot ID is Name#TAG');
  perform pg_temp.expect(pg_temp.as_user(c, 'select public.rib_game_account_set(''steam-ish'', ''Carol'')'), 'invalid_network', 'unknown networks are rejected');
  perform pg_temp.as_user(c, 'select public.rib_game_account_set(''riot'', ''Carol#NA1'')');
  perform pg_temp.expect(pg_temp.as_user(c, 'select public.rib_tournament_create(''Cup'', ''Valorant'', 1000, 4, ''riot'')'), 'ok', 'carol creates a 4-player cup');
  select id into v_tournament from public.tournaments where creator_id = c and name = 'Cup';
  perform pg_temp.expect((select count(*)::text from public.tournament_entries where tournament_id = v_tournament and user_id = c), '1', 'the creator is the first entrant');
  perform pg_temp.expect(pg_temp.as_user(d, format('select public.rib_tournament_join(%L)', v_tournament)), 'riot_account_required', 'joining needs a Riot ID');
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
  perform pg_temp.expect(pg_temp.scalar_as(e, format('select jsonb_array_length(public.rib_tournament_bracket(%L) -> ''rooms'')::text', v_tournament)), '3', 'the bracket is public');
  perform pg_temp.as_user(c, 'select public.rib_tournament_create(''Cup R'', ''Valorant'', 0, 4, ''riot'')');
  perform pg_temp.expect(pg_temp.as_user(c, 'select public.rib_game_account_remove(''riot'')'), 'game_account_in_use', 'a linked account in use cannot be removed');
  perform pg_temp.as_user(c, format('select public.rib_tournament_leave(%L)', (select id from public.tournaments where name = 'Cup R')));
  perform pg_temp.expect(pg_temp.as_user(c, 'select public.rib_game_account_remove(''riot'')'), 'ok', 'an unused account can be removed');
  perform pg_temp.as_user(c, 'select public.rib_game_account_set(''riot'', ''Carol#NA1'')');

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
  perform pg_temp.as_user('f1000000-0000-0000-0000-000000000001', 'select public.rib_game_account_set(''riot'', ''PlayerOne#NA1'')');
  perform pg_temp.as_user('f2000000-0000-0000-0000-000000000002', 'select public.rib_game_account_set(''riot'', ''PlayerTwo#NA1'')');
  perform pg_temp.as_user('f3000000-0000-0000-0000-000000000003', 'select public.rib_game_account_set(''riot'', ''PlayerThree#NA1'')');
  perform pg_temp.as_user('f4000000-0000-0000-0000-000000000004', 'select public.rib_game_account_set(''riot'', ''PlayerFour#NA1'')');
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
  perform pg_temp.as_user(g, $q$select public.rib_game_account_set('riot', 'Grace#LAN')$q$);
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

  -- Wild Rift engine (0026): rules, Riot IDs, Quick Play, automatic checks.
  perform pg_temp.expect(public.rib_ready_window()::text || '/' || public.rib_confirm_window()::text || '/' || public.rib_verified_confirm_window()::text || '/' || public.rib_auto_settle_confidence()::text,
    '00:05:00/00:10:00/00:03:00/0.90', 'ready 5 min, confirm 10 min, verified confirm 3 min, check at 0.90');
  perform pg_temp.expect(
    (select string_agg(public.rib_riot_id_valid(x)::text, ',' order by n)
       from unnest(array['Name#TAG', E'Na​me#TAG', 'Nm#TAG', 'Name#TA', 'Name#TAG123', '한국어#한국1', 'Name#T-G', 'Na#me#TAG', 'Big Name 16 char#EUW', E'Name\u0007#TAG']) with ordinality u(x, n)),
    'true,false,false,false,false,true,false,false,true,false', 'Riot IDs follow the same rules as the app');
  perform pg_temp.expect(public.rib_riot_id_normalize(E' Name  #TAG '), 'Name#TAG', 'Riot IDs are stored trimmed like the app parses them');
  perform pg_temp.expect(
    public.rib_rate_limit_hit('resultCheckGlobal', '00000000-0000-0000-0000-000000000000', 2, 86400)::text || ','
    || public.rib_rate_limit_hit('resultCheckGlobal', '00000000-0000-0000-0000-000000000000', 2, 86400)::text || ','
    || public.rib_rate_limit_hit('resultCheckGlobal', '00000000-0000-0000-0000-000000000000', 2, 86400)::text,
    'true,true,false', 'the global daily check budget counts on the nil subject');
  update public.platform_settings set value = 'true' where key = 'test_payments_enabled';
  foreach u in array array[w1, w2, w3, w4, w5] loop
    perform pg_temp.as_user(u, 'select public.rib_buy_rcoin_test(10000)');
  end loop;
  perform pg_temp.expect(pg_temp.as_user(w1, $q$select public.rib_game_account_set('riot', 'WildOne#NA1')$q$), 'ok', 'link a Riot ID');
  perform pg_temp.as_user(w2, $q$select public.rib_game_account_set('riot', 'WildTwo#NA1')$q$);
  perform pg_temp.as_user(w3, $q$select public.rib_game_account_set('riot', 'WildThree#NA1')$q$);
  perform pg_temp.as_user(w4, $q$select public.rib_game_account_set('riot', 'WildFour#NA1')$q$);

  -- The service role pins the Riot account; a new handle drops it.
  perform pg_temp.expect(pg_temp.as_user(w1, $q$select public.rib_riot_account_verified('a1000000-0000-0000-0000-00000000000a', 'puuid-w1', 'WildOne', 'NA1')$q$), '42501', 'players cannot verify their own Riot ID');
  perform public.rib_riot_account_verified(w1, 'puuid-w1', 'WildOne', 'NA1');
  perform pg_temp.expect((select riot_puuid || ':' || (verified_at is not null)::text from public.game_accounts where user_id = w1 and network = 'riot'), 'puuid-w1:true', 'a Riot-confirmed ID is verified');
  begin
    perform public.rib_riot_account_verified(w5, 'puuid-w1', 'WildFive', 'NA1');
    raise exception 'FAIL one Riot account verified twice';
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    perform pg_temp.expect(v_hint, 'riot_account_taken', 'a Riot account verifies one player only');
  end;
  perform pg_temp.as_user(w1, $q$select public.rib_game_account_set('riot', 'wildone#na1')$q$);
  perform pg_temp.expect((select (verified_at is not null)::text from public.game_accounts where user_id = w1 and network = 'riot'), 'true', 'a case-only change keeps the verification');
  perform pg_temp.as_user(w1, $q$select public.rib_game_account_set('riot', 'WildUno#NA1')$q$);
  perform pg_temp.expect((select coalesce(riot_puuid, 'none') || ':' || (verified_at is null)::text from public.game_accounts where user_id = w1 and network = 'riot'), 'none:true', 'a different Riot ID drops the verification');
  perform pg_temp.expect(pg_temp.as_user(w2, $q$select public.rib_game_account_set('riot', 'WILDUNO#na1')$q$), 'riot_account_taken', 'a Riot ID belongs to one player, whatever the case');
  begin
    perform public.rib_riot_account_verified(w2, 'puuid-w2', 'wilduno', 'NA1');
    raise exception 'FAIL a taken Riot ID was verified';
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    perform pg_temp.expect(v_hint, 'riot_account_taken', 'the service role cannot give a taken Riot ID to another player');
  end;

  -- Custom tournaments are Wild Rift on riot, whatever the client sends.
  perform pg_temp.expect(pg_temp.as_user(w5, $q$select public.rib_tournament_create('No ID', 'Wild Rift', 0, 4, null)$q$), 'riot_account_required', 'creating needs a Riot ID');
  perform pg_temp.expect(pg_temp.as_user(w1, $q$select public.rib_tournament_create('WR Custom', 'Valorant', 0, 4, 'steam')$q$), 'ok', 'a custom tournament is created');
  select id into v_tournament from public.tournaments where name = 'WR Custom';
  perform pg_temp.expect((select game || ':' || network || ':' || coalesce(tier_key, 'custom') || ':' || entrants from public.tournaments where id = v_tournament), 'Wild Rift:riot:custom:1', 'custom events are forced to Wild Rift / riot');
  perform pg_temp.as_user(w1, format('select public.rib_tournament_leave(%L)', v_tournament));
  perform pg_temp.expect((select status || ':' || entrants from public.tournaments where id = v_tournament), 'cancelled:0', 'the last player out closes the event');

  -- Quick Play.
  perform pg_temp.expect(pg_temp.as_user(w1, 'select public.rib_quick_join(300, 4)'), 'invalid_tier', 'unknown entry fee tier');
  perform pg_temp.expect(pg_temp.as_user(w1, 'select public.rib_quick_join(100, 6)'), 'invalid_tier', 'unknown size tier');
  perform pg_temp.expect(pg_temp.as_user(w5, 'select public.rib_quick_join(100, 4)'), 'riot_account_required', 'quick play needs a Riot ID');
  perform pg_temp.expect(pg_temp.as_user(e, 'select public.rib_quick_join(0, 4)'), 'account_closed', 'a closed account cannot queue for a free event');
  perform pg_temp.expect(pg_temp.as_user(e, format('select public.rib_tournament_join(%L)', (select id from public.tournaments where name = 'Free Cup'))), 'account_closed', 'a closed account cannot join a free event');
  perform pg_temp.expect(pg_temp.as_user(w1, 'select public.rib_quick_join(100, 4)'), 'ok', 'the first player opens a tier event');
  select id into v_tournament from public.tournaments where tier_key = '100:4' and status = 'open';
  perform pg_temp.expect((select name || '|' || game || '|' || network || '|' || creator_id::text from public.tournaments where id = v_tournament),
    'Wild Rift 4 · 1 rcoin|Wild Rift|riot|' || w1::text, 'a new tier event is named after the tier');
  perform pg_temp.expect(pg_temp.as_user(w1, 'select public.rib_quick_join(100, 4)'), 'already_queued', 'one open entry per tier');
  perform pg_temp.expect(pg_temp.as_user(w2, 'select public.rib_quick_join(100, 4)'), 'ok', 'the second player joins');
  perform pg_temp.expect((select count(*)::text || ':' || max(entrants) from public.tournaments where tier_key = '100:4' and status = 'open'), '1:2', 'quick play fills the open event and counts its entrants');
  perform pg_temp.expect(pg_temp.scalar_as(w5, 'select count(*)::text || ''/'' || sum(waiting) || ''/'' || sum(open_events) from public.rib_quick_tiers()'), '12/2/1', 'every tier is listed with who is waiting');
  perform pg_temp.expect(pg_temp.scalar_as(w5, 'select waiting || '':'' || open_events from public.rib_quick_tiers() where entry_fee_cents = 100 and size = 4'), '2:1', 'players waiting per tier');
  perform pg_temp.expect(pg_temp.as_user(w1, 'select public.rib_quick_join(0, 8)'), 'ok', 'a player can wait in another tier');
  select id into v_t2 from public.tournaments where tier_key = '0:8' and status = 'open';
  perform pg_temp.expect((select name || ':' || entrants from public.tournaments where id = v_t2), 'Wild Rift 8 · Free:1', 'an empty tier opens a free event');
  perform pg_temp.as_user(w1, format('select public.rib_tournament_leave(%L)', v_t2));
  perform pg_temp.expect((select status || ':' || entrants from public.tournaments where id = v_t2), 'cancelled:0', 'leaving updates the entrant count');

  -- An invite link can't put a queued player in a second event of the same tier.
  perform pg_temp.as_user(w3, 'select public.rib_quick_join(0, 4)');
  insert into public.tournaments (creator_id, name, game, entry_fee_cents, max_players, status, format, network, tier_key)
  values (w4, 'Wild Rift 4 · Free', 'Wild Rift', 0, 4, 'open', 'bracket', 'riot', '0:4') returning id into v_t2;
  perform pg_temp.expect(pg_temp.as_user(w3, format('select public.rib_tournament_join(%L)', v_t2)), 'already_queued', 'an invite join honours the tier queue');
  perform pg_temp.expect(pg_temp.as_user(w3, $q$select public.rib_game_account_set('riot', 'WildTres#NA1')$q$), 'riot_id_locked', 'no Riot ID change while waiting in an event');
  perform pg_temp.as_user(w3, format('select public.rib_tournament_leave(%L)', (select id from public.tournaments where tier_key = '0:4' and status = 'open' and id <> v_t2)));
  update public.tournaments set status = 'cancelled', finished_at = now() where id = v_t2;

  perform pg_temp.expect(pg_temp.as_user(w3, 'select public.rib_quick_join(100, 4)'), 'ok', 'the third player joins');
  perform pg_temp.expect(pg_temp.as_user(w4, 'select public.rib_quick_join(100, 4)'), 'ok', 'the fourth player fills the event');
  perform pg_temp.expect((select status || ':' || entrants from public.tournaments where id = v_tournament), 'active:4', 'a full tier event starts');
  perform pg_temp.expect((select string_agg(round || ':' || status, ',' order by round, slot) from public.match_rooms where tournament_id = v_tournament), '1:ready_check,1:ready_check,2:waiting', 'the bracket opens at once');
  perform pg_temp.expect((select bool_and(ready_deadline = now() + interval '5 minutes')::text from public.match_rooms where tournament_id = v_tournament and round = 1), 'true', 'the ready check lasts 5 minutes');
  perform pg_temp.expect((select bool_and(a_riot_id = public.rib_riot_handle(player_a) and b_riot_id = public.rib_riot_handle(player_b))::text from public.match_rooms where tournament_id = v_tournament and round = 1), 'true', 'rooms snapshot both Riot IDs when they open');
  perform pg_temp.expect((select count(*)::text from public.tournaments where tier_key = '100:4' and status = 'open'), '0', 'a started event leaves the tier');
  perform pg_temp.expect(pg_temp.balance(w4)::text, '9400', 'quick play charges the tier entry fee');
  perform pg_temp.expect(pg_temp.as_user(w2, $q$select public.rib_game_account_set('riot', 'WildDos#NA1')$q$), 'riot_id_locked', 'no Riot ID change during a tournament');
  perform pg_temp.expect(pg_temp.as_user(w2, $q$select public.rib_game_account_set('riot', 'wildtwo#na1')$q$), 'ok', 'a case-only change is not a change');
  begin
    perform public.rib_riot_account_verified(w2, 'puuid-w2', 'WildDos', 'NA1');
    raise exception 'FAIL Riot ID changed during a tournament';
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    perform pg_temp.expect(v_hint, 'riot_id_locked', 'the service role cannot swap a Riot ID mid-tournament either');
  end;

  -- Semifinal 1: a clear screenshot that agrees with the uploader's report
  -- shortens the confirm window; silence then confirms through the sweep.
  select id, player_a, player_b into v_room, v_ya, v_yb from public.match_rooms where tournament_id = v_tournament and round = 1 and slot = 0;
  perform pg_temp.as_user(v_ya, format('select public.rib_room_ready(%L)', v_room));
  perform pg_temp.as_user(v_yb, format('select public.rib_room_ready(%L)', v_room));
  perform pg_temp.as_user(v_ya, format('select public.rib_room_report(%L, %L)', v_room, v_ya));
  perform pg_temp.expect((select (confirm_deadline = now() + interval '10 minutes')::text from public.match_rooms where id = v_room), 'true', 'the confirm window lasts 10 minutes');
  perform set_config('request.jwt.claim.sub', v_ya::text, true);
  select t.token into v_token from public.rib_room_evidence_token(v_room) t;
  perform pg_temp.expect(pg_temp.as_user(v_ya, format('select public.rib_room_evidence_add(%L, %L, %L, %L, ''screen'')', v_room, v_token, v_room || '/' || v_ya || '/end.png', repeat('c', 64))), 'ok', 'the end screen is uploaded');
  select id into v_ev from public.room_evidence where room_id = v_room order by id desc limit 1;
  perform pg_temp.expect((select check_status from public.room_evidence where id = v_ev), 'pending', 'a new capture waits for the check');
  perform pg_temp.expect(pg_temp.as_user(v_yb, format('select check_status from public.room_evidence where id = %s', v_ev)), 'ok', 'players see the check status');
  perform pg_temp.expect(pg_temp.as_user(v_yb, format('select sha256 from public.room_evidence where id = %s', v_ev)), '42501', 'players cannot read the hashes');
  perform pg_temp.expect(pg_temp.as_user(v_yb, format('select check_detail from public.room_evidence where id = %s', v_ev)), '42501', 'players cannot read the checker output');
  perform pg_temp.expect(pg_temp.as_user(v_ya, format('select public.rib_evidence_for_check(%s)', v_ev)), '42501', 'the check input is server-only');
  perform pg_temp.expect(pg_temp.as_user(v_ya, format('select public.rib_evidence_check_apply(%s, ''verified'', %L, 0.99, null, null)', v_ev, v_ya)), '42501', 'players cannot apply a check');
  v_json := public.rib_evidence_for_check(v_ev);
  perform pg_temp.expect((v_json ->> 'room_id') || ':' || (v_json ->> 'uploader_id') || ':' || (v_json -> 'reports' ->> 'a') || ':' || (v_json ->> 'check_status') || ':' || (v_json ->> 'fast_tracked'),
    v_room::text || ':' || v_ya::text || ':' || v_ya::text || ':pending:false', 'the checker gets the room, uploader and reports');
  perform pg_temp.expect((v_json -> 'player_a' ->> 'riot_id') || '|' || (v_json -> 'player_b' ->> 'riot_id'),
    (select a_riot_id || '|' || b_riot_id from public.match_rooms where id = v_room), 'the checker gets the Riot ID snapshot');
  perform pg_temp.expect(coalesce(public.rib_evidence_for_check(-1)::text, 'none'), 'none', 'an unknown capture returns nothing');
  perform public.rib_evidence_check_apply(v_ev, 'verified', v_ya, 0.95, '{"model":"test"}', repeat('1', 64));
  perform pg_temp.expect((select status || ':' || fast_tracked::text || ':' || review_flag::text || ':' || (confirm_deadline = now() + interval '3 minutes')::text from public.match_rooms where id = v_room),
    'live:true:false:true', 'a verified screenshot shortens the confirm window, it does not settle');
  perform pg_temp.expect((select check_status || ':' || (check_winner = v_ya)::text || ':' || check_confidence || ':' || content_sha256 from public.room_evidence where id = v_ev), 'verified:true:0.950:' || repeat('1', 64), 'the check result is stored');
  perform pg_temp.expect((public.rib_evidence_for_check(v_ev) ->> 'fast_tracked'), 'true', 'the checker sees the fast track');
  begin
    perform public.rib_evidence_check_apply(v_ev, 'verified', v_ya, 0.95, null, null);
    raise exception 'FAIL a capture was checked twice';
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    perform pg_temp.expect(v_hint, 'evidence_not_pending', 'a capture is checked once');
  end;
  update public.match_rooms set confirm_deadline = now() - interval '1 second' where id = v_room;
  perform public.rib_room_sweep();
  perform pg_temp.expect((select status || ':' || (winner_id = v_ya)::text from public.match_rooms where id = v_room), 'done:true', 'silence confirms the fast-tracked report');
  perform pg_temp.expect((select player_a::text from public.match_rooms where tournament_id = v_tournament and round = 2), v_ya::text, 'the winner advances');

  -- Semifinal 2: nothing a screenshot says settles, voids or disputes the room.
  select id, player_a, player_b into v_room2, v_za, v_zb from public.match_rooms where tournament_id = v_tournament and round = 1 and slot = 1;
  perform pg_temp.as_user(v_za, format('select public.rib_room_ready(%L)', v_room2));
  perform pg_temp.as_user(v_zb, format('select public.rib_room_ready(%L)', v_room2));
  perform set_config('request.jwt.claim.sub', v_zb::text, true);
  select t.token into v_token from public.rib_room_evidence_token(v_room2) t;
  perform pg_temp.expect(pg_temp.as_user(v_zb, format('select public.rib_room_evidence_add(%L, %L, %L, %L, ''screen'')', v_room2, v_token, v_room2 || '/' || v_zb || '/end.png', repeat('c', 64))), 'evidence_duplicate', 'a screenshot from another match is refused');
  perform pg_temp.expect(pg_temp.as_user(v_zb, format('select public.rib_room_evidence_add(%L, %L, %L, %L, ''screen'')', v_room2, v_token, v_room2 || '/' || v_zb || '/end.png', repeat('1', 64))), 'evidence_duplicate', 'a file whose stored bytes were used elsewhere is refused');
  perform pg_temp.expect(pg_temp.as_user(v_zb, format('select public.rib_room_evidence_add(%L, %L, %L, %L, ''screen'')', v_room2, v_token, v_room2 || '/' || v_zb || '/end.png', repeat('d', 64))), 'ok', 'a fresh screenshot is accepted');
  select id into v_ev from public.room_evidence where room_id = v_room2 order by id desc limit 1;
  perform public.rib_evidence_check_apply(v_ev, 'verified', v_zb, 0.97, null, repeat('2', 64));
  perform pg_temp.expect((select status || ':' || fast_tracked::text || ':' || review_flag::text || ':' || coalesce(confirm_deadline::text, 'none') from public.match_rooms where id = v_room2), 'live:false:false:none', 'no fast track before the uploader reports');
  perform pg_temp.as_user(v_za, format('select public.rib_room_report(%L, %L)', v_room2, v_za));
  perform set_config('request.jwt.claim.sub', v_za::text, true);
  select t.token into v_token from public.rib_room_evidence_token(v_room2) t;
  perform pg_temp.as_user(v_za, format('select public.rib_room_evidence_add(%L, %L, %L, %L, ''screen'')', v_room2, v_token, v_room2 || '/' || v_za || '/end.png', repeat('f', 64)));
  select id into v_ev from public.room_evidence where room_id = v_room2 order by id desc limit 1;
  perform public.rib_evidence_check_apply(v_ev, 'verified', v_za, 0.50, null, repeat('3', 64));
  perform pg_temp.expect((select status || ':' || fast_tracked::text from public.match_rooms where id = v_room2), 'live:false', 'a low-confidence read changes nothing');
  perform set_config('request.jwt.claim.sub', v_zb::text, true);
  select t.token into v_token from public.rib_room_evidence_token(v_room2) t;
  perform pg_temp.as_user(v_zb, format('select public.rib_room_evidence_add(%L, %L, %L, %L, ''screen'')', v_room2, v_token, v_room2 || '/' || v_zb || '/end2.png', repeat('9', 64)));
  select id into v_ev from public.room_evidence where room_id = v_room2 order by id desc limit 1;
  v_before_za := pg_temp.balance(v_za);
  v_before_zb := pg_temp.balance(v_zb);
  perform public.rib_evidence_check_apply(v_ev, 'contradicts', null, 0.97, null, repeat('4', 64));
  perform pg_temp.expect((select status || ':' || review_flag::text || ':' || fast_tracked::text || ':' || coalesce(disputed_by::text, 'nobody') || ':' || dispute_deposit_cents from public.match_rooms where id = v_room2),
    'live:true:false:nobody:0', 'a contradicting screenshot only flags the room for review');
  perform pg_temp.expect((pg_temp.balance(v_za) - v_before_za)::text || '/' || (pg_temp.balance(v_zb) - v_before_zb)::text, '0/0', 'a flag moves no money');
  perform set_config('request.jwt.claim.sub', v_za::text, true);
  select t.token into v_token from public.rib_room_evidence_token(v_room2) t;
  perform pg_temp.as_user(v_za, format('select public.rib_room_evidence_add(%L, %L, %L, %L, ''screen'')', v_room2, v_token, v_room2 || '/' || v_za || '/end2.png', repeat('8', 64)));
  select id into v_ev from public.room_evidence where room_id = v_room2 order by id desc limit 1;
  update public.match_rooms set review_flag = false where id = v_room2;
  perform public.rib_evidence_check_apply(v_ev, 'verified', v_za, 0.99, null, repeat('1', 64));
  perform pg_temp.expect((select e.check_status || ':' || r.status || ':' || r.fast_tracked::text || ':' || r.review_flag::text from public.room_evidence e join public.match_rooms r on r.id = e.room_id where e.id = v_ev),
    'duplicate:live:false:true', 'stored bytes seen in another room make the check a duplicate');
  perform pg_temp.as_user(v_zb, format('select public.rib_room_report(%L, %L)', v_room2, v_za));
  perform pg_temp.expect((select status || ':' || (winner_id = v_za)::text from public.match_rooms where id = v_room2), 'done:true', 'matching reports still settle at once');
  perform pg_temp.expect((select status from public.match_rooms where tournament_id = v_tournament and round = 2), 'ready_check', 'the final opens');

  -- Friendlies: a contradicting screenshot flags the room and nothing else.
  perform pg_temp.as_user(w1, $q$select public.rib_challenge_create('Wild Rift', '1v1')$q$);
  select id into v_challenge from public.challenges where creator_id = w1 and status = 'open' order by created_at desc limit 1;
  perform pg_temp.as_user(w5, format('select public.rib_challenge_accept(%L)', v_challenge));
  select room_id into v_room from public.challenges where id = v_challenge;
  perform pg_temp.expect((select a_riot_id || ':' || coalesce(b_riot_id, 'none') from public.match_rooms where id = v_room), 'WildUno#NA1:none', 'friendly rooms snapshot the Riot IDs they have');
  perform pg_temp.as_user(w1, format('select public.rib_room_ready(%L)', v_room));
  perform pg_temp.as_user(w5, format('select public.rib_room_ready(%L)', v_room));
  perform set_config('request.jwt.claim.sub', w1::text, true);
  select t.token into v_token from public.rib_room_evidence_token(v_room) t;
  perform pg_temp.as_user(w1, format('select public.rib_room_evidence_add(%L, %L, %L, %L, ''camera'')', v_room, v_token, v_room || '/' || w1 || '/end.jpg', repeat('0', 64)));
  select id into v_ev from public.room_evidence where room_id = v_room order by id desc limit 1;
  perform public.rib_evidence_check_apply(v_ev, 'contradicts', null, 0.92, null, null);
  perform pg_temp.expect((select r.status || ':' || r.review_flag::text || ':' || c.status from public.match_rooms r join public.challenges c on c.room_id = r.id where r.id = v_room), 'live:true:active', 'a contradicted friendly keeps going');
  begin
    perform public.rib_evidence_check_apply(v_ev, 'pending', null, null, null, null);
    raise exception 'FAIL pending accepted as a check result';
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    perform pg_temp.expect(v_hint, 'evidence_invalid', 'a check result must be final');
  end;

  -- Ledger integrity: every balance equals the sum of its ledger rows.
  perform pg_temp.expect(
    (select count(*)::text from public.wallets w
      where w.test_balance_cents <> coalesce((select sum(amount_cents) from public.wallet_ledger l where l.user_id = w.user_id), 0)),
    '0', 'ledger reconciles with balances');
end;
$$;

-- ============================================================================
-- Hosted tournaments (0027): host rules, invites, byes, host decisions,
-- appeal window, 85/5/10 split, appeals, abandon sweep, chat purge.
-- ============================================================================
-- Run a scalar query before login (anon role).
create function pg_temp.scalar_anon(p_sql text) returns text
language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claim.sub', '', true);
  execute 'set local role anon';
  execute p_sql into v;
  execute 'reset role';
  return v;
end;
$$;

-- The host plays out every match of a tournament: lobby, then player A wins.
create function pg_temp.host_plays(p_host uuid, p_tournament uuid) returns void
language plpgsql as $$
declare v_room uuid; v_a uuid;
begin
  loop
    v_room := null;
    select id, player_a into v_room, v_a from public.match_rooms
     where tournament_id = p_tournament and status in ('setup','live') order by round, slot limit 1;
    exit when v_room is null;
    perform pg_temp.expect(pg_temp.as_user(p_host, format('select public.rib_host_room_lobby(%L, ''WR-LOBBY'')', v_room)), 'ok', 'the host posts the lobby');
    perform pg_temp.expect(pg_temp.as_user(p_host, format('select public.rib_host_decide(%L, %L)', v_room, v_a)), 'ok', 'the host decides the match');
  end loop;
end;
$$;

-- Money conservation for one tournament: every ledger movement plus the
-- platform revenue nets to zero.
create function pg_temp.conserved(p_tournament uuid) returns text
language sql as $$
  select (coalesce((select sum(amount_cents) from public.wallet_ledger where ref_id = p_tournament), 0)
        + coalesce((select amount_cents from public.platform_revenue where tournament_id = p_tournament), 0))::text
$$;

do $$
declare
  h  uuid := 'c0000000-0000-0000-0000-0000000000c0';
  op uuid := 'c9000000-0000-0000-0000-0000000000c9';
  hp uuid[] := array['c1000000-0000-0000-0000-0000000000c1', 'c2000000-0000-0000-0000-0000000000c2',
                     'c3000000-0000-0000-0000-0000000000c3', 'c4000000-0000-0000-0000-0000000000c4',
                     'c5000000-0000-0000-0000-0000000000c5', 'c6000000-0000-0000-0000-0000000000c6',
                     'c7000000-0000-0000-0000-0000000000c7']::uuid[];
  i int;
  v_t uuid; v_priv uuid; v_small uuid; v_x uuid; v_free uuid;
  v_code text; v_code2 text; v_json jsonb;
  v_room uuid; v_ya uuid; v_yb uuid; v_final uuid; v_winner uuid; v_app uuid; v_out uuid;
  v_before bigint; v_msgs int;
begin
  update public.platform_settings set value = 'true' where key = 'test_payments_enabled';
  for i in 1..7 loop
    perform pg_temp.as_user(hp[i], 'select public.rib_buy_rcoin_test(10000)');
    perform pg_temp.expect(pg_temp.as_user(hp[i], format('select public.rib_game_account_set(''riot'', ''HostedP%s#NA1'')', i)), 'ok', 'hosted player links a Riot ID');
  end loop;

  -- Creating.
  perform pg_temp.expect(pg_temp.as_user(h, $q$select public.rib_hosted_create('Bad', 6, 0, 'public')$q$), 'invalid_size', 'hosted sizes are 4, 8, 16 or 32');
  perform pg_temp.expect(pg_temp.as_user(h, $q$select public.rib_hosted_create('Bad', 8, 150, 'public')$q$), 'invalid_entry_fee', 'hosted entry fees are whole rcoin');
  perform pg_temp.expect(pg_temp.as_user(h, $q$select public.rib_hosted_create('Bad', 8, 0, 'secret')$q$), 'invalid_visibility', 'visibility is public or private');
  perform pg_temp.expect(pg_temp.as_user(h, $q$select public.rib_hosted_create('Bad', 8, 3000, 'public')$q$), 'host_fee_limit', 'new hosts are capped at 25 rcoin');
  perform pg_temp.expect(pg_temp.as_user(h, $q$select public.rib_hosted_create('Hosted Cup', 8, 1000, 'public', 'Best of one')$q$), 'ok', 'anyone signed in can host');
  select id, invite_code into v_t, v_code from public.tournaments where name = 'Hosted Cup';
  perform pg_temp.expect((select mode || ':' || visibility || ':' || entrants || ':' || (invite_code ~ '^[A-HJ-NP-Z2-9]{10}$')::text || ':' || game from public.tournaments where id = v_t),
    'hosted:public:0:true:Wild Rift', 'a hosted tournament gets an invite code and no entrant');
  perform pg_temp.expect(public.rib_tournament_rounds(16)::text || '/' || public.rib_tournament_rounds(32)::text, '4/5', 'brackets of 16 and 32');

  -- The host can't play.
  perform pg_temp.expect(pg_temp.as_user(h, format('select public.rib_tournament_join(%L)', v_t)), 'host_cannot_play', 'the host cannot join by id');
  perform pg_temp.expect(pg_temp.as_user(h, format('select public.rib_tournament_join_by_code(%L)', v_code)), 'host_cannot_play', 'the host cannot join by code');

  -- Private tournaments: by code only, never listed.
  perform pg_temp.expect(pg_temp.as_user(h, $q$select public.rib_hosted_create('Private Cup', 4, 500, 'private', 'Private rules')$q$), 'ok', 'host a private tournament');
  select id, invite_code into v_priv, v_code2 from public.tournaments where name = 'Private Cup';
  perform pg_temp.expect(pg_temp.as_user(hp[1], format('select public.rib_tournament_join(%L)', v_priv)), 'tournament_private', 'a private tournament is not joinable by id');
  v_before := pg_temp.balance(hp[1]);
  perform pg_temp.expect(pg_temp.as_user(hp[1], format('select public.rib_tournament_join_by_code(%L)', lower(v_code2))), 'ok', 'a private tournament is joinable by code');
  perform pg_temp.expect(pg_temp.as_user(hp[2], 'select public.rib_tournament_join_by_code(''ZZZZZZZZ'')'), 'invite_invalid', 'an unknown code is refused');
  perform pg_temp.expect(pg_temp.scalar_as(hp[2], format('select count(*)::text from public.rib_open_tournaments() where id = %L', v_priv)), '0', 'private tournaments are not listed');
  perform pg_temp.expect(pg_temp.scalar_as(hp[2], format('select count(*)::text from public.tournaments where id = %L', v_priv)), '0', 'nor readable by other players');
  perform pg_temp.expect(pg_temp.scalar_as(hp[2], format('select count(*)::text from public.tournament_entries where tournament_id = %L', v_priv)), '0', 'private entries are hidden from other players');
  perform pg_temp.expect(pg_temp.scalar_as(hp[1], format('select count(*)::text from public.tournament_entries where tournament_id = %L', v_priv)), '1', 'an entrant sees the private entries');
  perform pg_temp.expect(pg_temp.scalar_as(h, format('select count(*)::text from public.tournament_entries where tournament_id = %L', v_priv)), '1', 'the host sees the private entries');
  perform pg_temp.expect(pg_temp.scalar_as(hp[2], format('select (invite_code is not null)::text from public.tournaments where id = %L', v_t)), 'true', 'a public invite code is readable like the link');
  perform pg_temp.expect(pg_temp.scalar_as(hp[2], format('select mode || '':'' || host_username || '':'' || is_host from public.rib_open_tournaments() where id = %L', v_t)), 'hosted:host_one:false', 'the lobby shows the host');
  perform pg_temp.expect(pg_temp.scalar_as(h, format('select is_host::text from public.rib_open_tournaments() where id = %L', v_t)), 'true', 'the lobby flags my own hosted tournament');
  v_json := pg_temp.scalar_anon(format('select public.rib_tournament_preview(%L)::text', v_code2))::jsonb;
  perform pg_temp.expect((v_json ->> 'name') || ':' || coalesce(v_json ->> 'is_host', 'none') || ':' || (v_json ->> 'entrants') || ':'
    || coalesce(v_json ->> 'host_username', 'hidden') || ':' || coalesce(v_json ->> 'rules', 'hidden'),
    'Private Cup:none:1:hidden:hidden', 'the invite preview works before login and hides a private host and rules');
  perform pg_temp.expect(pg_temp.scalar_as(hp[1], format('select (public.rib_tournament_preview(%L) ->> ''host_username'') || '':'' || (public.rib_tournament_preview(%L) ->> ''rules'')', v_code2, v_code2)),
    'host_one:Private rules', 'signed in, the preview shows the host and rules');
  perform pg_temp.expect(coalesce(pg_temp.scalar_anon('select public.rib_tournament_preview(''ABCDEFGHJK'')::text'), 'none'), 'none', 'an unknown code previews as nothing');
  perform pg_temp.expect(pg_temp.scalar_as(h, format('select (public.rib_tournament_preview(%L) ->> ''is_host'')', v_code2)), 'true', 'the preview knows the host');
  perform pg_temp.expect(pg_temp.scalar_as(hp[1], format('select (public.rib_tournament_preview(%L) ->> ''joined'')', v_code2)), 'true', 'the preview knows I joined');

  -- At most 3 live hosted tournaments; early start needs 4 players.
  perform pg_temp.expect(pg_temp.as_user(h, $q$select public.rib_hosted_create('Small Cup', 8, 0, 'public')$q$), 'ok', 'a third hosted tournament');
  perform pg_temp.expect(pg_temp.as_user(h, $q$select public.rib_hosted_create('Fourth Cup', 8, 0, 'public')$q$), 'host_limit', 'a host runs up to 3 at a time');
  select id into v_small from public.tournaments where name = 'Small Cup';
  for i in 1..3 loop perform pg_temp.as_user(hp[i], format('select public.rib_tournament_join(%L)', v_small)); end loop;
  perform pg_temp.expect(pg_temp.as_user(hp[1], format('select public.rib_host_start(%L)', v_small)), 'not_host', 'only the host starts');
  perform pg_temp.expect(pg_temp.as_user(h, format('select public.rib_host_start(%L)', v_small)), 'not_enough_players', 'an early start needs 4 players');
  perform pg_temp.expect(pg_temp.as_user(hp[3], format('select public.rib_tournament_leave(%L)', v_small)), 'ok', 'a player leaves a hosted tournament');
  perform pg_temp.expect((select status from public.tournaments where id = v_small), 'open', 'a hosted tournament stays open for its host');
  perform pg_temp.expect(pg_temp.as_user(h, format('select public.rib_host_cancel(%L)', v_priv)), 'ok', 'the host cancels before the start');
  perform pg_temp.expect((select status from public.tournaments where id = v_priv), 'cancelled', 'cancelled');
  perform pg_temp.expect((pg_temp.balance(hp[1]) - v_before)::text, '0', 'cancelling refunds every entry fee');
  perform pg_temp.as_user(h, format('select public.rib_host_cancel(%L)', v_small));

  -- Hosted Cup: 7 entrants x 10 rcoin.
  for i in 1..7 loop
    perform pg_temp.expect(pg_temp.as_user(hp[i], format('select public.rib_tournament_join_by_code(%L)', v_code)), 'ok', 'players join by the invite link');
  end loop;
  v_json := pg_temp.scalar_as(hp[1], format('select public.rib_tournament_preview(%L)::text', v_code))::jsonb;
  perform pg_temp.expect((v_json -> 'prize_now' ->> 'platform_cents') || '/' || (v_json -> 'prize_now' ->> 'host_cents') || '/' || (v_json -> 'prize_now' ->> 'winner_cents'),
    '700/350/5950', 'fee split on 7 entrants: platform 7, host 3.50, winner 59.50');
  perform pg_temp.expect((v_json -> 'prize_full' ->> 'winner_cents'), '6800', 'winner gets 85% when full');
  perform pg_temp.expect(pg_temp.as_user(h, format('select public.rib_host_rotate_invite(%L)', v_t)), 'ok', 'the host rotates the invite');
  perform pg_temp.expect(pg_temp.as_user(hp[1], format('select public.rib_tournament_join_by_code(%L)', v_code)), 'invite_invalid', 'the old code stops working');
  perform pg_temp.expect(pg_temp.as_user(h, format('select public.rib_host_start(%L)', v_t)), 'ok', 'the host starts early');
  perform pg_temp.expect((select status || ':' || max_players from public.tournaments where id = v_t), 'active:8', 'the bracket is the next power of two');
  perform pg_temp.expect((select string_agg(status || case when walkover then '*' else '' end, ',' order by slot) from public.match_rooms where tournament_id = v_t and round = 1),
    'done*,setup,setup,setup', 'the top seed gets a bye (walkover); hosted rooms wait in setup');
  perform pg_temp.expect((select count(*)::text || ':' || count(*) filter (where round = 1 and player_b is null)::text from public.match_rooms where tournament_id = v_t), '7:1', 'seven rooms, one bye');
  perform pg_temp.expect((select (player_a is not null)::text || ':' || status from public.match_rooms where tournament_id = v_t and round = 2 and slot = 0), 'true:waiting', 'the bye winner moves up');
  perform pg_temp.expect(pg_temp.scalar_as(hp[2], format('select (public.rib_tournament_bracket(%L) ->> ''rounds'') || '':'' || jsonb_array_length(public.rib_tournament_bracket(%L) -> ''rooms'')', v_t, v_t)), '3:7', 'the bracket reads as jsonb');
  perform pg_temp.expect(pg_temp.scalar_as(h, format('select count(*)::text from public.match_rooms where tournament_id = %L', v_t)), '7', 'the host sees every room');

  -- A hosted room: the host posts the lobby; player reports are advisory.
  select id, player_a, player_b into v_room, v_ya, v_yb from public.match_rooms where tournament_id = v_t and round = 1 and slot = 1;
  select player_a into v_out from public.match_rooms where tournament_id = v_t and round = 1 and slot = 2;
  perform pg_temp.expect(pg_temp.as_user(v_ya, format('select public.rib_room_report(%L, %L)', v_room, v_ya)), 'challenge_not_started', 'no report before the lobby');
  perform pg_temp.expect(pg_temp.as_user(v_ya, format('select public.rib_room_ready(%L)', v_room)), 'room_not_waiting', 'hosted rooms have no ready check');
  perform pg_temp.expect(pg_temp.as_user(v_ya, format('select public.rib_host_room_lobby(%L, ''X'')', v_room)), 'not_host', 'players cannot post the lobby');
  perform pg_temp.expect(pg_temp.as_user(h, format('select public.rib_host_room_lobby(%L, null)', v_room)), 'lobby_required', 'a lobby needs a code or a screenshot');
  perform pg_temp.expect(pg_temp.as_user(h, format('select public.rib_host_room_lobby(%L, ''WR-12345'', ''pw'', ''elsewhere/x.png'')', v_room)), 'invalid_lobby', 'the screenshot lives in the room folder');
  perform pg_temp.expect(pg_temp.as_user(h, format('select public.rib_host_room_lobby(%L, ''WR-12345'', ''pw'')', v_room)), 'ok', 'the host posts the lobby');
  perform pg_temp.expect((select status || ':' || lobby_name from public.match_rooms where id = v_room), 'live:WR-12345', 'the lobby makes the room live');
  perform pg_temp.expect(pg_temp.scalar_as(v_ya, format('select kind || '':'' || body from public.room_messages where room_id = %L order by id desc limit 1', v_room)),
    'lobby:Lobby code: WR-12345 · Password: pw', 'players read the lobby message');
  update public.tournaments set last_progress_at = now() - interval '1 hour' where id = v_t;
  perform pg_temp.expect(pg_temp.as_user(h, format('select public.rib_host_room_lobby(%L, null, null, %L)', v_room, v_room || '/' || gen_random_uuid() || '.png')), 'ok', 'the host re-posts a lobby screenshot');
  perform pg_temp.expect((select lobby_name || ':' || lobby_password from public.match_rooms where id = v_room) || ':' || (select (last_progress_at < now())::text from public.tournaments where id = v_t),
    'WR-12345:pw:true', 'a re-post keeps the code and does not count as progress');
  perform pg_temp.expect(pg_temp.scalar_as(h, format('select mode || '':'' || host_username || '':'' || is_host || '':'' || entrants || '':'' || (host_id = %L) from public.rib_room_info(%L)', h, v_room)), 'hosted:host_one:true:7:true', 'the room page knows the host');
  perform pg_temp.expect(pg_temp.scalar_as(v_ya, format('select mode || '':'' || host_username || '':'' || is_host from public.rib_room_info(%L)', v_room)), 'hosted:host_one:false', 'players see who hosts');
  perform pg_temp.expect(pg_temp.as_user(h, format('select public.rib_room_message(%L, ''good luck'')', v_room)), 'ok', 'the host chats in the room');
  perform pg_temp.expect(pg_temp.scalar_as(h, format('select count(*)::text from public.room_messages where room_id = %L', v_room)), '3', 'the host reads the room chat');
  perform pg_temp.expect(pg_temp.scalar_as(v_out, format('select count(*)::text from public.room_messages where room_id = %L', v_room)), '0', 'other entrants cannot read it');
  perform pg_temp.expect(pg_temp.as_user(v_ya, format('select public.rib_room_report(%L, %L)', v_room, v_ya)), 'ok', 'a player reports');
  perform pg_temp.expect(pg_temp.as_user(v_yb, format('select public.rib_room_report(%L, %L)', v_room, v_ya)), 'ok', 'the other agrees');
  perform pg_temp.expect((select status || ':' || coalesce(confirm_deadline::text, 'none') from public.match_rooms where id = v_room), 'live:none', 'matching player reports do not settle a hosted room');
  perform pg_temp.expect(pg_temp.as_user(v_yb, format('select public.rib_room_dispute(%L, ''the host will get this wrong'')', v_room)), 'host_decides', 'no room disputes in hosted matches');
  update public.match_rooms set confirm_deadline = now() - interval '1 minute' where id = v_room;
  perform public.rib_room_sweep();
  perform pg_temp.expect((select status from public.match_rooms where id = v_room), 'live', 'the confirm sweep skips hosted rooms');
  update public.match_rooms set confirm_deadline = null, started_at = now() - interval '2 hours' where id = v_room;
  perform pg_temp.expect(pg_temp.as_user(h, 'select public.rib_hosted_sweep()'), '42501', 'the hosted sweep is server-only');
  perform public.rib_hosted_sweep();
  perform pg_temp.expect((select review_flag::text from public.match_rooms where id = v_room), 'true', 'an undecided live room is flagged after the decide window');
  insert into public.operators (user_id) values (op);
  perform pg_temp.expect(pg_temp.scalar_as(op, format('select (r ->> ''player_a'') || '':'' || (r ->> ''player_b'') from jsonb_array_elements(public.rib_ops_hosted_queue() -> ''flagged_rooms'') r where r ->> ''room_id'' = %L', v_room)),
    v_ya || ':' || v_yb, 'flagged rooms carry both players');
  perform pg_temp.expect(pg_temp.as_user(v_ya, format('select public.rib_host_decide(%L, %L)', v_room, v_ya)), 'not_host', 'players cannot decide');
  perform pg_temp.expect(pg_temp.as_user(h, format('select public.rib_host_decide(%L, %L)', v_room, h)), 'invalid_winner', 'the winner is one of the two players');
  perform pg_temp.expect(pg_temp.as_user(h, format('select public.rib_host_decide(%L, %L, false, ''Scoreboard shows B'')', v_room, v_yb)), 'ok', 'the host decides against the reports');
  perform pg_temp.expect((select status || ':' || (winner_id = v_yb)::text || ':' || host_note from public.match_rooms where id = v_room), 'done:true:Scoreboard shows B', 'the host decision ends the room');
  perform pg_temp.expect((select (player_b = v_yb)::text || ':' || status from public.match_rooms where tournament_id = v_t and round = 2 and slot = 0), 'true:setup', 'the winner advances and the next room opens');

  -- Walkover (setup) and a void.
  select id, player_a, player_b into v_room, v_ya, v_yb from public.match_rooms where tournament_id = v_t and round = 1 and slot = 2;
  perform pg_temp.expect(pg_temp.as_user(h, format('select public.rib_host_decide(%L, %L, true, '' '')', v_room, v_ya)), 'note_required', 'a walkover needs a note');
  perform pg_temp.expect(pg_temp.as_user(h, format('select public.rib_host_decide(%L, %L, true, ''B never joined'')', v_room, v_ya)), 'walkover_too_early', 'a walkover waits 10 minutes');
  update public.match_rooms set setup_at = now() - interval '11 minutes' where id = v_room;
  perform pg_temp.expect(pg_temp.as_user(h, format('select public.rib_host_decide(%L, %L, true, ''B never joined'')', v_room, v_ya)), 'ok', 'a walkover before the lobby');
  perform pg_temp.expect((select walkover::text from public.match_rooms where id = v_room) || ':' || (select no_shows::text from public.player_reputation where user_id = v_yb), 'true:1', 'the absent player counts a no-show');
  select id into v_room from public.match_rooms where tournament_id = v_t and round = 1 and slot = 3;
  perform pg_temp.expect(pg_temp.as_user(h, format('select public.rib_host_void_room(%L, null)', v_room)), 'note_required', 'a void needs a note');
  perform pg_temp.expect(pg_temp.as_user(h, format('select public.rib_host_void_room(%L, ''Nobody came'')', v_room)), 'walkover_too_early', 'a void waits 10 minutes');
  update public.match_rooms set setup_at = now() - interval '11 minutes' where id = v_room;
  perform pg_temp.expect(pg_temp.as_user(h, format('select public.rib_host_void_room(%L, ''Nobody came'')', v_room)), 'ok', 'the host voids a room nobody showed up to');
  perform pg_temp.expect((select status || ':' || walkover::text || ':' || (winner_id = v_ya)::text from public.match_rooms where tournament_id = v_t and round = 2 and slot = 1), 'done:true:true', 'the opponent of a void advances by walkover');

  -- Semifinal (a real match length) and final (decided at once: flagged).
  select id, player_a into v_room, v_ya from public.match_rooms where tournament_id = v_t and round = 2 and slot = 0;
  perform pg_temp.as_user(h, format('select public.rib_host_room_lobby(%L, ''WR-SEMI'')', v_room));
  update public.match_rooms set started_at = now() - interval '9 minutes' where id = v_room;
  perform pg_temp.expect(pg_temp.as_user(h, format('select public.rib_host_decide(%L, %L)', v_room, v_ya)), 'ok', 'the host decides the semifinal');
  perform pg_temp.expect((select review_flag::text from public.match_rooms where id = v_room), 'false', 'a decision after a real match length is not flagged');
  perform pg_temp.host_plays(h, v_t);
  perform pg_temp.expect((select review_flag::text from public.match_rooms where tournament_id = v_t and round = 3), 'true', 'a decision right after the lobby is flagged for review');
  select id, winner_id, case when winner_id = player_a then player_b else player_a end into v_final, v_winner, v_app
    from public.match_rooms where tournament_id = v_t and round = 3;
  perform pg_temp.expect((select status || ':' || (winner_id = v_winner)::text || ':' || (payout_at = now() + interval '72 hours')::text from public.tournaments where id = v_t),
    'payout_pending:true:true', 'a new host''s paid final waits out a 72-hour appeal window');
  perform pg_temp.expect((select count(*)::text from public.wallet_ledger where ref_id = v_t and kind in ('tournament_prize','host_commission')), '0', 'no money moves at the final');

  -- Appeal.
  perform pg_temp.expect(pg_temp.as_user(h, format('select public.rib_tournament_appeal(%L, ''The host picked wrong'')', v_t)), 'not_an_entrant', 'the host cannot appeal');
  perform pg_temp.expect(pg_temp.as_user(v_winner, format('select public.rib_tournament_appeal(%L, ''I want a bigger prize'')', v_t)), 'not_an_entrant', 'the winner cannot appeal');
  perform pg_temp.expect(pg_temp.as_user(v_app, format('select public.rib_tournament_appeal(%L, ''short'')', v_t)), 'dispute_reason_required', 'an appeal needs a reason');
  v_before := pg_temp.balance(v_app);
  perform pg_temp.expect(pg_temp.as_user(v_app, format('select public.rib_tournament_appeal(%L, ''The final was decided wrongly'', %L)', v_t, v_final)), 'ok', 'an entrant appeals');
  perform pg_temp.expect((v_before - pg_temp.balance(v_app))::text || ':' || (select status from public.tournaments where id = v_t), '100:disputed', 'the appeal holds a deposit and the payout');
  perform pg_temp.expect(pg_temp.as_user(v_app, format('select public.rib_tournament_appeal(%L, ''Again, the final was wrong'')', v_t)), 'already_appealed', 'one appeal per player');
  update public.tournaments set payout_at = now() - interval '1 second' where id = v_t;
  perform public.rib_tournament_payouts();
  perform pg_temp.expect((select status from public.tournaments where id = v_t) || ':' || (select count(*) from public.wallet_ledger where ref_id = v_t and kind = 'tournament_prize'), 'disputed:0', 'the payout job skips an appealed tournament');
  perform pg_temp.expect(pg_temp.as_user(v_app, format('select public.rib_appeal_resolve(%L, ''overturn'', %L)', v_t, v_app)), 'not_operator', 'only operators resolve appeals');
  perform pg_temp.expect(pg_temp.scalar_as(op, 'select jsonb_array_length(public.rib_ops_hosted_queue() -> ''appeals'')::text'), '1', 'operators see the appeal queue');
  perform pg_temp.expect(pg_temp.as_user(op, format('select public.rib_appeal_resolve(%L, ''overturn'', %L)', v_t, v_winner)), 'invalid_winner', 'overturning needs another entrant');
  perform pg_temp.expect(pg_temp.as_user(op, format('select public.rib_appeal_resolve(%L, ''uphold'', null, ''Result stands'')', v_t)), 'ok', 'the operator upholds the result');
  perform pg_temp.expect((select status from public.tournaments where id = v_t) || ':' ||
    (select sum(amount_cents) from public.wallet_ledger where ref_id = v_t and kind = 'tournament_prize' and user_id = v_winner) || ':' ||
    (select sum(amount_cents) from public.wallet_ledger where ref_id = v_t and kind = 'host_commission' and user_id = h) || ':' ||
    (select amount_cents from public.platform_revenue where tournament_id = v_t),
    'finished:5950:350:800', 'uphold pays 85/5/10 and keeps the deposit');
  perform pg_temp.expect((v_before - pg_temp.balance(v_app))::text || ':' || (select status from public.tournament_disputes where tournament_id = v_t and user_id = v_app), '100:rejected', 'a rejected appeal loses the deposit');
  perform pg_temp.expect(pg_temp.conserved(v_t), '0', 'uphold conserves money');
  perform pg_temp.expect((select hosted_completed::text from public.player_reputation where user_id = h), '1', 'the host completes a tournament');
  perform pg_temp.expect(pg_temp.as_user(h, $q$select public.rib_hosted_create('Big fee', 4, 3000, 'public')$q$), 'host_fee_limit', 'the fee cap lifts only after 3 clean hosted payouts');
  perform pg_temp.expect((select coalesce(sum(matches_completed), 0)::text from public.player_reputation where user_id = any (hp)), '0', 'hosted matches do not count as completed matches');
  perform pg_temp.expect((select count(*)::text from public.player_stats where user_id = any (hp) and wins + losses > 0), '0', 'hosted matches do not feed the ranking');
  perform pg_temp.expect(pg_temp.scalar_as(v_winner, format('select mode || '':'' || host_username || '':'' || prize_cents from public.rib_my_tournaments() where id = %L', v_t)), 'hosted:host_one:5950', 'my tournaments show the host and my prize');

  -- No appeal: the payout job pays 85/5/10 after the window.
  perform pg_temp.as_user(h, $q$select public.rib_hosted_create('Payout Cup', 4, 500, 'public')$q$);
  select id into v_x from public.tournaments where name = 'Payout Cup';
  for i in 1..4 loop perform pg_temp.as_user(hp[i], format('select public.rib_tournament_join(%L)', v_x)); end loop;
  perform pg_temp.expect((select status from public.tournaments where id = v_x), 'active', 'a full hosted tournament starts');
  perform pg_temp.host_plays(h, v_x);
  select winner_id into v_winner from public.tournaments where id = v_x;
  update public.tournaments set payout_at = now() - interval '1 second' where id = v_x;
  perform public.rib_tournament_payouts();
  perform pg_temp.expect((select status from public.tournaments where id = v_x) || ':' ||
    (select sum(amount_cents) from public.wallet_ledger where ref_id = v_x and kind = 'tournament_prize' and user_id = v_winner) || ':' ||
    (select sum(amount_cents) from public.wallet_ledger where ref_id = v_x and kind = 'host_commission') || ':' ||
    (select amount_cents from public.platform_revenue where tournament_id = v_x),
    'finished:1700:100:200', 'the payout job pays the hosted split');
  perform pg_temp.expect(pg_temp.conserved(v_x), '0', 'the payout conserves money');

  -- A hosted tournament never started: kept past 24 hours, cancelled after 7 days.
  perform pg_temp.as_user(h, $q$select public.rib_hosted_create('Stale Cup', 4, 500, 'public')$q$);
  select id into v_x from public.tournaments where name = 'Stale Cup';
  perform pg_temp.as_user(hp[5], format('select public.rib_tournament_join(%L)', v_x));
  update public.tournaments set created_at = now() - interval '25 hours' where id = v_x;
  perform public.rib_room_sweep();
  perform pg_temp.expect((select status from public.tournaments where id = v_x), 'open', 'the 24-hour sweep leaves hosted tournaments open');
  update public.tournaments set created_at = now() - interval '8 days' where id = v_x;
  perform public.rib_hosted_sweep();
  perform pg_temp.expect((select status from public.tournaments where id = v_x) || ':' || pg_temp.conserved(v_x) || ':' ||
    (select coalesce(host_strikes, 0) from public.player_reputation where user_id = h),
    'cancelled:0:0', 'after 7 days a never-started hosted tournament is refunded, no strike');

  -- Overturn: the appellant wins with the host commission; the host gets a strike.
  perform pg_temp.as_user(h, $q$select public.rib_hosted_create('Overturn Cup', 4, 1000, 'public')$q$);
  select id into v_x from public.tournaments where name = 'Overturn Cup';
  for i in 1..4 loop perform pg_temp.as_user(hp[i], format('select public.rib_tournament_join(%L)', v_x)); end loop;
  perform pg_temp.host_plays(h, v_x);
  select winner_id, runner_up_id into v_winner, v_app from public.tournaments where id = v_x;
  v_before := pg_temp.balance(v_app);
  perform pg_temp.expect(pg_temp.as_user(v_app, format('select public.rib_tournament_appeal(%L, ''I won the final, see the end screen'')', v_x)), 'ok', 'the runner-up appeals');
  update public.tournament_disputes set created_at = now() - interval '49 hours' where tournament_id = v_x;
  perform pg_temp.expect(public.rib_ops_health() ->> 'stale_appeals', '1', 'appeals older than 48 hours are reported');
  perform pg_temp.expect(pg_temp.as_user(op, format('select public.rib_appeal_resolve(%L, ''overturn'', %L, ''End screen shows the appellant won'')', v_x, v_app)), 'ok', 'the operator overturns');
  perform pg_temp.expect((pg_temp.balance(v_app) - v_before)::text || ':' ||
    coalesce((select sum(amount_cents) from public.wallet_ledger where ref_id = v_x and kind = 'tournament_prize' and user_id = v_winner), 0) || ':' ||
    coalesce((select sum(amount_cents) from public.wallet_ledger where ref_id = v_x and kind = 'host_commission'), 0) || ':' ||
    (select amount_cents from public.platform_revenue where tournament_id = v_x) || ':' ||
    (select (winner_id = v_app)::text from public.tournaments where id = v_x),
    '3600:0:0:400:true', 'overturn pays the new winner 90% and returns the deposit');
  perform pg_temp.expect((select host_strikes::text from public.player_reputation where user_id = h), '1', 'an overturned result is a host strike');
  perform pg_temp.expect(pg_temp.conserved(v_x), '0', 'overturn conserves money');

  -- Refund all.
  perform pg_temp.as_user(h, $q$select public.rib_hosted_create('Refund Cup', 4, 1000, 'public')$q$);
  select id into v_x from public.tournaments where name = 'Refund Cup';
  for i in 1..4 loop perform pg_temp.as_user(hp[i], format('select public.rib_tournament_join(%L)', v_x)); end loop;
  perform pg_temp.host_plays(h, v_x);
  select runner_up_id into v_app from public.tournaments where id = v_x;
  perform pg_temp.as_user(v_app, format('select public.rib_tournament_appeal(%L, ''The host favoured his friend'')', v_x));
  perform pg_temp.expect(pg_temp.as_user(op, format('select public.rib_appeal_resolve(%L, ''refund_all'')', v_x)), 'ok', 'the operator refunds everyone');
  perform pg_temp.expect((select status from public.tournaments where id = v_x) || ':' || pg_temp.conserved(v_x) || ':' ||
    (select count(*) from public.platform_revenue where tournament_id = v_x) || ':' ||
    (select count(*) from public.wallet_ledger where ref_id = v_x and kind = 'tournament_refund') || ':' ||
    (select host_strikes from public.player_reputation where user_id = h),
    'cancelled:0:0:4:2', 'refund_all returns every entry fee and the deposit, host strike');

  -- Abandoned: no progress for 24 hours voids it, refunds everyone, strike.
  perform pg_temp.as_user(h, $q$select public.rib_hosted_create('Abandon Cup', 4, 500, 'public')$q$);
  select id into v_x from public.tournaments where name = 'Abandon Cup';
  for i in 1..4 loop perform pg_temp.as_user(hp[i], format('select public.rib_tournament_join(%L)', v_x)); end loop;
  perform pg_temp.expect(pg_temp.as_user(h, format('select public.rib_host_cancel(%L)', v_x)), 'already_started', 'the host cannot cancel after the start');
  update public.tournaments set last_progress_at = now() - interval '25 hours' where id = v_x;
  perform public.rib_hosted_sweep();
  perform pg_temp.expect((select status from public.tournaments where id = v_x) || ':' || pg_temp.conserved(v_x) || ':' ||
    (select count(*) from public.match_rooms where tournament_id = v_x and status not in ('done','void')) || ':' ||
    (select host_strikes from public.player_reputation where user_id = h),
    'cancelled:0:0:3', 'the sweep voids an abandoned tournament and refunds it');
  perform pg_temp.expect(pg_temp.as_user(h, $q$select public.rib_hosted_create('Paid again', 4, 100, 'public')$q$), 'host_restricted', 'hosts with 3 strikes host free only');
  perform pg_temp.expect(pg_temp.as_user(h, $q$select public.rib_hosted_create('Free Cup H', 4, 0, 'public')$q$), 'ok', 'free hosting stays open');

  -- Chat purge: only rooms of terminal tournaments.
  select id into v_free from public.tournaments where name = 'Free Cup H';
  for i in 1..4 loop perform pg_temp.as_user(hp[i], format('select public.rib_tournament_join(%L)', v_free)); end loop;
  select id into v_room from public.match_rooms where tournament_id = v_free and round = 1 and slot = 0;
  perform pg_temp.as_user(h, format('select public.rib_host_room_lobby(%L, ''WR-FREE'')', v_room));
  perform pg_temp.expect(pg_temp.as_user(hp[1], 'select * from public.rib_room_purge_candidates(10)'), '42501', 'purge candidates are server-only');
  perform pg_temp.expect(pg_temp.as_user(hp[1], 'select public.rib_room_messages_purge(''{}'')'), '42501', 'the purge is server-only');
  perform pg_temp.expect((select count(*)::text from public.rib_room_purge_candidates(1000) c join public.match_rooms r on r.id = c.room_id where r.tournament_id = v_free), '0', 'rooms of a live tournament are not candidates');
  perform pg_temp.expect((select (count(*) > 0)::text from public.rib_room_purge_candidates(1000) c join public.match_rooms r on r.id = c.room_id where r.tournament_id = v_t), 'true', 'rooms of a finished tournament are candidates');
  select count(*) into v_msgs from public.room_messages m join public.match_rooms r on r.id = m.room_id where r.tournament_id = v_t;
  perform pg_temp.expect(public.rib_room_messages_purge(array(select id from public.match_rooms where tournament_id in (v_t, v_free)))::text, v_msgs::text, 'the purge deletes the finished tournament''s messages');
  perform pg_temp.expect((select count(*)::text from public.room_messages m join public.match_rooms r on r.id = m.room_id where r.tournament_id = v_t), '0', 'finished tournament chats are gone');
  perform pg_temp.expect((select count(*)::text from public.room_messages where room_id = v_room), '1', 'live tournament chats stay');
  perform pg_temp.expect((select count(*)::text from public.rib_room_purge_candidates(1000) c join public.match_rooms r on r.id = c.room_id where r.tournament_id = v_t), '0', 'purged rooms are not candidates again');

  perform pg_temp.expect((public.rib_ops_health() ?& array['open_appeals','flagged_hosted_rooms','stale_appeals'])::text, 'true', 'ops health counts appeals and flagged rooms');
  perform pg_temp.expect(public.rib_appeal_window_for(v_free)::text, '24:00:00', 'free tournaments keep the 24-hour appeal window');

  -- Storage: lobby screenshots by the host of a live room, 10 per room;
  -- evidence by the room's players; malformed names never raise.
  select id, player_a, player_b into v_room, v_ya, v_yb from public.match_rooms where tournament_id = v_free and round = 1 and slot = 0;
  perform pg_temp.expect(pg_temp.as_user(h, format('insert into storage.objects (bucket_id, name) values (''room-lobby'', %L)', v_room || '/' || gen_random_uuid() || '.png')), 'ok', 'the host uploads a lobby screenshot');
  perform pg_temp.expect(pg_temp.as_user(v_ya, format('insert into storage.objects (bucket_id, name) values (''room-lobby'', %L)', v_room || '/' || gen_random_uuid() || '.png')), '42501', 'players cannot upload lobby screenshots');
  perform pg_temp.expect(pg_temp.as_user(h, format('insert into storage.objects (bucket_id, name) values (''room-lobby'', %L)', v_final || '/' || gen_random_uuid() || '.png')), '42501', 'no lobby uploads to a finished room');
  perform pg_temp.expect(pg_temp.as_user(h, format('insert into storage.objects (bucket_id, name) values (''room-lobby'', %L)', v_room || '/lobby.png')), '42501', 'lobby files are named <uuid>.<ext>');
  for i in 1..9 loop
    perform pg_temp.as_user(h, format('insert into storage.objects (bucket_id, name) values (''room-lobby'', %L)', v_room || '/' || gen_random_uuid() || '.webp'));
  end loop;
  perform pg_temp.expect(pg_temp.as_user(h, format('insert into storage.objects (bucket_id, name) values (''room-lobby'', %L)', v_room || '/' || gen_random_uuid() || '.png')), '42501', 'up to 10 lobby files per room');
  perform pg_temp.expect(pg_temp.scalar_as(v_ya, format('select count(*)::text from storage.objects where bucket_id = ''room-lobby'' and name like %L', v_room || '/%')), '10', 'players read the lobby files');
  perform pg_temp.expect(pg_temp.scalar_as(hp[7], format('select count(*)::text from storage.objects where bucket_id = ''room-lobby'' and name like %L', v_room || '/%')), '0', 'outsiders do not');
  perform pg_temp.as_user(v_ya, format('delete from storage.objects where bucket_id = ''room-lobby'' and name like %L', v_room || '/%'));
  perform pg_temp.expect((select count(*)::text from storage.objects where bucket_id = 'room-lobby' and name like v_room || '/%'), '10', 'players cannot delete lobby files');
  perform pg_temp.as_user(h, format('delete from storage.objects where bucket_id = ''room-lobby'' and name = (select min(name) from storage.objects where bucket_id = ''room-lobby'' and name like %L)', v_room || '/%'));
  perform pg_temp.expect((select count(*)::text from storage.objects where bucket_id = 'room-lobby' and name like v_room || '/%'), '9', 'the host deletes a lobby file of a live room');
  perform pg_temp.expect(pg_temp.as_user(h, format('insert into storage.objects (bucket_id, name) values (''room-evidence'', %L)', v_room || '/' || h || '/end.png')), '42501', 'the host cannot upload evidence');
  perform pg_temp.expect(pg_temp.as_user(v_ya, format('insert into storage.objects (bucket_id, name) values (''room-evidence'', %L)', v_room || '/' || v_ya || '/end.png')), 'ok', 'a player uploads evidence');
  perform pg_temp.expect(pg_temp.as_user(hp[7], format('insert into storage.objects (bucket_id, name) values (''room-evidence'', %L)', v_room || '/' || hp[7] || '/end.png')), '42501', 'outsiders cannot upload evidence');
  perform pg_temp.expect(pg_temp.as_user(hp[7], 'insert into storage.objects (bucket_id, name) values (''avatars'', ''not-a-uuid/x.png'')'), '42501', 'malformed names in other buckets are refused, not cast errors');

  -- The 0019 operator resolution closes the disputes it settles.
  insert into public.tournaments (creator_id, name, game, entry_fee_cents, max_players, status, format, network, entrants, winner_id, payout_at)
  values (hp[6], 'Legacy Cup', 'Wild Rift', 0, 4, 'payout_pending', 'bracket', 'riot', 2, hp[1], now() + interval '1 hour') returning id into v_x;
  insert into public.tournament_entries (tournament_id, user_id) values (v_x, hp[1]), (v_x, hp[2]);
  perform pg_temp.expect(pg_temp.as_user(hp[2], format('select public.rib_tournament_dispute(%L, ''legacy dispute'')', v_x)), 'ok', 'a legacy dispute');
  perform public.rib_tournament_resolve(v_x, 'refund');
  perform pg_temp.expect((select status from public.tournament_disputes where tournament_id = v_x), 'upheld', 'a legacy refund closes its disputes');

  -- Invite-code guessing: 20 failed lookups per 10 minutes.
  for i in 1..20 loop
    perform pg_temp.expect(coalesce(pg_temp.scalar_as(hp[7], 'select public.rib_tournament_preview(''ABCDEFGHJK'')::text'), 'none'), 'none', 'a failed lookup');
  end loop;
  perform pg_temp.expect(pg_temp.as_user(hp[7], 'select public.rib_tournament_preview(''ABCDEFGHJK'')'), 'rate_limited', 'too many failed lookups are refused');
  perform pg_temp.expect(pg_temp.as_user(hp[7], format('select public.rib_tournament_join_by_code(%L)', (select invite_code from public.tournaments where id = v_free))), 'rate_limited', 'joining by code is refused too');
  perform pg_temp.expect(pg_temp.scalar_as(h, 'select jsonb_array_length(public.rib_host_dashboard() -> ''tournaments'')::text'), '9', 'the host dashboard lists my tournaments');
  perform pg_temp.expect(pg_temp.scalar_as(h, 'select (public.rib_host_dashboard() -> ''tournaments'' -> 0 ->> ''name'') || '':'' || jsonb_array_length(public.rib_host_dashboard() -> ''tournaments'' -> 0 -> ''rooms_needing_action'')'), 'Free Cup H:2', 'live tournaments first, with rooms needing action');

  perform pg_temp.expect(
    (select count(*)::text from public.wallets w
      where w.test_balance_cents <> coalesce((select sum(amount_cents) from public.wallet_ledger l where l.user_id = w.user_id), 0)),
    '0', 'ledger reconciles with balances after hosted tournaments');
end;
$$;

-- 0028: every constraint 0027 added NOT VALID is validated.
do $$
begin
  perform pg_temp.expect(
    (select count(*)::text from pg_constraint
      where contype = 'c' and not convalidated
        and conrelid in ('public.tournaments'::regclass, 'public.match_rooms'::regclass,
                         'public.room_messages'::regclass, 'public.tournament_disputes'::regclass,
                         'public.wallet_ledger'::regclass)),
    '0', 'hosted-tournament check constraints are validated');
end;
$$;

-- 0028: a signed-out preview of a private tournament names nobody, champion included.
do $$
declare v_id uuid; v_code text; v_json jsonb;
begin
  select id, invite_code into v_id, v_code from public.tournaments where name = 'Private Cup' and mode = 'hosted';
  update public.tournaments set winner_id = (select user_id from public.tournament_entries where tournament_id = v_id limit 1) where id = v_id;
  v_json := pg_temp.scalar_anon(format('select public.rib_tournament_preview(%L)::text', v_code))::jsonb;
  perform pg_temp.expect(coalesce(v_json ->> 'winner_username', 'hidden'), 'hidden', 'a signed-out private preview hides the champion');
  perform pg_temp.expect(((pg_temp.scalar_as((select creator_id from public.tournaments where id = v_id),
    format('select public.rib_tournament_preview(%L)::text', v_code))::jsonb ->> 'winner_username') is not null)::text, 'true',
    'signed in, the preview names the champion');
  update public.tournaments set winner_id = null where id = v_id;
end;
$$;

\echo 'rpc-smoke: all expectations passed'
