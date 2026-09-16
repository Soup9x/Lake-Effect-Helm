# Lake Effect Helm — Cryptographic Operations

How the secret engine works in practice: what happens on a read, on a write, and
during a key rotation. Companion to `01-security-model.md`, which covers *why*.

---

## 1. The division of labour

Two layers, and which one owns what is the entire security argument.

| | PostgreSQL | Application |
| --- | --- | --- |
| Decides if access is allowed | ✅ | ❌ |
| Writes the audit record | ✅ | ❌ |
| Holds ciphertext | ✅ | transiently |
| Sees plaintext | **never** | ✅ |
| Sees an unwrapped DEK | **never** | transiently |

A bug in `src/lib/secrets/` can fail to decrypt. It cannot hand out a secret
without an audit row, cannot bypass the authorisation ladder, and cannot reach
another tenant's material — because none of those decisions are made there.

---

## 2. Revealing a secret

```
 app                          postgres                         KMS
  │                               │                             │
  │ BEGIN                         │                             │
  │ set_session_context()         │                             │
  │──────────────────────────────>│ resolves role, rank, scope  │
  │                               │ from the membership row     │
  │ reveal_secret(id, reason)     │                             │
  │──────────────────────────────>│ ladder: permission, rank,   │
  │                               │ step-up, reason, purpose    │
  │                               │ INSERT audit_log  ◀── same  │
  │<──────── envelope ────────────│ transaction as the read     │
  │ COMMIT                        │                             │
  │                               │                             │
  │ unwrap(wrapped_dek, context)  │                             │
  │────────────────────────────────────────────────────────────>│
  │<─────────────── DEK (cached ≤5 min) ────────────────────────│
  │                                                             │
  │ AES-256-GCM open, AAD verified against the expected binding │
  │ → SecretValue                                               │
```

Three properties worth being explicit about.

**The audit row and the ciphertext leave together.** `helm.reveal_secret()` is
`SECURITY DEFINER` and inserts the audit event in the same transaction as the
read. `secret_version` has RLS enabled with no SELECT policy and no grant to
`helm_app`, so there is no second route.

**A refusal is returned, not raised.** PostgreSQL has no autonomous
transactions, so raising on refusal would roll back the record of the refusal —
and a denied attempt is precisely what an investigation needs.
`reveal_secret()` therefore returns `granted = false`, and **the TypeScript
wrapper throws only after the transaction has committed**. That second half is
easy to get wrong: throwing inside `withTenant()` rolls the audit row back and
silently undoes the guarantee. `tests/integration/secrets.test.ts` asserts the
denial row survives.

**The binding is verified, not trusted.** The AAD stored alongside the
ciphertext is compared against the tenant, secret and version the caller asked
for *before* decryption. The GCM tag would catch a mismatch anyway, but checking
first turns "a row was moved at the database level" into a clear signal rather
than a generic authentication failure that reads like corruption.

---

## 3. Writing a secret

The AAD binds a ciphertext to its version, so the application must know the
version *before* it encrypts — but the version is allocated by the database
under a row lock. `helm.begin_secret_write()` resolves that:

```
begin_secret_write(secret_id, expected_version?)
  → locks the secret row (as definer)
  → optionally asserts the expected current version
  → returns next_version

  ... application encrypts, binding next_version into the AAD ...

write_secret_version(secret_id, key_id, ciphertext, nonce, tag, aad, ...)
  → appends the version, advances current_version, writes the audit row
```

The lock is held for the rest of the caller's transaction, so the number cannot
go stale in between.

Taking the lock inside a `SECURITY DEFINER` function is load-bearing, not
stylistic: PostgreSQL requires UPDATE (not merely SELECT) privilege for a row
lock, so a client-side `SELECT ... FOR UPDATE` would have forced UPDATE on
`secret` for every role that writes secrets — including `helm_key_admin`, whose
entire purpose is to rotate keys *without* being able to edit documentation.

### Nonce discipline

