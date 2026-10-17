#!/usr/bin/env bash
# =============================================================================
# Put Helm behind a Cloudflare Tunnel (or any proxy that owns the public name).
#
# Helm answers to exactly one name: Caddy serves that site and nothing else,
# and sign-in callbacks and emailed links are built from it. A tunnel that
# publishes a DIFFERENT name forwards the browser's Host header unchanged, so
# Caddy matches no site and returns an empty reply — and even with the header
# rewritten, the sign-in redirect would send people to the internal name,
# which does not resolve outside the LAN.
#
# So the public name becomes Helm's name. This script:
#
#   1. sets HELM_PUBLIC_HOST / HELM_PUBLIC_URL in .env to the tunnel's name,
#   2. sets HELM_CLIENT_IP_HEADER so Helm reads the real client address from
#      the edge's header instead of seeing every visitor as the connector
#      (otherwise a few wrong passwords from anyone lock everyone out),
#   3. restarts the stack and confirms Caddy answers on the new name,
#   4. exports Caddy's root certificate for the connector to trust,
#   5. prints the settings that have to be made elsewhere: the Cloudflare
#      application, and the internal DNS record so LAN users reach the same
#      name directly.
#
# It edits .env and nothing else. The master key, the database and its
# passwords are untouched. Re-running it is safe.
#
#   sudo ./deploy/publish-via-tunnel.sh --host helm.example.com [--yes]
#
# See docs/deployment/docker-on-prem.md, "Behind a Cloudflare Tunnel".
# =============================================================================
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
ENV_FILE="$REPO_ROOT/.env"
cd "$REPO_ROOT"

if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; BLUE=$'\033[34m'; RESET=$'\033[0m'
else
  BOLD=''; DIM=''; RED=''; GREEN=''; YELLOW=''; BLUE=''; RESET=''
fi
step()  { printf '\n%s==> %s%s\n' "$BOLD$BLUE" "$*" "$RESET"; }
ok()    { printf '    %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
info()  { printf '    %s\n' "$*"; }
note()  { printf '    %s%s%s\n' "$DIM" "$*" "$RESET"; }
warn()  { printf '    %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
die()   { printf '\n%sFAILED:%s %s\n\n' "$BOLD$RED" "$RESET" "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Lake Effect Helm — publish through a Cloudflare Tunnel

  sudo ./deploy/publish-via-tunnel.sh --host <public name> [options]

Options:
  --host <name>       The public hostname the tunnel publishes, e.g. helm.example.com
  --header <name>     Header carrying the client address (default: cf-connecting-ip;
                      true-client-ip behind some load balancers; "none" to count hops)
  --skip-restart      Edit .env only; do not restart the stack or verify
  --yes               Do not pause for confirmation
  -h, --help          This text
USAGE
}

OPT_HOST=''; OPT_HEADER='cf-connecting-ip'; OPT_RESTART=1; OPT_YES=0
while [ $# -gt 0 ]; do
  case $1 in
    --host)         OPT_HOST=${2:-}; shift 2 ;;
    --header)       OPT_HEADER=${2:-}; shift 2 ;;
    --skip-restart) OPT_RESTART=0; shift ;;
    --yes)          OPT_YES=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    *)              usage >&2; die "unknown option: $1" ;;
  esac
done

# -----------------------------------------------------------------------------
# .env helpers, the same shape as deploy/setup.sh: rewrite into a temp file
# that inherits .env's permissions, refuse a rewrite that lost lines, then
# move it into place.
# -----------------------------------------------------------------------------
get_env() {
  [ -f "$ENV_FILE" ] || return 1
  KEY="$1" awk 'BEGIN{k=ENVIRON["KEY"]} index($0,k"=")==1 { print substr($0, length(k)+2); exit }' "$ENV_FILE"
}

