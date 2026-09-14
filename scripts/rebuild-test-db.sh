#!/usr/bin/env bash
# Drops and rebuilds the throwaway validation database from db/sql/*.sql.
set -euo pipefail
PSQL=(psql -h "${PGSOCK:-/run/pgt}" -p "${PGPORT:-5433}" -U postgres -v ON_ERROR_STOP=1 -q)
"${PSQL[@]}" -c "DROP DATABASE IF EXISTS helm WITH (FORCE);" postgres
"${PSQL[@]}" -c "CREATE DATABASE helm;" postgres
for f in db/sql/*.sql; do
  printf '  -> %s\n' "$(basename "$f")"
  "${PSQL[@]}" -f "$f" helm
done
echo "=== all migrations applied ==="
