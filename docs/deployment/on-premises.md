# Running Lake Effect Helm on an on-premises server

A working install from a bare host, and the operational facts that come with
holding every client's credentials on a machine you own.

Read §1 and §2 before running anything. The rest can be followed in order.

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

- Linux host with Docker Engine 24+ and the Compose plugin
- 4 GB RAM, 2 vCPU and 20 GB disk to start; the audit log is partitioned
  monthly and retained for seven years by default
- A DNS name that resolves to the host on your internal network
- `openssl` on the host, for key generation
- Root (or sudo) for the first-run script — it chowns the master key to the
  container's uid

PostgreSQL 16 is required and is included in the stack. Helm depends on
`security_invoker` views and on 16's partition-wise behaviour for the audit log;
15 and earlier will not work.

---

## 3. Generate keys and passwords

```bash
git clone <your fork> /opt/helm && cd /opt/helm
sudo ./deploy/init-secrets.sh
```

This writes two files and refuses to overwrite either:

- **`deploy/secrets/master.key`** — a versioned key ring, mode `0400`, owned by
  uid 10001.
- **`.env`** — every database password, `AUTH_SECRET`, and the blind-index key,
  mode `0600`.

The permissions are not cosmetic. **Helm refuses to start from a key file that
is group- or world-readable**, which includes the `0444` that `docker secret`
produces by default — the script sets the mode and the owner so this is not
something you have to get right by hand.

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

```bash
docker compose up -d
docker compose logs -f migrate   # should exit 0
```

On first start, in order: Postgres initialises and creates the five runtime
roles with passwords; the `migrate` service applies every SQL migration and
exits; the web tier and worker start once it has.

### The certificate

`HELM_TLS_DIRECTIVE` defaults to `tls internal` — Caddy mints a certificate
from its own CA. No public DNS, no ACME reachability, which is right for an
internal host. The cost is one step: trust Caddy's root on the machines that
will use Helm.

```bash
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./helm-root.crt
# Then install helm-root.crt as a trusted root on each technician's machine.
```

To use your own certificate instead, put the files in `deploy/tls/` and set:

```ini
HELM_TLS_DIRECTIVE=tls /etc/helm/tls/helm.crt /etc/helm/tls/helm.key
```

For a publicly resolvable name, set `HELM_TLS_DIRECTIVE=` (empty) and Caddy
obtains one from Let's Encrypt.

---

## 5. Sign-in: the thing to decide before you go further

**Helm ships with Microsoft Entra ID as its only authentication provider.**
There is no local username-and-password login. That is a deliberate scope
choice — a credentials provider done properly needs password hashing policy,
rate limiting, lockout, and a reset flow, and every one of those is a place to
get a credential vault wrong — but it means **you cannot sign in until SSO is
configured**.

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

### If you need local logins

`src/lib/auth/config.ts` is the only file that imports next-auth; adding a
Credentials provider is contained, but it is a real piece of security work, not
a config flag. Treat it as a project.

### `HELM_DEV_SESSION_EMAIL`

There is a development bypass that runs every request as a named user. It
**throws on startup when `NODE_ENV=production`**, which is what this stack runs,
so it cannot be used here — it exists for evaluating Helm on a laptop before
SSO is set up. Mentioned so that finding it in `.env.example` does not look like
a back door you missed.

---

## 6. Create the first tenant and administrator

The migrations leave a schema and nothing in it. Helm is fail-closed, so an
empty database is not half-working — every policy denies and there is nobody to
sign in as.

```bash
docker compose --profile bootstrap run --rm bootstrap \
  --tenant "Northwind Managed Services" \
  --slug northwind \
  --admin-email admin@northwind.example.com \
  --admin-name "Dana Whitfield"
```

It creates the MSP root tenant, a `super_admin` user, their membership, and —
the part that matters — **mints the tenant's first data key through the KEK
provider**. A `tenant_data_key` row inserted by hand is a wrapped key nothing
can unwrap, and that failure only surfaces the first time someone stores a
password.

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

Three volumes hold state that is not the database:

```
helm-exports       rendered export bundles, encrypted when they hold credentials
helm-passphrases   the passphrases for those bundles
helm-anchors       witnessed audit chain heads
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
monitoring.

**Redis is optional** and off by default. Start it with
`docker compose --profile queue up -d` and set `REDIS_URL` only if you need
queue throughput.

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

From a shell, against a checkout:

```bash
pnpm db:drift      # the TypeScript schema matches the live catalog
pnpm test          # 383 tests; the integration suite needs a throwaway database
./scripts/run-tests.sh   # 109 SQL assertions on RLS, grants and the audit chain
```

---

## 12. Known limitations of this deployment

Stated plainly so they are decisions rather than surprises.

- **Single host.** This compose stack runs one Postgres with no replica. A disk
  failure loses everything since the last backup. Streaming replication or a
  managed Postgres is the answer for anything you would be embarrassed to lose;
  the five connection strings in `.env` point wherever you like.
- **No local authentication.** §5. Entra, or nothing.
- **The anchor volume is not a witness by default.** §7.
- **Redis, if enabled, is unauthenticated** on the internal compose network.
  Fine while it stays there; add `requirepass` before exposing it.
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
| `docs/architecture/05-workers-and-exports.md` | Worker identities, four-eyes exports |
| `docs/architecture/06-web-interface.md` | Pages, tenant switching, secret handling |
| `.env.example` | Every variable, with the reasoning |
