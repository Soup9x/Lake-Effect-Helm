# Testing Lake Effect Helm

What the suites are, how to run them, how to write a test that would have
caught the bug in front of you, and which parts of Helm still need tests.

---

## 1. The suites

| Suite | Command | Needs | Last counted (2026-10-15) |
| --- | --- | --- | --- |
| Unit | `pnpm test:unit` | Nothing | 51 files, 809 tests |
| Integration | `pnpm test:integration` | A throwaway PostgreSQL 16 cluster | 57 files, 1,249 tests |
| SQL security | `pnpm test:sql` | The same cluster, superuser access | 625 assertions, plus tamper detection |
| Type check | `pnpm typecheck` | Nothing | |
| Lint | `pnpm lint` | Nothing | Biome; see `biome.json` for what is on and why |
| Migration manifest | `pnpm db:check-migrations` | Nothing | |
| Schema drift | `pnpm db:drift` | A freshly migrated database | |
| Everything above | `pnpm verify` and `pnpm test:sql` | | |

Counts are written down once, here, with a date. They change with every
feature, and copies of them elsewhere were how the README came to claim 244
tests when there were nearly 2,000.

### Running against a database

The SQL and integration suites **drop and recreate a database called `helm`**.
Give them a cluster that holds nothing you want:

```bash
# A throwaway cluster on a unix socket, as CI and the scripts expect.
initdb -D /tmp/pgt-data -U postgres --auth=trust
pg_ctl -D /tmp/pgt-data -o '-p 5433 -k /run/pgt' start

export PGHOST=/run/pgt PGPORT=5433 PGSUPERUSER=postgres
pnpm test:sql            # first: it creates the roles the next suite connects as
pnpm test:integration
```

`scripts/rebuild-test-db.sh` refuses to run in a checkout that has a `.env`,
because that file means `deploy/init-secrets.sh` provisioned a real deployment
there. CI runs the same commands against a `postgres:16-alpine` service.

Integration files run one at a time (`fileParallelism: false` in
`vitest.config.ts`), because each file rebuilds the same database in its
`beforeAll`. Inside a file, tests run in order and may build on each other's
rows, so read a file's `beforeAll` and `beforeEach` before adding to it.

## 2. What each suite is for

**Unit** (`tests/unit/`): pure logic with no database. Crypto (envelope,
key ring, TOTP vectors, bundle encryption), parsers (CSV, RADIUS codec,
schema guard, lead days, bounded bodies), UI logic that lives in `lib/ui`
(browse matching, selection, form diffs, step-up retry), and **structural
checks that read the source**:

- `env-docs`: every environment variable the code reads is in `.env.example`,
  and the reverse.
- `client-imports`: a server module imports only components from a
  `'use client'` module. This would have caught the theme script that never ran.
- `worker-jobs`: no two jobs share an advisory lock key.
- `check-migrations`: the manifest logic itself.
- `pg-errors`: what a database refusal becomes on the way out — a `helm:`
  raise is a 400 with its sentence, Postgres's own wording never reaches a
  client, an unlisted SQLSTATE stays a 500.
- `api`: the browser-side result contract (`apiFetch`): envelope parsing, the
  network failure, a 204, a proxy's HTML.

**Integration** (`tests/integration/`): everything that touches PostgreSQL,
connecting as the real non-superuser roles (`helm_app`, `helm_auth`,
`helm_worker` …). Route handlers are imported and called directly with a
`NextRequest`, pages are rendered as server components, and worker jobs are run
through their real `run()`. The areas each file covers are in its name: `api`,
`secrets`, `exports`, `local-auth-routes`, `notifications`, `expiry-alerts`,
`runtime`, `pages`, `write-surface`, `api-tokens` and so on.

**SQL** (`db/tests/security.sql`, `tamper.sql`): the guarantees that live in
the database, asserted from inside it with `helm_test.check(name, condition)`.
Covered: fail-closed defaults, tenant isolation, grants, `SECURITY DEFINER`
boundaries, ciphertext unreachability, and that edited, deleted or re-hashed
audit rows are detected.

## 3. Writing a test that would have caught it

These rules come from defects this project shipped. Each one was invisible to
the test that existed at the time.

1. **Run the real job, tenant discovery included.** Four zero-rows-under-RLS
   defects have shipped. Two were jobs whose tenant enumeration returned
   nothing, so the job never ran: the notification fan-out (fixed in `0700`)
   and export expiry (`0720`). Their tests called the inner SQL function inside
   `withTenant()` and skipped the broken part. Call `someJob().run(ctx)` and assert on what changed.
   `tests/integration/expiry-alerts.test.ts` and the expiry test in
   `exports.test.ts` are the pattern.

2. **Connect as the role the code connects as.** A superuser or table owner
   bypasses the RLS policy you think you are testing. The harness's `db('app')`,
   `db('worker')` and `withTenant(actor, …)` are the real roles. Use
   `superuserSql()` only to arrange fixtures.

3. **Watch the test fail without the fix.** Before committing a regression
   test, run it with the fix stashed (`git stash push <file>`) and confirm it
   fails for the right reason. One test in this repository was found asserting
   the bug itself: it checked that a caller's encryption key *was* zeroed on
   eviction.

4. **Call routes the way Next does.** Import the handler, build a `NextRequest`,
   pass `{ params: Promise.resolve({...}) }`. Set the signed-in user with
   `useSessionResolver(async () => currentUser)`, and mock `next/headers` when
   the route reads cookies (see `local-auth-routes.test.ts`).

5. **Assert what a caller can observe.** For anything security-relevant,
   compare the status and the exact response bytes for the case that must be
   indistinguishable. The reset tests compare a known and an unknown address
   byte for byte.

