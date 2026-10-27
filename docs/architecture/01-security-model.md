# Lake Effect Helm — Security Model

This document states what Helm guarantees, how, and — importantly — what it
does not guarantee. A credential platform that overstates its protections is
worse than one that is honest about them, because the operator plans around the
claim.

---

## 1. What Helm is

A multi-tenant documentation and credential vault for an IT Managed Service
Provider. One deployment serves one or more **MSP tenants**; each tenant
documents many **client organisations**; each organisation has **sites**,
**assets**, and **credentials**.

The threat that shapes every decision below: an MSP's Helm instance holds
privileged access to every one of its clients. It is a supply-chain target. A
single compromised technician account should not yield every client's domain
admin password, and if it does, the record of it happening must survive the
attacker.

---

## 2. Isolation: three layers, in order of trustworthiness

### 2.1 Structural (strongest)

Every scoping table declares `UNIQUE (id, tenant_id)`, and every child table
references it with a **composite foreign key**:

```sql
CONSTRAINT asset_node_org_fk FOREIGN KEY (organization_id, tenant_id)
  REFERENCES organization (id, tenant_id) ON DELETE CASCADE
```

A row therefore cannot reference a parent in another tenant. Not "is prevented
from" — *cannot*. This holds if every RLS policy were dropped, if the
application were rewritten, and if someone connected with psql as the table
owner. The test suite asserts it directly (`db/tests/security.sql` §9).

The same technique pins asset subtypes to their supertype's kind: `device`
carries `node_type` with a `CHECK` and an FK to `asset_node (id, node_type)`, so
a device row cannot attach to a node declared as an SSL certificate.

### 2.2 Row-Level Security

Every table carrying `tenant_id` has RLS **enabled and forced**, with per-command
policies resolving against transaction-local session variables.

Two conventions, both load-bearing:

**Separate policies per command.** A single `FOR ALL` policy reuses its `USING`
clause as the `WITH CHECK` for writes, which permits an `UPDATE` that moves a row
*out* of your tenant. Helm declares `SELECT`, `INSERT`, `UPDATE` and `DELETE`
policies separately, and `UPDATE` carries both clauses.

**Reads fail quiet, writes fail loud.** `USING` calls
`helm.current_tenant_id()`, which returns `NULL` when unset — so a connection
that skipped `set_session_context()` matches no rows. `WITH CHECK` calls
`helm.require_tenant_id()`, which raises. A forgotten context produces an empty
list on read and an exception on write, never a cross-tenant leak.

`FORCE ROW LEVEL SECURITY` matters as much as `ENABLE`: without it, the table
owner — which is the role migrations run as — bypasses every policy.

A catalog assertion at the end of `0200_rls_policies.sql` fails the migration if
any table carrying `tenant_id` lacks either. The failure mode that matters is not
a badly written policy; it is a table added six months from now that nobody
remembered to wire up. The catalog cannot forget.

### 2.3 Application (weakest — convenience, not a boundary)

Drizzle query helpers add tenant predicates for query performance and clarity.
Nothing relies on them for correctness.

---

## 3. Session context

```
BEGIN;
SELECT helm.set_session_context(tenant_id, actor_id, 'user', request_id, ip, ua);
  ... all request queries ...
COMMIT;
```

`helm.set_session_context()` is `SECURITY DEFINER` and derives role, rank,
organisation scope and the effective permission set **from the database**. The
caller supplies only an identity and request metadata. It cannot assert "I am a
super admin" or "my scope is every organisation" — those come from the
`membership` row.

It refuses to run outside an explicit transaction. `SET LOCAL` outside a
transaction evaporates after the statement, and under a transaction-pooling proxy
a context set without `BEGIN` could be inherited by another tenant's request on
the same backend. The check (`helm.assert_in_transaction()`) compares
`xact_start` to `query_start` in `pg_stat_activity`.

Organisation scope uses an explicit sentinel rather than NULL:

| `helm.org_scope` | Meaning |
| --- | --- |
| unset or `''` | **No organisations.** Fail closed. |
| `'*'` | Every organisation in the tenant (MSP staff). |
| `'uuid,uuid'` | Exactly those organisations (co-managed client users). |

"NULL means everything" is one accidental outer join away from a breach.

### 3.0 Custom roles

Besides the built-in ladder, a tenant can define its own roles (0830): a name,
MSP staff or client-side, an access level, and an exact set of permissions,
chosen from the catalogue on the People screen. A custom role is an `app_role`
row with a `tenant_id`, its permissions in `role_permission`, so
`set_session_context()` builds a holder's permissions exactly as for a built-in
role, and an edit reaches every holder on their next request.

| Rule | Why |
| --- | --- |
| **Only `tenant:write` defines roles**, through `create_custom_role` / `update_custom_role` / `delete_custom_role`; the request role still cannot write the catalogue | Changing what a role means is a change to the authority model — the same call 0480 made for overrides |
| **A role is visible and assignable only in its own tenant.** `app_role` and `role_permission` gained RLS (built-in rows visible to all), and a trigger on `membership` and `service_account` refuses another tenant's role even from a `SECURITY DEFINER` path or the superuser | Several functions look roles up by key past RLS |
| **Nobody gives out a permission they do not hold** — when defining a role, and when assigning one to a person or a service account (`helm.enforce_role_assignment()`, every column, like 0350) | Rank alone protected the built-in ladder because every role that can manage people holds everything below it. A custom role breaks that: rank 40 with `tenant:write` would be one click from `tier3` assigning it to itself |
| **The access level is bounded**: at most your own; at least 40 for MSP staff; at most 30 for a client-side role | Rank still gates RLS writes and each secret's `min_role_rank`; a customer login must not clear a rank-40 gate |
| **MSP-only permissions stay off client-side roles**, and the kind of role is fixed at creation | The 0020 trigger already enforces the first; flipping the kind later would strand tenant-wide memberships |
| **A role somebody holds cannot be deleted** | The audit log names it, and a membership must always resolve to a role |

`helm.grantable_roles()` is the one answer to "what may I assign", used by the
People screen, the users API and the service-account form, so the pickers never
offer what the triggers would refuse.

### 3.1 Per-user permission overrides

A role carries a permission set. `membership_permission` adds to it or subtracts
from it for one person: `set_session_context()` unions the grants, subtracts the
denies and honours `expires_at`. Each row carries a reason and who wrote it.

Three acts, deliberately distinct, because they read differently six months
later:

| | Effect |
| --- | --- |
| **Grant** | Adds a permission the role does not carry. |
| **Deny** | Removes one the role does carry. The row stays, pinned off. |
| **Remove** | Deletes the override, so the role decides again. |

A deny and a removal look identical from outside and are opposite intentions.

**Who may write one: `tenant:write`**, raised from `user:write` in 0480.
`user:write` is "manage the people in this tenant" — invite somebody, change
their role, end their membership. An override changes what the role catalogue
*means* for one person, which is a change to the authority model rather than to
somebody's job. In the shipped catalogue `tenant:write` belongs to `super_admin`
alone.

**Two rules the API does not enforce**, because they belong beside the data
where they hold for every writer — a route, a maintenance script, a psql
session (the argument 0350 makes for `membership`):

- **Nobody grants a permission they do not hold themselves.** Without this,
  `tier3` (rank 80, holds `user:write`, does not hold `tenant:write`) could
  write itself a `tenant:write` grant here and be rank-100 in effect on its next
  request. That was live until 0480 and is reproduced in `db/tests/security.sql`
  §40.
- **An MSP-only permission never reaches a client-side role.** `permission.msp_only`
  marks the fifteen a co-managed customer may never hold, and a trigger on
  `role_permission` (0020) has always enforced it there. `membership_permission`
  had no equivalent, so `secret:export` could be pinned straight onto a
  `client_admin` and was honoured in full — which is exactly the precondition for
  the export escalation described in
  [05-workers-and-exports.md](./05-workers-and-exports.md).