set_env() {
  local key=$1 value=$2 tmp
  tmp="${ENV_FILE}.tmp.$$"
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
  local before after
  before=$(grep -cE '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE" || true)
  after=$(grep -cE '^[A-Za-z_][A-Za-z0-9_]*=' "$tmp" || true)
  if [ "$after" -lt "$before" ]; then
    rm -f "$tmp"
    die "rewriting $ENV_FILE would have dropped variables ($before -> $after). Refusing; the original is untouched."
  fi
  mv -f "$tmp" "$ENV_FILE"
}

# Strip the quotes .env.example uses, so a value copied from it compares equal.
unquote() { local v=$1; v=${v#\"}; v=${v%\"}; printf '%s' "$v"; }

# -----------------------------------------------------------------------------
# Preconditions
# -----------------------------------------------------------------------------
[ "$(id -u)" -eq 0 ] || die "run this with sudo: .env is readable by root only."
[ -f "$ENV_FILE" ] || die "no .env in $REPO_ROOT. Run deploy/setup.sh first — this script re-addresses an install, it does not create one."
[ -n "$OPT_HOST" ] || { usage >&2; die "--host is required: the public name the tunnel publishes."; }
printf '%s' "$OPT_HOST" | grep -qE '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$' \
  || die "--host '$OPT_HOST' is not a hostname."
case $OPT_HOST in
  *.*) ;;
  *) die "--host '$OPT_HOST' has no domain part. The tunnel publishes a fully qualified name." ;;
esac
if [ "$OPT_RESTART" -eq 1 ]; then
  command -v docker >/dev/null 2>&1 || die "docker is not installed or not on PATH."
  docker compose version >/dev/null 2>&1 || die "docker compose (v2) is not available."
fi

# A header name is lower-case letters, digits and dashes; "none" means count hops.
case $OPT_HEADER in
  none|'') OPT_HEADER='' ;;
  *) printf '%s' "$OPT_HEADER" | grep -qE '^[a-z0-9-]+$' || die "--header '$OPT_HEADER' is not a header name (use lower case, e.g. cf-connecting-ip)." ;;
esac

# -----------------------------------------------------------------------------
# 1. What changes
# -----------------------------------------------------------------------------
step "1/4  Address"

old_host=$(unquote "$(get_env HELM_PUBLIC_HOST 2>/dev/null || true)")
old_url=$(unquote "$(get_env HELM_PUBLIC_URL 2>/dev/null || true)")
old_header=$(unquote "$(get_env HELM_CLIENT_IP_HEADER 2>/dev/null || true)")
old_hops=$(unquote "$(get_env HELM_TRUSTED_PROXY_HOPS 2>/dev/null || true)")
https_port=$(unquote "$(get_env HELM_HTTPS_PORT 2>/dev/null || true)"); https_port=${https_port:-443}

new_host=$OPT_HOST
if [ "$https_port" = "443" ]; then new_url="https://${new_host}"; else new_url="https://${new_host}:${https_port}"; fi

printf '    %-24s %s  ->  %s\n' "HELM_PUBLIC_HOST"      "${old_host:-(unset)}"   "$new_host"
printf '    %-24s %s  ->  %s\n' "HELM_PUBLIC_URL"       "${old_url:-(unset)}"    "$new_url"
printf '    %-24s %s  ->  %s\n' "HELM_CLIENT_IP_HEADER" "${old_header:-(blank)}" "${OPT_HEADER:-(blank: count hops)}"
if [ -z "$OPT_HEADER" ] && [ "${old_hops:-1}" = "1" ]; then
  printf '    %-24s %s  ->  %s\n' "HELM_TRUSTED_PROXY_HOPS" "${old_hops:-1}" "2"
fi
printf '\n'
note "Caddy will serve ${new_host} and nothing else. Browser sessions were issued"
note "for ${old_host:-the old name}, so everyone signs in again at the new address."
if [ -n "$OPT_HEADER" ]; then
  warn "Reading ${OPT_HEADER} is safe ONLY while nothing can reach Caddy except through"
  warn "the tunnel. Do not forward ports 80/443 from your router to this host."
fi

if [ "$OPT_YES" -ne 1 ]; then
  printf '\n'
  read -r -p "    Apply? [y/N] " answer
  case $answer in y|Y|yes|YES) ;; *) echo "    Nothing changed."; exit 0 ;; esac
fi

# -----------------------------------------------------------------------------
# 2. Write .env
# -----------------------------------------------------------------------------
step "2/4  .env"
set_env HELM_PUBLIC_HOST "$new_host"
set_env HELM_PUBLIC_URL  "$new_url"
if [ -n "$OPT_HEADER" ]; then
  set_env HELM_CLIENT_IP_HEADER "$OPT_HEADER"
else
  set_env HELM_CLIENT_IP_HEADER ""
  # Cloudflare appends the client, Caddy appends the connector: two hops.
  [ "${old_hops:-1}" = "1" ] && set_env HELM_TRUSTED_PROXY_HOPS "2"
fi
ok "wrote $ENV_FILE"

if [ "$OPT_RESTART" -ne 1 ]; then
  printf '\n'
  info "Skipped the restart. When ready:  docker compose up -d --wait"
  exit 0
fi

