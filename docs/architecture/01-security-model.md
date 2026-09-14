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

1. `secret:reveal` permission
2. `current_role_rank() >= secret.min_role_rank`
3. Step-up verification, if `requires_step_up`
4. A justification of at least 10 characters, if `requires_reason`
5. `secret:export` for export purposes
6. Sensitivity gate for autofill — elevated and critical credentials are never
   auto-filled into a browser

A `critical` secret is constrained by `CHECK` to always require both step-up and
a reason. That is an invariant, not a default an admin can quietly clear.

### 4.5 Password reuse detection

`secret_version.reuse_hmac` is an HMAC of the plaintext under a per-deployment
blind-index key that is **not** derived from the KEK. It answers "this password
is reused across four clients" without storing anything that helps crack it.

Stated plainly: an attacker holding both this column and the blind-index key
gains an offline verification oracle for guessed plaintexts. The column is
nullable; deployments that do not want that tradeoff leave
`HELM_BLIND_INDEX_KEY_B64` unset and get no reuse detection.

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

**What it does not give you:** protection from someone with superuser or
filesystem access, who can disable triggers and recompute the whole chain
forward. Tamper *evidence* requires the head to be witnessed somewhere Postgres
cannot reach. Periodically anchor `audit_chain_head` to WORM storage
(`HELM_AUDIT_MIRROR_BUCKET`); `anchored_seq` records how far that has got. The
schema is built for this, but the anchoring job is an operational control and
without it the chain only detects careless tampering.

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

Assertions at the end of `0220_grants.sql` verify each of these negatives at
migration time rather than leaving them to a penetration test.

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
read, cached, and a candidate for mirroring into Meilisearch. Secret material
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

---

## 8. Verification

```bash
pnpm test:sql              # 105 SQL assertions against a real Postgres 16 cluster
pnpm verify                # typecheck + 151 TypeScript tests + schema drift
```

The SQL suite covers fail-closed defaults, tenant isolation, organisation
scoping, the full reveal authorisation ladder, audit immutability, three tamper
scenarios, GCM nonce reuse, cross-tenant FK rejection, expiry projection, graph
traversal across the isolation boundary, inline-secret rejection, and export
four-eyes approval.

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
