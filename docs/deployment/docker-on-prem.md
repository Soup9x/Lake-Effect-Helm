# On-Premises Docker Installation Guide

Installing Lake Effect Helm on a single on-premises host with Docker Compose.

**[Quick Start](#quick-start-5-minute-deployment) runs the whole install for
you.** Everything after it is the reference manual: the same five steps done by
hand, plus TLS, backup and restore, verification and troubleshooting. Use the
Quick Start to get running; come back to the manual when you need to know why
something is the way it is, or when something breaks.

> **Which guide is which.** These two sit side by side in this directory and
> do different jobs. This one owns *installation*: getting from a bare host to
> a running stack. [`on-premises.md`](on-premises.md) owns *operation*:
> master-key rotation, migrating custody into Vault, storage separation,
> upgrades. Where they overlap, this is the more detailed Docker walkthrough
> and that is the runbook. Neither replaces the other.

---

## Quick Start (5-minute deployment)

```bash
git clone <your-fork> /opt/lake-effect-helm
cd /opt/lake-effect-helm
sudo ./deploy/setup.sh
```

That is the whole install. Five minutes of your attention, plus a few minutes
of image build you can walk away from.

### What it asks you

Four questions, each validated as you answer and re-asked if it does not fit:

| | Example | Why it matters |
| --- | --- | --- |
| Public hostname | `helm.internal.example.com` | Must match the certificate and the browser's address bar. §3 |
| MSP name | `Northwind Managed Services` | Your own company — the root tenant |
| URL slug | `northwind` | Offered for you, derived from the name |
| Administrator email and name | `admin@northwind.example.com` | The first account. Must match what Entra asserts, if you later add SSO |

### What it does

| Phase | Equivalent manual section |
| --- | --- |
| 1. Preflight — Docker and Compose versions, root, disk, port conflicts | §1 |
| 2. Secrets — generates the master key ring and every password, then **verifies** the key is mode `0400` and owned by uid 10001 | §2 |
| 3. Configure — writes `HELM_PUBLIC_HOST` and `HELM_PUBLIC_URL` into `.env` | §3 |
| 4. Start — builds the images, then `docker compose up -d --wait` until every healthcheck passes | §4 |
| 5. Bootstrap — creates the tenant, the administrator and their local password, and mints the first data key through the KEK provider | §5 |

It finishes by exporting Caddy's root certificate to `./helm-root.crt` and
printing what is left to do.

### What it deliberately will not do

* **Overwrite an existing master key.** That is unrecoverable — every credential
  in the database becomes ciphertext nobody can read. A second run detects an
  existing install, skips ahead, and picks up where the first stopped.
* **Destroy a volume, drop a database, or force anything.** Every destructive
  operation stays something you type yourself.
* **Configure TLS trust or SSO.** Those need decisions a script cannot make —
  §6 and §5.2.

It is safe to re-run. If it stops halfway, fix what it complained about and run
it again.

### Unattended

Supply any answer as a flag to skip its prompt. With all of them and `--yes`,
it runs start to finish with no input — suitable for a provisioning tool:

```bash
sudo ./deploy/setup.sh --yes \
  --host        helm.internal.example.com \
  --tenant      "Northwind Managed Services" \
  --slug        northwind \
  --admin-email admin@northwind.example.com \
  --admin-name  "Dana Whitfield"
```

`sudo ./deploy/setup.sh --help` lists every option.

### Two things left when it finishes

1. **Trust the certificate.** `./helm-root.crt` has been exported for you;
   install it as a trusted root on each technician's machine, or browsers warn
   on every visit. Per-OS commands: **§6.1**.
2. **Make the name resolve** — an internal DNS A record, or a `hosts` entry on
   each machine. **§6.1**.

Then open `https://<your-host>/sign-in` and use the password the bootstrap
printed. Helm will make you change it.

### If something fails

The script stops at the first problem and says which one. **§9** maps the
common symptoms to causes. The reference manual below is the same five steps
done by hand, so you can pick up from wherever it stopped.

---

# Reference manual

The rest of this document is the long form: each step done manually, and the
operational material the Quick Start does not cover.

**Contents**

1. [Prerequisites](#1-prerequisites)
2. [Generate keys and passwords](#2-generate-keys-and-passwords)
3. [Configure `.env`](#3-configure-env)
4. [Start the stack](#4-start-the-stack)
5. [Bootstrap the first tenant and administrator](#5-bootstrap-the-first-tenant-and-administrator)
6. [TLS for an internal hostname or IP](#6-tls-for-an-internal-hostname-or-ip)
7. [Backup and restore](#7-backup-and-restore)
8. [Post-install verification](#8-post-install-verification)
9. [Troubleshooting](#9-troubleshooting)
10. [Reference](#10-reference)

---

## 1. Prerequisites

### 1.1 Software

| | Minimum | Why |
| --- | --- | --- |
| Docker Engine | 24.0 | BuildKit is the default builder |
| Docker Compose | **v2.20+** | `depends_on.condition: service_completed_successfully`, used to gate the app on migrations |
| `openssl` on the host | any | `deploy/init-secrets.sh` generates keys with it |
| Disk | 20 GB free | Images ≈ 2 GB; the rest is database, exports and backups |
| RAM | 4 GB | Postgres is configured for `shared_buffers=256MB`; Argon2id sign-in costs 64 MiB per concurrent attempt |

```bash
docker --version           # Docker version 24.x or newer
docker compose version     # Docker Compose version v2.20.x or newer
```

If `docker compose version` reports **v1.x** or the command is `docker-compose`
(with a hyphen), stop and upgrade. Compose v1 does not understand the
`depends_on` conditions this stack relies on, so at best it refuses the file and
at worst it starts the web tier before the migrations have finished — which
fails in a way that looks like a database problem.

### 1.2 The uid that matters

The runtime image runs as **uid 10001**, and that is not an implementation
detail you can ignore. Helm refuses to start from a master key file that any
other user on the host can read, so the key file must be owned by 10001 and
mode `0400`. `deploy/init-secrets.sh` does this for you — but it means the
script has to run as root, and it means two Docker configurations will fight
you:

> **Rootless Docker and `userns-remap` will break the key file.** Both remap
> container uids to a different range on the host, so the file you chowned to
> 10001 is not the 10001 the container sees, and Helm exits with a permission
> error on start-up. If you must run rootless, chown the key to the *host* uid
> that your remapping assigns to container uid 10001
> (`cat /etc/subuid` will tell you the base) rather than to 10001 literally.
> Standard rootful Docker needs none of this.

### 1.3 Volume mounts and permissions

Six named volumes and four bind mounts. The distinction is not cosmetic — it
decides what your backup tool sees.

**Named volumes** (Docker-managed, under `/var/lib/docker/volumes/`):

| Volume | Mounted into | Holds | Backup? |
| --- | --- | --- | --- |
| `lake-effect-helm_postgres-data` | postgres | The entire database | **Yes** — §7.2 |
| `lake-effect-helm_helm-passphrases` | worker *only* | Passphrases for encrypted export bundles | **Yes, separately** — §7.4 |
| `lake-effect-helm_helm-exports` | web, worker | Rendered export bundles | Optional; regenerable |
| `lake-effect-helm_helm-anchors` | web, worker | Witnessed audit chain heads | Yes, if you rely on anchoring |
| `lake-effect-helm_caddy-data` | caddy | Caddy's internal CA and issued certs | Yes — losing it reissues the CA, and every trusted root you distributed stops matching |
| `lake-effect-helm_caddy-config` | caddy | Caddy's autosaved config | No |

**Bind mounts** (files on your host, visible to your normal backup tooling):

| Host path | Mounted at | Mode | Notes |
| --- | --- | --- | --- |
| `deploy/secrets/master.key` | `/run/helm/master.key` | `0400`, uid 10001, read-only | The one file that makes the database readable |
| `deploy/postgres/10-roles.sh` | `/docker-entrypoint-initdb.d/` | read-only | Runs once, on first init |
| `deploy/Caddyfile`, `deploy/tls/` | `/etc/caddy/`, `/etc/helm/tls/` | read-only | Proxy config and your own certificate, if any |

Two rules that the whole design rests on:

* **The master key is a bind mount, not a Docker/Compose `secret:`.** Outside
  Swarm, Compose ignores the `uid`/`gid`/`mode` fields on a secret and the
  container simply sees the host file's permissions — so writing `mode: 0400`
  there would look like a control and be none. Helm enforces the mode itself at
  start-up instead, and the host file has to be right.
* **`helm-exports` and `helm-passphrases` must never land in the same backup
  archive.** An encrypted bundle and its passphrase travelling together is the
  same as an unencrypted bundle. If your backup tool sweeps every named volume
  into one tarball, exclude one of the two. See §7.4.

`deploy/secrets/` is in `.dockerignore`, so the master key never enters an
image layer even though `deploy/` is inside the build context.

### 1.4 Network and firewall

Only Caddy publishes ports. Postgres, the web tier and the worker are
reachable *only* on the internal Compose network.

| Port | Service | Purpose |
| --- | --- | --- |
| 80/tcp | caddy | Redirect to HTTPS only |
| 443/tcp | caddy | The application |

Override with `HELM_HTTP_PORT` / `HELM_HTTPS_PORT` in `.env` if 80 and 443 are
taken.

Outbound access is needed only for: pulling images (first run), your RMM/PSA
integrations, Microsoft Entra ID if you use SSO, and Let's Encrypt if you
choose public ACME. An air-gapped install works with `tls internal` and local
accounts.

---

## 2. Generate keys and passwords

*`deploy/setup.sh` does this, and verifies the result. Read on to do it by hand.*

```bash
git clone <your-fork> /opt/lake-effect-helm
cd /opt/lake-effect-helm
sudo ./deploy/init-secrets.sh
```

This writes exactly two things and refuses to overwrite either:

* **`deploy/secrets/master.key`** — a versioned JSON key ring, mode `0400`,
  owned by uid 10001:

  ```json
  {
    "current": "v1",
    "keys": { "v1": "<32 random bytes, base64>" }
  }
  ```

  Versioned from the start because rotating a bare key later means editing the
  file by hand. Adding `"v2"` and moving `"current"` is how §8 of the
  operations runbook rotates it.

* **`.env`** — every password and application secret, mode `0600`.

Confirm the permissions before going further; nothing downstream will:

```bash
stat -c '%a %u:%g %n' deploy/secrets/master.key
# 400 10001:10001 deploy/secrets/master.key
```

> **Back both files up off this host now, encrypted.** Without `master.key`
> the database is a pile of ciphertext and there is no recovery path — that is
> the design, not a gap in it. Without `.env` you will be rebuilding database
> roles by hand. §7 covers doing this properly; do it crudely right now
> regardless.

---

## 3. Configure `.env`

*`deploy/setup.sh` sets the two variables below for you; the rest is yours.*

Open `.env` and set the address people will actually type:

```ini
HELM_PUBLIC_HOST=helm.internal.example.com
HELM_PUBLIC_URL=https://helm.internal.example.com
```

These must agree with each other, with the certificate, and with what appears
in the browser's address bar. `AUTH_URL` is derived from `HELM_PUBLIC_URL`, and
an Auth.js callback that disagrees with the address bar fails in a way that is
tedious to diagnose.

Everything else has a working default. The settings you are most likely to
touch:

| Variable | Default | Change it when |
| --- | --- | --- |
| `HELM_TLS_DIRECTIVE` | `tls internal` | You have your own certificate — §6 |
| `HELM_HTTPS_PORT` | `443` | 443 is already in use on the host |
| `HELM_KEK_PROVIDER` | `local-keyfile` | You want the key off this host — see the Vault section of the operations runbook |
| `AUTH_MICROSOFT_ENTRA_ID_*` | empty | You are wiring SSO |
| `HELM_RESET_DELIVERY_URL` | empty | You want self-service password reset by email |

Leave `HELM_TRUSTED_PROXY_HOPS=1` alone unless you put another proxy in front
of Caddy. It is how Helm finds the real client address for rate limiting and
API-token IP allowlisting, counted from the *right* of `X-Forwarded-For`.

---

## 4. Start the stack

*`deploy/setup.sh` does this and waits for health. §4.2 is worth reading either way — it explains what each healthcheck proves.*

```bash
docker compose up -d --build
```

The first run builds two images and takes a few minutes. What happens, in
order — Compose enforces this with `depends_on`, so you do not have to:

```
postgres  ──(healthy)──▶  migrate  ──(exited 0)──▶  web  ──(healthy)──▶  caddy
                                               └──▶  worker
```

1. **postgres** initialises the data directory, runs `deploy/postgres/10-roles.sh`
   to create the five runtime roles *with* passwords, and starts.
2. **migrate** waits for postgres to be healthy, applies every file in
   `db/sql/` under an advisory lock, and exits 0. It records a SHA-256 of each
   applied file, so an edited migration is refused rather than silently
   diverging.
3. **web** and **worker** wait for migrate to have *completed successfully*,
   not merely started.
4. **caddy** waits for web to be **healthy**, so the first person to load the
   page does not get a 502 and conclude the install failed.

### 4.1 Watching it come up

```bash
docker compose ps
```

```
NAME                        STATUS
lake-effect-helm-postgres-1 Up 2 minutes (healthy)
lake-effect-helm-migrate-1  Exited (0) 2 minutes ago
lake-effect-helm-web-1      Up 1 minute (healthy)
lake-effect-helm-worker-1   Up 1 minute (healthy)
lake-effect-helm-caddy-1    Up 1 minute (healthy)
```

`migrate` showing **Exited (0)** is success, not a failure. It is a one-shot
job.

To block until everything is healthy rather than polling by eye:

```bash
docker compose up -d --wait --wait-timeout 300
```

### 4.2 The healthchecks, and what each one actually proves

Helm defines a custom check per service rather than taking the defaults,
because the default for most images is nothing at all. Each one is scoped to a
question with a useful answer:

| Service | Check | Proves | Does **not** prove |
| --- | --- | --- | --- |
| `postgres` | `pg_isready -U postgres -d helm` | The server accepts connections | That migrations ran |
| `web` | `GET /api/health`, requires `"status":"ok"` | HTTP is serving **and** the app pool reaches the database | That TLS works, or that Entra is configured |
| `worker` | `SELECT 1` as `helm_worker` | The database is reachable and the worker's own role still authenticates | That jobs are making progress |
| `caddy` | `wget https://127.0.0.1/api/health` with a `Host:` header | TLS terminates **and** Caddy can reach the web tier — the whole browser path | That clients trust the certificate |

Three details worth knowing, because each one was a bug before it was a
feature:

* **`web` checks the flag, not the status code.** `/api/health` deliberately
  answers `200` with `{"status":"degraded"}` when the database is unreachable,
  so that a load balancer can tell "this process is wedged" from "this process
  is fine, its dependency is not". A check that stopped at the status code
  would report the web tier healthy while it could not render a single page.

* **`worker` does not check that its process is alive.** The worker is PID 1 in
  its container, so if it dies the container dies and Docker restarts it — the
  container lifecycle already answers that question. The useful question is
  whether it can still reach the database, so that is what the check asks.

* **`caddy` skips certificate verification, on purpose.** With `tls internal`
  the certificate comes from Caddy's own CA, which nothing inside the container
  trusts. The check is asking "does the request path work", not "is this
  certificate trusted" — the second question is answered from a technician's
  browser (§8), not from inside the container.

### 4.3 An important limitation of Compose healthchecks

`restart: unless-stopped` restarts a container that **exits**. It does not
restart one that is merely **unhealthy**. A container can sit in
`Up (unhealthy)` indefinitely.

That is usually what you want here — a web tier that is up but cannot reach the
database should stay up and keep serving its health endpoint so you can see
*why*, rather than crash-looping and telling you nothing. But it means
**something has to be watching**. Point your monitoring at:

```bash
docker compose ps --format '{{.Service}} {{.Health}}'
```

or, for one service, a plain exit code you can alert on:

```bash
test "$(docker inspect --format '{{.State.Health.Status}}' lake-effect-helm-web-1)" = healthy
```

If you want automatic restarts on unhealthy, that is an orchestrator's job —
the image runs unchanged under Kubernetes or Nomad, both of which act on
liveness probes.

---

## 5. Bootstrap the first tenant and administrator

*`deploy/setup.sh` prompts for these values and runs this for you.*

The migrations leave a schema and nothing in it. Helm is fail-closed, so an
empty database is not half-working — every policy denies, and there is nobody
to sign in as.

The `bootstrap` service sits behind a Compose **profile**, so it never runs on
`up`. Run it once, by hand:

```bash
docker compose --profile bootstrap run --rm bootstrap \
  --tenant "Northwind Managed Services" \
  --slug   northwind \
  --admin-email admin@northwind.example.com \
  --admin-name  "Dana Whitfield"
```

### 5.1 What it does

```
key custody : master key in this process environment
provider    : local-keyfile
note        : this host can read the master key. A database compromise
              alone yields nothing usable, but root on this box can
              decrypt everything offline, with no record.

tenant      : Northwind Managed Services (northwind)
              6826b366-3d83-4b1d-84ba-1d69a3f4d50c
administrator: Dana Whitfield <admin@northwind.example.com>
              f89ec3cd-2db9-485d-b444-69aaf9b166f7
data key    : generation 1, wrapped by helm-master/v1

────────────────────────────────────────────────────────────────────────
  INITIAL PASSWORD — shown once, stored nowhere.

      admin@northwind.example.com
      quarry-silver-trestle-willow-kettle-51

  Sign in with it at /sign-in and change it immediately; Helm will
  insist. It is in this terminal's scrollback, so treat it as
  compromised the moment it has been used.
────────────────────────────────────────────────────────────────────────
```

Five things happen, and the order matters:

1. **Key custody is resolved first.** A misconfigured master key stops the
   bootstrap here, with a legible message, rather than after the tenant and the
   administrator exist and only the key mint fails.
2. The **MSP root tenant** is inserted on the superuser connection. `tenant` has
   no INSERT policy for any runtime role — deliberately, because creating an MSP
   is a deployment act, not something the application should ever do.
3. The **administrator** and a `super_admin` **membership** are created.
4. A **local password** is set, flagged must-change, and printed once.
5. The tenant's **first data key is minted through the KEK provider** — not
   inserted. This is the step that makes the key ring from §2 operational: a
   `tenant_data_key` row written by hand is a wrapped key nothing can unwrap,
   and the failure surfaces much later as "we cannot decrypt anything".

### 5.2 About the printed password

Use it now. It is flagged `must_change`, so Helm sends you straight to the
change-password screen on first sign-in and the account is not useful until you
have replaced it. It is also in your terminal's scrollback and possibly in a
session recording, which is reason enough on its own.

Keeping a local password on at least one administrator **after** you configure
SSO is the point of having local accounts at all: it is what gets you in when
Entra cannot be reached, which is precisely the outage in which you most need a
client's credentials. See [`../architecture/07-local-authentication.md`](../architecture/07-local-authentication.md).

### 5.3 Running it again

It refuses, by design:

```
tenant "northwind" already exists (Northwind Managed Services).
Bootstrap runs once; add further users through the application.
```

Add further tenants and users through the application, not by re-running this.

### 5.4 The other profiles

| Profile | Command | Purpose |
| --- | --- | --- |
| `bootstrap` | `docker compose --profile bootstrap run --rm bootstrap …` | First tenant and administrator |
| `maintenance` | `docker compose --profile maintenance run --rm rotate-kek --reason "…"` | Re-wrap every tenant DEK onto a new master key version |

---

## 6. TLS for an internal hostname or IP

**TLS is not optional.** In production Helm names its session cookie
`__Secure-authjs.session-token`, and browsers refuse to send a `__Secure-`
cookie over plain HTTP — with no error worth the name. Over HTTP, sign-in
appears to succeed and every subsequent page reports you as signed out. This is
intended behaviour for a credential vault, and it is why Caddy is a required
service rather than a convenience.

Three options, in the order most on-premises deployments should consider them.

### 6.1 Internal hostname + Caddy's own CA (the default)

Best for an internal network with no public DNS. `HELM_TLS_DIRECTIVE=tls internal`
makes Caddy mint a certificate from a CA it generates on first boot. No ACME,
no internet reachability, no certificate to renew.

**Step 1 — make the name resolve.** Add an A record on your internal DNS:

```
helm.internal.example.com.  IN  A  10.20.30.40
```

No internal DNS? A `hosts` entry on each technician's machine works, though it
does not scale:

```
10.20.30.40  helm.internal.example.com
```

**Step 2 — export Caddy's root certificate.**

```bash
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./helm-root.crt
```

**Step 3 — trust it on every machine that will use Helm.**

| OS | Command |
| --- | --- |
| Windows | `certutil -addstore -f Root helm-root.crt` (elevated), or push via Group Policy |
| macOS | `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain helm-root.crt` |
| Linux (Debian/Ubuntu) | `sudo cp helm-root.crt /usr/local/share/ca-certificates/helm-root.crt && sudo update-ca-certificates` |
| Linux (RHEL/Fedora) | `sudo cp helm-root.crt /etc/pki/ca-trust/source/anchors/ && sudo update-ca-trust` |
| Firefox | Trusts its own store — import under Settings → Privacy & Security → Certificates |

> **Back up `caddy-data`.** It holds that CA. Lose the volume and Caddy
> generates a *new* CA on next boot, at which point every root certificate you
> distributed stops matching and every browser shows a warning. §7.5.

### 6.2 Your own internal CA certificate

If you already run an internal PKI — which most MSPs do — issue Helm a
certificate from it and skip the trust distribution entirely, because your
machines already trust that root.

```bash
cp helm.crt helm.key deploy/tls/
chmod 0400 deploy/tls/helm.key
```

```ini
HELM_TLS_DIRECTIVE=tls /etc/helm/tls/helm.crt /etc/helm/tls/helm.key
```

```bash
docker compose up -d caddy
```

The certificate's subject or a SAN must match `HELM_PUBLIC_HOST` exactly.

### 6.3 IP address only, no DNS at all

Possible, and worth understanding before you choose it. Set both variables to
the address:

```ini
HELM_PUBLIC_HOST=10.20.30.40
HELM_PUBLIC_URL=https://10.20.30.40
```

Caddy's internal CA will issue a certificate with an IP SAN, and TLS works —
which means the `__Secure-` cookie works, which means sign-in works.

What you give up:

* **Entra SSO is effectively out.** Microsoft will not register a redirect URI
  on a bare IP for most tenant configurations. You will be on local accounts
  only, which is supported but leaves you with one door instead of two.
* **The address is baked into `AUTH_URL`.** Re-addressing the host means
  editing `.env` and restarting, not just updating DNS.
* **Certificate handling is clumsier.** Some clients treat IP-SAN certificates
  from a private CA less gracefully than hostnames.

A hostname — even one that only exists in a `hosts` file — costs you nothing
and avoids all three. Prefer §6.1.

### 6.4 Public hostname with Let's Encrypt

If the name is publicly resolvable and ports 80/443 reach this host from the
internet, set `HELM_TLS_DIRECTIVE=` (empty) and Caddy obtains and renews a
certificate automatically. Note what this implies: your credential vault is
reachable from the internet. Most MSPs should put it behind a VPN and use
§6.1 or §6.2 instead.

---

## 7. Backup and restore

### 7.1 What has to be backed up, and the rules

| # | Item | Where it lives | If you lose it |
| --- | --- | --- | --- |
| 1 | Database | `lake-effect-helm_postgres-data` | Everything, unless you have a dump |
| 2 | **Master key** | `deploy/secrets/master.key` (**bind mount, not a volume**) | Every credential is unrecoverable ciphertext. Permanently. |
| 3 | `.env` | repo root | Database roles must be rebuilt by hand |
| 4 | Export passphrases | `lake-effect-helm_helm-passphrases` | Existing encrypted bundles cannot be opened |
| 5 | Caddy CA | `lake-effect-helm_caddy-data` | Every distributed root certificate stops matching |
| 6 | Audit anchors | `lake-effect-helm_helm-anchors` | Historical chain heads lose their witness |

> **The master key is a file on your host, not a Docker volume.** A backup job
> that walks `docker volume ls` will not see it. This is the single most common
> way an on-premises Helm backup turns out to be worthless — the database
> restores perfectly and decrypts nothing.

Two separation rules that are part of the security design, not preferences:

* **(2) must not live on the same medium as (1).** The whole point of envelope
  encryption is that a stolen database dump yields nothing. Put the key backup
  somewhere the database backup is not.
* **(4) must not live in the same archive as `helm-exports`.** A bundle and its
  passphrase travelling together is an unencrypted bundle.

### 7.2 Backing up the database

Use a **logical dump**, not a copy of the volume. Copying `postgres-data` while
Postgres is running produces a torn, unrestorable directory; a dump is
transactionally consistent and needs no downtime.

```bash
docker compose exec -T postgres sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U postgres -d helm -Fc' \
  > "helm-$(date -u +%Y%m%dT%H%M%SZ).dump"
```

> **`PGPASSWORD` is not optional, and leaving it out fails confusingly.** This
> stack initialises Postgres with `--auth-local=scram-sha-256`, so even a
> superuser connection over the container's own socket needs a password —
> without it `pg_dump` prints `Password:` and, under `exec -T`, dies with
> `fe_sendauth: no password supplied`. Taking the value from the container's own
> `POSTGRES_PASSWORD` keeps the credential off your command line and out of your
> shell history. Every `psql` and `pg_dump` in this section does the same.

`-Fc` (custom format) is compressed, restores selectively, and is the format
`pg_restore` wants. A round trip preserves everything that matters — this was
verified, not assumed: identical row counts, **byte-identical wrapped DEKs**,
all 203 RLS policies, `FORCE ROW LEVEL SECURITY` still set, all 45 audit
partitions, and the column-level grant that keeps `helm_app` away from password
hashes.

You generally do **not** need `pg_dumpall --globals-only`: on a fresh stack,
`deploy/postgres/10-roles.sh` recreates the five roles from `.env` during
first-time initialisation. If you do capture globals anyway:

> **`pg_dumpall --globals-only` contains credentials.** It emits
> `ALTER ROLE … PASSWORD 'SCRAM-SHA-256$4096:…'` for every role. Protect that
> file exactly as you protect `.env`; do not drop it somewhere your database
> dumps live if those are less carefully guarded.

### 7.3 Backing up the key and `.env`

```bash
tar czf helm-secrets.tar.gz deploy/secrets/master.key .env
gpg --symmetric --cipher-algo AES256 helm-secrets.tar.gz
rm helm-secrets.tar.gz
# Store helm-secrets.tar.gz.gpg OFF this host.
```

These change only when you rotate something, so this is not a nightly job — but
re-run it after every key rotation and every password change, and verify you
can decrypt it.

### 7.4 Backing up the volumes

The pattern for any named volume — mount it into a throwaway container
alongside a host directory:

```bash
mkdir -p ./backups

# Passphrases — its OWN archive, on its OWN backup set.
docker run --rm \
  -v lake-effect-helm_helm-passphrases:/src:ro \
  -v "$PWD/backups:/dst" \
  alpine tar czf /dst/passphrases.tar.gz -C /src .

# Caddy's CA.
docker run --rm \
  -v lake-effect-helm_caddy-data:/src:ro \
  -v "$PWD/backups:/dst" \
  alpine tar czf /dst/caddy-data.tar.gz -C /src .

# Audit anchors.
docker run --rm \
  -v lake-effect-helm_helm-anchors:/src:ro \
  -v "$PWD/backups:/dst" \
  alpine tar czf /dst/anchors.tar.gz -C /src .
```

`helm-exports` is deliberately absent. Export bundles are regenerable from the
database and are the one thing that must not sit next to `passphrases.tar.gz`.
If you do back it up, send it to a different destination.

### 7.5 A complete nightly script

```bash
#!/usr/bin/env bash
# /opt/lake-effect-helm/backup.sh — run from cron as root.
set -euo pipefail
cd /opt/lake-effect-helm

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DEST=/backup/helm/$STAMP            # database + volumes
VAULT=/backup/helm-keys             # SEPARATE medium — see §7.1
mkdir -p "$DEST" "$VAULT"

# 1. Database (online, consistent)
docker compose exec -T postgres sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U postgres -d helm -Fc' > "$DEST/helm.dump"

# 2. Volumes, passphrases in their own archive
for vol in helm-passphrases caddy-data helm-anchors; do
  docker run --rm -v "lake-effect-helm_$vol:/src:ro" -v "$DEST:/dst" \
    alpine tar czf "/dst/$vol.tar.gz" -C /src .
done

# 3. Key material, encrypted, to the OTHER medium
tar czf - deploy/secrets/master.key .env \
  | gpg --batch --yes --symmetric --cipher-algo AES256 \
        --passphrase-file /root/.helm-backup-pass \
        -o "$VAULT/secrets-$STAMP.tar.gz.gpg"

chmod -R 0600 "$DEST"/* "$VAULT"/*
find /backup/helm -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +
echo "backup complete: $DEST"
```

### 7.6 Restoring onto a fresh host

Order matters. Doing this in the wrong order is recoverable, but only if you
still have the backups.

```bash
# 1. Repo and secrets FIRST. The roles are created from .env during the
#    database's first-time initialisation, so .env must be in place before
#    Postgres ever starts.
git clone <your-fork> /opt/lake-effect-helm
cd /opt/lake-effect-helm
gpg -d /backup/helm-keys/secrets-<STAMP>.tar.gz.gpg | tar xzf -

# 2. Permissions. Restoring from an archive does not preserve these reliably.
sudo chown 10001:10001 deploy/secrets/master.key
sudo chmod 0400 deploy/secrets/master.key
sudo chmod 0600 .env

# 3. Bring up ONLY the database, so migrate does not race the restore.
docker compose up -d --build postgres
docker compose ps postgres          # wait for (healthy)

# 4. Restore into the database the init created.
docker compose exec -T postgres sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql -U postgres -d postgres \
     -c "DROP DATABASE IF EXISTS helm WITH (FORCE);" \
     -c "CREATE DATABASE helm;"'
docker compose exec -T postgres sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore -U postgres -d helm --exit-on-error' \
  < /backup/helm/<STAMP>/helm.dump

# 5. Volumes.
for vol in helm-passphrases caddy-data helm-anchors; do
  docker run --rm -v "lake-effect-helm_$vol:/dst" \
    -v "/backup/helm/<STAMP>:/src:ro" \
    alpine sh -c "rm -rf /dst/* && tar xzf /src/$vol.tar.gz -C /dst"
done

# 6. Everything else. `migrate` will find every migration already applied
#    and no-op.
docker compose up -d --build
```

`--exit-on-error` on step 4 is deliberate: without it `pg_restore` reports
errors and carries on, and a half-restored credential vault that *looks*
restored is worse than a failed restore.

**If `pg_restore` fails with `role "helm_app" does not exist`**, you restored
into a cluster whose roles were never created — the data volume was not
initialised from your `.env`. Drop the volume, let step 3 run again with the
restored `.env` in place, and retry.

### 7.7 Verifying a restore

Do not declare victory on an absence of errors. Check the things that would be
silently wrong:

```bash
# Row counts and schema objects are all present.
docker compose exec -T postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U postgres -d helm -tAc "$0"' "
SELECT 'tenants='  || (SELECT count(*) FROM tenant)
    || ' users='   || (SELECT count(*) FROM app_user)
    || ' keys='    || (SELECT count(*) FROM tenant_data_key)
    || ' policies='|| (SELECT count(*) FROM pg_policies WHERE schemaname='public');"

# The privilege boundaries survived. Both MUST print false.
docker compose exec -T postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U postgres -d helm -tAc "$0"' "
SELECT has_table_privilege('helm_app','secret_version','SELECT'),
       has_column_privilege('helm_app','local_credential','password_phc','SELECT');"

# The audit hash chain is intact. Needs a session context, inside a
# transaction — verify_audit_chain() refuses to read another tenant's chain.
# (\o /dev/null hides the context blob set_session_context echoes back.)
docker compose exec -T postgres sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql -U postgres -d helm -tAq' <<'SQL'
BEGIN;
\o /dev/null
SELECT helm.set_session_context(t.id, m.user_id)
FROM tenant t JOIN membership m ON m.tenant_id = t.id LIMIT 1;
\o
SELECT t.slug, v.is_intact, v.verified_rows
FROM tenant t, LATERAL helm.verify_audit_chain(t.id) v;
ROLLBACK;
SQL
# northwind|t|1     <- is_intact must be t
```

Then the only test that really counts — **reveal a secret in the UI**. That
exercises the database, the master key and the envelope decryption in one
action. A restore where the database came back but the key did not will pass
every check above and fail this one.

> **Rehearse it.** A backup you have never restored is a hypothesis. Restore
> into a scratch host once a quarter and reveal a secret. Every organisation
> that has lost data to a bad backup had a backup job that reported success.

---

## 8. Post-install verification

Work down the list; each step depends on the one before.

```bash
# 1. Everything healthy, migrate exited 0.
docker compose ps

# 2. The app answers, and its database is reachable.
docker compose exec -T web node -e \
  "fetch('http://127.0.0.1:3000/api/health').then(r=>r.json()).then(j=>console.log(j))"
# {"status":"ok","database":"ok","time":"..."}

# 3. TLS terminates and the proxy reaches the app.
curl -sS https://helm.internal.example.com/api/health
# If this fails with a certificate error, §6 step 3 is incomplete —
# add -k to confirm the path works, then fix the trust.

# 4. Migrations all applied.
docker compose run --rm migrate node_modules/.bin/tsx db/migrate.ts --status

# 5. The worker is running its jobs.
docker compose logs worker --since 10m | grep -E 'job|lock' | tail
```

**6. Sign in.** Open `https://helm.internal.example.com/sign-in`, use the
address and password the bootstrap printed, change the password when prompted.
If sign-in appears to succeed but every page says you are signed out, you are
on HTTP — see §6.

**7. Store a credential and reveal it.** This is the end-to-end proof that the
master key is wired correctly. Until you have done it, the KEK configuration is
untested.

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `web` exits: `refusing to read a key file that is group- or world-readable` | Key file mode or owner is wrong | `sudo chown 10001:10001 deploy/secrets/master.key && sudo chmod 0400 …` — and re-read §1.2 if you run rootless Docker |
| Sign-in succeeds, every page says signed out | Reached over HTTP; the browser dropped the `__Secure-` cookie | Use HTTPS. §6 |
| Browser certificate warning | Caddy's internal root is not trusted on that machine | §6.1 step 3 |
| Certificate warnings return after a rebuild | `caddy-data` was recreated, so the CA is new | Restore `caddy-data`, or redistribute the new root. §7.4 |
| `web` is `Up (unhealthy)`, logs show connection refused | Postgres is down or the password in `.env` no longer matches the role | `docker compose logs postgres`; §9.1 |
| `caddy` is unhealthy but the site works in a browser | Its healthcheck could not run — see §9.2 | §9.2 |
| `migrate` exits non-zero: `checksum mismatch` | A migration file was edited after being applied | Never edit an applied migration; add a new one |
| `pg_restore`: `role "helm_app" does not exist` | Restored into a cluster initialised without your `.env` | §7.6 |
| Bootstrap: `tenant "…" already exists` | It already ran | Working as intended — add users in the app |
| Entra sign-in loops back to `/sign-in` | Redirect URI or `HELM_PUBLIC_URL` mismatch | Both must be exactly `https://<host>/api/auth/callback/microsoft-entra-id` and `https://<host>` |
| Everything is healthy, reveal fails with a decryption error | Database and master key are from different generations | Restore the matching key. There is no other recovery. |

### 9.1 Rotating a database password

The passwords in `.env` are consumed **only** when the Postgres volume is first
initialised. Changing one in `.env` later does not change it in the database —
it just makes the two disagree, and the service that uses that role starts
failing to authenticate. Change both:

```bash
docker compose exec -T postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -U postgres \
  -c "ALTER ROLE helm_app WITH PASSWORD '"'"'new-value'"'"';"'
sed -i 's/^HELM_DB_PASSWORD_APP=.*/HELM_DB_PASSWORD_APP=new-value/' .env
docker compose up -d web worker
```

### 9.2 If the `caddy` healthcheck is wrong about you

The check runs `wget --no-check-certificate` inside the Caddy container. Alpine's
BusyBox build supports that flag; if yours does not, the container reports
unhealthy while the site works perfectly — and because `caddy` is what `web`'s
consumers reach, an unhealthy Caddy is alarming for no reason.

Confirm which it is:

```bash
docker compose exec caddy wget --no-check-certificate -q -O - \
  --header="Host: $HELM_PUBLIC_HOST" https://127.0.0.1/api/health
```

If that prints the health JSON, the check is fine and something else is wrong.
If it errors on the *flag*, replace the `caddy` healthcheck in
`docker-compose.yml` with a listener check, which needs nothing but `grep`:

```yaml
    healthcheck:
      # 0x01BB = 443. Proves Caddy is listening; does not prove it can reach web.
      test: ["CMD-SHELL", "grep -qE ':01BB ' /proc/net/tcp /proc/net/tcp6 2>/dev/null"]
```

### 9.3 Reading logs

```bash
docker compose logs -f web worker          # follow both
docker compose logs --since 1h caddy       # proxy access log, JSON
docker compose exec -T postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" \
  psql -U postgres -d helm -c "SELECT * FROM pg_stat_activity WHERE state <> '"'"'idle'"'"';"'
```

Helm logs JSON at `HELM_LOG_LEVEL` (default `info`). Set `debug` in `.env` and
`docker compose up -d web worker` to raise it. Secrets are never logged —
plaintext credentials do not appear in any log line at any level, by design.

---

## 10. Reference

### Commands

```bash
sudo ./deploy/setup.sh                             # the whole install, start to finish
sudo ./deploy/setup.sh --help                      # every non-interactive option

docker compose up -d --build                       # build and start everything
docker compose up -d --wait --wait-timeout 300     # ...and block until healthy
docker compose ps                                  # status and health
docker compose logs -f web worker                  # follow logs
docker compose down                                # stop, keep all data
docker compose down -v                             # stop and DESTROY every volume
docker compose pull && docker compose up -d --build # upgrade
docker compose --profile bootstrap   run --rm bootstrap  --tenant … --slug … --admin-email …
docker compose --profile maintenance run --rm rotate-kek --reason "quarterly rotation"
```

`docker compose down -v` deletes the database, the passphrases and Caddy's CA.
It does **not** delete `deploy/secrets/master.key`, because that is a bind
mount — which is exactly why a "clean slate" that keeps the key still cannot
read the old data.

### Ports

| Port | Service | Configurable via |
| --- | --- | --- |
| 80 | caddy → redirect | `HELM_HTTP_PORT` |
| 443 | caddy → web:3000 | `HELM_HTTPS_PORT` |
| 5432 | postgres (internal only) | — |
| 3000 | web (internal only) | — |

### Paths inside containers

| Path | Service | Source |
| --- | --- | --- |
| `/run/helm/master.key` | web, worker, bootstrap, rotate-kek | bind mount |
| `/var/lib/helm/exports` | web, worker | `helm-exports` |
| `/var/lib/helm/passphrases` | **worker only** | `helm-passphrases` |
| `/var/lib/helm/anchors` | web, worker | `helm-anchors` |
| `/data/caddy/pki/authorities/local/root.crt` | caddy | `caddy-data` |

### Further reading

| Document | |
| --- | --- |
| [`on-premises.md`](on-premises.md) | Operations runbook: key rotation, Vault custody, storage, upgrades |
| [`../architecture/01-security-model.md`](../architecture/01-security-model.md) | Guarantees, mechanisms and stated limitations |
| [`../architecture/03-crypto-operations.md`](../architecture/03-crypto-operations.md) | Key hierarchy and both on-premises KEK providers |
| [`../architecture/07-local-authentication.md`](../architecture/07-local-authentication.md) | Local passwords, lockout, reset, the outage case |
| [`../architecture/08-radius-authentication.md`](../architecture/08-radius-authentication.md) | RADIUS: the third door, shared-secret custody, graceful fallback |
| `.env.example` | Every variable, with the reasoning |
