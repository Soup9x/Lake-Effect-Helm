#!/usr/bin/env bash
# =============================================================================
# Lake Effect Helm — the host updater
#
# Installs an update somebody asked for on Administration → Updates. Run once a
# minute, as root, by the helm-updater systemd timer that deploy/setup.sh
# installs; setup.sh copies this file to /usr/local/sbin/helm-updater and
# passes the checkout's path in HELM_REPO_ROOT.
#
# Each run:
#
#   1. Says it is alive (helm_updater.last_seen_at), so the page knows a
#      request will be picked up and offers the button.
#   2. Takes the oldest due request, if any, and marks it running.
#   3. Fetches the branch named in .env (HELM_UPDATE_BRANCH, default main) and
#      refuses the requested commit unless it is on that branch.
#   4. Fast-forwards the checkout to it, as the checkout's owner.
#   5. Runs ./deploy/setup.sh --yes, which keeps every answer already in .env,
#      and copies the tail of its output into the request as it goes.
#   6. Records succeeded or failed.
#
# WHY THIS IS ON THE HOST AND NOT IN A CONTAINER. Rebuilding the stack needs
# the Docker socket and the checkout, and anything holding the socket is root
# on this machine. The web tier holds decrypted credentials and talks to the
# internet; it must not also be able to do that. This script reads one table
# through `docker compose exec postgres psql` and accepts a commit hash from
# it, nothing more: no command, no branch and no remote comes from the
# database.
#
# Running it by hand is fine: `sudo HELM_REPO_ROOT=/opt/lake-effect-helm
# /usr/local/sbin/helm-updater`. It does nothing when nothing is due.
# =============================================================================
set -euo pipefail

REPO_ROOT=${HELM_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}
cd "$REPO_ROOT"

LOCK=/run/lock/helm-updater.lock
LOG_DIR=/var/log/helm-updater
mkdir -p "$(dirname "$LOCK")"

# One at a time. A run that is still installing holds this for the whole
# install, so the timer's next tick simply exits.
exec 9>"$LOCK"
flock -n 9 || exit 0

[ -f docker-compose.yml ] || { echo "helm-updater: $REPO_ROOT is not a Helm checkout" >&2; exit 1; }

# psql inside the postgres container, as the superuser, reading the script
# from stdin so `-v` variables are interpolated (:'name' quotes them safely —
# nothing from the database or git is ever pasted into SQL text).
sql() {
  local script=$1; shift
  printf '%s\n' "$script" | docker compose exec -T postgres \
    sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -U postgres -d helm -X -q -t -A -v ON_ERROR_STOP=1 "$@"' sh "$@"
}

env_value() {
  [ -f .env ] || return 0
  awk -v k="$1" 'index($0, k "=") == 1 { v = substr($0, length(k) + 2); gsub(/^"|"$/, "", v); print v; exit }' .env
}

# --- 1. alive ----------------------------------------------------------------
# Quietly nothing when the stack is down or 1210 has not been applied yet:
# there is nobody to tell and nothing to do.
sql "INSERT INTO helm_updater (id, last_seen_at, host) VALUES (1, now(), :'host')
     ON CONFLICT (id) DO UPDATE SET last_seen_at = now(), host = EXCLUDED.host;" \
  -v host="$(hostname 2>/dev/null || echo unknown)" >/dev/null 2>&1 || exit 0

# A request left 'running' belongs to a run that died — the host rebooted, or
# the unit was stopped. We hold the lock, so no live run owns it.
sql "UPDATE helm_update SET status = 'failed', finished_at = now(),
            error = 'The updater stopped before this finished (the server restarted, or the updater was stopped). Check the version on the Updates page, and run sudo ./deploy/setup.sh on the server if it did not complete.'
      WHERE status = 'running';" >/dev/null

