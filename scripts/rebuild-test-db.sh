#!/usr/bin/env bash
# Drops and rebuilds the throwaway validation database from db/sql/*.sql.
set -euo pipefail
# PGHOST is the standard name and what check-drift.ts reads; PGSOCK is kept as
# a fallback for local setups that already set it.
PSQL=(psql -h "${PGHOST:-${PGSOCK:-/run/pgt}}" -p "${PGPORT:-5433}" -U "${PGSUPERUSER:-postgres}" -v ON_ERROR_STOP=1 -q)
"${PSQL[@]}" -c "DROP DATABASE IF EXISTS helm WITH (FORCE);" postgres
"${PSQL[@]}" -c "CREATE DATABASE helm;" postgres
for f in db/sql/*.sql; do
  printf '  -> %s\n' "$(basename "$f")"
  "${PSQL[@]}" -f "$f" helm
done
echo "=== all migrations applied ==="
