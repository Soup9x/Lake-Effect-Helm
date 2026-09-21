# Running Lake Effect Helm on an on-premises server

A working install from a bare host, and the operational facts that come with
holding every client's credentials on a machine you own.

Read §1 and §2 before running anything. The rest can be followed in order.

> Installing for the first time? [`docker-on-prem.md`](docker-on-prem.md), next
> to this file, is the step-by-step Docker walkthrough — volume permissions,
> healthchecks, the bootstrap profile, TLS for an internal name, and verified
> backup and restore procedures. Come back here for the operational decisions:
> where the master key lives, how to rotate it, and what to back up.

---

## 1. What you are signing up for

Helm encrypts every credential with a per-tenant data key, and those keys are
themselves wrapped by a master key. **Where that master key lives is the single
decision that determines what a breach costs you**, and on-premises there are
two honest answers:

| | `local-keyfile` | `vault-transit` |
| --- | --- | --- |
| Master key lives | In a file on this host | Inside HashiCorp Vault, on another host |
| Stolen database dump | Useless. Ciphertext and wrapped keys. | Useless. Same. |
| Root on the Helm host | **Reads the key. Decrypts everything offline. No record, no revocation.** | Can use Helm's Vault token until it is revoked. Every unwrap is a Vault audit entry. |
| Extra service to run | None | Vault |

`local-keyfile` is the default in this compose stack because it works on one
box with nothing else to keep alive, and for many single-server MSP deployments
that trade is correct. Make it knowingly. If the answer to "could someone with
root on the app server read every client's domain admin password" has to be
"no", you need §9.

Two more things that are true of this deployment regardless:

- **TLS is mandatory.** In production Helm's session cookie carries the
  `__Secure-` prefix, and browsers will not send those over plain http. Without
  the proxy in front, sign-in appears to work and every page then reports you
  as signed out. The stack includes Caddy for this reason.
- **Losing the master key is unrecoverable.** There is no escrow and no reset.
  That is the design. Back it up (§3) before you put real data in.

---

## 2. Prerequisites

The bundled Compose stack is the shortest path, not the only one. This section
separates what Helm needs from *any* environment from what the bundled stack
happens to provide, so you can run it against managed Postgres, behind your own
reverse proxy, or under a scheduler that is not Compose.

### 2.1 What Helm requires, however you run it

- **PostgreSQL 16 or newer.** Not negotiable: Helm depends on
  `security_invoker` views and on 16's partition-wise behaviour for the audit
  log. 15 and earlier will not work.
- **Six database roles** — `helm_app`, `helm_auth`, `helm_key_admin`,
  `helm_auditor`, `helm_worker`, and a migrating role. None may hold
  `BYPASSRLS`. `deploy/postgres/10-roles.sh` creates them with passwords and
  asserts that; run it, or reproduce it, against any cluster you bring.
- **A migrating role that row-level security does not apply to.** Every
  sensitive table is `FORCE ROW LEVEL SECURITY`, which subjects the table owner
  to its own policies, and `SECURITY DEFINER` functions run as whoever owns
  them. Migrate as a role RLS applies to and `helm.reveal_secret()` returns
  NULL rather than the credential — silently. `db/migrate.ts` refuses to start
  in that case rather than letting it happen;
  [`../architecture/01-security-model.md`](../architecture/01-security-model.md)
  §6 has the detail.
- **A master key**, from HashiCorp Vault's transit engine or a key file this
  host can read and nobody else can. §1 is the decision, §9 is the Vault path.
- **TLS in front of the application.** In production the session cookie is
  `__Secure-` prefixed and browsers will not send it over plain http, so
  without a terminator sign-in appears to succeed and every page then reports
  you signed out. Caddy is in the bundled stack for this; your own proxy,
  ingress or load balancer does just as well.
- **Node 22 or newer** if you are running the application outside the bundled
  images.
- **`openssl`**, for key generation.

Sizing: 4 GB RAM, 2 vCPU and 20 GB disk to start. The audit log is partitioned
monthly and nothing prunes it automatically.

### 2.2 What the bundled stack adds

- Linux host with Docker Engine 24+ and the Compose plugin v2.20+ — earlier
  Compose does not understand `service_completed_successfully`, which is how
  the web tier waits for migrations.
