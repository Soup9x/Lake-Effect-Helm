#!/usr/bin/env bash
# =============================================================================
# Lake Effect Helm — turnkey on-premises setup
#
#   sudo ./deploy/setup.sh
#
# Runs the five steps of a first install in order, checking as it goes:
#
#   1. Preflight   Docker, Compose, versions, permissions, ports, disk
#   2. Secrets     ./deploy/init-secrets.sh — master key ring and .env
#   3. Configure   the address people will type, written into .env
#   4. Start       build, then `docker compose up -d --wait`
#   5. Bootstrap   the first tenant, administrator and data key
#
# WHAT THIS SCRIPT WILL NOT DO, by design:
#
#   * Overwrite an existing master key. That is unrecoverable — every
#     credential in the database becomes ciphertext nobody can read — so the
#     script detects an existing install and skips ahead instead.
#   * Destroy a volume, drop a database, or force anything. Every destructive
#     operation stays a deliberate act you type yourself.
#   * Configure TLS trust or SSO. Those are §6 and §5.2 of
#     docs/deployment/docker-on-prem.md and need decisions this script cannot
#     make for you.
#
# Safe to re-run. A second run detects what is already done, skips it, and
# picks up wherever the first one stopped.
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$PWD"
ENV_FILE="$REPO_ROOT/.env"
KEY_FILE="$REPO_ROOT/deploy/secrets/master.key"

# The uid baked into the runtime image. The master key must be readable by
# exactly this user; Helm refuses to start otherwise.
HELM_UID=10001

# Minimums. Compose v2.20 is the real floor: the stack gates the web tier on
# `service_completed_successfully`, which earlier versions do not understand.
MIN_DOCKER=24.0
MIN_COMPOSE=2.20

# --- Non-interactive overrides ----------------------------------------------
# Any value supplied here skips its prompt, so the script can run from a
# provisioning tool. Anything left unset is asked for.
OPT_HOST=""
OPT_TENANT=""
OPT_SLUG=""
OPT_ADMIN_EMAIL=""
OPT_ADMIN_NAME=""
ASSUME_YES=0

# -----------------------------------------------------------------------------
# Output
# -----------------------------------------------------------------------------
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; BLUE=$'\033[34m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; BLUE=""; RESET=""
fi

step()  { printf '\n%s==> %s%s\n' "$BOLD$BLUE" "$*" "$RESET"; }
ok()    { printf '    %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
info()  { printf '    %s\n' "$*"; }
note()  { printf '    %s%s%s\n' "$DIM" "$*" "$RESET"; }
warn()  { printf '    %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
die()   { printf '\n%sFAILED:%s %s\n\n' "$BOLD$RED" "$RESET" "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Lake Effect Helm — turnkey on-premises setup

  sudo ./deploy/setup.sh [options]

Options (any supplied value skips its prompt):
  --host <name>            Address people will type, e.g. helm.internal.example.com
  --tenant <name>          MSP display name, e.g. "Northwind Managed Services"
  --slug <slug>            URL-safe MSP identifier, 3-40 chars [a-z0-9-]
  --admin-email <email>    First administrator's sign-in address
  --admin-name <name>      First administrator's display name
  --yes                    Do not pause for confirmation before starting
  -h, --help               This message

With every option supplied and --yes, the script runs unattended.

Run it from anywhere; it operates on the repository it lives in.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --host)        OPT_HOST=${2:?--host needs a value}; shift 2 ;;
    --tenant)      OPT_TENANT=${2:?--tenant needs a value}; shift 2 ;;
    --slug)        OPT_SLUG=${2:?--slug needs a value}; shift 2 ;;
    --admin-email) OPT_ADMIN_EMAIL=${2:?--admin-email needs a value}; shift 2 ;;
    --admin-name)  OPT_ADMIN_NAME=${2:?--admin-name needs a value}; shift 2 ;;
    --yes|-y)      ASSUME_YES=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    *)             usage >&2; die "unknown option: $1" ;;
  esac
done

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

# True when $1 >= $2, comparing dotted versions.
version_at_least() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n 1)" = "$2" ]
}

