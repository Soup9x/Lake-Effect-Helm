#!/usr/bin/env bash
# =============================================================================
# Lake Effect Helm — turnkey on-premises setup
#
#   sudo ./deploy/setup.sh
#
# Runs the five steps of a first install in order, checking as it goes:
#
#   1. Preflight   Docker, Compose, versions, permissions, disk
#   2. Secrets     ./deploy/init-secrets.sh — master key ring and .env
#   3. Configure   this host's LAN address, an optional hostname, the ports,
#                  and what sits in front of Helm, written into .env. Helm
#                  answers on any address that reaches it.
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
OPT_HTTP_PORT=""
OPT_HTTPS_PORT=""
OPT_EDGE=""
OPT_BIND=""
OPT_LAN=""
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
  --lan-address <ip|none>  This host's LAN address; people open https://<ip>.
                           Detected by default.
  --host <name|none>       Optional hostname. It gets a certificate and is used in
                           the links Helm emails; behind a tunnel, the tunnel's
                           public name. Helm answers on any name either way.
  --https-port <port>      Port Caddy serves HTTPS on (default 443)
  --http-port <port>       Port Caddy redirects to HTTPS from (default 80)
  --edge <kind>            What sits in front of Helm:
                             direct      nothing; people reach this host (default)
                             cloudflare  a Cloudflare Tunnel; Helm reads the client
                                         address from CF-Connecting-IP
                             proxy       another reverse proxy or load balancer that
                                         appends X-Forwarded-For
  --bind <address>         Address Caddy's ports are published on. 0.0.0.0 reaches
                           the LAN; 127.0.0.1 is reachable only from this host — the
                           default behind a Cloudflare connector running here.
  --tenant <name>          MSP display name, e.g. "Northwind Managed Services"
  --slug <slug>            URL-safe MSP identifier, 3-40 chars [a-z0-9-]
  --admin-email <email>    First administrator's sign-in address
  --admin-name <name>      First administrator's display name
  --yes                    Do not pause for confirmation, and take the defaults
                           for anything optional (ports, edge, bind) not supplied
  -h, --help               This message

With every option supplied and --yes, the script runs unattended.

Run it from anywhere; it operates on the repository it lives in.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --host)        OPT_HOST=${2:?--host needs a value}; shift 2 ;;
    --https-port)  OPT_HTTPS_PORT=${2:?--https-port needs a value}; shift 2 ;;
    --http-port)   OPT_HTTP_PORT=${2:?--http-port needs a value}; shift 2 ;;
    --edge)        OPT_EDGE=${2:?--edge needs a value}; shift 2 ;;
    --bind)        OPT_BIND=${2:?--bind needs a value}; shift 2 ;;
    --lan-address) OPT_LAN=${2:?--lan-address needs a value}; shift 2 ;;
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

# Ask a yes/no question. Enter takes the default; y/yes/n/no in any case are
# accepted, and anything else re-asks. Succeeds on yes.
# $1 prompt  $2 default: y or n
ask_yn() {
  local prompt=$1 default=$2 hint answer=""
  if [ "$default" = "y" ]; then hint="Y/n"; else hint="y/N"; fi
  while :; do
    printf '    %s [%s]: ' "$prompt" "$hint" > /dev/tty
    IFS= read -r answer < /dev/tty || die "no input available; supply the value as a flag instead"
    [ -z "$answer" ] && answer=$default
    case "$answer" in
      [yY]|[yY][eE][sS]) return 0 ;;
      [nN]|[nN][oO]) return 1 ;;
    esac
    printf '    %sy or n.%s\n' "$YELLOW" "$RESET" > /dev/tty
  done
}

# $1 prompt  $2 default: y or n (n when left out). --yes skips it as a yes.
confirm() {
  [ "$ASSUME_YES" -eq 1 ] && return 0
  ask_yn "$1" "${2:-n}"
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

# This host's address on the LAN: the source address of its default route.
# Empty when there is no default route or no `ip` command.
detect_lan_ip() {
  ip -4 route get 1.1.1.1 2>/dev/null \
    | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}' || true
}

