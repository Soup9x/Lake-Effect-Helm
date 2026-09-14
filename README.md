# Lake Effect Helm

Multi-tenant documentation and credential platform for IT Managed Service
Providers.

> **All three milestones complete.** PostgreSQL schema and security kernel
> (Step 1), secret and relationship engine (Step 2), Next.js API layer with the
> flexible-asset validator and global search (Step 3). The web interface is the
> natural next piece; the API it would consume is here and tested.

---

## What is here

```
db/
  sql/          PostgreSQL schema — the authority. Hand-authored, ordered.
  schema/       Drizzle ORM definitions — the typed query layer.
  tests/        SQL security suite (105 assertions) and fixtures.
  migrate.ts    Migration runner: transactional, locked, checksum-guarded.
src/
  app/          Next.js App Router — 14 API routes, all force-dynamic.
  lib/
    api/        Route wrapper, typed HTTP errors. The tenant-context choke point.
    auth/       API tokens, identity resolution, Auth.js config.
    db/         Per-role pools; withTenant() opens the RLS session context.
    crypto/     KEK providers, DEK cache, AES-256-GCM envelope, TOTP, blind index.
    secrets/    SecretService and key lifecycle over the audited SQL API.
    graph/      Relation vocabulary, canonicalisation, the link engine.
    flexible/   JSON Schema guard and record validator.
    search/     Global search over helm.search().
tests/
  unit/         129 tests — RFC 6238 vectors, envelope semantics, schema guard.
  integration/  115 tests against a real cluster as the real roles.
docs/
  architecture/01-security-model.md     guarantees, mechanisms, and limitations
  architecture/02-data-model.md         schema shape and rejected alternatives
  architecture/03-crypto-operations.md  how reads, writes and rotation work
  architecture/04-api-layer.md          request flow, auth, untrusted schemas
scripts/
  check-drift.ts        Drizzle schema vs. live catalog
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
| `0900_seed_system_data` | Roles and permissions |

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

**Technician-authored schemas are treated as untrusted code.** A structural scan
plus an empirical cost probe reject patterns that backtrack catastrophically —
because a length limit does not: `^((a)+)+$` against 31 characters runs for over
a minute.

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
