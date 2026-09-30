# Hosted tournaments — contract

Status: implemented on `feat/hosted-tournaments` (2026-09-30).
Single source of truth for the database, Edge Function and console work.
Change this file first, then the code. Builds on `docs/wild-rift-engine.md`.

## The flow

1. **Create.** Anyone signed in creates a tournament: name, size, entry fee,
   visibility (public/private), optional rules text. They become its **host**.
2. **Share.** Every hosted tournament has an invite code. The share link is
   `<origin>/console.html#join/<CODE>`. Public tournaments are also listed in
   the lobby; private ones are reachable only through the link/code.
3. **Join.** Players open the link, see a preview (host, fee, prize, entrants)
   and join (entry fee is taken; Riot ID required, as today). They can leave
   with a refund until it starts.
4. **Start.** Automatically when full, or the host starts early once it has
   at least `rib_tournament_min_entrants()` (4) players; the bracket shrinks to
   the next power of two ≥ entrants and the top seeds get byes (walkovers).
5. **Matches.** Each bracket match is a room. When both players are known the
   room is in `setup`: the host creates the Wild Rift custom lobby and posts
   the **lobby code** (and/or a **screenshot of the lobby**) in the room. That
   message moves the room to `live`. Players join the lobby in Wild Rift and play.
6. **Decide.** The **host decides the winner** of every match (or a walkover
   if one player didn't show, or voids it if neither did). Players can still
   say "I won" and upload the end screen (the existing screenshot check runs);
   that is advisory, shown to the host. The winner advances, the loser is out.
7. **Chat.** Each match room has its own chat: the two players + the host
   (+ operators). Nothing tournament-wide. See *Chat retention*.
8. **Finish.** When the host decides the final, the tournament becomes
   `payout_pending` with `payout_at = now() + rib_appeal_window()` (24 h).
9. **Appeal.** During that window any entrant can appeal (one per player per
   tournament, optionally pointing at a match). An appeal holds the payout
   (`disputed`) until an operator resolves it.
10. **Pay.** When the window closes with no open appeal (or after the
    operator's resolution), prizes are paid by the payout job.

## Money

Pool = `entry_fee_cents × entrants` (actual entrants, not `max_players`).

| Mode | Winner | Host | Platform |
|---|---|---|---|
| `hosted` | 85% (remainder, absorbs rounding) | 5% (`rib_host_fee_percent()`) | 10% (`rib_platform_fee_percent()`) |
| `quick` (Quick Play, no host) | unchanged: 90% split 70/30 champion/runner-up | — | 10% |

- Integer cents: `platform = pool*10/100`, `host = pool*5/100`, `winner = pool - platform - host`.
- Free tournaments (fee 0) move no money, but still use the appeal window.
- Host commission is paid **only** with the prize, after the appeal window.
- If an appeal is upheld against the host's decision (`overturn`), the host
  commission is **forfeited to the new winner** (winner gets 90%) and the host
  gets a strike. `refund_all` refunds every entry fee; nobody earns anything.
- New ledger kind `host_commission` (wallet_ledger kind check + `rib_apply` + stats that sum kinds).
- `platform_revenue` keeps one row per tournament (amount updated on resolution).
- Riot's policy (≥ 70% of entry fees to prizes) holds: 85%.

## Integrity rules

- **The host can't play** in their own tournament (hint `host_cannot_play`).
- A host has at most 3 non-terminal hosted tournaments (hint `host_limit`).
- Paid hosting needs a clean record: hosts with ≥ 3 strikes can only host
  free tournaments (hint `host_restricted`). New hosts (fewer than 3 completed
  matches as a player, `player_reputation`) can set an entry fee up to
  25 rcoin (2500 cents) (hint `host_fee_limit`).
- Only the host (or an operator) decides rooms; players can't settle a hosted room.
- Host SLA: a `live` hosted room without a decision after
  `rib_host_decide_window()` (60 min) gets `review_flag = true` (operators see it).
  A hosted tournament with no room decided/opened for `rib_host_abandon_window()`
  (24 h) while `active` is **voided by the sweep**: every entry fee refunded,
  host gets a strike.
- Before start the host can cancel (full refunds). After start only operators can
  (operators call `rib_host_cancel` at any non-terminal status: refunds entries and open appeal deposits, no strike).
- A hosted tournament still `open` 7 days after creation is cancelled with full refunds (no strike).
- Anti-collusion (host + alt accounts):
  - A walkover or void needs the room to have been in `setup`/`live` for ≥ 10 min
    (`rib_host_walkover_wait()`, hint `walkover_too_early`) and a note (hint `note_required`).
  - A normal decision less than 8 min after the room went live (`rib_host_min_match_minutes()`)
    is allowed but sets `review_flag`.
  - Host-decided matches don't feed reputation `matches_completed` or the ranking (no-shows still count).
    The new-host fee cap uses `hosted_completed` (3 hosted tournaments paid out without a strike).
  - Paid tournaments whose host has `hosted_completed < 3` get a 72 h appeal window.
- `last_progress_at` moves only on start, `setup → live` and decisions — not on lobby re-posts.
- `rib_ops_health` reports `open_appeals`, `stale_appeals` (disputed > 48 h) and `flagged_hosted_rooms`.
- Appeal deposit on paid tournaments: 10% of the entry fee, min 100 cents,
  held from the appellant; returned if the appeal is upheld (`overturn` or
  `refund_all`), forfeited to platform revenue if the result stands.

## Database — migration `0027_hosted_tournaments.sql` (idempotent)

Columns
- `tournaments.mode text not null default 'quick' check in ('quick','hosted')`
  (Quick Play and pre-existing custom tournaments stay `quick` semantics).
- `tournaments.visibility text not null default 'public' check in ('public','private')`.
- `tournaments.invite_code text unique` — 10 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, set for hosted.
- `tournaments.rules text check (char_length(rules) <= 1000)`.
- `tournaments.host_fee_cents bigint not null default 0`.
- `tournaments.last_progress_at timestamptz` (start, room open, decision) — for the abandon sweep.
- `match_rooms.status` adds `'setup'` (hosted room waiting for the host's lobby).
- `match_rooms.host_note text` (host's reason for a decision, ≤ 300).
- `room_messages.kind text not null default 'chat' check in ('chat','lobby','system')`,
  `room_messages.image_path text` (lobby screenshot in bucket `room-lobby`).
- `tournament_disputes` (appeals) adds: `room_id uuid null`, `status text not null default 'open' check in ('open','upheld','rejected')`,
  `deposit_cents bigint not null default 0`, `resolved_at`, `resolution_note`.
- `player_reputation` adds `hosted_completed int not null default 0`, `host_strikes int not null default 0`.

Storage: private bucket `room-lobby`, 5 MB, `image/png|jpeg|webp`. Path
`<room_id>/<uuid>.<ext>`. Insert allowed only to the host of that room's
tournament; select to anyone who can see the room (`rib_can_see_room`).

Visibility: `rib_can_see_room` also returns true for the host of the room's
tournament; `match_rooms` select policy likewise. Hosts see every room of their tournaments.

RPCs (authenticated, security definer, `hint` on every error)
- `rib_hosted_create(p_name text, p_size int, p_entry_fee_cents bigint, p_visibility text, p_rules text default null) returns public.tournaments`
  — size ∈ {4, 8, 16, 32}; fee ∈ [0, 50000] and multiple of 100; Wild Rift / riot forced.
- `rib_tournament_preview(p_code text) returns jsonb` — by invite code: id, name, host username, mode,
  visibility, size, entrants, entry fee, projected prizes (winner/host/platform at current entrants and when full),
  status, rules, whether the caller is host / already joined. Hint `invite_invalid`.
  Also callable by `anon` so shared links render a preview before login (then no caller flags).
- `rib_tournament_join_by_code(p_code text) returns public.tournaments` — same checks as `rib_tournament_join`.
- `rib_tournament_join(p_tournament_id)` rejects private tournaments (hint `tournament_private`) and the host.
- `rib_host_rotate_invite(p_tournament_id uuid) returns text`.
- `rib_host_start(p_tournament_id uuid) returns public.tournaments` — early start (hint `not_enough_players`).
- `rib_host_cancel(p_tournament_id uuid) returns public.tournaments` — only before start (hint `already_started`).
- `rib_host_room_lobby(p_room_id uuid, p_lobby_code text, p_lobby_password text default null, p_image_path text default null) returns public.match_rooms`
  — code ≤ 40 chars; code or image required (hint `lobby_required`); posts a `lobby` message; `setup → live`.
  Can be re-posted while `live` (lobby changed).
- `rib_host_decide(p_room_id uuid, p_winner_id uuid, p_walkover boolean default false, p_note text default null) returns public.match_rooms`
  — room `live` (or `setup` for a walkover); winner must be one of the two players; advances the bracket.
- `rib_host_void_room(p_room_id uuid, p_note text) returns public.match_rooms` — neither player showed.
- `rib_room_message(p_room_id, p_body)` — the host of the tournament may post too.
- `rib_tournament_appeal(p_tournament_id uuid, p_reason text, p_room_id uuid default null) returns public.tournaments`
  — entrant only, `payout_pending` and before `payout_at`, reason 10–500 chars; moves to `disputed`.
  Hints `appeal_closed`, `already_appealed`, `not_an_entrant`.
- `rib_host_dashboard(p_limit int default 20) returns jsonb` — the caller's hosted tournaments with
  entrants, status, invite code, rooms needing action (setup / live), open appeals count.
- `rib_tournament_bracket(p_tournament_id uuid) returns jsonb` — rooms (round, slot, players' usernames,
  status, winner) for entrants, the host and operators; public tournaments to anyone signed in.
- `rib_my_tournaments` and `rib_open_tournaments` include `mode`, `visibility`, host username; the open list excludes private.

Service role / operators
- `rib_ops_hosted_queue() returns jsonb` — `{appeals[], flagged_rooms[]}` for the ops console.
- `rib_appeal_resolve(p_tournament_id uuid, p_action text, p_winner_id uuid default null, p_note text default null) returns public.tournaments`
  — `p_action` ∈ `uphold` (result stands, pay as decided), `overturn` (pay `p_winner_id`, host fee to winner, host strike),
  `refund_all` (refund all, host strike). Resolves every open appeal of the tournament with the right deposit handling.
  Operators call it through the existing ops console (`rib_require_operator`). It pays at once (status must be `disputed`).
- `rib_tournament_payouts` pays hosted tournaments with the 85/5/10 split and increments `hosted_completed`.
- `rib_hosted_sweep() returns int` — decide-window flags + abandon voids. Scheduled with pg_cron (every 5 min) like the others.
- `rib_room_purge_candidates(p_batch int) returns table(room_id uuid, image_paths text[])` and
  `rib_room_messages_purge(p_room_ids uuid[]) returns int`.

Error hints (map every one in `src/scripts/lib/errors.js`):
`host_cannot_play`, `host_limit`, `host_restricted`, `host_fee_limit`, `not_host`, `invalid_size`,
`invalid_visibility`, `invite_invalid`, `tournament_private`, `not_enough_players`, `room_not_setup`,
`lobby_required`, `invalid_winner`, `appeal_closed`, `already_appealed`, `not_an_entrant`, `already_started`,
`invalid_rules`, `invalid_lobby`, `host_decides`, `walkover_too_early`, `note_required`.

Invite-code probing: authenticated failed lookups in `rib_tournament_preview` / `rib_tournament_join_by_code`
are rate-limited (`rate_limited`); anon previews of private tournaments omit host and rules.
Private tournaments' entries (`tournament_entries`) are visible only to the host, entrants and operators.

## Chat retention

- Server: messages and lobby images of a room are deleted once its tournament is
  terminal (`finished` / `cancelled`) — i.e. after the appeal window and any
  appeal — because an appeal needs the chat as evidence. Friendly rooms: 24 h after
  the room ends. The Edge Function `room-cleanup` (service role, cron) takes
  `rib_room_purge_candidates`, removes the storage objects through the Storage
  API, then calls `rib_room_messages_purge`. It runs hourly from `.github/workflows/room-cleanup.yml`
  (secrets `SUPABASE_FUNCTIONS_URL`, `OPS_SECRET`, as ops-alerts).
- Client: a room's chat channel is unsubscribed and its messages dropped from
  memory as soon as the room is `done`/`void` (the player is out or moved on).
  Only the current room's messages are ever kept; the list is capped at 200.

## Console (frontend)

- **Create tournament** (Tournaments page): name, size 4/8/16/32, entry fee,
  public/private, rules. Live breakdown: pool when full, winner 85%, host 5%, platform 10%.
- **Hosting** page (new nav item): my hosted tournaments → share link (copy /
  native share / rotate), entrants, Start now, Cancel (before start), bracket;
  every match needing action at the top: *Post lobby* (code, password, lobby
  screenshot upload) → *Pick winner* (A / B / walkover / void) with the players'
  reports and evidence shown. Open appeals are visible.
- **Join link** `#join/<CODE>`: preview card → Join (login redirect preserves the hash).
- **Player view**: bracket, current match room with the host's lobby card (code copy,
  image), chat, "I won" + upload end screen, eliminated / champion states,
  appeal button with countdown during the window, then payout status.
- **Ops**: open appeals queue with `rib_appeal_resolve` actions; flagged hosted rooms.
- Vocabulary: entry fee, prize, prize pool, host commission. Never wager/bet/stake/pot.
