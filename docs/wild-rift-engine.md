# Wild Rift tournament engine — contract

Status: in progress on `feat/wild-rift-tournament-engine` (2026-09-29).
This file is the single source of truth shared by the database, Edge Function
and console work. Change it first, then the code.

## Why this shape

- **Wild Rift has no public Riot API.** developer.riotgames.com lists
  LoL, TFT, VALORANT, LoR and Riftbound APIs, nothing for Wild Rift: no match
  history, no tournament codes, no results. We do not scrape or call
  unofficial endpoints (Riot policy; one ban would take the whole platform).
- What Riot *does* offer and we use: `account-v1` (`/riot/account/v1/accounts/by-riot-id/{gameName}/{tagLine}`)
  to prove a Riot ID exists and pin its `puuid`, when `RIOT_API_KEY` is set.
- Match results are proven by the players: **both reports agree → settle at
  once**; otherwise the **end-of-match screenshot is read automatically**
  (Claude vision) and, if it clearly shows the reported winner with both
  Riot IDs, the match settles at once. Anything unclear goes to disputes.
- Speed and scale: players don't browse lobbies. **Quick Play** puts them in
  the oldest open tournament of the tier they pick (entry fee × size) with
  `FOR UPDATE SKIP LOCKED`, so concurrent joins never queue on one row, and
  creates a new one only when every open one is busy or full.

## Product rules

- Only game: `Wild Rift` (constant `WILD_RIFT` in `src/scripts/lib/wild-rift.js`
  and `rib_wild_rift_game()` in SQL). Only network: `riot`.
  A linked Riot ID (`Name#TAG`) is required to enter any tournament.
- Matches are 1v1 Wild Rift custom games. Player A hosts the custom lobby;
  the room shows lobby name/password as today.
- Tiers: entry fee in cents ∈ {0, 100, 500, 1000, 2500, 5000}; size ∈ {4, 8}.
  Prizes unchanged: 10% platform fee, 70/30 champion/runner-up.
- Timings (functions, so they can be tuned without a migration):
  `rib_ready_window()` = 5 min (was 15), `rib_confirm_window()` = 10 min (was 15).
- Vocabulary: entry fee, prize, prize pool. Never wager/bet/stake/pot.

## Database (migration `0026_wild_rift_engine.sql`, idempotent)

Tables / columns
- `tournaments.tier_key text` — `'<fee_cents>:<size>'` for Quick Play events (null for custom ones).
  Partial index `tournaments_quick_open_idx (tier_key, created_at) where status = 'open' and tier_key is not null`.
- `game_accounts.riot_puuid text`, `game_accounts.verified_at timestamptz`
  (set only by the service role via `rib_riot_account_verified`).
- `room_evidence` adds: `check_status text not null default 'pending'`
  check in (`pending`,`verified`,`contradicts`,`unreadable`,`duplicate`,`skipped`),
  `check_winner uuid`, `check_confidence numeric(4,3)`, `check_detail jsonb`,
  `checked_at timestamptz`.
  A screenshot already used in another room (same `sha256`) is rejected by
  `rib_room_evidence_add` with hint `evidence_duplicate` (index on `sha256`).
- `match_rooms.fast_tracked boolean not null default false`, `match_rooms.review_flag boolean not null default false`,
  `match_rooms.a_riot_id text`, `match_rooms.b_riot_id text` (snapshot at open).
- `room_evidence.content_sha256 text` (service-set from the stored bytes, indexed).
- `tournaments.entrants int not null default 0`, maintained under the row lock.

RPCs for players (`authenticated`, security definer, a `hint` on every error)
- `rib_quick_join(p_entry_fee_cents bigint, p_size int) returns public.tournaments`
  — validates the tier, requires a `riot` game account, applies the existing
  limits (`rib_paid_entry_limits`, `already_registered`, account restrictions),
  picks `select … where tier_key = … and status = 'open' order by created_at
  for update skip locked limit 1`, else inserts a new tournament
  (name `Wild Rift <size> · <fee> rcoin` / `Wild Rift <size> · Free`,
  creator = the joiner) and joins. Rejects a second open Quick Play entry in
  the same tier (hint `already_queued`).
- `rib_quick_tiers() returns table(entry_fee_cents bigint, size int, waiting int, open_events int)`
  — for the Play screen (players waiting per tier). One grouped read over the partial index.
- `rib_tournament_create` keeps working but forces game = Wild Rift, network = riot.
- `rib_room_report` keeps its signature; the confirm window uses `rib_confirm_window()`.

RPCs for the service role only (Edge Functions)
- `rib_evidence_for_check(p_evidence_id bigint) returns jsonb` — room id and
  status, both players' ids, usernames and Riot IDs, the uploader, reports so
  far, storage path, check status.
