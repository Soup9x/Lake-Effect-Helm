# Lake Effect Helm

Multi-tenant documentation and credential platform for IT Managed Service
Providers.

> **Step 1 of 3 — Data Model & Security Schema.**
> This repository currently contains the PostgreSQL schema, its security kernel,
> the typed query layer and a security test suite. The application (Next.js) and
> the TypeScript secret/relationship engine are Steps 2 and 3.

---

## What is here

```
db/
  sql/          PostgreSQL schema — the authority. Hand-authored, ordered.
  schema/       Drizzle ORM definitions — the typed query layer.
  tests/        Security test suite (105 assertions).
  migrate.ts    Migration runner: transactional, locked, checksum-guarded.
docs/
  architecture/01-security-model.md    guarantees, mechanisms, and limitations
  architecture/02-data-model.md        schema shape and rejected alternatives
scripts/
  check-drift.ts        Drizzle schema vs. live catalog
  run-tests.sh          rebuild + fixtures + security suite
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

### Running the security suite

The suite needs a throwaway cluster it can drop and rebuild:

```bash
PGSOCK=/var/run/postgresql PGPORT=5432 ./scripts/run-tests.sh
```

It rebuilds the database from `db/sql/`, loads two mutually-hostile MSP tenants,
and runs 105 assertions covering isolation, the reveal authorisation ladder,
audit immutability and tamper detection.

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

## Next steps

**Step 2 — Secret & Relationship Engine.** TypeScript modules for AES-256-GCM
encrypt/decrypt against the envelope schema, KMS DEK unwrapping with an in-memory
cache, TOTP generation, the bi-directional link engine, and the audited access
wrappers.

**Step 3 — Project Scaffold & Base API.** Next.js App Router layout, the
request-scoped database client that opens and closes the RLS session context,
the Ajv-based flexible-asset validator, and the global search endpoint.
