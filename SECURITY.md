# Runinback — Security & backend (Fase 2)

This document describes the authentication + data layer added in Fase 2 and the
zero-trust rules it follows. Everything here is **code**; the live Supabase
project is provisioned by the owner (see *Setup* at the end). Until it is wired,
the site runs exactly as before and the auth UI shows a "backend not connected"
message instead of failing.

## Architecture at a glance

```
Browser (static site on Vercel)
  │  supabase-js (anon key, public)         ← never holds secrets
  ▼
Supabase Auth  ──issues──▶  JWT (per user)
  │
  ▼
PostgREST / Postgres  ── Row Level Security ──▶  a request only ever sees
                                                 rows that belong to auth.uid()
  ▲
  │ service role (server only)
Edge Functions (Deno)  ← mint API keys, hash secrets, verify JWTs
```

## Zero-trust principles applied

1. **Never trust the client.** The browser is treated as hostile. Identity is
   always derived from a **verified JWT** on the server, never from a value in
   the request body. See `supabase/functions/issue-api-key/index.ts`, which
   calls `auth.getUser()` and pins `owner_id` to that verified id.
2. **Deny by default.** Row Level Security is enabled on every table
   (`supabase/migrations/0001_init.sql`). With RLS on and no matching policy,
   access is refused. Policies then grant **owner-only** access
   (`auth.uid() = owner_id`). There is no "public read" anywhere.
3. **Least privilege for keys.**
   - `anon` key: public, in the browser. Can do only what RLS allows.
   - `service_role` key: server-only, bypasses RLS. Lives exclusively in Edge
     Function secrets — never in the repo, never in `supabase-config.js`.
   - API keys for developers are **hashed** (SHA-256) before storage; the
     plaintext is shown once and never persisted. Direct client inserts into
     `api_keys` are refused by RLS; keys can only be minted server-side.
4. **Verify at the edge.** `verify_jwt = true` on the function (see
   `supabase/config.toml`) means the platform rejects unauthenticated calls
   before our own check even runs — defense in depth.
5. **Harden the transport.** `vercel.json` sends a strict Content-Security-Policy
   (self + the fonts/CDN/Supabase origins we actually use), HSTS,
   `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, a locked-down
   `Permissions-Policy`, and `upgrade-insecure-requests`. This closes off
   clickjacking, mixed content and most injected-resource classes.

## Why SQL injection has no surface here

- The browser **never sends SQL**. It calls PostgREST through `supabase-js`,
  which sends every filter and value as a **bound parameter**. There is no
  string concatenation of user input into a query, so classic injection cannot
  occur on the client path.
- Server-side inserts in the Edge Function also go through `supabase-js`
  (parameterized), not raw SQL.
- The two database functions are `SECURITY DEFINER`/`INVOKER` with a pinned
  `search_path = ''`, so they cannot be hijacked by shadowing objects in another
  schema — the other common injection vector against Postgres functions.
- Input is **allowlisted**: `environment` is coerced to `live`/`test`, names are
  length-capped, usernames are constrained by a `CHECK` regex in the schema.

## Social sign-in (Google, GitHub, Apple, Steam)

- **Google, GitHub, Apple** use Supabase's native OAuth (`signInWithOAuth`).
  Enable each in the dashboard (Authentication → Providers) and paste that
  provider's client id + secret there — nothing lands in the repo. The callback
  redirects to `console.html`, where supabase-js completes the session.
  - Apple ("iOS") requires an Apple Developer account: a Services ID, a Sign in
    with Apple key, and `https://<ref>.supabase.co/auth/v1/callback` as the
    return URL.
- **Steam** has no OAuth — it speaks OpenID 2.0 — so it goes through the
  `steam-auth` Edge Function (`supabase/functions/steam-auth/`). The function
  redirects to Steam, then **verifies Steam's signed assertion straight back
  against Steam** before trusting the steamid, and only then mints a Supabase
  session via a magic link. Deploy it with `verify_jwt = false` (it is the login
  entry, before any session exists) and set `ALLOWED_ORIGIN` (and optionally
  `STEAM_WEB_API_KEY` for the player's name). Trade-offs to know: Steam returns
  no email, so the account uses a stable synthetic identity
  (`steam_<id>@steam.local`); this flow needs one end-to-end test once the
  project is live.

## The client guard is not the security boundary

`console.js` hides the console and redirects signed-out visitors. That is UX
only. The actual authorization boundary is RLS in the database: even a user who
bypasses the redirect and calls the API directly sees nothing that isn't theirs.

## Setup (owner only)

1. Create a project at [supabase.com](https://supabase.com).
2. **Apply the schema:** with the [Supabase CLI](https://supabase.com/docs/guides/cli),
   run `supabase link --project-ref <ref>` then `supabase db push`
   (or paste `supabase/migrations/0001_init.sql` into the SQL editor).
3. **Deploy the functions:**
   `supabase functions deploy issue-api-key` and
   `supabase functions deploy steam-auth --no-verify-jwt`, then set secrets:
   `supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<key> ALLOWED_ORIGIN=https://runinback.com`
   (add `STEAM_WEB_API_KEY=<key>` for Steam names; `SUPABASE_URL` and
   `SUPABASE_ANON_KEY` are injected automatically).
4. **Enable social providers** in Authentication → Providers (Google, GitHub,
   Apple) with each provider's client id + secret. Steam needs nothing here.
5. **Wire the site:** put your project URL and anon key into `supabase-config.js`
   (both are public/safe). Redeploy on Vercel.
6. In Supabase Auth settings, add your domain + `console.html` to the allowed
   redirect URLs.

Never commit `.env` (it is git-ignored); `.env.example` shows the shape.
