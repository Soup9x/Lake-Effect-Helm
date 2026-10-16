# Lake Effect Helm — API Layer

How a request becomes a tenant-scoped database transaction, and what stops it
becoming an untenanted one. Companion to `01-security-model.md` (guarantees) and
`03-crypto-operations.md` (the secret engine).

---

## 1. The shape of a request

```
  HTTP request
      │
      ▼
  tenantRoute(handler, { permissions })
      │
      ├─ resolveIdentity(request)          who is this, in which tenant?
      │    ├─ Bearer token  → helm.authenticate_api_token()   (no context yet)
      │    └─ Session cookie → getSessionUser() + memberships_for_user()
      │
      ├─ withTenant(identity, fn)          BEGIN; set_session_context(); …
      │    └─ the database resolves role, rank, scope, permissions
      │
      ├─ assertPermitted(session, options) fast, clear failure — not the boundary
      │
      └─ handler({ tx, session, identity, params })
                 ▲
                 └── the ONLY database handle a route ever sees
```

### Why the wrapper exists

One failure mode, made structurally impossible: **a route that queries tenant
data without first establishing the RLS session context**.

A handler written with `tenantRoute()` is *given* a transaction that already has
the context set. It is never given a pool, a connection, or any way to reach
one. Forgetting the context is not a mistake available here — there is no code
path from a route to the database that does not go through `withTenant()`.

Everything else the wrapper does — request ids, error mapping, permission
pre-checks — follows from having one place all requests pass through.

`publicRoute()` exists for health checks and login, and is named to be
conspicuous in review. It hands the handler no database access at all.

`serviceRoute()` is for handlers whose work happens in a service that opens its
own transaction — reveal, rotate, copy, TOTP codes, exports, documents, logos,
the link engine. It checks the declared permissions in a short transaction,
commits it, and hands the handler no transaction at all, only `actor`: the full
session-context request, with request id, IP, user agent and API token id.
Under `tenantRoute()` those handlers held one pooled connection idle while the
service checked out a second — enough concurrent requests could exhaust the pool
— and the service's audit rows lost the request context, and an API token's
scopes did not apply. A handler that needs its own reads opens them with
`withTenant(actor, ...)` before or after the service call, never around it.

### The permission options are not the security boundary

```ts
export const GET = tenantRoute(handler, { permissions: ['secret:reveal'] });
```

This produces a clear 403 before the handler runs. It is **not** what enforces
the rule: RLS policies and the `SECURITY DEFINER` secret API run regardless of
what a route declares. A route that forgets to declare a permission is still
safe; it just returns an uglier error from deeper down.

That ordering matters. If the declaration were the enforcement, every new route
would be a chance to forget one.

---

## 2. Authentication

Two paths, separated because their threat models differ:

| | Session | API token |
| --- | --- | --- |
| Carrier | Cookie | `Authorization: Bearer` |
| Who | A technician in a browser | A script or tool acting as the person who issued the token |
| Step-up possible | Yes | **No** — machine accounts cannot re-authenticate |
| IP restriction | No | Yes, exact-match allowlist |
| Revocation | Delete the session row | Set `revoked_at` |

### The chicken-and-egg, and how it is resolved

Resolving "which tenant is this bearer token for" is the question that must be
answered *before* a tenant context exists. That is a genuine bootstrap problem,
not an excuse to relax RLS.

`db/sql/0270_authentication.sql` gives it exactly three `SECURITY DEFINER`
functions, each as narrow as the job allows: `authenticate_api_token`,
`record_api_token_use`, `memberships_for_user`. They return only what is needed
to establish a context — never tenant data, never a secret, never an audit row —
and make no authorisation decision. A migration-time assertion fails the deploy
if a fourth appears, so adding one is a decision rather than a drift.

### Issuing one

`POST /api/account/tokens` issues a PERSONAL token: bound to the person, carrying
`*` (everything their role allows) or a subset of the permissions the database
resolved for that session, expiring within a year, and shown exactly once.
`helm.issue_my_api_token()` (0750) enforces all of that itself, including that a
request which authenticated with a token cannot issue another — a leaked
30-day token must not become an unbounded chain of them. Revocation
(`DELETE /api/account/tokens/:id`) is immediate: the session context re-reads
`revoked_at` on every request.

A SERVICE ACCOUNT is the identity for automation that outlives a person.
Settings → Service accounts creates one with a role and a scope, under 0350's
rule that nobody grants above their own rank, and issues it tokens whose
scopes are bounded by the account's role rather than the administrator's
(`helm.issue_service_account_token()`, 0760). Disabling the account refuses
every token it holds on the next request. The built-in worker identities get
no tokens: they run in-process as the worker role.

### Token format

