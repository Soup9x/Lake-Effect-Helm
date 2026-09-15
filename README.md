# Lake Effect Helm

Multi-tenant documentation and credential platform for IT Managed Service
Providers.

> **On-premises deployment.** The master key comes from HashiCorp Vault's
> transit engine or a versioned key file on the Helm host — no cloud KMS. See
> `docs/architecture/03-crypto-operations.md` §4.

---

## What is here

```
db/
  sql/          PostgreSQL schema — the authority. Hand-authored, ordered.
  schema/       Drizzle ORM definitions — the typed query layer.
  tests/        SQL security suite (105 assertions) and fixtures.
  migrate.ts    Migration runner: transactional, locked, checksum-guarded.
src/
  app/          Next.js App Router — 9 pages and 18 API routes, all dynamic.
  components/   App shell, tenant switcher, reveal and export controls, and a
                shadcn/ui-shaped primitive layer.
  lib/
    api/        Route wrapper, typed HTTP errors. The tenant-context choke point.
    auth/       API tokens, identity resolution, Auth.js config.
    db/         Per-role pools; withTenant() opens the RLS session context.
    crypto/     KEK providers (Vault transit, on-prem key file), DEK cache,
                AES-256-GCM envelope, TOTP, blind index.
    secrets/    SecretService and key lifecycle over the audited SQL API.
    graph/      Relation vocabulary, canonicalisation, the link engine.
    flexible/   JSON Schema guard and record validator.
    search/     Global search over helm.search().
    exports/    Collection, JSON and PDF renderers, bundle format, storage.
  workers/      Job runtime, expiry alerts, RMM/PSA sync, audit anchoring,
                export rendering and expiry.
tests/
  unit/         230 tests — RFC 6238 vectors, envelope semantics, schema guard,
                on-premises key custody, PDF structure, bundle encryption,
                Argon2id and password policy, session cookie naming.
  integration/  215 tests against a real cluster as the real roles.
                The UI was additionally driven end to end in a real browser;
                see docs/architecture/06-web-interface.md §8.
docs/
  architecture/01-security-model.md     guarantees, mechanisms, and limitations
  architecture/02-data-model.md         schema shape and rejected alternatives
  architecture/03-crypto-operations.md  how reads, writes and rotation work
  architecture/04-api-layer.md          request flow, auth, untrusted schemas
  architecture/05-workers-and-exports.md  jobs, worker identities, four eyes
  architecture/06-web-interface.md      pages, tenant switching, secret handling
  architecture/07-local-authentication.md  passwords, lockout, reset, the outage case
  deployment/docker-on-prem.md          step-by-step Docker install and backup/restore
  deployment/on-premises.md             docker compose, keys, TLS, rotation runbook
scripts/
  check-drift.ts        Drizzle schema vs. live catalog
  rotate-kek.ts         re-wrap tenant DEKs onto a new master key version
  run-tests.sh          rebuild + fixtures + SQL security suite
  rebuild-test-db.sh    drop and reapply every migration
```

### Migrations