- Root (or sudo) for the first-run script: it chowns the master key to the
  container's uid.
- A DNS name that resolves to the host on your internal network. An IP works;
  §6.3 of the install guide covers what you give up.

[`docker-on-prem.md`](docker-on-prem.md) is the step-by-step walkthrough for
that path, including `deploy/setup.sh`, which does all of §3, §4 and §6 below
in one command.

### 2.3 What the UniFi Network integration requires

Optional — skip this unless you intend to document clients' UniFi networks.

**`HELM_BLIND_INDEX_KEY_B64` must be set.** Everywhere else in Helm it is
optional: leave it unset and you decline password-reuse detection along with the
offline-verification tradeoff it carries. **This integration does not work
without it.** A synced device is recognised between polls by the blind index of
its MAC address, and that index is the upsert key — with no key to compute it,
there is no way to tell a device seen before from a new one. The sync worker
refuses to poll anything and logs why once per run, rather than filling the
inventory with duplicates. `deploy/init-secrets.sh` generates it, so a deployment
built with the bundled scripts already has one.

**Each controller needs:**

- **UniFi Network 9.x or later on UniFi OS 9.3.43 or later.** The Integration
  API does not exist below that, and an older console answers 404 on every path
  Helm uses. Check under Settings → System.
- **An API key**, created on the console under Settings → Control Plane →
  Integrations → API Keys. Paste it into Helm once; it is stored in the vault
  with every other credential and read back through the audited reveal path, so
  it never needs re-entering to change a setting.
- **Network reachability from the Helm server** — same LAN, a routed link, or a
  VPN. Helm talks to the console directly and never through Ubiquiti's cloud.
- **Its certificate accepted, once.** A self-hosted console presents a
  self-signed certificate; that is the product's default, not a
  misconfiguration. Run the connection test in Helm, compare the SHA-256
  fingerprint it shows against the console, and accept it. That pins **that one
  certificate for that one controller**, recorded against your name — it is not
  a global "ignore TLS" switch, and Helm does not have one. If the console is
  later rebuilt, the next poll fails loudly rather than trusting whatever
  answered.

Helm **reads**. It never adopts, restarts or reconfigures anything, so the API
key does not need write scope.

Configuring a controller needs the `integration:network:manage` permission,
which Tier 3 holds. It is deliberately separate from `tenant:write`, so a senior
technician can be trusted with a client's network gear without also being handed
the MSP's authentication settings and key custody.

**Live events (optional).** Helm can also accept events pushed by the console,
which shortens the gap between a device changing state and Helm noticing from
minutes to seconds. It is a convenience and nothing depends on it:

- Turn it on per controller from the settings card. Helm generates a signing
  secret, shows it **once**, and gives you a callback URL to paste into the
  console alongside it.
- **There is no environment variable for the secret.** It is generated per
  controller and stored encrypted; the callback URL is derived from the address
  you reach Helm on.
- The controller must be able to reach Helm over HTTPS — the reverse of the
  polling direction, so a one-way firewall rule that allows polling may not
  allow this.
- If the card says **"Live events unavailable"**, that console does not offer
  webhook registration. Nothing is wrong and nothing is missing: polling covers
  everything and is unaffected. Some consoles have a manual webhook or
  alert-forwarding setting you can point at the callback URL instead.
- Turning live events off revokes the secret, so one pasted into a console
  stops working immediately.

Full design: [`../architecture/11-network-integration.md`](../architecture/11-network-integration.md).

---

## 3. Generate keys and passwords

```bash
git clone <your repository> /opt/lake-effect-helm && cd /opt/lake-effect-helm
sudo ./deploy/init-secrets.sh
```

The path is an example; the script operates on the repository it lives in and
writes nothing outside it. It produces two files and refuses to overwrite
either:

- **`deploy/secrets/master.key`** — a versioned key ring, mode `0400`, owned by
  the uid Helm runs as (10001 in the bundled images).
- **`.env`** — every database password, `AUTH_SECRET`, and the blind-index key,
  mode `0600`.

The permissions are not cosmetic. **Helm refuses to start from a key file that
is group- or world-readable**, which includes the `0444` that `docker secret`
produces by default — the script sets the mode and the owner so this is not
something you have to get right by hand.