# --- 2. anything due? --------------------------------------------------------
claimed=$(sql "UPDATE helm_update SET status = 'running', started_at = now(), stage = 'Fetching'
                WHERE id = (SELECT id FROM helm_update
                             WHERE status = 'scheduled' AND scheduled_for <= now()
                             ORDER BY scheduled_for LIMIT 1 FOR UPDATE SKIP LOCKED)
            RETURNING id || ' ' || target_commit;")
[ -n "$claimed" ] || exit 0
read -r id target <<< "$claimed"

mkdir -p "$LOG_DIR"
chmod 0700 "$LOG_DIR"
log_file="$LOG_DIR/$(date -u +%Y%m%dT%H%M%SZ)-${id}.log"
: > "$log_file"

stage() {
  sql "UPDATE helm_update SET stage = :'stage' WHERE id = :'id';" -v id="$id" -v stage="$1" >/dev/null || true
}
push_log() {
  sql "UPDATE helm_update SET log = :'log' WHERE id = :'id';" \
    -v id="$id" -v log="$(tail -c 60000 "$log_file")" >/dev/null 2>&1 || true
}
finish() {
  local status=$1 error=${2:-}
  local head
  head=$(as_owner git rev-parse HEAD 2>/dev/null || true)
  # setup.sh may have just recreated the postgres container, so keep trying
  # for a couple of minutes rather than leave the request saying "running".
  local attempt
  for attempt in $(seq 1 24); do
    if sql "UPDATE helm_update
               SET status = :'status', finished_at = now(), stage = NULL,
                   to_commit = nullif(:'head', ''), error = nullif(:'error', ''), log = :'log'
             WHERE id = :'id';" \
         -v id="$id" -v status="$status" -v head="$head" -v error="${error:0:1900}" \
         -v log="$(tail -c 60000 "$log_file")" >/dev/null 2>&1; then
      return 0
    fi
    sleep 5
  done
  echo "helm-updater: could not record the result of update $id" >&2
}

# git runs as whoever owns the checkout. Run as root, a fetch leaves root-owned
# objects in .git and the next `git pull` by the person who normally runs it
# fails with "insufficient permission".
owner=$(stat -c %U "$REPO_ROOT")
as_owner() {
  if [ "$owner" = root ]; then "$@"; else runuser -u "$owner" -- "$@"; fi
}

fail() {
  printf '\nhelm-updater: %s\n' "$1" >> "$log_file"
  finish failed "$1"
  exit 1
}

# --- 3. fetch and check the commit ------------------------------------------
branch=$(env_value HELM_UPDATE_BRANCH); branch=${branch:-main}
from=$(as_owner git rev-parse HEAD 2>>"$log_file") || fail "this is not a git checkout"
sql "UPDATE helm_update SET from_commit = :'from' WHERE id = :'id';" -v id="$id" -v from="$from" >/dev/null || true

printf '$ git fetch origin %s\n' "$branch" >> "$log_file"
as_owner git fetch --quiet origin "$branch" >> "$log_file" 2>&1 \
  || fail "could not fetch $branch from GitHub (see the log below)"

as_owner git cat-file -e "${target}^{commit}" 2>/dev/null \
  || fail "commit ${target:0:7} is not on origin/$branch"
as_owner git merge-base --is-ancestor "$target" "origin/$branch" \
  || fail "commit ${target:0:7} is not on origin/$branch, so it was not installed"

# --- 4. fast-forward ---------------------------------------------------------
if [ "$from" != "$target" ]; then
  stage 'Pulling'
  printf '$ git merge --ff-only %s\n' "${target:0:7}" >> "$log_file"
  as_owner git merge --ff-only "$target" >> "$log_file" 2>&1 \
    || fail "the checkout on the server has changes of its own, so it could not be moved to ${target:0:7}. Run git status in $REPO_ROOT."
fi

# --- 5. setup.sh -------------------------------------------------------------
stage 'Building and restarting'
printf '\n$ ./deploy/setup.sh --yes\n' >> "$log_file"
./deploy/setup.sh --yes >> "$log_file" 2>&1 &
setup_pid=$!
# Copy the tail into the request every few seconds so the page can show it.
# The web service restarts part way through; the page waits for it.
while kill -0 "$setup_pid" 2>/dev/null; do
  sleep 5
  push_log
done
if wait "$setup_pid"; then
  finish succeeded
else
  fail "setup.sh did not finish (see the log below). The code was updated to ${target:0:7}; fix the problem and run sudo ./deploy/setup.sh on the server."
fi