Nonces are 96-bit and random. A unique index on `(data_key_id, nonce)` makes
reuse a constraint violation rather than a silent break — under GCM, reuse is
not degradation, it leaks the XOR of two plaintexts and enables tag forgery.

At 2⁹⁶ possible nonces, a collision is not a practical concern; the index exists
because "safe by argument" and "enforced" are different things, and a duplicate
key error is a far better outcome than a quiet compromise.

---

## 4. Key hierarchy and rotation

```
KEK — Vault transit, or a master key file on this host
 └─ DEK — one per tenant per generation, stored only wrapped
     └─ AES-256-GCM ciphertext, one row per secret version
```

The encryption context (`helm:purpose`, `helm:tenant`, `helm:generation`) is
passed on both wrap and unwrap and enforced by the provider. A `wrapped_dek`
lifted from tenant A's row cannot be unwrapped as tenant B's — not because
application code checks, but because the provider refuses.

### On-premises KEK providers

Helm runs on the customer's own server and does not use a cloud KMS.

**`vault-transit`** (`src/lib/crypto/kek-vault.ts`). The master key never enters
the Helm process. Wraps go to `transit/datakey/plaintext/<key>`, unwraps to
`transit/decrypt/<key>`, and a master key rotation to `transit/rewrap/<key>` —
which re-seals a DEK under the new key version *inside Vault*, so rotation never
exposes a tenant key to the application host at all.

The transit key **must** be created with `derived=true`:

```
vault write -f transit/keys/helm-tenant-kek type=aes256-gcm96 derived=true
```

Without derivation Vault accepts the per-call `context` and silently ignores it.
Every wrap and unwrap would still succeed and the tenant binding the rest of
Helm depends on would simply not exist — a failure invisible until someone
tested whether tenant A's DEK opens as tenant B's. The provider reads the key's
configuration on first use and refuses to run against a non-derived key, rather
than trusting this paragraph to have been read.

Helm's Vault policy needs `update` on `datakey/plaintext` and `decrypt`, and
`read` on the key. Note what is absent: no `encrypt`, and no writes to
`transit/keys/*`. Helm cannot re-seal an arbitrary DEK of its own accord and
cannot rotate or delete the KEK. `rewrap` belongs to the rotation job's role,
not the web tier.

**`local-keyfile`** (`src/lib/crypto/kek-local.ts`). The master key is held by
this host. A file is strongly preferred over `HELM_KEK_B64`: an environment
variable is copied into crash dumps, `docker inspect`, the unit file that set
it, the CI system that rendered that file, and `/proc/<pid>/environ`. Helm
refuses a key file that is readable by group or other — note that `docker
secret` mounts at 0444 by default, which is exactly the case the check exists
for. With systemd, `LoadCredential=` puts it in a per-service tmpfs that is
unmounted when the service stops.

The wrapped layout is `format(1) || nonce(12) || tag(16) || ciphertext(32)`; the
leading byte exists so a future change of wrapping algorithm is *detectable*
rather than presenting as a corrupt key during an incident. The AAD is the
tenant context plus the KEK version, so a row whose `kek_id` was edited fails
authentication by construction rather than by coincidence.

### Rotating the MASTER key

This is not the same operation as rotating a data key, and conflating them is
expensive. Rotating the DEK re-encrypts every secret. Rotating the KEK re-wraps
one column per tenant key and touches no ciphertext at all.

A single-key local file has no equivalent of a KMS key version: overwriting it
would make every existing tenant DEK permanently unopenable. So the key ring is
versioned:

```json
{ "current": "v2", "keys": { "v1": "<base64>", "v2": "<base64>" } }
```

`kek_id` records `<label>/<version>` per row, wraps use `current`, and unwraps
look up whichever version actually sealed that row. The procedure:

1. Add the new version, point `current` at it, **keep the old version**, restart.
2. `pnpm helm:rotate-kek` — re-wraps every non-destroyed DEK onto the new version.
3. Confirm `0 left on an older KEK version`.
4. Only now remove the old version from the key ring.