Running Helm yourself rather than in the bundled images? The key ring is an
ordinary file: put it wherever your service account can read it and nobody else
can, and point `HELM_KEK_FILE` at it. The mode check is on the file, not on any
particular path — and `chown` it to whatever user your service runs as, not to
10001.

The key ring is versioned JSON rather than a bare key, so rotating the master
key later is an operation instead of a data-loss event (§8).

### Back it up now

```bash
# Somewhere off this host, encrypted, that is not the same backup set
# as the database.
sudo tar czf - deploy/secrets/master.key .env | \
  gpg --symmetric --cipher-algo AES256 -o helm-keys-$(date +%F).tar.gz.gpg
```

Without `master.key` the database is a pile of ciphertext. There is no recovery
path, by design — an escrow would be a second copy of the key with weaker
controls than the first.

---

## 4. Configure and start

Edit `.env` and set the two values the script cannot guess:

```ini
HELM_PUBLIC_HOST=helm.internal.example.com
HELM_PUBLIC_URL=https://helm.internal.example.com
```

They must match the certificate and what people type in a browser — an Auth.js
callback that disagrees with the address bar fails in a way that wastes an
afternoon.

`HELM_PUBLIC_URL` is what Helm builds absolute links from — password-reset
links most of all, which are useless as bare paths. `AUTH_URL` alone also
works; `HELM_PUBLIC_URL` wins when both are set. `HELM_PUBLIC_HOST` is used by
the bundled Caddy configuration.

### With the bundled stack

```bash
docker compose up -d
docker compose logs -f migrate   # should exit 0
```

On first start, in order: Postgres initialises and creates the runtime roles
with passwords; the `migrate` service applies every SQL migration and exits;
the web tier and worker start once it has.

### Running it yourself

The same three steps in the same order, with your own supervisor:

```bash
pnpm install --frozen-lockfile
pnpm build && pnpm build:worker

pnpm db:migrate        # as the migrating role — see §2.1
pnpm start             # the web tier
pnpm helm:worker       # the worker, as a separate service
```

`db:migrate` must run to completion before either process starts, and must run
as a role row-level security does not apply to. Put your reverse proxy,
ingress or load balancer in front of the web tier and terminate TLS there;
Helm reads the client address from `X-Forwarded-For` according to
`HELM_TRUSTED_PROXY_HOPS`, which must match how many entries your
infrastructure appends.

### The certificate

Whatever terminates TLS has to present a certificate the browsers trust, or
sign-in fails in the confusing way §2.1 describes. The bundled Caddy covers
four cases — its own internal CA, your own internal CA, an IP address with no
DNS at all, and a public name via Let's Encrypt — in
[`docker-on-prem.md`](docker-on-prem.md) §6. With your own terminator, this is
whatever you already do for an internal service.

---

## 5. Sign-in: two doors, and why you want both

Helm has two ways in, and the second one is not a fallback you hope never to
use — it is the one that works on the morning the first one does not.

| | Microsoft Entra ID | Local password |
|---|---|---|
| Everyday use | Yes, this is the default | No |
| Works when Entra is down | No | **Yes** |
| Revocation | Immediate (database session) | Immediate (same session) |
| MFA | Whatever Entra enforces | Helm's step-up, where configured |

Both produce **the same session**: one row in `auth_session`, one cookie, one
resolver. Nothing downstream can tell which door somebody came through, so
"this technician left, cut their access now" means the same thing either way.

### 5.1 Entra

Register an application in Entra, then set in `.env`:

```ini
AUTH_MICROSOFT_ENTRA_ID_ID=<application (client) id>
AUTH_MICROSOFT_ENTRA_ID_SECRET=<client secret>
AUTH_MICROSOFT_ENTRA_ID_ISSUER=https://login.microsoftonline.com/<tenant id>/v2.0
```

The redirect URI to register is:

```
https://helm.internal.example.com/api/auth/callback/microsoft-entra-id
```

Then `docker compose up -d web`.

Entra answers *who* somebody is and nothing else. Their role, their
organisation scope and every permission come from the `membership` row in
Helm's own database — so a person who authenticates successfully but has no
membership is told exactly that, rather than being bounced through a login loop.

### 5.2 Local passwords