Both are enforced by `helm.enforce_membership_permission_authority()`, which
fires `BEFORE INSERT OR UPDATE` on every column and is deliberately **not**
`SECURITY DEFINER` — it reads the caller's own context. Denies are exempt from
both rules: a deny only ever subtracts, and refusing one would mean an
administrator could not withdraw a permission they may not hand out.

The table carries policies for all four commands. Until 0480 it had SELECT and
INSERT only, so `UPDATE` and `DELETE` matched zero rows and reported success —
a grant could be made and never taken back through the request path, and a
revoke button over that would have said "done" and changed nothing.

The write path is `/api/users/[userId]/permissions` (GET, POST, DELETE), surfaced
on the People page. You cannot edit your own overrides, for the same reason you
cannot edit your own membership: the useful things you could do are the ones
that lock you out.

---

## 4. Secrets

### 4.1 Key hierarchy

```
KEK — the master key. On-premises: HashiCorp Vault, or a key file on this host.
 └─ DEK — one per tenant per generation, stored only wrapped (tenant_data_key)
     └─ AES-256-GCM ciphertext — one row per secret version
```

Postgres never sees a plaintext secret or an unwrapped DEK. The database stores
an opaque envelope; the application unwraps the DEK and decrypts in-process.

Helm is deployed **on-premises with no cloud KMS**, so the master key comes from
one of two places, and the difference between them is worth stating plainly
because it is the difference in what a breach costs:

| Provider | Where the master key lives | Root on the Helm host can… |
| --- | --- | --- |
| `vault-transit` | HashiCorp Vault's transit engine, on another host | …use Helm's Vault token until it is revoked. Every unwrap is a Vault audit entry. |
| `local-keyfile` | A mode-0400 file on the Helm host | …read the master key and decrypt the entire database offline, leaving no trace. |

Both defeat the threat the envelope scheme is really aimed at — a stolen
database dump, replica or backup tape yields wrapped DEKs and ciphertext and
nothing else. They differ on host compromise, and `vault-transit` is preferred
precisely because it gives you a revocation point and a record.

`tenant_data_key.host_held_kek` is a generated column recording which case each
key falls under, so "could someone with root on the app server have read this"
is a query rather than an exercise in reconstructing deployment history.

`local-dev` is refused when `NODE_ENV=production`. It is not a third production
option: its key is unversioned, so the master key could never be rotated without
stranding every tenant DEK.

**Master key rotation** is a distinct, much cheaper operation than data key
rotation: the DEK does not change, so no field ciphertext is touched. See
`docs/architecture/03-crypto-operations.md` §4.

pgcrypto is deliberately **not** used for field encryption. Passing a key as a
SQL literal puts it in `pg_stat_activity`, in `log_statement` output, and in any
query sampler that happens to be running.

### 4.2 Envelope integrity

| Control | Mechanism |
| --- | --- |
| Nonce uniqueness | `UNIQUE (data_key_id, nonce)`. GCM nonce reuse is not degradation, it is a total break — two messages under one `(key, nonce)` leak their XOR and allow tag forgery. A duplicate-key error is a far better outcome. |
| Context binding | `aad` binds ciphertext to `tenant\|secret\|field\|version`. A blob lifted from one row fails authentication in another rather than decrypting to a different client's password. |
| Parameter pinning | `CHECK octet_length(nonce) = 12` and `octet_length(auth_tag) = 16` — the only GCM parameters with a clean security proof and the only ones Node and WebCrypto agree on. |
| Append-only | `secret_version` rejects `UPDATE`/`DELETE` by trigger. Rotation writes a new version. |

### 4.3 Reads cannot outrun the audit log

This is the central mechanism, and it is worth being precise about:

- `secret_version` has RLS enabled and **no SELECT policy at all**. Not a
  restrictive one — none. Every direct read returns zero rows for every role.
- `helm_app` additionally holds **no SELECT privilege** on the table.
- The only route to ciphertext is `helm.reveal_secret()`, which is
  `SECURITY DEFINER` and writes its audit row **in the same transaction** as the
  read.