| File | Contents |
| --- | --- |
| `0000_bootstrap` | Extensions, schemas, four database roles, RLS session-context API |
| `0010_tenancy` | tenant → organization → site, contacts |
| `0020_identity` | Users, Auth.js tables, RBAC, service accounts, API tokens |
| `0030_session_context` | `helm.set_session_context()` — the only way into a tenant |
| `0040_keys_and_secrets` | Wrapped per-tenant DEKs, AES-256-GCM envelopes |
| `0050_asset_graph` | `asset_node` supertype, `asset_link`, relation inversion |
| `0060_core_assets` | Devices, networks, IPs, domains, certificates, directories, contracts |
| `0070_credentials` | Vault items, TOTP parameters, autofill domain matching |
| `0075_graph_views` | Bi-directional edge views, bounded graph traversal |
| `0080_flexible_assets` | Versioned JSON Schema templates, out-of-band secret fields |
| `0090_sops` | Procedures, frozen versions, checklist runs |
| `0100_expirations` | Unified expiry projection, severity, alert rules |
| `0110_integrations` | RMM/PSA/Graph connections, sync runs, webhooks |
| `0120_search` | `tsvector` index across all documentation |
| `0130_attachments` | Files, notes, the export engine's ledger |
| `0140_audit` | Partitioned, hash-chained, immutable audit log |
| `0200_rls_policies` | RLS on every tenant table, with a catalog assertion |
| `0210_secret_access_api` | The audited reveal/write API |
| `0220_grants` | Privilege separation, with assertions |
| `0230_key_rotation` | Rotation worker's read API — counts and ids, never ciphertext |
| `0240_trigger_privileges` | Trigger functions that must run as definer, plus a catalog guard |
| `0250_graph_walk_fix` | One row per reachable node; parallel-edge regression guard |
| `0260_secret_write_handshake` | Version allocation under lock, without granting UPDATE |
| `0270_authentication` | The three pre-context authentication functions, and a guard fixing their number |
| `0280_onprem_kek` | On-premises KEK custody, `host_held_kek`, key-custody reporting |
| `0290_worker_identities` | `helm_worker`, per-tenant worker service accounts, reveal-purpose pinning |
| `0300_worker_queues` | Backlog enumerators, alert evaluation, sync lifecycle, chain anchoring |
| `0310_export_engine` | Export request/approve/render/download, four-eyes and scope binding |
| `0320_export_approval_window` | The parked-approval window; `v_secret_metadata` without a join |
| `0330_export_render_context` | Requester and approver names, without granting the worker `user:read` |
| `0900_seed_system_data` | Roles and permissions |
| `0910_worker_seed` | Worker roles, their permissions, and per-tenant identities |

---

## Design commitments

A handful of decisions that everything else follows from. The reasoning is in
`docs/architecture/01-security-model.md`.

**Secrets cannot be read without being logged.** `secret_version` has RLS on and
no `SELECT` policy; `helm_app` has no privilege on it. The only route to
ciphertext is `helm.reveal_secret()`, which writes the audit event in the same
transaction. Not "the application logs access" — the database cannot hand out a
secret without recording it.

**Cross-tenant references are structurally impossible.** Composite
`(id, tenant_id)` foreign keys mean a row cannot point at another tenant's parent
even with every RLS policy dropped.

**Unset context means no access.** Reads return zero rows, writes raise. A
connection that skipped `set_session_context()` sees nothing.

**The audit log is tamper-evident.** Per-tenant SHA-256 chain. The test suite
proves detection of row edits, row deletions, and re-hashed forgeries.

**`db/sql` is the schema authority, not the ORM.** RLS policies, `SECURITY
DEFINER` routines, partitioning and column grants cannot be expressed in the
Drizzle DSL. `pnpm db:drift` keeps the TypeScript honest.

**Plaintext is hard to leak by accident.** Every decrypted value is a
`SecretValue`: it redacts in `String()`, template literals, `JSON.stringify` and
`console.log`. Reaching the real value takes an explicit `.expose()` that shows
up in a diff.

**Key rotation cannot revert a credential.** If a technician changes a password
while the rotation worker holds a decrypted copy, the database refuses the stale
write and the worker skips.

**A route cannot query without a tenant context.** `tenantRoute()` hands the
handler a transaction that already has one and no way to reach a pool. Declared
permissions produce a clear error; RLS is what actually enforces them.

**The master key never has to be a cloud service.** Helm runs on-premises.
`vault-transit` keeps the KEK inside HashiCorp Vault — Helm holds a token, not a
key, so revoking it stops decryption and every unwrap is in Vault's audit log.
`local-keyfile` holds a mode-0400 versioned key ring on the host instead, which
is simpler and honestly weaker: root on that box can decrypt the database
offline. `tenant_data_key.host_held_kek` records which case each key is, so a
breach assessment is a query.

