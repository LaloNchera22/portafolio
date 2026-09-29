# Architecture

## Overview

```
Browser (Vite-bundled ES modules)
  ├─ supabase-js ──► PostgREST ──► Postgres (RLS: read own rows)
  │                     └─ rpc('rib_*') ──► SECURITY DEFINER RPCs ──► rib_apply (single balance writer)
  ├─ Realtime (postgres_changes on game_matches) for live paid games
  └─ functions.invoke ──► Edge Functions (Deno)
                            ├─ stripe-checkout / crypto-checkout  → hosted checkout
                            ├─ stripe-webhook / crypto-webhook    → signature check → rib_credit_* (service role)
                            ├─ steam-auth                         → OpenID 2.0 bridge → magic link
                            └─ issue-api-key                      → hashed developer keys
Vercel serves dist/ with CSP + HSTS; hashed assets are cached immutably.
```

## Key decisions

- **No framework rewrite.** The UI is server-rendered HTML plus small modules.
  Vite gives bundling, hashing, tree-shaking and a pinned supabase-js without
  changing how pages are authored. Revisit a component framework only if the
  console grows beyond what plain modules keep maintainable.
- **Build-time public config.** `SUPABASE_URL`, `SUPABASE_ANON_KEY` and the
  payment-rail flags are injected by `vite.config.js`. This removed the blocking
  `/api/config` serverless call on every page view. Changing them needs a redeploy.
- **Database is the security boundary.** RLS limits reads; all writes to money
  tables go through RPCs; `rib_apply` performs the funds check atomically;
  multi-wallet RPCs lock wallets in uuid order; per-user caps take an advisory
  lock. Internal functions are not executable by client roles (migration 0009).
- **Incremental player stats.** The ranking reads `player_stats` /
  `player_stats_weekly`, updated by a trigger on every ledger insert, and pages
  on an index ordered like the board — it never aggregates the ledger at read
  time. Weeks are Monday 00:00 UTC.
- **Stable error codes.** RPCs raise English messages with a `hint` code; the
  client maps hints to copy (`lib/errors.js`), so wording and language can change
  without breaking the UI.
- **Chain: Base.** Entry fees and prizes are designed to settle in USDC on Base,
  matching the Coinbase Commerce rail already in use; today everything runs
  in test mode on the off-chain ledger.
- **Pure game rules.** Each game exposes `init/legal/apply/result/bot`
  without DOM access. The stakeable ones live in
  `supabase/functions/_shared/game-rules` (imported by the web app through the
  `@game-rules` alias and by the `game-move` Edge Function), so the browser and
  the server run the exact same rules.

## Roadmap to 1M users (ordered by risk)

1. ~~**Server-authoritative staked games.**~~ Done in 0012: the `game-move`
   Edge Function validates every staked move with the shared pure rules
   (`supabase/functions/_shared/game-rules`) and settles the pot atomically;
   clients can no longer write boards or report results. Only deterministic,
   perfect-information games are stakeable. **Next:** server-side randomness
   and per-player hidden state to re-enable Crazy Eights and card games.
2. **Realtime at scale.** Replace `postgres_changes` (RLS evaluated per
   subscriber, full row images) with private Broadcast channels per match
   (`realtime.broadcast_changes` trigger + RLS on `realtime.messages`). Kept on
   `postgres_changes` for now on purpose: the transport only carries
   server-validated state, and switching it must be verified on a staging
   project first.
3. ~~**Tournament results.**~~ Done in 0019: no self-entry in paid events,
   minimum 3 entrants, 24-hour review window with entrant disputes, payout
   job, and operator resolution (`rib_tournament_resolve`).
4. ~~**Refunds and chargebacks.**~~ Done in 0011: Stripe refunds / disputes
   reverse the top-up and freeze the wallet on a shortfall. Crypto (Coinbase)
   payments are not reversible on-chain; handle them with manual review.
5. **Data lifecycle.** Escrow expiry and batched match cleanup run on
   pg_cron since 0011. Still to do: partition or archive `wallet_ledger`, and
   keyset pagination for the console lists.
6. **Operability.** Browser errors from the console are captured in
   `client_errors` (0020, 14-day retention). Still to do: alerting on those
   and on Edge Function logs, uptime checks, Supabase branching for preview
   deployments, and Playwright end-to-end tests (plan in the audit notes).
7. **Account closure vs. financial records (decision needed).** Deleting an
   `auth.users` row cascades to `wallets`, `wallet_ledger` and
   `rcoin_purchases`. Switching those foreign keys to `RESTRICT` preserves the
   audit trail but blocks deletes, so it must ship together with an
   anonymizing account-closure flow agreed with legal (retention vs. GDPR).
8. **Migration baseline.** Squash 0001–0009 into a baseline once every
   environment is on 0009, and add pgTAP tests alongside the smoke suite.