```
helm_sa_A7f3Kp2Q.9dLm4xR8vQ2wN6bT1cY5hJ0sF3gK7pZ...
└─ prefix ────┘ └──────────── secret ───────────┘
```

Stored: the prefix in the clear (indexed, so verification is one lookup) and
SHA-256 of the whole token. The secret half is never stored, so a database dump
yields nothing usable.

**Why a visible prefix.** It makes a leaked token identifiable. When one turns
up in a public repository or a support ticket, `helm_sa_A7f3Kp2Q` can be revoked
without anyone working out which token it was, and secret scanners can be taught
the pattern.

**Why SHA-256 and not Argon2.** This is the opposite of the right answer for
passwords, and the reasoning matters: these tokens are 256 bits of CSPRNG
output. There is no dictionary to attack, so a slow hash buys nothing while
making every API request cost 100ms.

**Constant time everywhere.** The comparison is `timingSafeEqual`, and an
unknown prefix is compared against a fixed dummy hash so that "no such token"
takes the same time as "wrong secret". Without that, response timing confirms
which prefixes exist.

### Every rejection is one flat 401

`revoked`, `expired`, `unknown`, `ip_not_allowed`, `subject_disabled` — all
return `invalid API token`. The reason is logged server-side only. Telling a
caller their token is *expired* rather than *unknown* confirms it was real, and
even "invalid or expired" invites the reader to infer which.

### X-Forwarded-For is read from the right

```ts
const index = parts.length - hops;   // count back from the trusted end
```

The common mistake is taking the leftmost entry, which is entirely
client-controlled — and that defeats IP allowlisting completely. Helm counts
back `HELM_TRUSTED_PROXY_HOPS` entries from the right, which is the only part a
trusted proxy actually writes.

### Multi-tenant users are asked, not guessed

A user with memberships in two tenants must send `X-Helm-Tenant`; without it the
request is a 400 listing the options. Silently picking the first membership is
how a technician writes documentation into the wrong MSP.

---

## 3. Error mapping

| Situation | Status | Code |
| --- | --- | --- |
| No session, no token | 401 | `unauthenticated` |
| Authenticated, no membership | **403** | `forbidden` |
| Secret needs re-auth | 403 | `step_up_required` |
| Secret needs a justification | 403 | `reason_required` |
| Role too low / no permission | 403 | `forbidden` |
| Not found **or not yours** | 404 | `not_found` |
| A `helm:` RAISE, a CHECK, a value that would not cast | 400 | `invalid_request` |
| A UNIQUE or EXCLUSION constraint, two writers crossing | 409 | `conflict` |
| `no_data_found` inside a function | 404 | `not_found` |
| Anything unexpected | 500 | `internal` |

Three decisions worth stating:

**"No membership" is 403, not 401.** Re-authenticating will not help a former
employee whose account still exists; a login prompt would just loop them.

**`step_up_required` is distinguishable from `forbidden`.** The client needs to
know whether a re-authentication prompt would help. Collapsing both to a generic
403 means showing "ask your manager" to someone who could have solved it
themselves, or a useless prompt to someone who cannot.

**Not-found and not-yours are identical.** The database already refuses to
distinguish them — `helm.reveal_secret` returns `not_found` for both — and an API
that renders different messages hands that distinction straight back.

Unknown errors collapse to a bare 500 carrying only the request id. A Postgres
error message can contain a column name, a constraint body, or part of a query,
and the client may be a co-managed customer.

