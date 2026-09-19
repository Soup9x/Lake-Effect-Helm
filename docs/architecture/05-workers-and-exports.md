# Lake Effect Helm — Background Workers and the Export Engine

Everything in the first four documents happens inside a request. This one covers
the two subsystems that do not: the jobs that run on a schedule, and the engine
that produces a file containing a client's documentation — and, when a second
person has approved it, their credentials.

---

## 1. The enumeration problem

Every job here is per-tenant work, and to do per-tenant work a process must
first know which tenants have work. That question cannot be asked from inside a
tenant context, which is the only place Helm lets anything read tenant data.

The tempting answers are all bad: give the worker `BYPASSRLS` and it holds the
whole database; run it as a superuser and the same, worse; keep a second
"platform" table outside RLS and it drifts from reality within a month.

Instead each job gets one narrow `SECURITY DEFINER` enumerator —
`helm.alert_backlog()`, `helm.sync_due()`, `helm.audit_anchor_backlog()`,
`helm.export_backlog()` — returning ids, counts and timestamps and no tenant
content. They are granted to **`helm_worker`** and to nothing else.

`helm_worker` is a member of `helm_app`, so it inherits exactly the request
path's table privileges and is subject to exactly the same RLS policies. The
membership runs one way: `helm_app` is **not** a member of `helm_worker`, so
none of these enumerators is reachable from an HTTP request. A migration guard
asserts both halves of that on every deploy.

The actual work then happens inside a normal tenant context, as the job's own
service account, under the same policies and the same audit log as a technician
doing it by hand. The enumerators are a scheduler, not a bypass.

---

## 2. Worker identities

`helm.set_session_context()` accepts two actor types: `user` and
`service_account`. That is the right answer — a third "system" type that skipped
membership resolution would be a second, weaker authorisation path that
eventually diverges from the first — so each tenant gets four service accounts,
provisioned by trigger on tenant creation and backfilled for existing tenants.

| Identity | Role | Rank | Reveal purposes |
| --- | --- | --- | --- |
| Helm Expiry Alerts | `system_alerts` | 60 | — (no secret capability at all) |
| Helm Integration Sync | `system_sync` | 80 | `integration` only |
| Helm Audit Anchoring | `system_audit` | 60 | — (no secret capability at all) |
| Helm Export Rendering | `system_export` | 60 | `export` only |

Ranks are set by what the RLS write policies require (60 for the alert and
export tables, 80 for the integration tables), not by seniority: these
identities have none.

### The purpose restriction

The sync worker needs rank 80 to write `integration_sync_run` and
`external_identity`. Before this subsystem existed, rank 80 plus `secret:reveal`
would have let it read a client's domain admin password by asking for purpose
`view`. That is a large capability to hand a background process that mostly
talks to a vendor API.

So `service_account.allowed_reveal_purposes` pins a machine identity to the
purposes its job actually has, enforced inside `helm.reveal_secret()` — the
single doorway — rather than by every caller remembering to check. And for the
two purposes that have a natural scope, the scope is **re-derived from the
database** rather than asserted:

- `integration` — the secret must be referenced by an
  `integration_connection.credential_secret_ids` in this tenant.
- `export` — the secret must fall inside a live, approved, secret-bearing
  export job, recomputed on every call so a job revoked mid-render stops
  yielding material immediately.

The result is that **no background worker holds a general reveal capability**. A
compromised sync worker gets the RMM API keys it was always going to need; it
does not get the vault. New denial reasons `purpose_not_permitted_for_actor`,
`not_an_integration_credential` and `not_in_an_approved_export` are audited like
every other refusal.

System identities are also protected by trigger: their role, scope and purposes
cannot be edited and they cannot be deleted. `disabled_at` is the supported way
to stop a worker. A well-meaning administrator widening the sync account's
purposes would silently hand it the vault, so the database refuses rather than
relying on a UI that hides the fields.

---

## 3. The runtime

`pnpm helm:worker` (long-running) or `pnpm helm:worker --once` (for a
deployment that prefers its own cron). Same code, same locking.

**Mutual exclusion is a Postgres advisory lock, not a Redis lock.** Helm is
deployed on-premises, frequently as two app servers behind a load balancer. Both
run the runtime, and two concurrent syncs against one connection is how
duplicate assets get created. An advisory lock costs nothing, is released
automatically if the process dies, and — the real reason — needs no second piece
of infrastructure to be *correct*. A Redis lock would make Redis a dependency of
correctness rather than of throughput, on a deployment where nobody is
monitoring Redis. Helm therefore ships no broker at all.