**Rotating the master key is not an outage.** The key ring is versioned, so old
DEKs stay openable while `pnpm helm:rotate-kek` moves them onto the new version.
The DEK does not change, so no field ciphertext is touched. The job is
idempotent, reports what it could not re-wrap rather than skipping it, and exits
non-zero — because the next thing the operator does is delete a key.

**No background worker holds a general reveal capability.** Each job runs as its
own per-tenant service account, pinned to the reveal purposes that job actually
has. For `integration` and `export` the scope is re-derived from the database on
every call — the secret must be a live integration credential, or inside a live
approved export. A compromised sync worker gets the RMM keys it was always going
to need; it does not get the vault.

**The request role cannot enumerate tenants.** Background jobs connect as
`helm_worker`, a member of `helm_app` with the same tables and the same RLS,
plus EXECUTE on the cross-tenant backlog functions. The membership runs one way,
and a migration guard asserts it: nothing reachable from an HTTP request can ask
which tenants exist.

**Worker mutual exclusion is a Postgres advisory lock.** Two app servers both
run the job runtime, and two concurrent syncs against one connection is how
duplicate assets get created. Making that correctness depend on Redis — on a
deployment where nobody is monitoring Redis — would be the wrong trade.

**One alert per expiry, not four.** Of the lead-day thresholds an expiry has
crossed and not yet fired, only the most urgent is delivered; the rest are
recorded as suppressed so they can never fire later. A team that gets four
alerts for one certificate stops reading alerts.

**A credential export needs two people, and the approval is bound to what they
read.** Approving records a digest of the scope; the render refuses if the scope
changed since. Every credential in the bundle is decrypted through the audited
path individually, and anything the worker could not decrypt is named on the
cover page rather than quietly missing.

**An export bundle's passphrase is stored nowhere.** Not in the database, not in
the audit log. The file at rest is useless to anyone who has only the file.

**Secret material never reaches a server component.** Revealing a credential is
a client-side fetch, because server-rendering it would put the plaintext in the
RSC payload, the data cache and any proxy in between. It auto-hides, and copying
is a separate audited call rather than a local read of what is already on screen.

**Technician-authored schemas are treated as untrusted code.** A structural scan
plus an empirical cost probe reject patterns that backtrack catastrophically —
because a length limit does not: `^((a)+)+$` against 31 characters runs for over
a minute.

---

## Deploying it

```bash
sudo ./deploy/init-secrets.sh   # master key ring + every password, once
$EDITOR .env                    # set HELM_PUBLIC_HOST and HELM_PUBLIC_URL
docker compose up -d
docker compose --profile bootstrap run --rm bootstrap \
  --tenant "Your MSP" --slug your-msp --admin-email you@example.com
```

`docs/deployment/on-premises.md` is the full guide. Three things in it are not
optional and are the usual causes of a failed first install:

* **TLS.** The session cookie is `__Secure-` prefixed in production, so sign-in
  cannot work over plain http. Caddy is in the stack for this.
* **The master key file must be mode 0400 and owned by uid 10001.** Helm
  refuses to start otherwise — including from the 0444 `docker secret` produces
  by default. `init-secrets.sh` gets this right for you.
* **Decide your sign-in story before you invite anybody.** Entra and local
  passwords both work, and both produce the same revocable session. Keep a
  local password on at least one administrator — it is what gets you in when
  Entra cannot be reached, which is the outage where you most need a client's
  credentials.

---

## Getting started

Requires PostgreSQL 16+ (`security_invoker` views), Node 22+, pnpm 10+.

```bash
pnpm install
cp .env.example .env.local     # then fill it in

# Apply the schema as the DDL owner
DATABASE_URL_MIGRATOR=postgresql://helm_migrator@host/helm pnpm db:migrate

# Verify
pnpm db:drift                  # TypeScript schema vs. live catalog
pnpm typecheck
```