# Ask, with a default and a validation pattern. Re-asks until it matches.
# $1 prompt  $2 default (may be empty)  $3 ERE  $4 message shown on a bad answer
ask() {
  local prompt=$1 default=$2 pattern=$3 complaint=$4 answer=""
  while :; do
    if [ -n "$default" ]; then
      printf '    %s [%s]: ' "$prompt" "$default" > /dev/tty
    else
      printf '    %s: ' "$prompt" > /dev/tty
    fi
    IFS= read -r answer < /dev/tty || die "no input available; supply the value as a flag instead"
    [ -z "$answer" ] && answer=$default
    if [ -n "$answer" ] && printf '%s' "$answer" | grep -qE "$pattern"; then
      printf '%s' "$answer"
      return 0
    fi
    printf '    %s%s%s\n' "$YELLOW" "$complaint" "$RESET" > /dev/tty
  done
}

confirm() {
  [ "$ASSUME_YES" -eq 1 ] && return 0
  local answer=""
  printf '    %s [y/N]: ' "$1" > /dev/tty
  IFS= read -r answer < /dev/tty || return 1
  case "$answer" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

# Every secret this deployment has lives in .env, so rewriting it is the most
# dangerous thing this script does. The write is atomic: a temp file NEXT TO
# .env (same filesystem, so rename() is atomic), given .env's mode and owner,
# checked, and only then moved into place.
#
# The earlier form was `awk ... > tmp; cat tmp > "$ENV_FILE"`, which truncates
# .env and then refills it. Anything that interrupts the refill — a full disk,
# a signal, ^C — leaves a PREFIX of the file. HELM_PUBLIC_HOST and
# HELM_PUBLIC_URL are its first two lines, so the surviving prefix looks like a
# valid .env and every database password is gone. On a running deployment that
# is unrecoverable from the file alone.
#
# awk rather than sed: the value is never treated as a pattern or a template,
# so a URL full of slashes and ampersands cannot corrupt the file.
set_env() {
  local key=$1 value=$2 tmp
  tmp="${ENV_FILE}.tmp.$$"

  # Inherit .env's permissions BEFORE anything secret is written into it.
  : > "$tmp"
  chmod --reference="$ENV_FILE" "$tmp" 2>/dev/null || chmod 0600 "$tmp"
  chown --reference="$ENV_FILE" "$tmp" 2>/dev/null || true

  if ! KEY="$key" VALUE="$value" awk '
    BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VALUE"]; seen = 0 }
    index($0, k "=") == 1 { if (!seen) { print k "=" v; seen = 1 } ; next }
    { print }
    END { if (!seen) print k "=" v }
  ' "$ENV_FILE" > "$tmp"; then
    rm -f "$tmp"
    die "failed to rewrite $ENV_FILE (setting $key). The original is untouched."
  fi

  # A rewrite that lost lines means the write was short. Refuse it rather than
  # moving a truncated file over the real one.
  local before after
  before=$(grep -cE '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE" || true)
  after=$(grep -cE '^[A-Za-z_][A-Za-z0-9_]*=' "$tmp" || true)
  if [ "$after" -lt "$before" ]; then
    rm -f "$tmp"
    die "rewriting $ENV_FILE would have dropped variables ($before -> $after).
    Refusing, and the original is untouched. Check free disk space."
  fi

  mv -f "$tmp" "$ENV_FILE"
}

# The variables without which the stack cannot start. Echoes any that are
# missing or empty, one per line.
env_missing_secrets() {
  local k
  for k in AUTH_SECRET HELM_BLIND_INDEX_KEY_B64 \
           HELM_DB_PASSWORD_SUPERUSER HELM_DB_PASSWORD_APP \
           HELM_DB_PASSWORD_AUTH HELM_DB_PASSWORD_KEY_ADMIN \
           HELM_DB_PASSWORD_AUDITOR HELM_DB_PASSWORD_WORKER; do
    [ -n "$(get_env "$k" 2>/dev/null || true)" ] || printf '%s\n' "$k"
  done
}

get_env() {
  [ -f "$ENV_FILE" ] || return 1
  KEY="$1" awk 'BEGIN{k=ENVIRON["KEY"]} index($0,k"=")==1 { print substr($0, length(k)+2); exit }' "$ENV_FILE"
}

# 0 = in use, 1 = free, 2 = could not tell.
#
# The third case matters: a minimal host may have neither ss nor netstat, and
# reporting "free" when the answer is unknown is worse than saying nothing —
# the operator trusts it and then hits a bind failure from Caddy.
port_in_use() {
  local port=$1 hex files=()

  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${port}$" && return 0
    return 1
  fi
  if command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${port}$" && return 0
    return 1
  fi

  # No tools; read the kernel directly. /proc/net/tcp lists the local address
  # as HEX:HEX and state 0A is LISTEN. tcp6 is absent when IPv6 is disabled.
  [ -r /proc/net/tcp ]  && files+=(/proc/net/tcp)
  [ -r /proc/net/tcp6 ] && files+=(/proc/net/tcp6)
  [ ${#files[@]} -gt 0 ] || return 2

  hex=$(printf '%04X' "$port")
  awk -v hex="$hex" '$4 == "0A" && substr($2, length($2) - 3) == hex { found = 1 }
                     END { exit found ? 0 : 1 }' "${files[@]}" && return 0
  return 1
}

# psql inside the postgres container.
#
# PGPASSWORD is not optional here: the stack initialises Postgres with
# --auth-local=scram-sha-256, so even a socket connection as the superuser
# needs a password. Taking it from the container's own POSTGRES_PASSWORD keeps
# the credential off this script's command line and out of the host's history.
psql_in_container() {
  docker compose exec -T postgres \
    sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U postgres -d helm -tAc "$0"' "$1"
}

# -----------------------------------------------------------------------------
# 1. Preflight
# -----------------------------------------------------------------------------
preflight() {
  step "1/5  Preflight"

  [ "$(id -u)" -eq 0 ] || die "run this with sudo. The master key must be chowned to uid ${HELM_UID}, which needs root."
  ok "running as root"

  [ -f "$REPO_ROOT/docker-compose.yml" ] || die "docker-compose.yml not found in $REPO_ROOT — is this the Helm repository?"
  [ -x "$REPO_ROOT/deploy/init-secrets.sh" ] || die "deploy/init-secrets.sh is missing or not executable"
  ok "repository layout looks right"

  command -v docker >/dev/null 2>&1 || die "docker is not installed. See docs/deployment/docker-on-prem.md §1.1."

  local docker_version
  docker_version=$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)
  [ -n "$docker_version" ] || die "the Docker daemon is not reachable. Is it running, and can this user talk to it?"
  version_at_least "$docker_version" "$MIN_DOCKER" \
    || die "Docker $docker_version is too old; $MIN_DOCKER or newer is required."
  ok "Docker $docker_version"

  local compose_version
  compose_version=$(docker compose version --short 2>/dev/null || true)
  if [ -z "$compose_version" ]; then
    die "Docker Compose v2 is not available.
    If you have the old \`docker-compose\` (with a hyphen), that is v1 and will
    not work: it does not understand the depends_on conditions this stack uses
    to gate the web tier on migrations. Install the Compose v2 plugin."
  fi
  version_at_least "$compose_version" "$MIN_COMPOSE" \
    || die "Docker Compose $compose_version is too old; $MIN_COMPOSE or newer is required."
  ok "Docker Compose $compose_version"

  command -v openssl >/dev/null 2>&1 || die "openssl is required to generate keys."
  ok "openssl present"

  local avail_kb
  avail_kb=$(df -Pk "$REPO_ROOT" | awk 'NR==2 {print $4}')
  if [ "${avail_kb:-0}" -lt 20971520 ]; then
    warn "less than 20 GB free on $(df -Ph "$REPO_ROOT" | awk 'NR==2 {print $6}') — images alone are about 2 GB"
  else
    ok "$((avail_kb / 1048576)) GB free"
  fi

  # Ports are checked against what .env asks for, which may not be 80/443.
  local http_port https_port
  http_port=$(get_env HELM_HTTP_PORT 2>/dev/null || true); http_port=${http_port:-80}
  https_port=$(get_env HELM_HTTPS_PORT 2>/dev/null || true); https_port=${https_port:-443}
  local clash=0 unknown=0 rc
  for p in "$http_port" "$https_port"; do
    rc=0; port_in_use "$p" || rc=$?
    case "$rc" in
      0) warn "something is already listening on port $p"; clash=1 ;;
      2) unknown=1 ;;
    esac
  done
  if [ "$clash" -eq 1 ]; then
    note "Caddy will fail to bind. Stop the other service, or set HELM_HTTP_PORT"
    note "and HELM_HTTPS_PORT in .env and re-run."
    confirm "Continue anyway?" || die "stopped so you can free the ports."
  elif [ "$unknown" -eq 1 ]; then
    warn "could not check whether ports $http_port and $https_port are free"
    note "No ss, netstat or /proc/net/tcp on this host. If they are taken,"
    note "Caddy will say so when it tries to bind."
  else
    ok "ports $http_port and $https_port are free"
  fi
}

# -----------------------------------------------------------------------------
# 2. Secrets
# -----------------------------------------------------------------------------
secrets() {
  step "2/5  Keys and passwords"

  if [ -e "$KEY_FILE" ] && [ -e "$ENV_FILE" ]; then
    # Existence is not provisioning. A .env that exists but has lost its
    # secrets passes this step happily and then fails in phase 4 with forty
    # lines of compose interpolation errors that name the symptom and not the
    # cause. Check the contents here, where the remedy is obvious.
    local missing
    missing=$(env_missing_secrets)
    if [ -n "$missing" ]; then
      printf '\n'
      warn "$ENV_FILE exists but is missing values it must have:"
      printf '%s\n' "$missing" | sed 's/^/        /'
      printf '\n'
      die "this .env is incomplete — most likely a rewrite was interrupted.

    If NO database has started yet, nothing is encrypted and it is safe to
    start over:

        docker compose down -v
        rm -f '$ENV_FILE' '$KEY_FILE'
        sudo ./deploy/setup.sh

    If Helm HAS stored anything, do NOT delete the master key: it is the only
    thing that can read the database. Restore .env from your backup instead,
    or recover the passwords from the running postgres volume.
    See docs/deployment/docker-on-prem.md §7."
    fi
    ok "already provisioned — leaving the master key and .env untouched"
    note "Overwriting the master key would make every stored credential"
    note "permanently unreadable, so this step never runs twice."
  elif [ -e "$KEY_FILE" ] || [ -e "$ENV_FILE" ]; then
    # One without the other means a half-finished or hand-edited install. The
    # script must not guess which half is authoritative.
    die "found one of deploy/secrets/master.key and .env but not the other.
    That is a half-finished install, and guessing wrong here destroys data.
    Sort it out by hand, then re-run. See docs/deployment/docker-on-prem.md §2."
  else
    info "generating the master key ring and every database password..."
    "$REPO_ROOT/deploy/init-secrets.sh" >/dev/null
    local born_missing
    born_missing=$(env_missing_secrets)
    [ -z "$born_missing" ] || die "init-secrets.sh finished but $ENV_FILE is missing:
$(printf '%s\n' "$born_missing" | sed 's/^/        /')
    Check free disk space, then remove '$ENV_FILE' and '$KEY_FILE' and re-run."
    ok "wrote deploy/secrets/master.key (0400, uid ${HELM_UID}) and .env (0600)"
  fi

  # Verify rather than assume — a key file the container cannot read stops the
  # web tier dead, with an error that reads like a bug.
  local mode owner
  mode=$(stat -c '%a' "$KEY_FILE")
  owner=$(stat -c '%u' "$KEY_FILE")
  [ "$mode" = "400" ] || die "deploy/secrets/master.key is mode $mode; it must be 400. Run: chmod 0400 '$KEY_FILE'"
  [ "$owner" = "$HELM_UID" ] || die "deploy/secrets/master.key is owned by uid $owner; it must be $HELM_UID. Run: chown $HELM_UID:$HELM_UID '$KEY_FILE'"
  ok "master key permissions verified (0400, uid $owner)"

  printf '\n'
  warn "BACK UP deploy/secrets/master.key AND .env, OFF THIS HOST, ENCRYPTED."
  note "Without the master key the database is ciphertext nobody can read."
  note "There is no recovery path — that is the design. See §7.3."
}

# -----------------------------------------------------------------------------
# 3. Configure
# -----------------------------------------------------------------------------
configure() {
  step "3/5  Address"

  local current host
  current=$(get_env HELM_PUBLIC_HOST 2>/dev/null || true)

  if [ -n "$OPT_HOST" ]; then
    host=$OPT_HOST
    printf '%s' "$host" | grep -qE '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$' \
      || die "--host '$host' is not a hostname or IP address"
  else
    info "The address technicians will type. It must match the certificate and"
    info "what appears in the browser's address bar."
    note "A hostname is strongly preferred over a bare IP: Entra SSO will not"
    note "accept a redirect URI on an IP, and re-addressing the host later"
    note "means editing .env rather than updating DNS. See §6.3."
    printf '\n'
    host=$(ask "Public hostname" \
                "${current:-helm.internal.example.com}" \
                '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$' \
                "That is not a hostname or IP address.")
  fi

  local https_port url
  https_port=$(get_env HELM_HTTPS_PORT 2>/dev/null || true); https_port=${https_port:-443}
  if [ "$https_port" = "443" ]; then
    url="https://${host}"
  else
    # AUTH_URL is derived from this, and an Auth.js callback that disagrees
    # with the address bar fails in a way that is tedious to diagnose.
    url="https://${host}:${https_port}"
  fi

  set_env HELM_PUBLIC_HOST "$host"
  set_env HELM_PUBLIC_URL  "$url"

  ok "HELM_PUBLIC_HOST=$host"
  ok "HELM_PUBLIC_URL=$url"
}

# -----------------------------------------------------------------------------
# 4. Start
# -----------------------------------------------------------------------------
start_stack() {
  step "4/5  Build and start"

  if [ "$ASSUME_YES" -eq 0 ]; then
    info "About to build two images and start postgres, migrate, web, worker and caddy."
    info "The first build takes a few minutes."
    confirm "Go ahead?" || die "stopped before building. Nothing has been started."
  fi

  # Build separately from `up` so build time is visible as build time, and so
  # the --wait timeout below measures only how long health takes.
  info "building images..."
  docker compose build || die "image build failed — the output above says why."
  ok "images built"

  info "starting the stack and waiting for every service to report healthy..."
  if ! docker compose up -d --wait --wait-timeout 300; then
    printf '\n'
    docker compose ps || true
    printf '\n'
    warn "not everything came up healthy. Recent logs:"
    docker compose logs --tail 40 postgres migrate web worker caddy 2>/dev/null || true
    die "startup failed. docs/deployment/docker-on-prem.md §9 maps the common symptoms."
  fi

  ok "every service healthy"
  printf '\n'
  docker compose ps
}

# -----------------------------------------------------------------------------
# 5. Bootstrap
# -----------------------------------------------------------------------------
bootstrap() {
  step "5/5  First tenant and administrator"

  # Already bootstrapped? Then say so rather than letting the bootstrap command
  # refuse with an error that reads like a failure.
  local tenants
  tenants=$(psql_in_container "SELECT count(*) FROM tenant" 2>/dev/null | tr -d '[:space:]' || true)
  if [ -n "$tenants" ] && [ "$tenants" != "0" ]; then
    ok "already bootstrapped ($tenants tenant(s)) — skipping"
    note "Add further tenants and users through the application, not this script."
    return 0
  fi

  local tenant slug admin_email admin_name
  if [ -n "$OPT_TENANT" ]; then tenant=$OPT_TENANT; else
    info "The MSP that owns this deployment — your own company."
    printf '\n'
    tenant=$(ask "MSP name" "" '^.{2,}$' "Give it at least two characters.")
  fi

  if [ -n "$OPT_SLUG" ]; then slug=$OPT_SLUG; else
    # Offer a slug derived from the name; it appears in URLs, so a loose one
    # becomes a support call the first time somebody types a capital letter.
    local suggested
    suggested=$(printf '%s' "$tenant" | tr '[:upper:]' '[:lower:]' \
                | sed 's/[^a-z0-9]\+/-/g; s/^-//; s/-$//' | cut -c1-40 | sed 's/-$//')
    slug=$(ask "URL slug" "$suggested" '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' \
                "3-40 characters, lowercase letters, digits and hyphens, not starting or ending with a hyphen.")
  fi

  if [ -n "$OPT_ADMIN_EMAIL" ]; then admin_email=$OPT_ADMIN_EMAIL; else
    printf '\n'
    info "The first administrator. If you later enable Entra SSO, this address"
    info "must match the one Entra asserts for that person."
    printf '\n'
    admin_email=$(ask "Administrator email" "" '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' \
                       "That does not look like an email address.")
  fi

  if [ -n "$OPT_ADMIN_NAME" ]; then admin_name=$OPT_ADMIN_NAME; else
    admin_name=$(ask "Administrator name" "$admin_email" '^.{1,}$' "Give a name.")
  fi

  printf '\n'
  info "Creating the tenant, the administrator, their membership, a local"
  info "password, and minting the tenant's first data key through the KEK provider."
  printf '\n'

  # No -T when there is a terminal, so the printed password renders as intended.
  local tty_flag=()
  [ -t 1 ] || tty_flag=(-T)

  docker compose --profile bootstrap run --rm "${tty_flag[@]}" bootstrap \
    --tenant "$tenant" \
    --slug "$slug" \
    --admin-email "$admin_email" \
    --admin-name "$admin_name" \
    || die "bootstrap failed — the output above says why."
}

# -----------------------------------------------------------------------------
# Finish
# -----------------------------------------------------------------------------
finish() {
  local host url tls
  host=$(get_env HELM_PUBLIC_HOST); url=$(get_env HELM_PUBLIC_URL)
  tls=$(get_env HELM_TLS_DIRECTIVE 2>/dev/null || true)

  step "Done"
  info "Helm is running at ${BOLD}${url}${RESET}"
  printf '\n'

  # With the default internal CA there is one step left before a browser will
  # trust it, and it is the most common reason a fresh install "does not work".
  if [ -z "$tls" ] || [ "$tls" = "tls internal" ]; then
    if docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt \
         "$REPO_ROOT/helm-root.crt" >/dev/null 2>&1; then
      ok "exported Caddy's root certificate to ./helm-root.crt"
      info "Install it as a trusted root on every machine that will use Helm,"
      info "or browsers will warn on every visit. Commands per OS: §6.1."
    else
      warn "could not export Caddy's root certificate; see §6.1 to do it by hand"
    fi
    printf '\n'
  fi

  cat <<NEXT
    Next:

      1. Trust the certificate (above), then open ${url}/sign-in
         and sign in with the password printed a moment ago. Helm will
         insist you change it.

      2. Make sure ${host} resolves on your network — internal DNS A
         record, or a hosts entry on each machine.                      §6.1

      3. Back up deploy/secrets/master.key and .env, off this host,
         encrypted. Then set up the nightly job.                        §7

      4. Optional: wire Microsoft Entra ID for SSO — on-premises.md §5.1.
         Keep the local password working too: it is what gets you in
         when Entra cannot be reached.              docker-on-prem.md §5.2

    Full reference: docs/deployment/docker-on-prem.md
NEXT
  printf '\n'
}

# -----------------------------------------------------------------------------
main() {
  printf '%s\n' "$BOLD"
  printf 'Lake Effect Helm — on-premises setup\n'
  printf '%s' "$RESET"
  note "$REPO_ROOT"

  preflight
  secrets
  configure
  start_stack
  bootstrap
  finish
}

main "$@"