# psql inside the postgres container.
#
# PGPASSWORD is not optional here: the stack initialises Postgres with
# --auth-local=scram-sha-256, so even a socket connection as the superuser
# needs a password. Taking it from the container's own POSTGRES_PASSWORD keeps
# the credential off this script's command line and out of the host's history.
# git on this checkout. safe.directory because this runs under sudo and the
# checkout usually belongs to somebody else, which git otherwise refuses.
g() {
  git -c safe.directory="$REPO_ROOT" -C "$REPO_ROOT" "$@"
}

psql_in_container() {
  docker compose exec -T postgres \
    sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U postgres -d helm -tAc "$0"' "$1"
}

# The same, reading the SQL from stdin so `-v name=value` variables are
# interpolated (:'name' quotes them). Anything that came from git goes in this
# way, never pasted into the SQL text.
psql_vars() {
  local script=$1; shift
  printf '%s\n' "$script" | docker compose exec -T postgres \
    sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -U postgres -d helm -X -q -t -A -v ON_ERROR_STOP=1 "$@"' sh "$@"
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

  # The backup passphrase (0820) arrived after the first installs. An install
  # provisioned before it has a master key and no backup.pass, and compose
  # would bind-mount the missing file as an empty DIRECTORY, which the backup
  # service then cannot read as a passphrase. Create it here on every run, so
  # an upgrade needs nothing more than re-running this script.
  local pass_file="$REPO_ROOT/deploy/secrets/backup.pass"
  if [ ! -e "$pass_file" ]; then
    ( umask 077; openssl rand -base64 48 | tr -d '\n' > "$pass_file" )
    chown "${HELM_UID}:${HELM_UID}" "$pass_file"
    chmod 0400 "$pass_file"
    ok "wrote deploy/secrets/backup.pass (0400, uid ${HELM_UID}) — the passphrase that seals every backup"
  fi
  if [ ! -d "$REPO_ROOT/backups" ]; then
    mkdir -p "$REPO_ROOT/backups"
    chown "${HELM_UID}:${HELM_UID}" "$REPO_ROOT/backups"
    chmod 0700 "$REPO_ROOT/backups"
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
  warn "BACK UP deploy/secrets/master.key, deploy/secrets/backup.pass AND .env, OFF THIS HOST, ENCRYPTED."
  note "Without the master key the database is ciphertext nobody can read."
  note "There is no recovery path — that is the design. See §7.3."
}