`0000_bootstrap.sql` creates the four database roles without passwords. Set them
out of band, or use IAM/certificate authentication:

```sql
ALTER ROLE helm_app       PASSWORD '...';
ALTER ROLE helm_auth      PASSWORD '...';
ALTER ROLE helm_key_admin PASSWORD '...';
ALTER ROLE helm_auditor   PASSWORD '...';
```

### Running the tests

```bash
pnpm verify        # typecheck + 244 vitest tests + schema drift
pnpm test:sql      # 105 SQL assertions including tamper detection
pnpm build         # every route must compile and be dynamic
```

Both need a throwaway cluster they can drop and rebuild; point them at one with
`PGSOCK` / `PGPORT` / `PGDATABASE`:

```bash
PGSOCK=/var/run/postgresql PGPORT=5432 pnpm verify
```

Integration tests connect as the real non-superuser roles. That is not
thoroughness for its own sake: RLS policies, `SECURITY DEFINER` boundaries and
grants do not exist in a mock, and three of the bugs found during Step 2 were
invisible to any test that did not commit against real roles.

---

## Roles

| Role | Rank | Scope | Notable |
| --- | --- | --- | --- |
| `super_admin` | 100 | Tenant-wide | Everything, including key rotation |
| `tier3` | 80 | Tenant-wide | Schemas and integrations |
| `tier2` | 60 | Tenant-wide | Full documentation and credential access |
| `tier1` | 40 | Tenant-wide | Reveal is permitted but audited and gated |
| `client_admin` | 30 | Own organisation | `secret:read` but **not** `secret:reveal` |
| `client_read_only` | 20 | Own organisation | No secret reveal at all |
| `api_service` | 10 | Per service account | Effective = role ∩ token scopes |

A client-side role can never hold an MSP-only permission — enforced by trigger on
every grant, and asserted across the whole seeded set.

---

## Using the engine

```ts
const secrets = new SecretService({ dekCache, blindIndex });

// Write. The version is allocated under a row lock and bound into the AAD.
const { secretId } = await secrets.create(
  { tenantId, actorId },
  { organizationId, kind: 'password', label: 'ACME Domain Admin',
    sensitivity: 'critical' },
  plaintext,
);

// Read. Throws SecretAccessDeniedError on refusal — after the denial is
// committed to the audit log.
const revealed = await secrets.reveal({ tenantId, actorId }, secretId, {
  reason: 'INC-4471 emergency domain controller restore',
});
revealed.value.use((password) => connectTo(host, password));

// Link. Idempotent in either direction.
await links.link({ tenantId, actorId }, {
  sourceNodeId: firewallId, relation: 'secures', targetNodeId: networkId,
});

// What breaks if this fails?
const blast = await links.impactOf({ tenantId, actorId }, domainControllerId);
```

## The API

Fourteen routes, all tenant-scoped through one wrapper. See
`docs/architecture/04-api-layer.md` for the full table and the reasoning.

```ts
// Every route looks like this. The handler is given a transaction that already
// has the RLS session context set, and no way to reach a pool without one.
export const GET = tenantRoute(
  async ({ tx, session, identity }) => {
    return search(tx, { query: 'acme-fw-01' });
  },
  { permissions: ['asset:read'] },
);
```

```bash
# Reveal is a POST: a GET would land in browser history, proxy logs and Referer
# headers, for the one endpoint that hands out plaintext credentials.
curl -X POST https://helm.example.com/api/secrets/$ID/reveal \
  -H 'content-type: application/json' \
  -d '{"reason":"INC-4471 emergency domain controller restore"}'
```

## Next steps

The web interface, and the workers the schema is already shaped for: the
expiry-alert dispatcher reading `alert_rule`/`alert_event`, the RMM/PSA sync
using `external_identity` correlation, the audit-chain anchoring job, and the
compliance export engine behind `export_job`'s four-eyes approval.
