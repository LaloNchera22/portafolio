# Runinback

The trustless, skill-based wagering layer for competitive gaming: casual
multiplayer games, 1v1 challenges and tournaments with escrowed stakes in
**rcoin** (1 rcoin = 1 USD; 5% fee on the way in, none on the way out).

> **Test mode.** Balances are an off-chain test ledger. Real funds will be
> non-custodial on Base after contracts are audited and legal review clears rcoin.

## Stack

| Layer | Technology |
|-------|------------|
| Web | Vanilla ES modules, multi-page, bundled by **Vite** |
| Hosting | **Vercel** (static `dist/`, security headers in `vercel.json`) |
| Backend | **Supabase**: Postgres + RLS, SECURITY DEFINER RPCs, Realtime, Auth |
| Server code | Supabase **Edge Functions** (Deno): Stripe, Coinbase Commerce, Steam, API keys |
| Quality | ESLint, Vitest, SQL regression suite, GitHub Actions |

## Getting started

```bash
nvm use            # Node 22 (see .nvmrc)
npm ci
cp .env.example .env   # fill SUPABASE_URL + SUPABASE_ANON_KEY (public values only)
npm run dev        # http://localhost:5173
```

| Script | What it does |
|--------|--------------|
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build |
| `npm run lint` | ESLint |
| `npm test` | Unit + game-rule property tests (Vitest) |
| `npm run test:db` | Apply all migrations to a scratch Postgres and run the RPC regression suite (`PSQL=...`) |
| `npm run test:e2e` | Playwright journeys (desktop + mobile) against the production build with a mocked Supabase |
| `npm run check` | lint + test + build |

## Repository layout

```
src/                  HTML pages (one Vite entry each)
  scripts/
    entries/          one entry module per page type (marketing, static, console)
    lib/              config, Supabase client, DOM, formatting, errors
    auth/             login / signup forms, account nav
    site/             marketing-site interactions
    console/          dashboard: navigation, wallet, challenges, tournaments, profile, developer
    games/            engine + catalog (pure rules per game) + how-to-play copy
  styles/             site, console and games CSS
public/               unhashed static assets (icons, logos, media, robots, sitemap)
supabase/
  migrations/         forward-only SQL migrations
  functions/          Edge Functions (Deno)
  tests/              SQL regression suite + platform stub
tests/unit/           Vitest suites
scripts/              maintenance scripts
docs/                 architecture, design system
```

See [docs/architecture.md](docs/architecture.md) for how the pieces fit,
[CONTRIBUTING.md](CONTRIBUTING.md) for branch and commit conventions, and
[SECURITY.md](SECURITY.md) for the security model and deployment checklist.