Nothing to configure. The bootstrap command in §6 sets one on the first
administrator and prints it once; after that, an administrator with `user:write`
issues them for colleagues.

What is enforced, so you do not have to:

* **Argon2id**, `m=65536, t=3, p=1` — about a quarter of a second per
  verification, which is a deliberate trade against offline cracking. The
  parameters live inside each stored hash, so raising them later upgrades
  existing passwords on their owners' next sign-in rather than forcing a reset.
* **Twelve characters minimum**, no password containing the person's own name
  or email address, no reuse of the last five, and a rejection of the handful of
  passwords that get typed into a new deployment on its first day.
* **Lockout after five wrong attempts**, backing off exponentially to a
  fifteen-minute ceiling. It never becomes permanent: a lock an attacker can
  trigger on demand is a denial of service against the break-glass account, and
  attempts made *while* locked do not extend it.
* **Rate limiting per account and per source address** (ten and thirty failures
  in fifteen minutes). Both live in PostgreSQL, not a cache — this stack ships
  no cache tier, and a rate limit that stops limiting when a cache is unavailable
  is not a rate limit.
* An administrator holding `user:write` can clear a lockout without changing the
  password, which during an outage is considerably faster than a reset.

### 5.3 Resets, and why email is the *secondary* path

Your mail is almost certainly Microsoft 365. The outage that takes out Entra
takes out the mailbox a reset email would land in. So the primary reset path
does not touch email at all:

**An administrator issues a code and reads it to the person.** In the UI, or:

```bash
curl -sS https://helm.internal.example.com/api/auth/local/reset \
  -H 'content-type: application/json' \
  -b "$COOKIE" \
  -d '{"email":"tech@northwind.example.com","outOfBand":true}'
```

The response contains a single-use link, shown once. Read it down the phone —
do not paste it into a ticket.

Self-service reset by email is available on top, if you point Helm at something
that can send mail:

```ini
HELM_RESET_DELIVERY_URL=https://mail-relay.internal.example.com/send
```

With that unset, the self-service endpoint **refuses** rather than accepting the
request and silently dropping the mail. A form that says "check your email" when
nothing was sent produces a support call and somebody who believes they are
locked out permanently.

Redeeming a reset **deletes every session on that account**, including any the
previous password was holding open.

### 5.4 Behind a reverse proxy

The per-address rate limit needs the client's real address, and it reads it the
same way API token IP allowlisting does — `HELM_TRUSTED_PROXY_HOPS`, counted
from the **right** of `X-Forwarded-For`:

```ini
HELM_TRUSTED_PROXY_HOPS=1
```

One, for the Caddy in this stack. Raise it if you have another proxy in front.
Counting from the right is the point: the leftmost entry is whatever the client
sent, and an attacker who controls it controls which bucket their attempts count
against — which would defeat the per-address limit entirely.

### 5.5 TLS is not optional for this

In production Helm writes its session cookie as `__Secure-authjs.session-token`.
Browsers refuse a `__Secure-` cookie over plain http, with no useful error. A
production Helm reached over http therefore cannot hold a session at all — sign
-in appears to succeed and every subsequent page is anonymous. That is intended
for a credential vault, and it is why §4 terminates TLS in front of the app.

### `HELM_DEV_SESSION_EMAIL`

There is a development bypass that runs every request as a named user. It
**throws on startup when `NODE_ENV=production`**, which is what this stack runs,
so it cannot be used here — it exists for evaluating Helm on a laptop. Mentioned
so that finding it in `.env.example` does not look like a back door you missed.

---

## 6. Create the first tenant and administrator

The migrations leave a schema and nothing in it. Helm is fail-closed, so an
empty database is not half-working — every policy denies and there is nobody to
sign in as.

With the bundled stack:

```bash
docker compose --profile bootstrap run --rm bootstrap \
  --tenant "Northwind Managed Services" \
  --slug northwind \
  --admin-email admin@northwind.example.com \
  --admin-name "Dana Whitfield"
```

Running it yourself — the same command, the same arguments, one process:

```bash
pnpm helm:bootstrap \
  --tenant "Northwind Managed Services" \
  --slug northwind \
  --admin-email admin@northwind.example.com \
  --admin-name "Dana Whitfield"
```

