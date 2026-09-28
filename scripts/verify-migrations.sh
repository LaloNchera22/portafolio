#!/usr/bin/env bash
# Apply every migration to an EMPTY scratch Postgres, re-apply the latest one
# (idempotency), then run the SQL regression suite.
#
# Usage:
#   PSQL="psql postgresql://postgres:postgres@localhost:5432/postgres" scripts/verify-migrations.sh
#   PSQL="docker exec -i rib-pg psql -U postgres -d rib" scripts/verify-migrations.sh
#
# Never point this at a real Supabase project: it creates stub roles and users.
set -euo pipefail

PSQL="${PSQL:-psql}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
run() { { echo "set client_min_messages = warning;"; cat "$1"; } | $PSQL -q -v ON_ERROR_STOP=1 > /dev/null; }

echo "→ platform stub"
run "$ROOT/supabase/tests/platform-stub.sql"

latest=""
for migration in "$ROOT"/supabase/migrations/*.sql; do
  echo "→ $(basename "$migration")"
  run "$migration"
  latest="$migration"
done

echo "→ re-apply $(basename "$latest") (must be idempotent)"
run "$latest"

echo "→ regression suite"
if ! output=$($PSQL -v ON_ERROR_STOP=1 < "$ROOT/supabase/tests/rpc-smoke.test.sql" 2>&1); then
  echo "$output"
  exit 1
fi
echo "$output" | grep -E "pass:|all expectations" | sed -E 's/^.*NOTICE: +/  /'
