#!/usr/bin/env bash
# Rebuild the validation database, load fixtures, run the security suite.
set -euo pipefail
SOCK="${PGHOST:-${PGSOCK:-/run/pgt}}"; PORT="${PGPORT:-5433}"
./scripts/rebuild-test-db.sh > /dev/null
psql -h "$SOCK" -p "$PORT" -U "${PGSUPERUSER:-postgres}" -v ON_ERROR_STOP=1 -q -f db/tests/_assert.sql helm
psql -h "$SOCK" -p "$PORT" -U "${PGSUPERUSER:-postgres}" -v ON_ERROR_STOP=1 -q -f db/tests/fixtures.sql helm
psql -h "$SOCK" -p "$PORT" -U helm_app -v ON_ERROR_STOP=1 -f db/tests/security.sql helm 2>&1 \
  | grep -E '^(NOTICE|ERROR|==|psql.*(NOTICE|ERROR))' \
  | sed -E 's/^psql:[^:]+:[0-9]+: //'
psql -h "$SOCK" -p "$PORT" -U "${PGSUPERUSER:-postgres}" -v ON_ERROR_STOP=1 -f db/tests/tamper.sql helm 2>&1 \
  | grep -E '^(psql.*(NOTICE|ERROR)|==)' \
  | sed -E 's/^psql:[^:]+:[0-9]+: //'
