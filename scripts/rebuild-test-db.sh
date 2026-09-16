#!/usr/bin/env bash
# Drops and rebuilds the throwaway validation database from db/sql/*.sql.
set -euo pipefail

# ---------------------------------------------------------------------------
# This script DROPS a database called `helm`. So does the compose stack's
# POSTGRES_DB. A provisioned deployment and a developer's test cluster use the
# same database name, and the operational runbook used to tell operators to run
# the test suite as a post-install check — on the host serving it.
#
# `.env` is written by deploy/init-secrets.sh and by nothing else, so its
# presence means this checkout provisions a deployment. A developer's checkout
# uses .env.local and is unaffected. Set HELM_ALLOW_DESTRUCTIVE_TESTS=1 if you
# genuinely mean it.
# ---------------------------------------------------------------------------
if [ -f "$(dirname "$0")/../.env" ] && [ "${HELM_ALLOW_DESTRUCTIVE_TESTS:-}" != "1" ]; then
  cat >&2 <<'REFUSE'

REFUSING: this checkout has a .env, so deploy/init-secrets.sh provisioned a
deployment here. This script runs:

    DROP DATABASE IF EXISTS helm WITH (FORCE)

and the deployment's database is also called `helm`.

Run the test suite on a development machine against a throwaway cluster. If
this really is a development checkout that happens to have a .env, re-run with
HELM_ALLOW_DESTRUCTIVE_TESTS=1.

REFUSE
  exit 1
fi

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