# -----------------------------------------------------------------------------
# 3. Configure
# -----------------------------------------------------------------------------
configure() {
  step "3/5  Address, ports and what sits in front"

  # ---- how Helm is reached ------------------------------------------------
  # Helm answers on ANY address that reaches it (deploy/Caddyfile): this
  # host's IP, a name in DNS, a tunnel's or proxy's public name. Nothing here
  # has to know about a tunnel or a proxy. These two answers decide only
  # which addresses get certificates, and which one goes into the links Helm
  # emails, where there is no browser request to take an address from.
  local ipv4='^[0-9]{1,3}(\.[0-9]{1,3}){3}$'
  local hostname_re='^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$'
  local current current_lan current_name='' detected lan_addr host
  current=$(get_env HELM_PUBLIC_HOST 2>/dev/null || true)
  current_lan=$(get_env HELM_LAN_ADDRESS 2>/dev/null || true)
  detected=$(detect_lan_ip)
  # The placeholder init-secrets.sh writes is not a name anybody chose.
  if [ -n "$current" ] && [ "$current" != "helm.internal.example.com" ] \
     && ! printf '%s' "$current" | grep -qE "$ipv4"; then
    current_name=$current
  fi

  if [ -n "$OPT_LAN" ]; then
    lan_addr=$OPT_LAN
  elif [ "$ASSUME_YES" -eq 1 ]; then
    lan_addr=${current_lan:-$detected}
  else
    info "Helm answers on any address that reaches it: this host's IP, a name in"
    info "your DNS, a tunnel's or proxy's public name. None of them has to be set"
    info "up here first — publish Helm however you like and it will answer."
    printf '\n'
    info "This host's LAN address. People on the network open https://<address>."
    printf '\n'
    lan_addr=$(ask "LAN address" "${current_lan:-${detected:-none}}" \
                   '^(none|[0-9]{1,3}(\.[0-9]{1,3}){3})$' "An IPv4 address, or none.")
  fi
  [ "$lan_addr" = "none" ] && lan_addr=''
  if [ -n "$lan_addr" ]; then
    printf '%s' "$lan_addr" | grep -qE "$ipv4" || die "--lan-address '$lan_addr' is not an IPv4 address (or 'none')."
  fi

  if [ -n "$OPT_HOST" ]; then
    host=$OPT_HOST
  elif [ "$ASSUME_YES" -eq 1 ]; then
    host=$current_name
  else
    printf '\n'
    info "A hostname, if Helm has one. Optional: it gets a certificate of its own"
    info "and becomes the address in the links Helm emails (password resets,"
    info "reminders). Behind a tunnel, give the tunnel's public name here so those"
    info "links work away from the office. 'none' to use the LAN address."
    printf '\n'
    host=$(ask "Hostname" "${current_name:-none}" \
               '^(none|[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?)$' "A hostname, or none.")
  fi
  [ "$host" = "none" ] && host=''
  if [ -n "$host" ]; then
    printf '%s' "$host" | grep -qE "$hostname_re" || die "--host '$host' is not a hostname."
    # An IP given as the "hostname" is the LAN address by another name.
    if printf '%s' "$host" | grep -qE "$ipv4"; then
      [ -n "$lan_addr" ] || lan_addr=$host
      [ "$host" = "$lan_addr" ] && host=''
    fi
  fi
  [ -n "$host$lan_addr" ] || die "Helm needs at least one address: a LAN address (--lan-address) or a hostname (--host)."
  local primary=${host:-$lan_addr}

  # ---- the ports -----------------------------------------------------------
  # Asked here, not in preflight, so a port that turns out to be taken can be
  # answered on the spot by picking another one.
  local https_port http_port
  https_port=$(get_env HELM_HTTPS_PORT 2>/dev/null || true); https_port=${https_port:-443}
  http_port=$(get_env HELM_HTTP_PORT 2>/dev/null || true);   http_port=${http_port:-80}
  [ -n "$OPT_HTTPS_PORT" ] && https_port=$OPT_HTTPS_PORT
  [ -n "$OPT_HTTP_PORT" ]  && http_port=$OPT_HTTP_PORT

  if [ -z "$OPT_HTTPS_PORT$OPT_HTTP_PORT" ] && [ "$ASSUME_YES" -eq 0 ]; then
    printf '\n'
    info "The ports Caddy listens on. 443 and 80 unless this host already serves"
    info "something on them. A non-standard HTTPS port becomes part of the address"
    info "(https://${primary}:8443) and of every link Helm sends."
    printf '\n'
    https_port=$(ask "HTTPS port" "$https_port" '^[0-9]{1,5}$' "A port number, 1-65535.")
    http_port=$(ask "HTTP port (redirects to HTTPS)" "$http_port" '^[0-9]{1,5}$' "A port number, 1-65535.")
  fi
  for p in "$https_port" "$http_port"; do
    [ "$p" -ge 1 ] 2>/dev/null && [ "$p" -le 65535 ] || die "'$p' is not a port number (1-65535)."
  done
  [ "$https_port" != "$http_port" ] || die "the HTTPS and HTTP ports must differ."

  # Taken already? Ports Caddy itself holds from an earlier run do not count.
  local clash=0 unknown=0 rc caddy_up=0
  docker compose ps --status running caddy 2>/dev/null | grep -q caddy && caddy_up=1
  for p in "$https_port" "$http_port"; do
    rc=0; port_in_use "$p" || rc=$?
    case "$rc" in
      0) if [ "$caddy_up" -eq 1 ]; then note "port $p is held by the running Helm stack"; else warn "something is already listening on port $p"; clash=1; fi ;;
      2) unknown=1 ;;
    esac
  done
  if [ "$clash" -eq 1 ]; then
    note "Caddy will fail to bind. Stop the other service, or re-run with"
    note "--https-port / --http-port (or answer the prompt) to pick free ones."
    confirm "Continue anyway?" || die "stopped so you can free or change the ports."
  elif [ "$unknown" -eq 1 ]; then
    warn "could not check whether ports $https_port and $http_port are free"
    note "No ss, netstat or /proc/net/tcp on this host. If they are taken,"
    note "Caddy will say so when it tries to bind."
  else
    ok "ports $https_port and $http_port are free"
  fi

  # ---- what sits in front --------------------------------------------------
  # The answer decides where Helm reads the client address from (the per-IP
  # sign-in lockout, the audit log and token allow-lists all use it) and
  # where Caddy's ports are published.
  local edge current_edge
  current_edge=$(get_env HELM_EDGE 2>/dev/null || true); current_edge=${current_edge:-direct}
  if [ -n "$OPT_EDGE" ]; then
    edge=$OPT_EDGE
  elif [ "$ASSUME_YES" -eq 1 ]; then
    edge=$current_edge
  else
    printf '\n'
    info "How will people reach Helm?"
    printf '\n'
    info "  direct      Straight to this host, on the LAN or over a VPN."
    info "  cloudflare  Through a Cloudflare Tunnel. Helm reads each visitor's"
    info "              address from the header Cloudflare sets, so the sign-in"
    info "              lockout and the audit log see people, not the tunnel."
    info "  proxy       Through another reverse proxy or load balancer that"
    info "              appends X-Forwarded-For."
    printf '\n'
    edge=$(ask "Edge" "$current_edge" '^(direct|cloudflare|proxy)$' "One of: direct, cloudflare, proxy.")
  fi
  case $edge in direct|cloudflare|proxy) ;; *) die "--edge '$edge' must be one of: direct, cloudflare, proxy" ;; esac

  # ---- where the ports are published --------------------------------------
  # Reading CF-Connecting-IP is only safe while nothing can reach Caddy except
  # through the tunnel: a request that arrives another way could name any
  # address it likes. When the connector runs on this host, publishing on
  # 127.0.0.1 makes that hold by construction. Publishing to the LAN as well is
  # allowed, with the trade-off said out loud.
  local bind current_bind
  current_bind=$(get_env HELM_BIND_ADDRESS 2>/dev/null || true)
  if [ -n "$OPT_BIND" ]; then
    bind=$OPT_BIND
  elif [ "$edge" != "cloudflare" ]; then
    bind=${current_bind:-0.0.0.0}
    [ "$bind" = "127.0.0.1" ] && [ "$ASSUME_YES" -eq 0 ] && bind=0.0.0.0
  elif [ "$ASSUME_YES" -eq 1 ]; then
    bind=${current_bind:-127.0.0.1}
  else
    printf '\n'
    info "Where does the cloudflared connector run?"
    note "On this host, Helm can be published on 127.0.0.1 so the tunnel is the"
    note "only way in — then the client address Cloudflare reports cannot be"
    note "forged by anything on the LAN. On another machine, Helm has to be"
    note "reachable on the LAN."
    printf '\n'
    if ask_yn "Connector on this host?" n; then
      if ask_yn "Also let the LAN reach Helm directly, bypassing the tunnel?" n; then
        bind=0.0.0.0
        warn "A machine on the LAN can then send its own CF-Connecting-IP header and"
        warn "name any address it likes in the audit log and the sign-in lockout."
      else
        bind=127.0.0.1
      fi
    else
      bind=0.0.0.0
    fi
  fi
  printf '%s' "$bind" | grep -qE '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' || die "--bind '$bind' is not an IPv4 address (0.0.0.0 or 127.0.0.1)."

  # ---- write it ------------------------------------------------------------
  local url sites
  if [ "$https_port" = "443" ]; then url="https://${primary}"; else url="https://${primary}:${https_port}"; fi
  # The addresses Caddy gets certificates for. It answers every other one too.
  sites=$lan_addr
  if [ -n "$host" ]; then sites=${sites:+$sites, }$host; fi

  set_env HELM_PUBLIC_HOST    "$primary"
  set_env HELM_PUBLIC_URL     "$url"
  set_env HELM_SITE_ADDRESSES "$sites"
  set_env HELM_HTTPS_PORT   "$https_port"
  set_env HELM_HTTP_PORT    "$http_port"
  set_env HELM_EDGE         "$edge"
  set_env HELM_BIND_ADDRESS "$bind"
  set_env HELM_LAN_ADDRESS  "$lan_addr"
  case $edge in
    cloudflare) set_env HELM_CLIENT_IP_HEADER "cf-connecting-ip"; set_env HELM_TRUSTED_PROXY_HOPS "1" ;;
    proxy)      set_env HELM_CLIENT_IP_HEADER "";                 set_env HELM_TRUSTED_PROXY_HOPS "2" ;;
    direct)     set_env HELM_CLIENT_IP_HEADER "";                 set_env HELM_TRUSTED_PROXY_HOPS "1" ;;
  esac

  local port_suffix=''
  [ "$https_port" = "443" ] || port_suffix=":${https_port}"
  printf '\n'
  if [ "$bind" = "127.0.0.1" ]; then
    ok "Helm answers on this host only (127.0.0.1); the tunnel is the way in"
  elif [ -n "$lan_addr" ]; then
    ok "Helm answers on https://${lan_addr}${port_suffix}${host:+ and https://${host}${port_suffix}}, and on any other name pointed here"
  else
    ok "Helm answers on https://${host}${port_suffix}, and on any other name pointed here"
  fi
  ok "links Helm emails use ${url}"
  ok "ports ${https_port} (https) and ${http_port} (http), published on ${bind}"
  if [ -z "$host" ] && [ "$edge" != "direct" ]; then
    note "Emailed links point at the LAN address, which only works on the LAN. Re-run"
    note "with --host <the public name> to have them work through the ${edge} too."
  fi
  case $edge in
    cloudflare) ok "edge: Cloudflare Tunnel — client address from CF-Connecting-IP" ;;
    proxy)      ok "edge: reverse proxy — client address two hops back in X-Forwarded-For" ;;
    direct)     ok "edge: none — client address from the connection" ;;
  esac
}