The lock is taken on a **reserved** connection held for the whole job. Taking it
on a pooled connection and releasing it on a different one is a silent no-op
that leaves the lock held until the connection closes.

A job that throws does not stop the runtime: it is logged, counted, and retried
on the next tick. The failure that matters — a job failing every tick for a week
— shows up in the consecutive-failure count rather than in a process that
quietly exited at 3am.

---

## 4. Expiry alerts

Two jobs, deliberately split. **Evaluation** decides what should fire and is
set-based SQL. **Delivery** sends it, and is separate because delivery is the
part that talks to the outside world and therefore the part that fails: an SMTP
server that is down must not stop tomorrow's evaluation noticing that a
certificate now expires in seven days.

### The firing rule

A rule lists lead days such as `{90, 30, 14, 7, 1}`. An expiration has *crossed*
a threshold when it is due within that many days. The naive implementation fires
every crossed threshold — so adding a certificate that already expires in five
days immediately produces four alerts, and a team that gets four alerts for one
certificate stops reading alerts. That is the actual failure mode of expiry
tracking.

So of the thresholds crossed and not yet recorded, only the **smallest** is
delivered. The larger ones are written as `suppressed`, which keeps the
idempotency record — the unique constraint on `(rule, expiration, lead_day)`
means they can never fire later — while making it visible in the table that they
were deliberately not sent rather than lost. Steady state is unaffected: at 30
days the only newly-crossed threshold is 30, and it is delivered.

Re-running the evaluator changes nothing, so a crash halfway through is
recovered by running it again.

Delivery outcomes are recorded in their own transaction, one per alert.
Batching a tenant's results into one transaction would mean a crash after
sending twenty emails rolls back the record that they were sent — and the next
run sends them again.

---

## 5. Integration sync

The **engine** is complete and vendor-independent; the vendor part is
configuration. Every RMM and PSA in scope — NinjaOne, N-able N-central and RMM,
ConnectWise, HaloPSA, Autotask, Microsoft Graph — exposes a paged JSON REST API
over bearer or basic authentication, so one configurable adapter covers them:
`integration_connection.config` names the path, the pagination style, and a
field map from the vendor's JSON to Helm's columns. `registerProvider()` is
there for the cases where a bespoke client genuinely earns its keep — Microsoft
Graph's delta queries are the obvious first candidate.

This is a deliberate choice, not a stub. Hand-writing six clients against six
APIs that each version independently, with no live tenant of any of them to test
against, produces six plausible-looking files that are wrong in six different
ways.

What the engine guarantees:

**Correlation.** Every external record maps to a Helm node through
`external_identity`, whose unique constraints pin both directions. Without that,
the second sync creates duplicates and the third sync's "cleanup" deletes real
documentation.

**Manual edits survive.** With `respect_manual_edits` on (the default), an
inbound value only fills a field that is still NULL. A technician who corrected
a hostname the RMM has wrong keeps their correction. Last-writer-wins teaches
technicians that editing anything is pointless, and then the documentation stops
being maintained.

**Unchanged records cost nothing.** The vendor payload is hashed with
key-sorted JSON and compared to the last one seen, so a nightly sync over 4,000
devices writes only what moved. This is also what keeps the audit log readable.

**Exponential backoff.** A connection whose vendor credentials were revoked
would otherwise be retried every five minutes forever — thousands of failed
authentications a day against the client's RMM, which is how an MSP's
integration account gets locked out across every client at once. Backoff doubles
to 32× the configured interval. A connection that has never run is due
immediately, so an administrator finds out within a minute whether the
credentials they just entered work.

**A failed run does not advance the cursor.** Advancing it after a partial
failure silently skips whatever was missed, and nobody finds out until a client
asks why a server is not documented.

---

## 6. Audit chain anchoring

The per-tenant hash chain proves nobody edited a historical row without also
rewriting every row after it. It does **not** prove the whole chain was not
rewritten end to end by someone with ownership of the database — which, on an
on-premises deployment administered by the MSP's own staff, is precisely the
party an audit log most needs to bind.

Anchoring closes that. Once the head hash at sequence *N* has been witnessed
somewhere Helm cannot reach or alter, history up to *N* is fixed. Everything
after the last anchor is still only as trustworthy as the database, which is why
the job runs hourly and why `anchored_seq` appears in the compliance export.

Two things this does that "write the hash somewhere" would not:

**It verifies before it anchors.** `helm.verify_audit_chain()` re-walks the
chain and recomputes every row hash. Anchoring a chain that is already broken
would be worse than not anchoring: it manufactures evidence that tampered
history was witnessed intact. A broken chain is logged at error level and
`anchored_seq` is left where it was — which is itself evidence, because the last
good anchor bounds when the alteration could have happened.

