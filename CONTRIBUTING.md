# Contributing

Everything in this repository — code, identifiers, DOM ids, SQL, error
messages, comments, commits and branch names — is written in **English**.

## Branches

`main` is always deployable and protected: changes land only through pull
requests with a green CI.

Branch names are `<type>/<short-kebab-description>`:

| Type | Use for |
|------|---------|
| `feat/` | New user-facing capability (`feat/tournament-brackets`) |
| `fix/` | Bug fix (`fix/memory-bot-duplicate-pick`) |
| `refactor/` | Behavior-preserving restructuring (`refactor/split-console-modules`) |
| `perf/` | Performance work |
| `security/` | Security hardening (`security/steam-assertion-validation`) |
| `db/` | Schema or RPC migrations (`db/ledger-partitioning`) |
| `ci/`, `build/` | Pipeline and tooling |
| `docs/`, `chore/` | Documentation and housekeeping |

No personal, tool-generated or random suffixes (`claude/project-thread-x1y2`,
`jules-123…`). Delete the branch after merge (enable "Automatically delete head
branches" in the GitHub settings).

## Commits

[Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`
in the imperative, ≤ 72 characters, e.g. `fix(wallet): floor the purchase quote like the backend`.
Scopes: `web`, `console`, `games`, `auth`, `db`, `functions`, `ci`, `docs`.

## Pull requests

- Keep them focused: one concern per PR.
- `npm run check` must pass locally; CI also runs the database suite and
  `deno check` on the Edge Functions.
- Database changes: add a **new** migration (never edit a shipped one), keep it
  idempotent, use `using hint = '<code>'` for every user-facing error and map the
  hint in `src/scripts/lib/errors.js`, and extend `supabase/tests/rpc-smoke.test.sql`.
- Staked games: a game may be added to `STAKEABLE_GAME_IDS` only together with
  the matching allow-list change in `rib_game_create`.

## Code conventions

- ES modules only; no globals on `window`.
- Escape every interpolated value with `escapeHtml` when building HTML strings,
  or prefer `textContent`.
- Money is always integer cents; format only at the edge (`lib/format.js`).
- Never trust the client for money: balances move only inside SECURITY DEFINER
  RPCs that call `rib_apply`.