**The schema's own refusals are 4xx, and say what the schema said.**
`src/lib/api/pg-errors.ts` maps the SQLSTATEs a request can legitimately
provoke. A message Helm raised itself — `RAISE EXCEPTION 'helm: configure a
mail relay before adding an email destination'` — passes through with the
prefix removed, because that prefix is the schema's declaration that the
sentence is for a person. A message Postgres composed ("new row for relation
smtp_setting violates check constraint smtp_pin_shape") never does: it becomes
one fixed sentence per code, and the original is logged under the request id.
Codes not in the table (a statement timeout, a lost connection) stay 500s; a
400 would hide an outage. A route may still throw its own `ApiError` for a
more specific sentence, and that wins.

The denial reason mapping is `switch`-exhaustive over the SQL API's denial
reasons: adding one without a mapping fails the build rather than silently
becoming a 500.

---

## 4. Reveal is a POST

```
POST /api/secrets/:secretId/reveal
```

Not a GET, deliberately. A GET would end up in browser history, in proxy access
logs and in `Referer` headers, and would be prefetchable and CSRF-able — for the
one endpoint in the product that hands out plaintext credentials.

The response carries `auditEventUid`. Every reveal is recorded before material is
returned, and surfacing the id lets support answer "who saw this and when" from a
single lookup.

The plaintext is disposed as soon as the response is serialised
(`SecretValue.use()`), and every response carries `Cache-Control: no-store`.

---

## 5. Flexible assets: untrusted schemas

The builder lets a Tier 3 engineer define a documentation template at 4pm on a
Friday. That schema is then compiled by Ajv and run against input, which makes it
*code* in every sense that matters. Privilege protects against malice, not
against a mistake.

### Regular expression denial of service

This is the real hazard, and the section worth reading carefully because the
obvious mitigation does not work.

A `pattern` becomes a JS `RegExp` with no timeout. A backtracking one hangs the
event loop for the whole process — every tenant, not just the one whose record
triggered it.

**A length limit is not sufficient.** `^((a)+)+$` against a 31-character
non-matching subject runs for **over a minute**. Backtracking is exponential in
the input length, so any bound loose enough to be useful for a form field is
still catastrophic. An earlier draft of this layer claimed a 1024-character cap
"bounds the worst case to something trivial"; writing a test to demonstrate it
showed the claim was simply false.

Two defences, and both are needed:

**A structural scan that understands nesting.** Not a regex over the pattern
source — that misses `((a)+)+`, where the inner quantifier sits in its own group.
The scanner walks the pattern tracking group frames, and propagates a quantifier
upward through intervening plain groups, because `((a+))+` is exactly as
catastrophic as `(a+)+`. Alternation is deliberately *not* propagated through an
unquantified group, so `((a|b)c)+` — which is safe, its branches cannot match the
same text — is still accepted.

**An empirical probe.** The scanner is a heuristic and cannot be complete;
deciding this in general is undecidable. So the guard also *runs* the pattern
against adversarial input — a long run of a plausible character followed by one
that cannot match — at increasing lengths, and rejects anything whose cost grows.

The probe is itself bounded: lengths step by 4 up to 28 and it aborts the moment
the budget is exceeded, so an exponential pattern trips while the subject is
still short enough that the probe returns promptly. Probing at 64 characters
would hang the very request trying to prevent hangs.

It runs once, at schema publish — never on the record write path.

Neither defence is a proof. Together they catch every shape that occurs in
practice. A deployment wanting a guarantee should compile patterns with a
linear-time engine (RE2), which trades a native dependency for the property that
backtracking cannot happen at all.

### Other schema constraints

| Rule | Why |
| --- | --- |
| No `$ref`, `$dynamicRef`, `$recursiveRef` | A remote reference turns schema compilation into an outbound HTTP request from the application server |
| `additionalProperties: false` required | Otherwise undeclared fields land in jsonb unvalidated, unsearchable and undocumented |
| Depth ≤ 5, properties ≤ 120, schema ≤ 64 KiB | Bounded validation cost on a hot path |
| No `patternProperties` | Declare each field; a pattern over *names* is the same ReDoS surface with none of the benefit |
| `x-helm-secret` only on top-level strings | The database trigger enforcing "no inline secrets" examines top-level keys only. A nested marker would be honoured by the UI and silently ignored by the enforcement — so it is refused where it cannot be kept |
| No `default` or `enum` on a secret field | A default secret is a shared secret, stored in the schema in the clear; an enum is a public list of the possible values |

### Secret fields never enter the document

```
submitted { target: "nas01", repository_password: "restic-passphrase" }
                        │
              validateRecord()
                        │
        ┌───────────────┴────────────────┐
        ▼                                ▼
  data { target: "nas01" }        secrets { "/repository_password": … }
        │                                │
        ▼                                ▼
  flexible_asset_record.data      SecretService → secret_version
                                   + flexible_asset_secret pointer
```

Both in **one transaction**. A half-written record — document stored, secrets not
— would be a credential silently missing from documentation the technician
believes is complete, which is worse than the write failing outright.

Three details that are easy to get wrong:

- **Splitting happens before validation.** Ajv echoes offending data in some
  error shapes, and error objects get logged wholesale. A placeholder stands in
  during validation so `required` on a secret field still means something.
- **`secretFields` comes from the stored schema version**, not from the request.
  A caller who could nominate which fields are secret could nominate none.
- **`null` means "leave the existing secret alone"**, so editing a record's other
  fields does not require re-entering every credential on it.

The database backs all of this up: a trigger rejects a document still containing
a declared-secret field. This layer is where it is done correctly; the trigger is
where it is caught if this layer is wrong.

---

## 6. Search

`helm.search()` reads `search_document` under the caller's RLS, so scoping is the
policy's job and cannot be forgotten in a handler. A search endpoint that
assembled its own `WHERE` clause would be the single easiest place in the product
to leak one client's data to another.

Entity-type filters are an allow-list rather than passed through: the column is
free text, and accepting an arbitrary value turns the filter into a probe for
which entity types exist.

Pagination fetches one extra row to answer "is there a next page" rather than
running a second count query, which on a ranked full-text search costs as much as
the search itself.

---

## 7. Identifier validation

Helm validates UUIDs with `z.guid()`, not `z.uuid()`.

Zod 4's `uuid()` enforces the RFC 4122 version nibble; PostgreSQL's `uuid` type
does not — it stores any 128-bit value. An identifier imported from an RMM or PSA
is frequently not RFC 4122 versioned, and rejecting it at the API boundary would
make real records permanently unreachable while adding no safety. The shape check
is what keeps malformed input away from the database; the version nibble carries
no security meaning.

---

## 8. Routes

| Route | Method | Permission | Notes |
| --- | --- | --- | --- |
| `/api/health` | GET | — | Public; reports reachability and nothing else |
| `/api/auth/[...nextauth]` | GET/POST | — | Auth.js; importing it binds the session resolver |
| `/api/search` | GET | `asset:read` | Ranked, RLS-scoped |
| `/api/organizations` | GET | `organization:read` | Scope decides what is listed |
| `/api/assets/:nodeId` | GET | `asset:read` | Metadata + secret *metadata*, no ciphertext |
| `/api/assets/:nodeId/graph` | GET | `asset:read` | `neighbours` / `dependencies` / `impact` |
| `/api/assets/:nodeId/detail` | PATCH | `asset:write` | The subtype row (a network's CIDR, a device's serial), from the catalogue in `lib/assets/detail-fields.ts`; Postgres validates |
| `/api/contacts` | POST | `asset:write` | With `emails[]` and `phones[]` (0790), or the single columns, which seed one entry each |
| `/api/contacts/:id` | GET/PATCH/DELETE | `asset:read` / `asset:write` | Every address and number; PATCH replaces a list whole |
| `/api/devices` | POST | `asset:write` | A configuration whole: node, device columns (by catalogue), contact, interfaces (0800) |
| `/api/devices/:id` | GET/PATCH | `asset:read` / `asset:write` | The same, read back and corrected; interfaces replaced whole |
| `/api/document-pages` | POST | `asset:write` | A written document (0810) in the client's tree; one title per folder |
| `/api/document-pages/:id` | GET/PATCH/DELETE | `asset:read` / `asset:write` / `asset:delete` | Body versions on save; archive-first delete takes its attachments with it |
| `/api/assets/links` | POST/DELETE | `asset:link` | Idempotent in both directions |
| `/api/secrets/:id/reveal` | POST | `secret:reveal` | Audited; returns the event id |
| `/api/secrets/:id/copy` | POST | `secret:read` | Clipboard is its own event |
| `/api/flexible-assets/types` | GET/POST | `flexible_type:manage` | Publish runs the schema guard |
| `/api/flexible-assets/records` | POST | `asset:write` | Validate, split secrets, one transaction |
| `/api/expirations` | GET | `asset:read` | Single pane, severity computed at read |
| `/api/audit` | GET | `audit:read` | Chain columns deliberately withheld |
| `/api/account/tokens` | GET/POST | — | Your personal tokens; the token is in the POST response once |
| `/api/account/tokens/:id` | DELETE | — | Revoke one of yours; somebody else's is "no such token" |
| `/api/tenant/service-accounts` | GET/POST | `user:read` / `user:write` | Machine identities and the roles the caller may grant |
| `/api/tenant/service-accounts/:id` | PATCH | `user:write` | Disable or enable; no DELETE, the audit log names it |
| `/api/tenant/service-accounts/:id/tokens` | GET/POST | `user:read` / `user:write` | Scopes bounded by the account's role; IP allow-list optional |
| `/api/tenant/service-accounts/:id/tokens/:tokenId` | DELETE | `user:write` | Revoke |
| `/api/sops/:sopId/schedules` | GET/POST | `sop:read` / `sop:execute` | Recurring runs; POST refuses an unpublished procedure |
| `/api/sops/:sopId/schedules/:id` | PATCH/DELETE | `sop:execute` | Pause, resume, edit, remove; raised runs stay |

Every route is `force-dynamic`. Nothing in a credential vault may be prerendered
or cached at the edge, and making that the root default is safer than each route
remembering.

---

## 9. Verification

```bash
pnpm test:sql    # the SQL security suite, against a real Postgres 16 cluster
pnpm verify      # typecheck + migration manifest + every vitest suite + schema drift
pnpm build       # every route must compile and be dynamic
```

`tests/integration/api.test.ts` invokes the real route handlers against the real
database as the real non-superuser roles, and covers: unauthenticated rejection,
token verification including revoked/expired/forged, tenant and organisation
scoping through three different callers, the secret refusal mapping, the schema
guard rejecting a catastrophic pattern at publish, and a flexible-asset record
round trip asserting the secret is absent from the stored document.