# -----------------------------------------------------------------------------
# 4. Start
# -----------------------------------------------------------------------------
# `up` recreates only the containers whose configuration changed, so caddy and
# postgres can run for weeks across upgrades. If Docker, containerd or runc is
# updated underneath them in that time, the old containers keep serving but
# Docker can no longer exec into them: every healthcheck fails before it runs
# ("OCI runtime exec failed ... procReady not received") and `up --wait`
# reports a working service as unhealthy. Recreating such a container fixes
# it and loses nothing — its state is in named volumes. A healthcheck that
# ran and failed is a real failure and is left for the caller to report.
recover_stale_containers() {
  local stale="" svc id log
  for svc in $(docker compose ps --services --status running 2>/dev/null); do
    id=$(docker compose ps -q "$svc" 2>/dev/null) || continue
    [ -n "$id" ] || continue
    log=$(docker inspect --format '{{if .State.Health}}{{range .State.Health.Log}}{{.Output}}{{"\n"}}{{end}}{{end}}' "$id" 2>/dev/null) || continue
    case "$log" in
      *"OCI runtime exec failed"*|*"procReady not received"*) stale="$stale $svc" ;;
    esac
  done
  [ -n "$stale" ] || return 1

  warn "Docker cannot run healthchecks inside:$stale"
  note "Those containers predate a Docker runtime update on this host. Recreating"
  note "them; their data is in named volumes and is kept."
  # shellcheck disable=SC2086  # $stale is a list of service names
  docker compose up -d --force-recreate --wait --wait-timeout 300 $stale
}