Step 4 before step 3 is unrecoverable. `rewrapUnderCurrentKek()` is therefore
idempotent (a resumed rotation re-runs safely), reports what it could *not*
re-wrap rather than skipping it, writes a `key.kek_rewrap_incomplete` audit row
on partial failure, and exits non-zero — because the operator is about to delete
a key based on that answer.

Retired and retiring keys are re-wrapped too: history must stay readable, and an
old KEK version cannot be dropped while anything still references it. Destroyed
keys are skipped — their material is gone at the KEK and re-wrapping is neither
possible nor meaningful.

The rotation job needs to enumerate tenants, which is the one thing that cannot
happen inside a tenant context. `helm.tenants_with_keys()` is a deliberate,
minimal RLS bypass: `EXECUTE` to `helm_key_admin` only (so it is unreachable
from a request), returning names and key counts and nothing else. The
alternative — `BYPASSRLS` on the rotation role — would have handed it the whole
database instead of a list of names.

### Rotation is a state machine, not a swap

| Status | New writes | Decrypts history |
| --- | --- | --- |
| `pending` | ❌ | ❌ |
| `active` | ✅ (exactly one per tenant) | ✅ |
| `retiring` | ❌ | ✅ |
| `retired` | ❌ | ✅ |
| `destroyed` | ❌ | ❌ — ciphertext is gone for good |

`write_secret_version()` accepts only the `active` key, which is what makes the
backlog converge instead of chasing a moving target.

```
beginRotation()  → new active key, old one demoted to retiring
rotationBacklog()→ how many live secrets still depend on the old key
reEncrypt(id)    → reveal under old key, write under new. Both legs audited.
retire(keyId)    → refused by the DATABASE while anything still needs it
```

**Only current versions are re-encrypted.** Superseded versions stay on the key
they were written under. Re-encrypting them would mean appending rows to an
append-only table for no benefit — and destroying an old key making that history
unreadable is the intended effect of a shred, not a bug.

**Re-encryption uses two transactions, deliberately.** One would make
reveal-and-write atomic, but a failed write would then roll back the audit row
saying the worker decrypted this secret — and an automated process reading every
credential in the vault without leaving a trace is exactly what the audit log
exists to rule out. Splitting is safe because versions are append-only: a write
that never happens leaves the secret on the old key and the next pass retries.

**The stale-version guard.** Between the two transactions a technician might
rotate the password by hand. Writing the worker's decrypted copy back would
**silently revert their change** — a rotation job quietly restoring an old
credential is about the worst failure this system could have. `reEncrypt()`
therefore passes the version it decrypted, and `begin_secret_write()` refuses
(SQLSTATE 40001) if it has moved. The worker sees `StaleSecretVersionError` and
skips; the newer version is already under the active key anyway.

---

## 5. TOTP

Implemented in-tree (`src/lib/crypto/totp.ts`) rather than taken from a
dependency: the seed is a secret, and every package between the vault and the
generated code is supply-chain surface on the most sensitive data in the
product. It is ~100 lines of well-specified arithmetic, validated against all 18
RFC 6238 Appendix B vectors across SHA1/SHA256/SHA512.

**Generating a code is a secret access.** `generateTotpCode()` reveals the seed
through the same audited path as any other secret. An MSP that cannot show who
generated MFA codes for a shared client account has an incomplete trail. The
decrypted seed never leaves the method — only the digits come back.

Base32 decoding is deliberately lenient on formatting (lowercase, `=` padding,
space- or hyphen-separated groups — all seen in the wild) and strict on the
alphabet. A silently-skipped invalid character decodes cleanly and generates
wrong codes forever.

Verification is constant-time and the candidate loop runs to completion, so
neither the result nor the drift leaks through timing.

---

## 6. The graph

Edges are stored **once**, in a canonical direction, and read bi-directionally.

"A depends_on B" and "B supports A" are the same fact. So are both directions of
`connects_to`. A naive link table stores both, and then the map shows a
duplicated edge, impact analysis double-counts, and deleting one leaves the
other. Checking for the inverse before inserting is a read-then-write, so two
concurrent technicians still create both halves.