**It anchors a specific (sequence, hash) pair and the database checks the pair is
real.** `helm.record_audit_anchor()` refuses a hash that never appeared in the
chain, refuses a sequence ahead of the head, refuses to move an anchor backwards,
and refuses an empty reference. It writes the three anchor columns and nothing
else, so it cannot be used to rewrite the chain's own idea of where it is.

`HELM_AUDIT_ANCHOR_DIR` is only as good as the directory it points at. A
directory the Helm process can also rewrite is not a witness. Unset, the worker
verifies and logs but records **no** anchor — claiming one that does not exist is
the failure this is guarding against.

---

## 7. The export engine

The single most damaging action this product can perform. It is also legitimate
and routine: an MSP losing a client has a contractual obligation to hand over
documentation, and an auditor asking for evidence needs a record they can read.
Refusing to build it does not make it not happen — it makes it happen through a
database dump nobody logged.

### One authorised person, and a trail

**This changed deliberately in `0400`.** A secret-bearing export used to require
a second person who was not the requester. It no longer does: one account
holding `secret:export` can request a credential-bearing export and it renders
immediately. That was a requested change of security posture, not a bug fix, and
what follows describes both what went and what stayed.

What was removed: the `export_job_secrets_need_approval` constraint, the
approval filter and scope-digest comparison in `helm.export_backlog()`,
`helm.approve_export()` itself, and the approval gate inside the render worker's
own reveal check.

What was kept, and is now load-bearing:

- **`secret:export`.** Still required to request an export carrying credentials,
  still separate from `export:create`, still `msp_only`. This is now the whole
  of the gate rather than the first half of it.

  `msp_only` is enforced by a trigger on `role_permission` (0020), so no
  client-side **role** can hold it. It is **not** enforced on
  `membership_permission`, and `set_session_context()` unions the two — so a
  single client-side **user** can be granted `secret:export` directly. That is
  not theoretical; it is the path the regression test for the rank floor below
  uses, because it is the only one the database permits.
- **`min_role_rank`, per secret — against the REQUESTER and the worker.**

  This entry used to read "the render reveals each credential through
  `helm.reveal_secret()`, which applies the rank ladder individually, so an
  export cannot carry a credential its requester could not have revealed one at
  a time". That was not true, and the gap was exactly the shape of the sentence.

  The reveals run as the export **service account** (rank 60), because its
  reveal purposes are pinned to `export` and a person's are not. So
  `reveal_secret()` was applying the ladder to the *worker*. Metadata was
  collected as the requester and material was not, and nothing compared the
  requester's rank to each secret's `min_role_rank`: a rank-30 actor holding
  `secret:export` received every credential up to rank 60 in one file, including
  ones a single reveal would have refused them with an audit row.

  `#fillSecrets` now applies the requester's rank — resolved by the database at
  render time, from the session context already opened to collect as them — as a
  **floor**, in addition to the worker's ceiling. A secret must clear both, and
  one whose rank cannot be read is omitted rather than included.
- **Tenant and organisation scoping**, the ten-character written reason, the
  bundle expiry, mandatory encryption of any bundle containing secrets, and the
  numbered record of every download.
- **Revocation by somebody else.** `revoke_export()` gated on `export:approve`,
  so deleting that permission would have narrowed revocation to the requester
  alone. It was **renamed** to `export:revoke_any`, preserving every grant —
  removing a gate must not remove the brakes.

`approved_by`, `approved_at` and `approved_scope_sha256` remain on the table and
`export_job_four_eyes` still guards them. Nothing writes them now; the columns
exist so that an export approved before `0400` keeps the record that it was.
The exports page and the bundle cover page print an approver only when there is
one, so the field simply stops appearing on new jobs.

### What replaces prevention

Honestly: nothing prevents it any more. A single authorised person can export a
client's credentials, and the MSP finds out afterwards. The safeguard is
detection, and it is deliberately louder than the one row of "somebody agreed"
that approval produced:

| Event | What it records |
| --- | --- |
| `export.requested` | who asked, which client, scope, reason, whether it carries credentials |
| `secret.revealed` | **one row per credential**, written by `reveal_secret()` with purpose `export` — so "who exported *what*" is answerable per credential, not per job |
| `export.rendered` | counts, bytes, sha256, omissions |
| `export.downloaded` | every retrieval, numbered, with byte size |

The chain is hash-linked and append-only (`0140`), so the person it describes
cannot edit it afterwards. Export events are also the primary subject of the
outbound notifications in `0420`: a webhook fires on request and on download, so
an export shows up in a channel somebody reads rather than only in a log
somebody has to think to open.