It holds its own connection rather than going through the pool registry in
`src/lib/db/client.ts`: that registry is the product's privilege separation,
and a superuser sitting in it would be reachable from anything calling `db()`.

It creates the MSP root tenant, a `super_admin` user, their membership, and —
the part that matters — **mints the tenant's first data key through the KEK
provider**. A `tenant_data_key` row inserted by hand is a wrapped key nothing
can unwrap, and that failure only surfaces the first time someone stores a
password.

It also sets a **local password** on that administrator and prints it once:

```
────────────────────────────────────────────────────────────────────────
  INITIAL PASSWORD — shown once, stored nowhere.

      admin@northwind.example.com
      quarry-silver-trestle-willow-kettle-51

  Sign in with it at /sign-in and change it immediately; Helm will
  insist.
────────────────────────────────────────────────────────────────────────
```

Use it now. It is flagged must-change, so Helm sends you to the change-password
screen on first sign-in and the account is not useful until you have replaced
it. It is also sitting in your terminal's scrollback, which is reason enough.

Keeping a local password on at least one administrator after that is the point
of §5 — it is what gets you in when Entra cannot be reached.

It refuses to run twice against the same slug.

The email must match what Entra will assert for that person. Helm compares
case-insensitively (the column is `citext`, deliberately — with plain text
`Alice@` and `alice@` become two accounts, which in a credential vault is an
account-takeover primitive).

Background worker identities are provisioned automatically by trigger when the
tenant is created. You should see four in **Settings → Background worker
identities** after signing in.

---

## 7. Storage, and the two separations that matter

Four volumes hold state that is not the database:

```
helm-exports       rendered export bundles, encrypted when they hold credentials
helm-passphrases   the passphrases for those bundles
helm-anchors       witnessed audit chain heads
helm-documents     client documents, always encrypted
```

**Exports and passphrases must not share a backup set.** A credential bundle is
encrypted with a passphrase generated at render time and stored nowhere in the
database — that is what makes the file at rest useless to anyone who only has
the file. If your backup tool sweeps every named volume into one archive, that
property is gone. Exclude one of the two, or point them at separate mounts:

```yaml
volumes:
  helm-exports:
    driver_opt: { type: none, device: /srv/helm/exports, o: bind }
  helm-passphrases:
    driver_opt: { type: none, device: /mnt/keysafe/helm-passphrases, o: bind }
```

The passphrase volume is mounted into the **worker only**. The web tier serves
downloads and never needs it; mounting it there would put the file and its key
on the same side of every boundary.

**The anchor volume is only as good as the storage behind it.** Helm's audit log
is a per-tenant hash chain, which proves nobody edited history without
rewriting everything after it. It does *not* prove the whole chain was not
rewritten by someone with database ownership — which, on a box your own staff
administer, is precisely the party an audit log most needs to bind. Anchoring
closes that by writing the chain head somewhere Helm cannot alter. A Docker
volume the container can rewrite is **not** a witness. Point it at a WORM mount,
an append-only share, or a path your backup system snapshots:

```yaml
  helm-anchors:
    driver_opt: { type: none, device: /mnt/worm/helm-anchors, o: bind }
```

Left as an ordinary volume, the anchoring job still verifies the chain hourly
and logs the head — which is worth having — but the receipt proves less than it
appears to. **Settings → Audit** shows how many events are currently protected
only by the database.

### 7.1 Client documents

Files uploaded against a client — contracts, network diagrams, install notes —
are written to `helm-documents` under opaque, randomly-named, two-level-sharded
keys, mode 0600. The bytes are **AES-256-GCM under the tenant's data key before
they reach the disk**, with the ciphertext bound to its own row, so a copy of
this volume on its own is not a filing cabinet. Documents get the same
treatment as credentials on purpose: an install note with a PSK in it is a
credential whatever the filename says.

**Back this volume up WITH the database, not instead of it.** The filenames, the
folder tree and the nonce that opens each file are rows in Postgres. Restoring
one half without the other leaves documents nobody can open, or rows pointing
at files that are not there. Unlike exports and passphrases, these two belong
in the *same* backup set — the encryption key is not in either of them, it is
behind your KEK provider.