There is no ordering in which material is returned and the access is not
recorded: either both commit or neither does. This is the difference between
"the application logs secret access" — a code-review promise that a new developer
with a raw query can break — and "the database cannot hand out a secret without
logging it".

Denials are recorded too. PostgreSQL has no autonomous transactions, so raising
on refusal would roll back the record of the refusal — and a denied attempt is
exactly what an investigation needs. `reveal_secret()` therefore *returns*
`granted = false`, leaving the audit insert committed; the application turns that
into a 403.

The application half of that is easy to get wrong, and was: throwing inside the
transaction wrapper rolls the audit row back and silently undoes the guarantee.
`SecretService.reveal()` commits first and throws afterwards, and
`tests/integration/secrets.test.ts` asserts the denial row survives.

Refused **writes** are a different shape — a write that is refused cannot return
a value, so `write_secret_version()` raises, and the raise rolls back the audit
row it wrote first. The application records those from a separate transaction
instead, so "every denied attempt is logged" holds on both paths.

### 4.4 Authorisation ladder

Evaluated in order, most specific refusal first:

1. Visibility — `helm.secret_node_visible()`, for client-side actors only
2. `secret:reveal` permission
3. `current_role_rank() >= secret.min_role_rank`
4. Step-up verification, if `requires_step_up`
5. A justification of at least 10 characters, if `requires_reason`
6. `secret:export` for export purposes
7. Sensitivity gate for autofill — elevated and critical credentials are never
   auto-filled into a browser

A `critical` secret is constrained by `CHECK` to always require both step-up and
a reason. That is an invariant, not a default an admin can quietly clear.

Visibility leads rather than trails because the audit row records the reason,
and "your rank is too low" is a different fact from "you may not see this at
all" — the second is the one an MSP needs when a client asks why.

### 4.4.1 Which secrets a client-side actor may know exist

`helm.secret_node_visible(secret_id)` answers one question: may a client-side
role know this secret exists at all? It gates both the ladder's first rung and
`secret`'s own SELECT policy, and it is skipped entirely for MSP-side actors —
the caller short-circuits on `helm.is_tenant_wide()` first, so nothing below
applies to the operator's own view of their data.

The rule is `bool_or(NOT is_internal_only)` across **every** asset node that
references the secret. One ordinary reference is enough: a secret documented on
both an internal-only asset and a client-visible one stays visible, because the
client-visible one is a legitimate reason for the client to know it exists.

Four reference paths reach a secret, and all four are resolved:

| Path | Column |
| --- | --- |
| Credential, and its TOTP seed | `credential.secret_id`, `credential.totp_secret_id` |
| Secret field on a flexible asset record | `flexible_asset_secret.secret_id` |
| Certificate private key | `ssl_certificate.private_key_secret_id` |
| Licence key | `license.license_key_secret_id` |

**A secret with no referencing node is not visible.** 0390 defaulted the other
way, reasoning that such a secret was never part of the credential model and
stayed governed by organisation scope, `secret:reveal`, rank and step-up. 0460
flipped it, for two reasons:

- That premise was false even when written — `flexible_asset_secret` already
  existed — so the permissive default was standing for two different things at
  once: "genuinely unattached" and "attached by a path the function does not
  know about". The second is a silent leak of an internal-only secret's label,
  kind, sensitivity and rotation state.
- The failure mode has now happened twice (flexible assets, then the UniFi
  integration). A permissive default turns a forgotten reference path into an
  exposure nobody sees; a fail-closed one turns it into "why can't the client
  see this", which is the direction this class of mistake should fail in.