### Rendering

Runs in the background, as the export service account, whose reveal purposes are
pinned to `export`.

Every credential is decrypted through the ordinary audited path, one reveal at a
time. A 400-credential handover leaves 400 audit rows, not one.

**Refusals are recorded, not swallowed.** Two happen in practice: a credential
requiring step-up, which no machine identity can ever satisfy; and one pinned
above a role rank — either the requester's own (checked before the reveal) or
the worker's (checked inside it). Both are written to `export_job.omissions` and
printed on the cover page of the PDF. Continuing past a refusal is deliberate —
an offboarding pack that fails entirely because one break-glass credential needs
step-up helps nobody — but a handover that silently dropped credentials is
discovered by the client at the worst possible moment.

### The bundle

Two renderings, and both are in every bundle for a reason. **JSON** is the
machine-readable truth: complete, unmangled, every field. **PDF** is what a
person reads and signs, and is necessarily lossy — tables truncate, WinAnsi
cannot render every script — so it is never the only artefact. Where the PDF
says `...` the JSON has the whole value.

Both the PDF writer and the bundle format are in-tree rather than dependencies.
This code runs in the process that holds decrypted client credentials, and the
PDF renderers on npm are large dependency trees — font parsers, image codecs,
sometimes a headless browser — whose transitive surface is far larger than the
feature being bought. A handover document is headings, paragraphs and tables in
one of the fourteen standard PDF fonts.

A credential-bearing bundle is encrypted with AES-256-GCM under a key derived by
scrypt from a passphrase generated at render time. **The passphrase is stored
nowhere** — not in `export_job`, not in the audit log, not in the storage
backend. That is what makes the artefact at rest useless to anyone who has only
the file, including anyone who later gains access to the storage directory or a
backup of it. Lose the passphrase and the bundle is gone; that is preferable to
a handover archive sitting on disk in the clear because someone wanted it to be
re-downloadable.

The passphrase reaches a human through `HELM_EXPORT_PASSPHRASE_DIR`, one
mode-0600 file per export, on a **different backup set** from the bundles — the
whole scheme rests on the two not travelling together. Unset, the worker refuses
to render a credential-bearing export rather than producing a file nobody can
open.

### Download and expiry

`helm.claim_export_download()` authorises the download, writes the
`export_download` row and writes the audit event in one transaction, before a
single byte is read from storage. Same principle as revealing a secret: the
artefact and the record of who took it are inseparable. Downloads are
individually numbered in the audit log, not a counter bump.

Exports self-destruct. `helm.expire_exports()` marks rows expired and returns
their storage keys; the worker deletes the bytes driven by what it returned. A
row marked expired while the file stays on disk is exactly the failure the TTL
exists to prevent, so a deletion that fails is logged loudly — the file is now
orphaned and needs a human.

---

## 8. A defect this work surfaced

`v_secret_metadata` had been unusable by `helm_app` since Step 1. The view is
`security_invoker` and LEFT JOINed `secret_version` for the current version's
strength score, and no role holds any privilege on `secret_version` —
deliberately; that is the control which makes `helm.reveal_secret()` the only
route to ciphertext. Every SELECT from the view failed with "permission denied",
including from the asset detail route that had referenced it since Step 3. No
test covered a node with a credential attached, so it never fired.

Column-level grants would have removed the error and achieved nothing else:
`secret_version` has no SELECT policy at all, so RLS still returns zero rows and
`strength_score` would be NULL forever — while weakening the suite's assertion
that `helm_app` cannot read the table *at all* into something narrower, in
exchange for no capability.

So the fix denormalises: `secret.current_strength_score`,
`current_plaintext_length` and `current_version_created_at` are maintained by
`helm.write_secret_version()`, which is `SECURITY DEFINER` and already has the
privilege, and the view drops the join entirely. The invariant stays absolute —
**no role reads `secret_version`, for any column, ever** — and a migration guard
now asserts it column by column across all five runtime roles.

---

## 9. Verification

| Suite | Count |
| --- | --- |
| `tests/integration/workers.test.ts` | 28 — identities, purpose restriction, alert semantics, sync backoff, anchoring refusals |
| `tests/integration/exports.test.ts` | single-approver exports, scope binding, omissions, the requester-rank floor, revocation, expiry, storage mode |
| `tests/unit/exports.test.ts` | 21 — PDF structure and xref resolution, bundle round-trip, passphrase distribution |
| `db/tests/security.sql` | §15 (export behaviour) and §35 (what `0400` removed, and what it kept) |

The PDF output was additionally parsed with an independent reader (`pypdf`) to
confirm page count, extracted text, repeated table headers and the UTF-16 title.