| Setting | Default | |
| --- | --- | --- |
| `HELM_DOCUMENT_DIR` | `/var/lib/helm/documents` | where the bytes go |
| `HELM_DOCUMENT_MAX_BYTES` | `52428800` (50 MB) | per-file cap |

Raising the cap has a real cost: an upload is buffered in memory to be
encrypted, so this number is roughly the RAM one concurrent upload can occupy.

**Uploads are not virus-scanned.** `attachment.scan_status` exists and every
document is recorded as `skipped`, not `pending` — a `pending` that nothing
drains would read as "we are checking" when nobody is. Helm reduces the risk on
the way out instead: every download is served
`Content-Disposition: attachment` with `nosniff` and, for anything but a short
render-safe list of types, `application/octet-stream`, so no stored file is
ever executed or scripted by a browser that fetched it from Helm's origin.
Executables and scripts are refused at upload by extension, which stops the
obvious case and is trivially defeated by a rename — treat client-supplied
files as you would any other client-supplied file.

**Deleting a document is archive-first**, the same rail that guards deleting a
client or a credential: archiving needs `asset:write`, destroying needs
`asset:delete`, which no client-side role holds. A folder must be emptied
before it can be deleted, archived contents included. Every upload, download,
refusal and deletion is an audit event.

---

## 8. Rotating the master key

Rotating the KEK is much cheaper than rotating a data key: the DEK does not
change, so no field ciphertext is touched. It is one column per tenant key.

The order matters, and step 4 before step 3 is unrecoverable.

```bash
# 1. Add a new version. KEEP the old one.
sudo cp deploy/secrets/master.key deploy/secrets/master.key.bak
NEW=$(openssl rand -base64 32)
sudo -u '#10001' tee deploy/secrets/master.key >/dev/null <<EOF
{
  "current": "v2",
  "keys": {
    "v1": "<the existing v1 value>",
    "v2": "${NEW}"
  }
}
EOF
sudo chmod 0400 deploy/secrets/master.key

# 2. Restart so the new ring is loaded.
docker compose up -d --force-recreate web worker

# 3. Re-wrap every tenant DEK onto v2. HELM_MAINTENANCE_ACTOR_ID attributes
#    the key operation to a real person in the audit log.
HELM_MAINTENANCE_ACTOR_ID=<your app_user uuid> \
docker compose --profile maintenance run --rm rotate-kek \
  --reason "annual master key rotation"

# 4. ONLY after step 3 reports "0 left on an older KEK version",
#    remove "v1" from the ring and restart.
```

The job is idempotent, so an interrupted run is resumed by running it again. It
reports what it could **not** re-wrap rather than skipping it, and exits
non-zero — because the next thing you do is delete a key.

`--dry-run` lists the tenants and key counts without writing anything, and
needs no actor.

Under `vault-transit` this same command goes through `transit/rewrap`, so the
plaintext DEK never enters the Helm process at all.

---

## 9. Moving the master key into Vault

To stop this host from holding the key:

```bash
vault secrets enable transit
vault write -f transit/keys/helm-tenant-kek type=aes256-gcm96 derived=true
```

`derived=true` is **not optional**. Without derivation Vault accepts the
per-tenant encryption context and silently ignores it: every wrap and unwrap
would still succeed, and the tenant binding the rest of Helm depends on would
simply not exist — a failure invisible until someone checked whether one
client's wrapped key opens as another's. Helm reads the key's configuration on
first use and refuses to run against a non-derived key.

Policy Helm needs, and nothing more:

```hcl
path "transit/datakey/plaintext/helm-tenant-kek" { capabilities = ["update"] }
path "transit/decrypt/helm-tenant-kek"           { capabilities = ["update"] }
path "transit/keys/helm-tenant-kek"              { capabilities = ["read"] }
```

Note the absences: no `encrypt`, and no writes to `transit/keys/*`. Helm cannot
re-seal an arbitrary key of its own accord and cannot rotate or delete the KEK.
Grant `transit/rewrap/helm-tenant-kek` to the rotation job's role only, not to
the web tier.

Then in `.env`:

```ini
HELM_KEK_PROVIDER=vault-transit
VAULT_ADDR=https://vault.internal.example.com:8200
VAULT_ROLE_ID=<approle role id>
VAULT_SECRET_ID=<approle secret id>
```