start_stack() {
  step "4/5  Build and start"

  if [ "$ASSUME_YES" -eq 0 ]; then
    info "About to build two images and start postgres, migrate, web, worker and caddy."
    info "The first build takes a few minutes."
    confirm "Go ahead?" y || die "stopped before building. Nothing has been started."
  fi

  # Tell the image which commit it is and where this checkout lives, so
  # Administration → Updates can compare it with GitHub and show the right
  # commands. The image has no .git of its own. safe.directory because this
  # runs under sudo and the checkout usually belongs to somebody else, which
  # git otherwise refuses to read.
  HELM_BUILD_COMMIT=$(g rev-parse HEAD 2>/dev/null || true)
  HELM_INSTALL_DIR="$REPO_ROOT"
  export HELM_BUILD_COMMIT HELM_INSTALL_DIR
  if [ -n "$HELM_BUILD_COMMIT" ]; then
    ok "building commit ${HELM_BUILD_COMMIT:0:7}"
  else
    warn "not a git checkout, so Helm will not be able to tell when an update is available"
  fi

  # Build separately from `up` so build time is visible as build time, and so
  # the --wait timeout below measures only how long health takes.
  info "building images..."
  docker compose build || die "image build failed — the output above says why."
  ok "images built"

  info "starting the stack and waiting for every service to report healthy..."
  if ! docker compose up -d --wait --wait-timeout 300 && ! recover_stale_containers; then
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
# Updates from the web page
# -----------------------------------------------------------------------------
# Administration → Updates can install an update when an administrator asks
# (now, or at a time they pick). The web tier cannot do that itself and must
# not be able to — it would need the Docker socket — so a small service on
# this host does it: deploy/updater.sh, run once a minute by a systemd timer.
# It pulls the requested commit (only ever one on the configured branch) and
# runs this script with --yes, which keeps every answer already in .env.
#
# Reinstalled on every run, so an update also updates the updater. The copy
# is moved into place with a rename: a run of the old copy that is in the
# middle of an update keeps reading the file it started with.
updater() {
  step "Updates from Helm's Updates page"

  local current answer default=y
  current=$(get_env HELM_WEB_UPDATES 2>/dev/null || true)
  if [ "$ASSUME_YES" -eq 1 ]; then
    answer=${current:-on}
  else
    info "Administrators can install a Helm update from Administration → Updates,"
    info "straight away or at a time they choose, after re-entering their password."
    info "A small service on this host does it: it pulls the update from GitHub and"
    info "re-runs this script with the answers you have already given."
    printf '\n'
    [ "$current" = off ] && default=n
    if ask_yn "Allow updates from Helm's Updates page?" "$default"; then answer=on; else answer=off; fi
  fi
  set_env HELM_WEB_UPDATES "$answer"

  if ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then
    warn "this host does not run systemd, so updates from the web page are not available"
    note "Update with: cd $REPO_ROOT && git pull && sudo ./deploy/setup.sh"
    return 0
  fi

  if [ "$answer" != on ]; then
    systemctl disable --now helm-updater.timer >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/helm-updater.timer /etc/systemd/system/helm-updater.service /usr/local/sbin/helm-updater
    systemctl daemon-reload
    ok "updates from the web page are off"
    return 0
  fi

  install -m 0755 "$REPO_ROOT/deploy/updater.sh" /usr/local/sbin/helm-updater.new
  mv -f /usr/local/sbin/helm-updater.new /usr/local/sbin/helm-updater

  cat > /etc/systemd/system/helm-updater.service <<UNIT
[Unit]
Description=Lake Effect Helm updater (installs updates requested on Administration > Updates)
After=docker.service
Wants=docker.service

[Service]
Type=oneshot
Environment="HELM_REPO_ROOT=$REPO_ROOT"
Environment=HOME=/root
ExecStart=/usr/local/sbin/helm-updater
# A rebuild takes minutes; this is only a backstop for a hung one.
TimeoutStartSec=3h
Nice=5
UNIT

  cat > /etc/systemd/system/helm-updater.timer <<UNIT
[Unit]
Description=Check once a minute for a Helm update requested on the Updates page

[Timer]
OnCalendar=minutely
AccuracySec=10s

[Install]
WantedBy=timers.target
UNIT

  systemctl daemon-reload
  systemctl enable --now helm-updater.timer >/dev/null 2>&1 \
    || die "could not start helm-updater.timer — see: systemctl status helm-updater.timer"
  ok "updater installed; Administration → Updates can install updates"
  note "Its logs: /var/log/helm-updater and journalctl -u helm-updater"
}

# -----------------------------------------------------------------------------
# The update history (1220)
# -----------------------------------------------------------------------------
# One row per version deployed, so Administration → Updates → History can say
# what this server has run, when, and who put it there. Written here because
# every way of updating ends in this script: by hand, or from the Updates page
# through deploy/updater.sh — in which case the request that is 'running' right
# now is this run, and the row points at it (and so at who asked, and the log).
#
# A re-run on the version already recorded (to change a port, say) is not an
# update and adds nothing. A failure here never fails the deploy: the stack is
# up, and a missing history line is not worth stopping for.
record_deploy() {
  local commit=${HELM_BUILD_COMMIT:-}
  [ -n "$commit" ] || return 0

  local last
  last=$(psql_in_container "SELECT commit FROM helm_deploy ORDER BY deployed_at DESC, id DESC LIMIT 1" 2>/dev/null \
         | tr -d '[:space:]') || { warn "could not record this update in the history"; return 0; }
  [ "$last" = "$commit" ] && return 0

  # What changed since the last recorded version, as "<pr>\t<title>" lines,
  # newest first: a merged pull request by its own title, a squash merge by
  # its subject, and plain commits only when nothing was merged through a PR.
  local range=("-1" "$commit")
  if [ -n "$last" ] && g merge-base --is-ancestor "$last" "$commit" 2>/dev/null; then
    range=("$last..$commit")
  else
    last=''
  fi
  local changes
  changes=$(g log --first-parent --format='%s%x1f%b%x1e' "${range[@]}" 2>/dev/null | awk '
    BEGIN { RS = "\036"; FS = "\037" }
    {
      sub(/^\n+/, "", $1); subject = $1; body = $2; title = ""; pr = ""
      if (match(subject, /^Merge pull request #[0-9]+/)) {
        pr = substr(subject, 21, RLENGTH - 20)
        n = split(body, lines, "\n")
        for (i = 1; i <= n; i++) if (lines[i] ~ /[^[:space:]]/) { title = lines[i]; break }
        if (title == "") title = subject
        prs = prs pr "\t" title "\n"; next
      }
      if (match(subject, /\(#[0-9]+\)[[:space:]]*$/)) {
        pr = substr(subject, RSTART + 2, RLENGTH - 3); sub(/[)[:space:]]+$/, "", pr)
        title = substr(subject, 1, RSTART - 1); sub(/[[:space:]]+$/, "", title)
        prs = prs pr "\t" title "\n"; next
      }
      if (subject ~ /^Merge / || subject == "") next
      plain = plain "\t" subject "\n"
    }
    END { printf "%s", (prs != "" ? prs : plain) }')

  # Updated from the page? Then the request deploy/updater.sh is running is
  # this one.
  if psql_vars "
    WITH change AS (
      SELECT nullif(split_part(l, E'\t', 1), '')::int AS pr, left(split_part(l, E'\t', 2), 400) AS title, n
      FROM regexp_split_to_table(:'changes', E'\n') WITH ORDINALITY AS t(l, n)
      WHERE l <> ''
    ), running AS (
      SELECT id FROM helm_update WHERE status = 'running' ORDER BY started_at DESC LIMIT 1
    )
    INSERT INTO helm_deploy (commit, previous_commit, title, changes, source, update_id, host_user, host)
    SELECT :'commit', nullif(:'previous', ''),
           (SELECT title FROM change ORDER BY n LIMIT 1),
           coalesce((SELECT jsonb_agg(jsonb_build_object('pr', pr, 'title', title) ORDER BY n) FROM change), '[]'::jsonb),
           CASE WHEN (SELECT id FROM running) IS NULL THEN 'setup' ELSE 'page' END,
           (SELECT id FROM running),
           CASE WHEN (SELECT id FROM running) IS NULL THEN nullif(:'host_user', '') END,
           nullif(:'host', '');" \
    -v commit="$commit" -v previous="$last" -v changes="$changes" \
    -v host_user="${SUDO_USER:-$(id -un)}" -v host="$(hostname 2>/dev/null || true)" >/dev/null 2>&1; then
    ok "recorded ${commit:0:7} in the update history"
  else
    warn "could not record this update in the history"
  fi
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
  local host url tls lan sites edge https_port bind suffix=''
  host=$(get_env HELM_PUBLIC_HOST); url=$(get_env HELM_PUBLIC_URL)
  tls=$(get_env HELM_TLS_DIRECTIVE 2>/dev/null || true)
  lan=$(get_env HELM_LAN_ADDRESS 2>/dev/null || true)
  sites=$(get_env HELM_SITE_ADDRESSES 2>/dev/null || true)
  edge=$(get_env HELM_EDGE 2>/dev/null || true)
  https_port=$(get_env HELM_HTTPS_PORT 2>/dev/null || true); https_port=${https_port:-443}
  bind=$(get_env HELM_BIND_ADDRESS 2>/dev/null || true); bind=${bind:-0.0.0.0}
  [ "$https_port" = "443" ] || suffix=":${https_port}"
  sites=${sites:-$host}

  step "Done"
  if [ "$bind" = "127.0.0.1" ]; then
    info "Helm is running, reachable from this host only (through the tunnel)."
  else
    info "Helm is running. Open any of these — and any name you point here later:"
    local a
    IFS=',' read -ra _addrs <<< "$sites"
    for a in "${_addrs[@]}"; do a=${a// /}; [ -n "$a" ] && info "  ${BOLD}https://${a}${suffix}${RESET}"; done
  fi
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

  # Publishing Helm through a tunnel or proxy needs nothing from Helm: point
  # it at the HTTPS port and accept Caddy's certificate. Spelled out for
  # Cloudflare because its dialog has the most knobs to get wrong.
  if [ "$edge" = "cloudflare" ]; then
    local origin
    if [ "$bind" = "127.0.0.1" ]; then origin="https://localhost:${https_port}"; else
      origin="https://${lan:-$(detect_lan_ip)}:${https_port}"
    fi
    cat <<TUNNEL
    ${BOLD}Point the tunnel at Helm${RESET} — Cloudflare Zero Trust → Networks → Tunnels →
    your tunnel → Public Hostname. Any public name works; Helm answers on it.

      Public hostname            the name you want (subdomain + domain)
      Service URL                ${origin}
      TLS → No TLS Verify        on   (or CA Pool = ./helm-root.crt on the
                                       connector's host)
      Everything else            leave the defaults

    A locally managed connector takes the same thing in config.yml:

      ingress:
        - hostname: helm.example.com
          service: ${origin}
          originRequest:
            noTLSVerify: true
        - service: http_status:404

    After one sign-in through the tunnel, confirm the client address survived:
    the Audit page, or as the superuser
      SELECT ip, outcome, occurred_at FROM auth_attempt ORDER BY occurred_at DESC LIMIT 3;
    The address should be the visitor's, not the connector's.

TUNNEL
    if [ "$bind" = "127.0.0.1" ]; then
      note "Helm is published on 127.0.0.1 only: the tunnel is the one way in, which is"
      note "what makes the address Cloudflare reports trustworthy. Re-run with"
      note "--bind 0.0.0.0 to open it to the LAN as well."
    else
      warn "Helm is reachable on the LAN as well as through the tunnel. A machine on"
      warn "the LAN can send its own CF-Connecting-IP header and name any address."
    fi
    printf '\n'
  fi

  cat <<NEXT
    Next:

      1. Trust the certificate (above), then open ${url}/sign-in
         and sign in with the password printed a moment ago. Helm will
         insist you change it.

      2. Links Helm emails (password resets, reminders) use ${url}.
         Re-run with --host <name> if people should get a different one.

      3. Back up deploy/secrets/master.key and .env, off this host,
         encrypted. Then set up the nightly job.                        §7

      4. Optional: wire Microsoft Entra ID for SSO — on-premises.md §5.1.
         Entra needs a hostname for its redirect URI, not an IP. Keep the
         local password working too: it is what gets you in when Entra
         cannot be reached.                         docker-on-prem.md §5.2

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
  record_deploy
  bootstrap
  updater
  finish
}

main "$@"