Instead `canonicalise()` orders the endpoints by id and flips the relation to its
inverse if that reversed them. Both spellings produce byte-identical rows, and
the existing unique index rejects the duplicate — structurally, with no race
window. Reads are unaffected: `v_asset_edge` emits every stored edge in both
directions with the relation inverted on the reverse pass.

`INVERSE_RELATION` is duplicated in TypeScript and SQL because both layers need
it. `tests/integration/graph.test.ts` reads every enum value out of the catalog
and compares the two maps — a divergence would store edges in a direction the
view inverts differently, and the only symptom would be an arrow quietly missing
from a dependency map.

### Traversal

`helm.asset_graph_walk()` returns **one row per reachable node**, shortest path
first, with `via_relations` as an array.

It did not always. The first version expanded the frontier once per *edge*, so
two assets joined by more than one relation — normal; a firewall is both
`member_of` a VLAN and `secures` it — entered the frontier twice and duplicated
everything downstream of them. For a rendered map that is noise; for `impactOf()`
it is a double-counted blast radius, which is a number someone might plan a
maintenance window on. `db/sql/0250_graph_walk_fix.sql` collapses parallel
relations into one edge carrying an array, and carries a regression assertion
that runs on every deployment.

The walk runs under the caller's RLS, so a co-managed client tracing a
dependency stops at the isolation boundary rather than discovering that another
organisation's asset exists.

---

## 7. Handling plaintext in TypeScript

`SecretValue` wraps every decrypted value:

```ts
String(value)         // "[helm secret: redacted]"
`${value}`            // "[helm secret: redacted]"
JSON.stringify(value) // "[helm secret: redacted]"
console.log(value)    // SecretValue(password) [redacted]

value.expose()        // the actual string — greppable in review
value.use(fn)         // scoped: disposed when fn returns, even on throw
```

The realistic way a credential platform leaks passwords is not a broken cipher.
It is `logger.info({ credential })` in an error path, a value in a Sentry
breadcrumb, or an object spread into a response by `...rest`. A bare string
offers no defence against any of those.

This is a guard rail, not a sandbox. Once a caller has the string it is an
ordinary immutable JS string. The point is that leaking it now requires an
explicit act that shows up in a diff.

### On zeroing, honestly

`dispose()`, `wipe()` and the DEK cache's eviction all overwrite their buffers,
and that is worth doing. It is **best-effort and not a guarantee**: V8 may have
copied the bytes during GC, the OS may have paged them out, and none of it
survives a core dump taken mid-request. Treat it as shortening the exposure
window, not as making key material unrecoverable.

---

## 8. Verification

```bash
pnpm verify              # typecheck + 151 vitest tests + schema drift
pnpm test:sql            # 105 SQL assertions incl. tamper detection
```

| Suite | Covers |
| --- | --- |
| `tests/unit/totp.test.ts` | All 18 RFC 6238 vectors, base32 edge cases, window and URI handling |
| `tests/unit/envelope.test.ts` | Round-trip, tamper rejection, AAD replay across tenant/secret/field/version, KEK context binding, DEK cache semantics, blind index |
| `tests/integration/secrets.test.ts` | Real encryption path, audit coupling, the full authorisation ladder, denial durability |
| `tests/integration/rotation.test.ts` | Key state machine, re-encryption, backlog convergence, stale-version guard |
| `tests/integration/graph.test.ts` | Canonicalisation, inverse map parity with SQL, intrinsic edges, traversal, isolation boundary |

Integration tests run against a real cluster as the real non-superuser roles.
That is not thoroughness for its own sake: RLS policies, `SECURITY DEFINER`
boundaries and grants do not exist in a mock, and every one of them is somewhere
a tenant-isolation bug can hide. Three of the bugs fixed during Step 2 —
`secret_version` privilege on a deferred constraint trigger, the denial-audit
rollback, and the graph frontier duplication — were invisible to any test that
did not commit against real roles.