- `rib_evidence_check_apply(p_evidence_id bigint, p_status text, p_winner uuid, p_confidence numeric, p_detail jsonb, p_content_sha256 text default null) returns public.match_rooms`
  — idempotent (only from `pending`). **A screenshot never settles, voids or
  disputes a room on its own** (security review 2026-09-29: images can be
  forged or replayed, and a free forced dispute is an abuse path). Rules:
  - `p_content_sha256` is the hash the Edge Function computed from the stored
    bytes; if another room already has evidence with that content hash the
    status becomes `duplicate` whatever the model said.
  - `verified`, confidence ≥ `rib_auto_settle_confidence()` (0.90), room `live`,
    the uploader has reported, the winner equals the uploader's report and the
    opponent hasn't reported → the confirm window shrinks to
    `least(confirm_deadline, now() + rib_verified_confirm_window())` (3 min),
    `match_rooms.fast_tracked = true`. The opponent can still dispute; silence
    confirms through the normal sweep. Matching reports still settle at once.
  - Anything else (`contradicts`, `verified` against a report, `unreadable`,
    `skipped`, `duplicate`) → the room is untouched; `match_rooms.review_flag
    = true` for `contradicts`/`duplicate` so operators see it first if the
    room is disputed.
- Riot IDs are snapshotted on the room when it opens (`match_rooms.a_riot_id`,
  `b_riot_id`); `rib_evidence_for_check` returns the snapshot. A player can't
  change their Riot ID while they have an open or active tournament entry or
  a live room (hint `riot_id_locked`), and a Riot ID (case-insensitive) belongs
  to one player (hint `riot_account_taken`).
- `account-v1` proves a Riot ID exists, not who owns it. True ownership needs
  Riot Sign-On (RSO), which needs an approved Riot production app — follow-up.
- `rib_riot_account_verified(p_user_id uuid, p_puuid text, p_game_name text, p_tag_line text)`.

Realtime: `room_evidence` joins the `supabase_realtime` publication so players
see check results (UPDATE events). `tournaments` too, for fill progress.

Error hints (map every new one in `src/scripts/lib/errors.js`):
`invalid_tier`, `already_queued`, `riot_account_required`, `evidence_duplicate`,
`evidence_not_pending`, `invalid_riot_id`, `riot_account_taken`, `riot_id_locked`.

## Edge Functions (Deno, `supabase/functions/`)

- `verify-result` — POST `{ evidence_id }` with the player's JWT.
  1. Auth the user; rate limit per user (`_shared/rate-limit.ts`).
  2. `rib_evidence_for_check` (service role); the caller must be a participant.
  3. Download the image from the private `room-evidence` bucket.
  4. Claude vision, model `claude-haiku-4-5-20251001` first; if confidence is
     < 0.90 and the image isn't unreadable, retry once with `claude-sonnet-5-5`.
     Structured JSON output: `{ is_wild_rift_end_screen, result_for_uploader: "victory"|"defeat"|"unknown", names_seen: string[], matched_players: {a:boolean,b:boolean}, confidence }`.
     The winner is derived server-side from uploader + result + matched
     names — never taken from the model directly.
  5. `rib_evidence_check_apply` with the sha256 of the downloaded bytes. Returns `{ status, settled, fast_tracked }`.
  The model runs only when the room is `live`, the uploader has reported and the
  opponent hasn't (otherwise `skipped`, no model call), under a global daily budget.
  Without `ANTHROPIC_API_KEY` → `skipped` (the flow falls back to manual confirm).
- `riot-account` — POST `{ game_name, tag_line }` with the player's JWT;
  calls Riot `account-v1` (regional host `americas` by default, env
  `RIOT_REGION`); on 200 calls `rib_riot_account_verified`. Without
  `RIOT_API_KEY` returns `{ verified: false, reason: "unavailable" }`.
  The Riot and Anthropic keys are server secrets only.

## Console (frontend)

- Compete becomes **Play**: a tier grid (fee × size) with live "N waiting";
  one tap = `rib_quick_join`. No game field anywhere (Wild Rift is fixed).
- After joining: a waiting card with fill progress (`entrants/size`) and
  "Leave" (refund) until it starts; when it starts, straight into the room.
- Room: after reporting, the primary action is **Upload the end screen**; each
  evidence item shows its check status (Checking… / Verified / Doesn't match /
  Couldn't read it / Used in another match) from Realtime. A verified screen
  only shortens the confirm window to 3 minutes; the opponent can still dispute. The console calls
  `verify-result` right after `rib_room_evidence_add`.
- Riot ID linking calls `riot-account`; a verified ID shows a badge.
- Custom tournaments (name, 4/8, fee) stay as a secondary action, Wild Rift only.