# -----------------------------------------------------------------------------
# 3. Restart and verify
# -----------------------------------------------------------------------------
step "3/4  Restart"
info "docker compose up -d --wait (recreates caddy, web and worker with the new address)..."
if ! docker compose up -d --wait; then
  printf '\n'
  docker compose ps || true
  die "the stack did not come up healthy. 'docker compose logs caddy web' has the reason.
    .env already carries the new address; fix the cause and run: docker compose up -d --wait"
fi
ok "every container healthy"

# The question the tunnel will ask: does Caddy answer for the new name, with a
# certificate it can select? --resolve pins the name to this host so the check
# does not depend on DNS, which is step 4's job.
health=$(curl -sk --max-time 10 --resolve "${new_host}:${https_port}:127.0.0.1" \
  "https://${new_host}:${https_port}/api/health" 2>/dev/null || true)
case $health in
  *'"status":"ok"'*) ok "Caddy answers for ${new_host} and the web tier reaches the database" ;;
  '') die "no answer from https://${new_host}:${https_port}/ on this host. Is HELM_HTTPS_PORT=${https_port} what Caddy publishes? 'docker compose logs caddy' has the reason." ;;
  *)  die "https://${new_host}:${https_port}/api/health answered but not ok: ${health}" ;;
esac

# The connector has to trust Caddy's certificate, or verify nothing. Export the
# root so trusting it is an option; setup.sh writes the same file.
tls=$(unquote "$(get_env HELM_TLS_DIRECTIVE 2>/dev/null || true)")
root_crt=''
if [ -z "$tls" ] || [ "$tls" = "tls internal" ]; then
  if docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt "$REPO_ROOT/helm-root.crt" >/dev/null 2>&1; then
    root_crt="$REPO_ROOT/helm-root.crt"
    ok "exported Caddy's root certificate to ${root_crt}"
  else
    warn "could not export Caddy's root certificate; the connector will need 'No TLS Verify'"
  fi
fi

# -----------------------------------------------------------------------------
# 4. What has to happen elsewhere
# -----------------------------------------------------------------------------
step "4/4  Done on this host. Three settings live elsewhere:"

# Where the connector should point. localhost when cloudflared runs here;
# otherwise this host's LAN address, never the internal DNS name, which the
# connector may not be able to resolve.
lan_ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}' || true)
if command -v cloudflared >/dev/null 2>&1 || systemctl is-active --quiet cloudflared 2>/dev/null; then
  service_url="https://localhost:${https_port}"
  note "(cloudflared is installed on this host, so the connector reaches Caddy as localhost)"
else
  service_url="https://${lan_ip:-<LAN address of this host>}:${https_port}"
fi

cat <<SETTINGS

    ${BOLD}A. Cloudflare Zero Trust → Networks → Tunnels → your tunnel → Public Hostname${RESET}

       Public hostname       ${new_host}
       Service URL           ${service_url}
       HTTP → Host header    (leave default — the names now match)
       TLS → Origin Server Name   ${new_host}
            Caddy picks its certificate by this name; a connection to an
            IP or localhost sends none and the handshake fails without it.
       TLS → certificate     either  No TLS Verify = on
                             or      CA Pool = path on the connector host to
                                     ${root_crt:-helm-root.crt (see docs §6.1)}

       A locally managed connector takes the same thing in config.yml:

         ingress:
           - hostname: ${new_host}
             service: ${service_url}
             originRequest:
               originServerName: ${new_host}
               caPool: ${root_crt:-/path/to/helm-root.crt}      # or noTLSVerify: true
           - service: http_status:404

    ${BOLD}B. Internal DNS${RESET} — so machines on the LAN reach the same name directly:

       ${new_host}  A  ${lan_ip:-<LAN address of this host>}

       On a Windows DNS server (replace the zone with the one you host):

         Add-DnsServerResourceRecordA -ZoneName "${new_host#*.}" -Name "${new_host%%.*}" -IPv4Address "${lan_ip:-<address>}"

    ${BOLD}C. Confirm${RESET} after one sign-in through the tunnel, as the superuser:

         docker compose exec -T postgres sh -c 'PGPASSWORD="\$POSTGRES_PASSWORD" psql -U postgres -d helm -c \\
           "SELECT ip, outcome, occurred_at FROM auth_attempt ORDER BY occurred_at DESC LIMIT 3"'

       The address should be yours, not the connector's (a 172.x, 192.168.x
       or 127.0.0.1 one).

    A vault on a public name deserves an identity check in front of the sign-in
    page. Cloudflare Access on ${new_host} is the usual way.

SETTINGS
