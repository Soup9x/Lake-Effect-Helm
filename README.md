# Lake Effect Helm

[![CI](https://github.com/Soup9x/Lake-Effect-Helm/actions/workflows/ci.yml/badge.svg)](https://github.com/Soup9x/Lake-Effect-Helm/actions/workflows/ci.yml)

Documentation and credential management for IT Managed Service Providers,
deployed on premises. Clients, sites, assets, contacts, documents, flexible
asset types, checklists and a credential vault, with tenant isolation and audit
enforced by PostgreSQL itself rather than by application code.

> **On-premises by design.** The master key lives in HashiCorp Vault's transit
> engine or in a versioned key file on the Helm host. There is no cloud KMS.
> See [`docs/architecture/03-crypto-operations.md`](docs/architecture/03-crypto-operations.md) §4.

**Contents:**
[What it does](#what-it-does) ·
[How it is built](#how-it-is-built) ·
[Deploying it](#deploying-it) ·
[Development setup](#development-setup) ·
[Environment variables](#environment-variables) ·
[Dependencies](#dependency-management) ·
[Database and migrations](#database-and-migrations) ·
[Commands](#commands) ·
[Testing](#testing) ·
[Security model](#security-model) ·
[Documentation](#documentation)

---

## What it does

- **Clients and their estate.** Organisations, sites, contacts, assets (devices,
  networks, domains, certificates, applications …) linked as a graph, so "what
  breaks if this fails" is a query.
- **Credential vault.** Envelope-encrypted secrets with TOTP, autofill domain
  rules, sensitivity levels, step-up re-authentication and justification for
  critical credentials. Every reveal and copy is audited in the same database
  transaction.
- **Flexible asset types.** Technician-authored JSON Schema types, versioned,
  validated as untrusted input.
- **Documents and checklists.** Encrypted document storage per client;
  procedures with runnable, assignable checklists and due-date reminders.
- **Expiry tracking.** Certificates, domains, warranties and contracts, with
  warnings at configurable lead times (Settings → Expiry warnings).
- **Notifications.** Webhooks (generic, Slack, Teams, Discord), email through
  your own relay, and an in-app inbox.
- **Exports.** Client offboarding and audit bundles as PDF and JSON, encrypted
  with a passphrase delivered out of band when they contain credentials.
- **Network inventory.** UniFi controllers polled for devices and clients, with
  certificate pinning and signed webhooks.
- **Sign-in.** Local passwords (the break-glass path), Microsoft Entra ID, any
  OpenID Connect provider, and RADIUS. All produce the same revocable session.
- **Tamper-evident audit log.** Per-tenant SHA-256 hash chain, anchored to an
  external receipt on a schedule.

## How it is built

Next.js (App Router) and PostgreSQL 16, in TypeScript, with a separate worker
process for scheduled jobs.

```
db/
  sql/          The schema: ordered, append-only migrations. The authority.
  schema/       Drizzle ORM definitions of the same tables, for typed queries.
  tests/        SQL security and tamper-detection suite, and fixtures.
  migrate.ts    Migration runner: transactional, locked, checksum-guarded.
src/
  app/          Pages (app/(app)) and API routes (app/api).
  components/   React components. ui/ holds the primitive set.
  lib/          Server and shared code, one directory per concern:
                api/ (route wrappers, errors, bounded body reading), auth/,
                db/ (per-role pools, withTenant), crypto/, secrets/, exports/,
                documents/, flexible/, graph/, notifications/, email/, unifi/ …
  workers/      Job runtime and the scheduled jobs (alerts, exports, anchoring,
                notifications, reminders, external checks, UniFi sync).
tests/
  unit/         No database needed.
  integration/  Against a real Postgres, connecting as the real roles.
scripts/        Bootstrap, key rotation, drift and migration checks, test DB.
deploy/         Turnkey on-prem install: setup.sh, secrets, Postgres, Caddy.
docs/           Architecture and deployment documents.
```

Three ideas carry most of the weight:

1. **`db/sql` is the schema authority.** Row-level security policies,
   `SECURITY DEFINER` functions, grants and partitioning live in SQL. The
   Drizzle definitions mirror the tables for typing, and `pnpm db:drift` checks
   they still agree.
2. **A request cannot reach tenant data without a tenant context.** API routes
   are wrapped in `tenantRoute()` (handler gets a transaction with the RLS
   session context already set) or `serviceRoute()` (handler gets the caller's
   full context to pass to a service that opens its own transaction).
   `publicRoute()` is for pre-authentication endpoints and gets no database at
   all. See [`docs/architecture/04-api-layer.md`](docs/architecture/04-api-layer.md).
3. **Every subsystem connects as its own database role.** `helm_app` (requests),
   `helm_auth` (sign-in), `helm_worker` (jobs), `helm_key_admin` (key rotation),
   `helm_auditor` (read-only audit). None has `BYPASSRLS`.

## Deploying it

On a fresh Linux host with Docker and Compose, from a clone of this repository:

```bash
sudo ./deploy/setup.sh
```

It checks prerequisites, generates the master key ring and every database
password, asks for the hostname people will use, builds and starts the stack
(Postgres, web, worker, Caddy for TLS), applies the migrations, and creates the
first tenant and administrator. It is safe to re-run and never overwrites an
existing master key. Every prompt has a flag (`--host`, `--tenant`, `--slug`,
`--admin-email`, `--admin-name`, `--yes`) for unattended installs.

- [`docs/deployment/docker-on-prem.md`](docs/deployment/docker-on-prem.md):
  the install guide, covering the same steps by hand, TLS, backup and restore,
  and troubleshooting.
- [`docs/deployment/on-premises.md`](docs/deployment/on-premises.md):
  the operational runbook for any environment: key custody, KEK rotation, what
  to back up.

Three things cause most failed installs:

- **TLS is required.** The session cookie is `__Secure-` prefixed in
  production, so sign-in cannot work over plain http. Caddy handles it.
- **The master key file must be mode 0400** and owned by the user Helm runs as
  (uid 10001 in the bundled images). Helm refuses to start otherwise.
  `init-secrets.sh` sets both.
- **Keep a local password on at least one administrator.** It is how you get in
  when the identity provider is down, which is exactly when you need a client's
  credentials.

## Development setup

You need **Node 26+**, **pnpm 10** and **PostgreSQL 16+**.

**1. Toolchain and dependencies.** The pnpm version is pinned in
`package.json`'s `packageManager` field; corepack provides it.

```bash
corepack enable
pnpm install
pnpm hooks:install        # optional: the pre-commit check for edited migrations
```

**2. A database.** Migrations run as a superuser: every table is
`FORCE ROW LEVEL SECURITY`, and `SECURITY DEFINER` functions must be owned by a
role RLS does not apply to.

```bash
createdb helm
DATABASE_URL_MIGRATOR=postgresql://postgres@localhost/helm pnpm db:migrate
```

`0000_bootstrap.sql` and `0290_worker_identities.sql` create the runtime roles
without passwords. Give the five that connect a password, or use certificate
authentication:

```sql
ALTER ROLE helm_app       PASSWORD '...';
ALTER ROLE helm_auth      PASSWORD '...';
ALTER ROLE helm_worker    PASSWORD '...';
ALTER ROLE helm_key_admin PASSWORD '...';
ALTER ROLE helm_auditor   PASSWORD '...';
```

**3. Configuration.**

```bash
cp .env.example .env.local
```

Fill in the five `DATABASE_URL*` connection strings and `AUTH_SECRET`
(`openssl rand -base64 32`). For development the simplest key custody is:

```bash
HELM_KEK_PROVIDER=local-dev
HELM_LOCAL_KEK_B64=$(openssl rand -base64 32)
```

`local-dev` is refused when `NODE_ENV=production`. To skip signing in while
developing, set `HELM_DEV_SESSION_EMAIL` to an existing user's address; Helm
refuses to start with it set in production.

**4. The first tenant and administrator.** `next dev` reads `.env.local` by
itself; the command-line scripts do not, so export it first:

```bash
set -a; . ./.env.local; set +a
pnpm helm:bootstrap --tenant "Northwind IT" --slug northwind \
                    --admin-email you@example.com --admin-name "Your Name"
```

This prints a one-time local password for the administrator.

**5. Run it.**

```bash
pnpm dev                  # the web app on http://localhost:3000
pnpm helm:worker          # the scheduled jobs, in a second terminal
```

## Environment variables

[`.env.example`](.env.example) is the authoritative list, with a paragraph on
each. `tests/unit/env-docs.test.ts` fails CI if the code reads a variable that
file does not document, or the file documents one nothing reads. Integer
settings are validated, so a malformed value stops Helm with the variable's
name rather than being treated as zero.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | `helm_app`, the request role |
| `DATABASE_URL_AUTH` | yes | `helm_auth`, sign-in and sessions |
| `DATABASE_URL_WORKER` | worker | `helm_worker`, the scheduled jobs |
| `DATABASE_URL_KEY_ADMIN` | rotation | `helm_key_admin`, for `pnpm helm:rotate-kek` |
| `DATABASE_URL_AUDITOR` | audit | `helm_auditor`, read-only audit access |
| `DATABASE_URL_MIGRATOR` | migrations | A superuser, used by `pnpm db:migrate` and bootstrap only |
| `DATABASE_POOL_MAX`, `DATABASE_STATEMENT_TIMEOUT_MS` | no | Pool size per role (default 20) and statement timeout (15 s). The worker runs at most half the pool's worth of jobs at once. |
| `HELM_KEK_PROVIDER` | yes | `vault-transit`, `local-keyfile` or `local-dev` |
| `HELM_KEK_FILE` / `HELM_KEK_B64`, `HELM_KEK_ID` | local-keyfile | The versioned key ring (a 0400 file is strongly preferred over the variable) and its label |
| `VAULT_ADDR`, `HELM_VAULT_TRANSIT_MOUNT`, `HELM_VAULT_TRANSIT_KEY`, `VAULT_ROLE_ID`, `VAULT_SECRET_ID` (or `VAULT_TOKEN`), `VAULT_NAMESPACE`, `VAULT_APPROLE_MOUNT`, `HELM_VAULT_TIMEOUT_MS` | vault-transit | Vault transit custody; AppRole recommended |
| `HELM_LOCAL_KEK_B64` | local-dev | A development-only key |
| `HELM_DEK_CACHE_TTL_SECONDS` | no | How long an unwrapped data key stays in memory (300) |
| `HELM_BLIND_INDEX_KEY_B64` | UniFi | Separate key for blind indexes; required for network sync, optional otherwise |
| `AUTH_SECRET` | yes | Auth.js signing secret |
| `HELM_PUBLIC_URL`, `AUTH_URL` | yes | The address people use; links in mail and reset codes are built from it |
| `AUTH_TRUST_HOST`, `HELM_TRUSTED_PROXY_HOPS` | no | Proxy trust. Hops must match the proxies in front of Helm (1 behind the bundled Caddy) |
| `AUTH_MICROSOFT_ENTRA_ID_*` | no | Entra ID sign-in. Generic OIDC and RADIUS are configured in Settings, not here |
| `NODE_EXTRA_CA_CERTS` | no | A private CA for Vault, an IdP or a mail relay |
| `HELM_RESET_DELIVERY_URL` | no | Where self-service reset links are posted. Without it self-service reset is off, and administrator-issued codes still work |
| `HELM_DOCUMENT_DIR`, `HELM_DOCUMENT_MAX_BYTES` | yes / no | Encrypted document storage, and the upload limit (50 MB) |
| `HELM_EXPORT_DIR`, `HELM_EXPORT_PASSPHRASE_DIR` | yes / for credential exports | Export bundles, and where passphrases are written for an operator to hand over. Keep them on different backups |
| `HELM_AUDIT_ANCHOR_DIR` | recommended | Where audit-chain anchor receipts are written. Without it the anchoring job has nowhere to record them and says so in its log |
| `HELM_LOG_LEVEL`, `HELM_MAINTENANCE_ACTOR_ID`, `HELM_MIGRATE_VERBOSE` | no | Worker logging, attribution for shell maintenance jobs, migration output |
| `HELM_DEV_SESSION_EMAIL` | dev only | Authentication bypass for development; refused in production |

The Compose stack adds a few variables of its own (database passwords, ports,
the TLS directive); they are documented in
[`docs/deployment/docker-on-prem.md`](docs/deployment/docker-on-prem.md) §3.

## Dependency management

- **pnpm, pinned.** `packageManager` in `package.json` fixes the pnpm version,
  and corepack, CI and the Dockerfile all honour it. Install with
  `pnpm install --frozen-lockfile` anywhere that is not a developer adding a
  dependency.
- **Node, pinned in one place.** `.nvmrc` is read by CI; `engines` and the
  Dockerfile's base image say the same version.
- **Native and build scripts are opt-in.** `pnpm.onlyBuiltDependencies` allows
  esbuild's install script and nothing else.
- **Overrides are deliberate.** `pnpm.overrides` forces a patched esbuild
  under drizzle-kit, and `peerDependencyRules` accepts nodemailer 10 where
  Auth.js declares an older peer range. Remove either when the reason has gone.
  (`package.json` cannot hold comments, so the reason belongs in the commit
  that adds one.)
- **Updates.** Dependabot opens grouped monthly updates for npm, GitHub Actions
  and Docker base images, and security updates as soon as an advisory lands.
  CI's audit job fails on a moderate or higher advisory. GitHub Actions are
  pinned to commit SHAs, which Dependabot keeps current.
- **Runtime vs. dev.** `tsx` is a runtime dependency on purpose: the migrate,
  bootstrap and rotation containers run TypeScript directly. Everything used
  only to build or test belongs in `devDependencies`, which keeps it out of
  the production images (CI checks that the migrate image carries no test
  toolchain).

## Database and migrations

- **Append-only.** A migration that has run anywhere is never edited or
  deleted. Change something with a new migration. `db/sql/MANIFEST.sha256`
  records every file's checksum; `pnpm db:check-migrations` (CI and the
  pre-commit hook) refuses an edited or missing one, and `db/migrate.ts`
  refuses at deploy time if the database ran different bytes.
- **Adding one.** Take the next free number below `0900` (the `09xx` range is
  seed data and stays last), write it with a header saying why, and end it with
  a guard (`DO $$ … RAISE EXCEPTION …`) that asserts what it set up. Then:
  ```bash
  pnpm db:check-migrations --update     # records the new file's checksum
  ```
  If it adds or changes columns, update `db/schema/` to match; `pnpm db:drift`
  compares the two against a live database.
- **Superseded migrations stay.** Some early behaviour was later replaced: the
  two-person export approval of `0310`/`0320` (removed in `0400`), notes
  (`0370` → `0440`), topology sync (`0570` → `0580`). The files remain because
  databases have run them.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` / `pnpm build` / `pnpm start` | Next.js development server, production build, production server |
| `pnpm helm:worker` / `pnpm helm:worker:once` | The job runtime; `--once` runs every job once and exits non-zero if any failed |
| `pnpm build:worker` | Bundle the worker to `dist/worker.mjs` (what the image runs) |
| `pnpm db:migrate` / `pnpm db:migrate:status` | Apply pending migrations / list them |
| `pnpm db:check-migrations` | Compare `db/sql` with `MANIFEST.sha256` |
| `pnpm db:drift` | Compare the Drizzle schema with a live database |
| `pnpm helm:bootstrap` | Create the first tenant, administrator and data key |
| `pnpm helm:rotate-kek` | Re-wrap tenant data keys onto the current master key version |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` / `test:unit` / `test:integration` / `test:sql` | The test suites (below) |
| `pnpm verify` | Typecheck, migration check, every vitest suite, drift |

## Testing

```bash
pnpm test:unit                       # no database needed
PGHOST=/run/pgt PGPORT=5433 pnpm test:sql            # rebuilds a throwaway DB
PGHOST=/run/pgt PGPORT=5433 pnpm test:integration
```

The SQL and integration suites **drop and recreate a database called `helm`**.
Point them at a throwaway cluster (`PGHOST`, `PGPORT`, `PGSUPERUSER`), never a
deployment; `scripts/rebuild-test-db.sh` refuses to run in a checkout that has a
deployment's `.env`. Run `pnpm test:sql` first on a fresh cluster: it creates
the roles the integration suite connects as.

Integration tests connect as the real non-superuser roles, because RLS
policies, `SECURITY DEFINER` boundaries and grants do not exist in a mock.
[`docs/testing.md`](docs/testing.md) describes what each suite covers, how to
write a test for a new route or job, and which areas still need tests.

## Security model

The reasoning is in
[`docs/architecture/01-security-model.md`](docs/architecture/01-security-model.md).
In short:

- **Secrets cannot be read without being logged.** No role can `SELECT`
  ciphertext. The only way to it is `helm.reveal_secret()`, which writes the
  audit row in the same transaction.
- **Unset context means no access.** A connection that never set a tenant
  context sees zero rows and cannot write.
- **Cross-tenant references are impossible.** Composite `(id, tenant_id)`
  foreign keys, so a row cannot point at another tenant's parent even with
  every policy dropped.
- **Authority follows rank, in the database.** Nobody can grant, revoke or
  reset the password of somebody whose role outranks theirs (`0350`, `0710`),
  and client-side roles can never hold an MSP-only permission.
- **The audit log is tamper-evident.** Per-tenant hash chain. The suite proves
  that edited, deleted and re-hashed rows are detected.
- **Plaintext is hard to leak by accident.** Decrypted values are `SecretValue`
  objects that redact in strings, JSON and logs; reaching the value takes an
  explicit `.expose()`.
- **Revealing never happens server-side.** A credential is fetched by the
  browser on request and never rendered into a page or its payload.
- **No background job holds a general reveal capability.** Each job runs as its
  own per-tenant service account, pinned to the reveal purposes it needs.
- **Credential exports are detected, not approved.** Two-person approval was
  removed in `0400`. Every credential export and download is audited and
  notifies whoever subscribes to export activity. The bundle is encrypted, and
  its passphrase is stored nowhere and delivered separately.
- **Technician-authored schemas are untrusted code.** Regular expressions are
  scanned and cost-probed for catastrophic backtracking before a type is
  accepted.

### Roles

| Role | Rank | Scope | Notable |
| --- | --- | --- | --- |
| `super_admin` | 100 | Tenant-wide | Everything, including key rotation |
| `tier3` | 80 | Tenant-wide | Schemas, integrations, people |
| `tier2` | 60 | Tenant-wide | Full documentation and credential access |
| `tier1` | 40 | Tenant-wide | Reveal is permitted but audited and gated |
| `client_admin` | 30 | Own organisation | `secret:read` but **not** `secret:reveal` |
| `client_read_only` | 20 | Own organisation | No secret reveal at all |
| `api_service` | 10 | Per service account | Effective permissions = role ∩ token scopes |

## Documentation

| Document | Covers |
| --- | --- |
| [01 Security model](docs/architecture/01-security-model.md) | Guarantees, mechanisms and known limitations |
| [02 Data model](docs/architecture/02-data-model.md) | Schema shape and rejected alternatives |
| [03 Crypto operations](docs/architecture/03-crypto-operations.md) | Reads, writes, key custody and rotation |
| [04 API layer](docs/architecture/04-api-layer.md) | Request flow, route wrappers, authentication, errors |
| [05 Workers and exports](docs/architecture/05-workers-and-exports.md) | Job runtime, worker identities, alerts, exports |
| [06 Web interface](docs/architecture/06-web-interface.md) | Pages, tenant switching, secret handling in the browser |
| [07 Local authentication](docs/architecture/07-local-authentication.md) | Passwords, lockout, reset, the outage case |
| [08 RADIUS](docs/architecture/08-radius-authentication.md) | The third sign-in path and how it degrades |
| [09 OIDC](docs/architecture/09-oidc-authentication.md) | Any OpenID Connect provider, and its custody |
| [10 Notifications](docs/architecture/10-notifications.md) | What leaves the building, and what cannot |
| [11 Network integration](docs/architecture/11-network-integration.md) | UniFi polling, pinning and webhooks |
| [Docker install](docs/deployment/docker-on-prem.md) · [Runbook](docs/deployment/on-premises.md) | Installing and operating Helm |
| [Testing](docs/testing.md) | The suites, writing tests, and the gaps |
| [IT Glue parity](docs/itg-parity.md) | Historical feature plan and its decisions log |

## License

Proprietary. See [LICENSE](LICENSE).