The default is not relied on to be remembered: 0460 carries a migration-time
guard that reads `pg_constraint`, and a **new** foreign key into `secret` from a
table the function does not name fails the migration. Two references are exempt
by name — `secret_version` (a secret's own versions, not a reference to it) and
`unifi_site_mapping.api_key_secret_id` (integration configuration with no asset
node behind it, so there is no flag to consult; it falls to the default and is
therefore MSP-side only, which is what it should be).

In practice the flip affects legacy and integration material only. Every secret
created through `POST /api/secrets` is written with a credential row in the same
transaction, and every secret created through a flexible asset record is written
with a `flexible_asset_secret` row.

### 4.4.2 Step-up verification

A step-up is a person proving, again, that they are the one holding the session.
`POST /api/auth/step-up` takes the caller's **local password**, verifies it
through the ordinary sign-in path, and calls `helm.record_step_up()` to write a
`step_up_verification` row valid for **15 minutes** by default — the session
policy's step-up window (0890), which an administrator may set between 1 and 60.

Three properties are load-bearing:

- **It reuses `attemptLocalLogin()`**, so it inherits the sign-in throttle, the
  lockout and the `auth_attempt` ledger. Without that, a stolen session cookie
  becomes an unthrottled password oracle at an endpoint the login form's limits
  never see. `establishSession: false`: it proves knowledge, it does not mint a
  session.
- **It is refused to API tokens.** `helm.record_step_up()` rejects service
  accounts, but a token issued to a *user* carries `actor_type = 'user'` and
  would pass that check. The route refuses anything that did not arrive on a
  browser session.
- **It resolves its tenant exactly as the reveal does** (the `X-Helm-Tenant`
  header, via `resolveIdentity()`), because `set_session_context()` matches
  `step_up_verification` on `(user_id, tenant_id)`. A step-up recorded against
  the wrong tenant is written, audited, and silently useless.

The verification is **not a token handed back to the client**. It is a row the
database reads when the *next* request opens its session context — which is why
the interface retries the original action as a new request rather than replaying
one (`src/lib/ui/step-up.ts`).

RADIUS users can step up: `attemptLocalLogin()` tries the directory first, and
the recorded method is `password` either way. An account with no local password
and no RADIUS — SSO-only — **cannot** step up, and the route says so specifically
rather than answering "wrong password" forever. `step_up_verification.method`
already permits `webauthn`, `totp` and `sso_reauth`; none of those factors exists
in this product yet.

**An asymmetry worth knowing.** The two gates do not key on the same column:

| | Gate | Column |
| --- | --- | --- |
| Reveal | `helm.reveal_secret()` | `secret.requires_step_up` |
| Write / rotate | `helm.write_secret_version()` | `secret.sensitivity = 'critical'` |

So a `standard` secret flagged `requires_step_up` cannot be read without a
step-up but *can* be rotated without one. A `critical` secret needs one for
both — and, because of the `CHECK`, always carries `requires_step_up` anyway.
This is stated because two code comments previously asserted the stronger,
untrue rule.

### 4.4.3 Session policy (0890)

How long a session lives is a tenant setting, under Global → Settings →
Sessions and sign-in, and needs `tenant:write`:

- **Idle timeout** (default 480 minutes). `auth_session.last_seen_at` moves
  forward, at most once a minute, whenever the session is resolved; a session
  unused for longer is deleted the next time it is read. The shell warns a
  minute before and, while somebody is active on a page, pings so that reading
  is not idleness.
- **Absolute lifetime** (default none). Measured from `created_at`, which
  nothing moves: sign in again every N hours, however active.
- **Step-up window** (default 15 minutes) and the **local lockout** threshold
  and ceiling (default 5 and 15 minutes).

A person with memberships in several tenants is held to the strictest of
their tenants' policies (`helm.session_policy_for_user`). The enforcement runs
on `helm_auth` in the Auth.js adapter, so it covers SSO, OIDC, RADIUS and local
sessions alike, and it fails closed: a policy that cannot be read is a sign-in
prompt. **Sign everybody else out** ends every session of every member of the
tenant but the caller's, and is audited as `session.ended_all`.

### 4.5 Password reuse detection

`secret_version.reuse_hmac` is an HMAC of the plaintext under a per-deployment
blind-index key that is **not** derived from the KEK. It answers "this password
is reused across four clients" without storing anything that helps crack it.

Stated plainly: an attacker holding both this column and the blind-index key
gains an offline verification oracle for guessed plaintexts. The column is
nullable; deployments that do not want that tradeoff leave
`HELM_BLIND_INDEX_KEY_B64` unset and get no reuse detection.

### 4.6 The browser extension (1120)

A Chrome, Edge and Brave extension that looks up the credentials for the site
in front of a technician and copies a username, a standard password or a
one-time code. It does not fill forms. The code is in `extension/`; the server
side is `src/lib/extension/` and `/api/extension/*`.

**What the extension holds.** A P-256 device key it made itself, the private
half a non-extractable WebCrypto key in IndexedDB, and a `helm_be_` token. The
token is half a credential: `resolveIdentity()` refuses an extension token on
any request not signed by the device key over the method, path and query, a
timestamp within five minutes, and a SHA-256 of the body
(`src/lib/extension/signature.ts`). `helm.authenticate_api_token()` returns the
key of the token's live pairing for this, and nothing else changed at the
pre-context boundary; the guard still counts three functions. A token lifted
from the extension's storage, a log or a proxy is therefore not usable on its
own. What this does not defend: somebody with the browser profile on disk has
both halves, because non-extractable means "not exportable by script", not
"not on disk".

**Who may pair, and how.** A person, from a browser session, holding a
tenant-wide (MSP-side) role, in the tab the extension opens. The page shows the
key's fingerprint, which the extension's settings also show, and pairing is
the person pressing Pair. The token goes from that response to the extension
by `window.postMessage` to Helm's own origin, received by a listener the
extension injected into that one tab and checked against a random state; it is
never in a URL or the person's hands (`src/lib/extension/pairing-protocol.ts`).
`helm.pair_browser_extension()` refuses a client-side role, a service account
and a token-authenticated request, and every `/api/extension/*` route checks
the tenant-wide scope again on each request.

**What it may reveal.** `helm.reveal_secret()` has one more rung: an
extension token may reveal for `copy`, `autofill` and `totp` only, and a
password only when its secret is `standard`. Elevated and critical credentials
are listed with "Open in Helm" and refused if asked for anyway
(`not_permitted_for_extension`). Step-up was already unreachable to any token.
The personal vault is readable by the owner's extension, for `copy` and codes,
and not writable by it.

**Lifetime.** An extension token lives 30 days and the extension renews it in
its last week (`helm.renew_browser_extension_token()`, which revokes the old
one in the same statement). Unused for 30 days, it lapses. Unpairing under
Security & notifications, disabling the person or ending their membership stops
it on the next request.

**Lookup is not access.** The match and search routes return metadata only and
write no audit row, as 0210 decided for autofill: merely visiting a page must
not count as opening a credential. Each copy is a reveal with purpose `copy`,
audited exactly as the web interface's quick copy is.

**A personal API token cannot read the personal vault.** 1030's header said no
token could, relying on a token's actor never being a person; a personal token
(0750) is one. The owner policy now requires a request with no token, and the
extension's read-only policy admits only its own token type.

---

## 5. Audit log

Monthly RANGE partitions, per-tenant SHA-256 hash chain, immutable by trigger and
by revoked privilege.

```
row_hash = sha256(prev_hash || canonical(row))
```

The canonical form is pinned field by field rather than derived from
`to_jsonb(NEW)`, so a later `ALTER TABLE` adding a column does not silently
change every hash computed afterwards and make history unverifiable across the
schema change.

`audit_chain_head` is both the serialisation point (the insert trigger takes a
row lock on it, which is what makes `chain_seq` gap-free) and the anchor point.

**What the chain gives you:** `helm.verify_audit_chain()` locates the exact
break. The test suite proves three attacks are detected: editing a row, deleting
a row, and the sophisticated case — editing a row *and recomputing its hash* so
it is internally consistent, which still fails because every later row's
`prev_hash` was computed from the original.

**And it constrains what a bug fix may do.** `node_id` is inside the canonical
form, so a migration that "corrected" a stored `node_id` would invalidate every
hash after it. When the secret rows turned out to carry the wrong `node_id`
(0610 — `helm.audit()`'s sixth parameter received the secret's id, so
`helm.node_visible(node_id)` was false for every one of them and a scoped
reader saw none of its own credential history), the fix had to be to the
*policy* rather than to the data. The predicate now asks
`helm.secret_node_visible(entity_id)` for `secret.created` and
`secret.rotated` — the question a row about a secret can answer — and the rows
already written are unchanged, so the chain still verifies. A log you can
retroactively tidy up is not evidence.

**What it does not give you:** protection from someone with superuser or
filesystem access, who can disable triggers and recompute the whole chain
forward. Tamper *evidence* requires the head to be witnessed somewhere Postgres
cannot reach. The anchoring worker writes witnessed heads to
`HELM_AUDIT_ANCHOR_DIR`, one JSON line each; `anchored_seq` records how far
that has got. The directory is only a witness if Helm cannot rewrite it — a
WORM mount, an append-only share, a path your backups snapshot — so the choice
of directory is an operational control, and without it the chain only detects
careless tampering.

---

## 6. Privilege separation

Four database roles, none of them superuser and **none with `BYPASSRLS`** — a
migration assertion fails the deploy if any helm role acquires it, because that
one attribute silently disables every policy in the system.

| Role | Can | Cannot |
| --- | --- | --- |
| `helm_app` | Serve requests | Read `secret_version`, read auth tokens, modify audit history, write keys |
| `helm_auth` | Run the Auth.js adapter | Touch any tenant data |
| `helm_key_admin` | Rotate keys, maintain partitions | Read documentation |
| `helm_auditor` | Read audit history | Write anything |

The table says five roles' worth of the model; `helm_worker` is a member of
`helm_app` and adds only the cross-tenant backlog enumerators.

Assertions at the end of `0220_grants.sql` verify each of these negatives at
migration time rather than leaving them to a penetration test.

### The migrating role is the exception, and it has to be

Everything above is about roles that must NOT bypass RLS. The role that applies
the migrations must, and that is not a contradiction — it is the hinge the rest
turns on.

Every sensitive table is `FORCE ROW LEVEL SECURITY`, which subjects the table
**owner** to its own policies, and every `SECURITY DEFINER` function runs as
whoever owns it: the role that ran the migrations. So if migrations run as a
role RLS applies to, those functions match zero rows. `helm.reveal_secret()`
returns NULL instead of the credential. Nothing raises, nothing logs, and the
deployment looks healthy until somebody tries to read a password.

`db/migrate.ts` therefore refuses to run as such a role, and proves it
empirically — it creates a temporary `FORCE RLS` table and checks whether it can
read its own row — rather than trusting a `rolsuper` lookup that inheritance and
`BYPASSRLS` can both make wrong. `tests/integration/migrate-guard.test.ts`
asserts both directions.

None of this widens what the runtime roles can do. The migrating connection is
used by `pnpm db:migrate` and by nothing at request time.

---

## 7. Known limitations

Stated because planning around an overstated guarantee is worse than planning
around a known gap.

### 7.1 GUC-based RLS and SQL injection

Session variables defend against **application logic errors** — a forgotten
`WHERE`, a mis-scoped join, an ORM helper that ignores the tenant. They do not by
themselves defend against an attacker who can execute arbitrary SQL, because such
an attacker can issue their own `SET`.

What raises the bar meaningfully: `set_session_context()` derives authority from
the database, so injected SQL cannot invent a role or a scope — only re-assume
one an actual member already holds. What does not: nothing here makes arbitrary
SQL execution survivable.

Mitigations in force: parameterised queries everywhere (Drizzle), no `BYPASSRLS`,
and the audited-function boundary around secrets (injection that sets
`helm.role_rank = 100` still cannot read `secret_version`, because `helm_app` has
no privilege on it at all).

For deployments that want a harder boundary, the options are a database role per
tenant with `SET ROLE`, or a data-access proxy. Both cost operational complexity
that a single-MSP deployment usually should not pay.

### 7.2 "Zero-knowledge" is not what this is

Helm uses envelope encryption with a server-accessible per-tenant DEK. The server
*can* decrypt. That is a deliberate choice, because the product requires it:
browser-extension autofill, RMM/PSA credential sync, server-side TOTP generation
and compliance exports are all impossible over data the server cannot read.

Compromise of the application **and** KMS authorisation exposes secrets. If
genuine end-to-end encryption is wanted for a subset of items (break-glass
accounts, domain admin, DR keys), the schema can carry it as a per-item flag —
those items would be opaque to the server and excluded from autofill, sync and
export. That is a deliberate future extension, not something silently assumed.

### 7.3 Audit write serialisation

The hash chain serialises audit writes per tenant via the row lock on
`audit_chain_head`. At MSP volumes (thousands of events a day) this is the right
trade for a chain that proves something. A deployment writing millions of events
per second would need a different design — batched Merkle trees rather than a
linear chain.

### 7.4 Search index

`search_document` is the least protected copy of the data: denormalised, widely
read, and cached. Secret material
never enters it — credentials contribute label, username, type and URL only, and
flexible-asset fields are indexed **only** when explicitly allow-listed at schema
publish time, with `CHECK (NOT (secret_fields && searchable_fields))` preventing
a field being both.

### 7.5 Autofill matching

Match types are exact-host and registrable-domain subtree only. There is
deliberately **no regex or wildcard type**: hand-written `*.example.com` patterns
reliably end up matching `example.com.attacker.tld`. The extension sends the
browser-reported origin, never a page-supplied string, and the server resolves
candidates — the extension never holds a searchable copy of the vault.

The lookup that exists (§4.6) matches a credential's URL field by its host
(`helm.url_host()`) and any `credential_domain` rule, exactly or under the same
registrable domain, which the server computes from the Public Suffix List with
its private section. The tab's URL is parsed with `new URL()`, so a Unicode
lookalike arrives as punycode and never equals an ASCII host; an IP address or
intranet name only ever matches exactly.

### 7.6 Session tokens are stored as issued

API tokens and password-reset tokens are stored as SHA-256 digests, so a copy
of those tables yields nothing usable. Session tokens are not: `auth_session`
holds the cookie value itself, and `auth_account` holds identity-provider
access and refresh tokens in the clear. A database dump or backup of the
`helm_auth`-owned tables therefore yields live sessions until they expire or
are revoked. `helm_app` cannot read either table (§6), so this is about backups
and database-host compromise, not about a request-path bug.

Hashing them means wrapping the Auth.js adapter's session methods, the local
and RADIUS session functions in SQL, and a migration that hashes existing rows
(the presented cookie is then hashed on lookup, so nobody is signed out). It is
a deliberate change for its own review, not a cleanup.

---

## 8. Verification

```bash
pnpm test:sql    # the SQL security suite, against a real Postgres 16 cluster
pnpm verify      # typecheck + migration manifest + every vitest suite + schema drift
```

The SQL suite covers fail-closed defaults, tenant isolation, organisation
scoping, the full reveal authorisation ladder, audit immutability, three tamper
scenarios, GCM nonce reuse, cross-tenant FK rejection, expiry projection, graph
traversal across the isolation boundary, inline-secret rejection, and the export
controls that survived the removal of two-person approval in `0400` (§15, §35).

The TypeScript suite adds the real cryptographic path end to end: RFC 6238
vectors, AAD replay across tenant/secret/field/version, KEK context binding, DEK
cache semantics, audit coupling on reveal and denial, key rotation with backlog
convergence, and the stale-version guard that stops a rotation worker reverting
a credential.

Integration tests connect as the real non-superuser roles, which is what made
three otherwise-invisible bugs findable: a deferred constraint trigger reading
`secret_version` as the invoker (only fires at COMMIT, so a rolling-back suite
never reached it), the denial-audit rollback above, and a graph traversal that
duplicated every node downstream of a pair joined by two relations.