6. **A new page goes in `pages.test.ts`'s list.** The suite fails if a
   `page.tsx` exists that the list does not name, then renders every listed
   page against real data and checks every prop crossing into a client
   component.

7. **A new migration gets a guard in the file and a behavioural test.** The
   `DO $$ … RAISE EXCEPTION` at the end of a migration proves the object
   exists with the right shape. A test as the real role proves it does what it
   is for.

## 4. Gaps, in priority order

What remains untested or thinly tested in the core, with a sketch of the test
that would close each gap. The first three cover the classes of defect that
recurred most often.

### 4.1 A browser smoke suite

Every test today runs in Node. Three defects fixed in the last cleanup were
visible only in a browser: the pre-paint theme script, the TOTP panel
re-requesting every second, and bulk selection that kept rows the filter had
hidden. Playwright with its bundled Chromium is the natural fit; it is not a
dependency yet.

Start with five flows against the Compose stack, or `next start` plus a test
database: sign in with a local password; open a client and reveal a
credential (assert one audit row, and that the value auto-hides); generate a
TOTP code and wait through a refresh (assert one request per period); filter
the clients list, tick, filter, tick, and check the bulk bar's count; switch
to dark and reload (assert `data-theme` before first paint).

### 4.2 Every job finds its tenants

One integration test that seeds one unit of work per job, a due expiry, an
expired export, an undelivered notification, a due reminder and a pollable
UniFi mapping, then runs every job in `allJobs()` and asserts each reports
non-idle. A job whose enumeration silently returns nothing fails here the day
it is written, not months later.

### 4.3 The route-wrapper contract, checked statically

A unit test that reads `src/app/api/**/route.ts` and fails when:
- a handler is exported without `tenantRoute`, `serviceRoute` or `publicRoute`
  (allowlist `auth/[...nextauth]`);
- a `tenantRoute` handler calls a service method that opens its own
  transaction (`getSecretService().reveal(`, `getExportService().list(` …).
  That nesting held two connections per request in about sixteen routes.
- a route reads `request.json()`, `.text()` or `.formData()` directly instead
  of the bounded readers in `lib/api/body.ts`.

### 4.4 The authority matrix

`0350` and `0710` say nobody may grant, revoke, re-scope or reset the password
of somebody who outranks them. Today each path is tested on its own. A
table-driven test over `{tier1, tier2, tier3, super_admin} ×
{invite, change role, revoke, reset password, set per-user permission}` ×
`{lower, equal, higher-ranked target}` would catch the next path that forgets.

### 4.5 Upgrade-path migrations

CI builds the database fresh, where migrations run in file order. A deployed
database first deployed before `0430` applied everything from `0430` on
*after* the `09xx` seeds. Add a CI job that
checks out the previous release tag, migrates and loads fixtures, then checks
out `HEAD` and migrates again, so an ordering assumption fails in CI rather
than on an upgrade.

### 4.6 Pool exhaustion under concurrency

A load test, not a unit test: with `DATABASE_POOL_MAX=4`, fire twenty
concurrent `/api/secrets/{id}/copy` requests and assert all finish and
`/api/health` still answers. It guards against the nested-transaction
deadlock returning.

### 4.7 Sign-in callbacks

`tests/integration/oidc.test.ts` covers provider configuration and discovery.
The Auth.js `signIn` callback, the `allow_signup` refusal and `link_by_email`
behaviour, has no test that drives it. Exercise it through `tests/support/fake-oidc.ts`.

### 4.8 Property tests for the parsers

The CSV importer, the flexible-schema guard, `parseLeadDays`, `matchesBrowse`
and the RADIUS codec take untrusted input. A property-based pass with
fast-check would explore inputs the example-based tests do not, starting with
round-trips (CSV), monotonicity (adding a term never widens a match) and
bounds (no schema the guard accepts takes over a second to match).

### 4.9 The SQL-error contract, from the schema's side

`tests/unit/pg-errors.test.ts` pins what the handler does with a code. What
nothing asserts yet is the other half: that every `RAISE EXCEPTION` in `db/sql`
that is meant for a person carries the `helm:` prefix, and that one meant as a
fault does not. A unit test that greps `db/sql/*.sql` for `RAISE EXCEPTION`
and fails on a message without the prefix, with an allowlist for the handful
that are genuinely internal, keeps a new migration from quietly adding a 500.

### 4.10 Token scope, as a matrix

`api-tokens.test.ts` proves a narrowed token is refused where its scope does
not reach and that a wildcard token cannot exceed its role. Extend it the way
4.4 extends the authority tests: `{tier1, client_admin} × {'*', one scope,
two scopes} × {a route needing each}`, asserting 200 or 403 from the table,
so the next route that forgets `permissions:` in its wrapper is caught by the
token path even if the session path lets it through.

### 4.11 Component behaviour without a browser

Every form now calls `apiFetch`, so a component's error path is reachable
with a stubbed `fetch` and no server. Start with the three that carry the most
logic — `reveal-button` (step-up retry, auto-hide), `api-tokens-card` (the
token shown once and cleared on close), `import-dialog` (preview from
`details`) — rendered with React Testing Library under vitest's jsdom
environment, asserting what the person sees after a 403, a 400 with details,
and a network failure. This is the cheap half of 4.1; the browser suite stays
for what only a browser shows.

### Also worth adding

- **Session-token hashing tests**, alongside that change. Session tokens are
  stored as issued today, unlike API and reset tokens, which are hashed. Once
  they are hashed too, assert that `auth_session` never contains a cookie's
  value.