AppRole rather than a static token: a long-running server needs a credential
that renews itself, and the SecretID can be response-wrapped and short-lived.

For a private CA, set `NODE_EXTRA_CA_CERTS` on the web and worker services.
Never disable TLS verification — the Vault token and every unwrapped DEK cross
that connection.

**Point Helm at an external Vault, not one in this compose stack.** A Vault
container on the same host puts the key back on the same machine as the data,
which is the thing you switched providers to avoid.

### Existing data

Changing the provider does **not** re-wrap existing keys. Keep the old
`local-keyfile` ring in place, switch the provider, and the rotation job in §8
moves them across — `rotate-kek` re-wraps under whatever provider is configured.
Remove the file only once it reports zero remaining.

---

## 10. Day-to-day operations

```bash
docker compose ps                      # what is running
docker compose logs -f worker          # one JSON object per line
docker compose exec postgres psql -U postgres helm

# Run every background job once, now, instead of waiting for its interval.
docker compose run --rm worker node dist/worker.mjs --once
```

**Worker replicas are safe.** `docker compose up -d --scale worker=3` works:
every job takes a Postgres advisory lock, so exactly one replica does the work
and the others skip that tick. Mutual exclusion is deliberately *not* a Redis
lock — correctness should not depend on a service nobody on-premises is
monitoring. There is no queue broker in the stack and nothing to configure.

### Backups

```bash
docker compose exec -T postgres pg_dump -U postgres --format=custom helm \
  > helm-$(date +%F).dump
```

A database backup on its own is safe to store more cheaply than you might
expect: without the master key it is ciphertext. That is the point of the
envelope scheme, and it is also why the key backup from §3 has to live
somewhere else entirely.

### Upgrades

```bash
git pull
docker compose build
docker compose up -d
```

The `migrate` service runs before the web tier and worker start. It applies
migrations in one transaction each, takes an advisory lock so two hosts cannot
race, and records a SHA-256 of every applied file — editing a migration that
has already run is refused rather than silently diverging.

Roll back by checking out the previous tag and rebuilding. **Migrations do not
roll back**; a release that changes the schema is forward-only, so read the
release notes before upgrading a system holding real client data.

#### Before you upgrade: check the tree against what this server applied

One command, and it turns an upgrade that fails at 3am into one you knew about
beforehand:

```bash
sudo docker compose exec -T postgres sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql -U postgres -d helm -At -F" " \
   -c "SELECT filename, sha256 FROM helm_migration ORDER BY filename"' > applied.txt

pnpm db:check-migrations --expect applied.txt
```

It prints what is still pending, or names every file whose content no longer
matches what this server ran — which is exactly what the migrate service will
refuse on. It also names any migration this server **applied** that is no longer
in the tree at all, which is the quieter half of the same problem: deleting a
migration does not un-apply it, so your database still carries its effects while
a freshly built one no longer reproduces them.

**`helm_migration` is the authority, not a commit hash.** A commit is a guess
about what an environment applied; this table is what it applied. Two bad
reverts in this project came from guessing — one to a file's first commit,
one to a commit that turned out not to be the deploy point. Either would have
been caught in seconds by the command above.

#### If an upgrade stops with "has changed since it was applied"

The migrate service compares a SHA-256 of every file in `db/sql` against what
`helm_migration` recorded when it ran. A mismatch stops the deploy before any
DDL is attempted, and your database is untouched — nothing is half-applied.

It means the file was edited after your system ran it, which makes the version
you have and the version the file now describes two different schemas wearing
one name. **Do not work around it** by deleting the `helm_migration` row or by
re-pointing the checksum: both of those tell the runner a lie it cannot later
detect, and the next person to debug a missing column has nothing to go on.

Report it with the filename from the error. The fix belongs upstream: the
migration is restored to what it was, and a *new* migration carries the change
forward — which your next upgrade then applies normally.

#### If a migration has gone missing from `db/sql`

The same rule, and the same answer: an applied migration is immutable, and that
includes existing. Restore the file — `git checkout <ref> -- db/sql/<file>` —
and, if it must stop doing what it did, write a *new* migration that undoes it.
Never remove the file: two systems built from the same commit would then have
different schemas depending on when each was built, and nothing in the tree
would say so.

Contributors: `pnpm db:check-migrations` catches both an edit and a deletion
before they are committed — it compares the tree to `MANIFEST.sha256` for
content and to `HEAD` for existence — and `pnpm hooks:install` runs it
automatically on every commit that touches `db/sql`. CI runs the same check
against the merge base with the default branch on **every** event, push
included, plus a diff annotation on pull requests. `--deleted-since <ref>` asks
the existence question alone, for cases where a content comparison against a
recent reference would flag a legitimate revision of a migration that has never
shipped.

---

## 11. Verifying the install

After signing in:

- **Settings → Key custody** — shows the provider, the KEK id, and whether this
  host can read the KEK. If it says a *development* key is in use, stop: that
  data is not protected to production standards.
- **Settings → Background worker identities** — four, each pinned to the
  decryption purposes its job has. Two of them ("Expiry Alerts", "Audit
  Anchoring") should show *Nothing — no secret access*.
- **Audit → Chain integrity** — events in the chain, and how many are awaiting
  an external witness. If "externally anchored" stays at 0 after an hour, the
  anchor directory is not writable or is not configured (§7).

### Do not run the test suite against this deployment

> **`pnpm test` and `./scripts/run-tests.sh` DROP the database they run
> against**, and the name they default to is `helm` — the same name this
> deployment uses. `scripts/rebuild-test-db.sh` opens with
> `DROP DATABASE IF EXISTS helm WITH (FORCE)`, and the integration harness
> takes its database from `PGDATABASE` with `helm` as the fallback. Run them on
> a development machine against a throwaway cluster, never on a host whose
> `PG*` variables or network can reach production.

`pnpm db:drift` is read-only and safe to point at a live database — it compares
the TypeScript schema against the catalog and writes nothing:

```bash
pnpm db:drift      # ✓ no drift: 63 tables match the database
```

Everything else worth checking after an install is in the interface above, or
in the health endpoint:

```bash
# From the host. "ok" means the web tier is up AND the database is reachable;
# "degraded" means it answered but cannot reach Postgres.
curl -sk https://127.0.0.1/api/health --resolve "$(grep '^HELM_PUBLIC_HOST=' .env | cut -d= -f2):443:127.0.0.1" \
  https://"$(grep '^HELM_PUBLIC_HOST=' .env | cut -d= -f2)"/api/health
```

---

## 12. Known limitations of this deployment

Stated plainly so they are decisions rather than surprises.

- **Single host.** This compose stack runs one Postgres with no replica. A disk
  failure loses everything since the last backup. Streaming replication or a
  managed Postgres is the answer for anything you would be embarrassed to lose;
  the five connection strings in `.env` point wherever you like.
- **No breach-corpus check on passwords.** §5.2 enforces length, reuse and
  a short banned list, but does not consult Have I Been Pwned or an
  equivalent. Front the deployment with one if that matters to you.
- **The anchor volume is not a witness by default.** §7.
- **`docker compose` is not an orchestrator.** There is no rolling deploy:
  `up -d` stops and starts the web tier. For a few seconds of downtime per
  upgrade this is fine, and if it is not, the image runs unchanged under
  Kubernetes or Nomad.

---

## Reference

| Document | |
| --- | --- |
| `docs/architecture/01-security-model.md` | Guarantees, mechanisms and limitations |
| `docs/architecture/03-crypto-operations.md` | Key hierarchy, rotation, both KEK providers |
| `docs/architecture/05-workers-and-exports.md` | Worker identities, the export engine |
| `docs/architecture/06-web-interface.md` | Pages, tenant switching, secret handling |
| `docs/architecture/07-local-authentication.md` | Passwords, lockout, reset, the outage case |
| `docs/architecture/08-radius-authentication.md` | Signing in against your own directory, and how it falls back |
| `docs/architecture/09-oidc-authentication.md` | Any OpenID Connect provider, and where its client secret lives |
| `docs/architecture/10-notifications.md` | Discord, Teams, Slack and generic webhooks |
| `docs/architecture/11-network-integration.md` | Reading a UniFi controller: credentials, certificates, sync |
| `docs/deployment/docker-on-prem.md` | Step-by-step Docker install: volumes, healthchecks, TLS, backup/restore |
| `.env.example` | Every variable, with the reasoning |
