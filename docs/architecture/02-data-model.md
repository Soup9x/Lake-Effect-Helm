# Lake Effect Helm — Data Model

Companion to `01-security-model.md`. This one covers shape rather than
protection: why the tables are arranged the way they are, and which alternatives
were rejected.

---

## 1. Hierarchy

```
tenant                        the MSP
 └─ organization              a client (and the MSP itself, flagged is_msp_internal)
     ├─ site                  a location
     └─ asset_node            everything documentable
         ├─ device            server, workstation, firewall, switch, …
         ├─ network           VLAN, subnet, WAN, VPN, SSID
         ├─ ip_address
         ├─ domain
         ├─ ssl_certificate
         ├─ application
         ├─ directory_service AD forest / Entra tenant
         ├─ contract, license, isp_circuit, vendor
         ├─ credential        vault item (material lives in `secret`)
         ├─ sop               procedure
         └─ flexible_asset_record  technician-defined template instance
```

**The MSP is an organisation inside its own tenant.** That keeps
`organization_id` `NOT NULL` everywhere downstream. The alternative — nullable
organisation for internal records — means every RLS policy needs an `OR
organization_id IS NULL` branch, and the one that forgets it is either a leak or
a mystery empty page.

**Sites are not graph nodes.** They are a scoping dimension like organisations.
Making them nodes would create a circular foreign key with `asset_node.site_id`
for no modelling gain.

---

## 2. The asset supertype

The requirement is "link arbitrary assets to arbitrary assets". The tempting
implementation is a polymorphic `(entity_type text, entity_id uuid)` pair.

It is a trap. No foreign keys, no cascade, and every delete leaves dangling edges
that surface months later as a dependency map quietly missing a hop — which is
worse than a map that is obviously incomplete, because people trust it.

Instead, every documentable thing gets a row in `asset_node`, and concrete tables
are subtypes keyed by the same `id`:

```sql
CREATE TABLE device (
  id        uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  node_type node_type NOT NULL DEFAULT 'device' CHECK (node_type = 'device'),
  ...
  FOREIGN KEY (id, tenant_id) REFERENCES asset_node (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (id, node_type) REFERENCES asset_node (id, node_type) ON DELETE CASCADE
);
```

The first FK pins the subtype to its supertype *and* to the same tenant. The
second makes it impossible to attach a `device` row to a node declared as an
`ssl_certificate`. Links are then a plain table with two real foreign keys.

**Cost, stated honestly:** reading a device means joining two tables, and
creating one means two inserts. In exchange, referential integrity, cascades and
tenant binding are free and unforgettable.

---

## 3. Bi-directional linking

Edges are stored **once**, in one direction, and read bi-directionally through
`v_asset_edge`. Storing both directions would double every write and allow a
half-deleted relationship.

Two kinds of edge feed one view:

- **explicit** — rows in `asset_link`, asserted by a technician or integration
- **intrinsic** — projected from foreign keys that already exist
  (`ssl_certificate.domain_id`, `device.parent_device_id`, `ip_address.network_id`, …)

Intrinsic edges are projected rather than copied into `asset_link`. Copying would
require every FK update to be mirrored by a link update, and the two would drift.

`helm.inverse_relation()` maps each relation to its opposite so reverse traversal
reads naturally: a firewall that `secures` a network appears on the network as
`secured_by`, not as a backwards arrow the technician mentally flips at 2am. A
migration-time assertion fails if any enum value lacks an inverse, because a NULL
inverse would silently drop reverse edges from the map.

`helm.asset_graph_walk()` is a bounded BFS with a cycle guard (MSP topologies are
full of cycles — a domain controller that both hosts and authenticates the thing
that manages it). It is deliberately **not** `SECURITY DEFINER`: the walk runs
under the caller's RLS, so a co-managed client tracing a dependency stops at the
isolation boundary rather than learning that another organisation's node exists.

---

## 4. Flexible assets

Two decisions carry this module.

**Schemas are versioned and immutable once published.** A type whose schema can
be edited in place will eventually invalidate records written years earlier, and
the first anyone notices is during a compliance export when a required field is
missing from four hundred records. Each record pins `type_version_id`; a trigger
rejects changes to a published version's body.

**Secret fields never enter the JSONB.** A field marked `x-helm-secret` is stored
as a pointer in `flexible_asset_secret`; the `data` document omits it entirely,
and a trigger rejects a write that includes it. Otherwise every secret in a
custom template would sit in plaintext in a jsonb column — outside the audited
reveal path, and copied into every backup, logical replica and search index.

Searchable fields are an explicit allow-list. A technician who adds a "Recovery
Phrase" text field should not have it silently indexed.

---

## 5. Expirations

The naive implementation is a `UNION` over eight tables re-run on every dashboard
load. It is slow, and worse, it silently misses anything added later that nobody
remembered to add to the `UNION`.

Instead expirations are **projected** into one narrow table by triggers on each
source. The dashboard becomes a single indexed range scan, and adding a new
expiring thing is one `CREATE TRIGGER` using the generic projector.

The projection is derived data — the source column stays authoritative and
`helm.rebuild_expirations()` reconstructs it — so a missed trigger is a
recoverable bug, not lost data.

Severity is **computed, never stored**. A stored severity is wrong the moment the
clock passes midnight and nobody has run a job. Business-critical items get a
wider horizon: 30 days' notice on a domain carrying the client's email is not
notice, it is a fire.

Moving a source date clears a stale acknowledgement — acknowledging last year's
renewal must not suppress this year's. `alert_event` is unique on
`(rule, expiration, lead_day)` so the nightly job cannot re-alert on every run,
which is the real failure mode of expiry tracking: people stop reading the
alerts.

---

## 6. SOPs and checklist runs

A run is **evidence**. Six months after an offboarding goes wrong, the question
is "which steps did we complete, and what did the procedure say at the time".

So a run references a frozen `sop_version` snapshot, and `sop_run_step` **copies**
the step definition rather than referencing `sop_step`. Pointing a run at a living
document would let today's edit rewrite yesterday's evidence.

Constraints enforce the parts people skip: a step requiring evidence cannot be
closed as done with an empty evidence object, and skipping a mandatory step
requires a note.

---

## 7. Integrations

`external_identity` is the correlation spine, unique in **both** directions:

```sql
UNIQUE (connection_id, external_type, external_id)   -- one external record -> one node
UNIQUE (connection_id, node_id, external_type)       -- one node -> one external record
```

Without a stable mapping, a re-sync creates duplicates and the next sync's
"cleanup" deletes real documentation. `payload_sha256` means an unchanged record
costs no writes.

`respect_manual_edits` exists because inbound sync overwriting a technician's
correction is how people stop trusting the tool. `is_authoritative` marks fields
the external system owns, so the UI can say so rather than pretending a local
edit stuck.

Integration credentials are secrets like any other — `credential_secret_ids` maps
a role name to a secret uuid, and the sync worker resolves it through
`helm.reveal_secret()`. Machine access to a client's RMM key is audited exactly
like a technician's. An `api_key text` column on a connections table is how an
MSP platform leaks every client's RMM key in a single database dump.

`sync_run_one_active` permits one in-flight run per connection: two concurrent
syncs against the same cursor create duplicate assets.

---

## 8. Exports

The single highest-risk operation in the product: it turns per-record access
control into one file.

- `include_secrets` defaults false; turning it on is a separate, separately
  permissioned, separately audited decision
- secret-bearing exports require a second approver, and `CHECK` forbids
  self-approval — one compromised account must not walk out with the vault
- `expires_at` is `NOT NULL`; a handover archive lingering in a bucket is a
  breach waiting for a misconfigured ACL
- every download is its own row, not a counter bump

---

## 9. Where things live

| Concern | Location |
| --- | --- |
| Database authority | `db/sql/*.sql` — hand-authored, ordered, immutable once applied |
| Typed query layer | `db/schema/*.ts` — Drizzle |
| Migration runner | `db/migrate.ts` |
| Drift detection | `scripts/check-drift.ts` |
| Security tests | `db/tests/` |

`db/sql` is authoritative because RLS policies, `SECURITY DEFINER` routines,
partitioning, generated columns and column-level grants cannot be expressed in
the Drizzle DSL, and silently losing one is a tenant-isolation breach rather than
a migration inconvenience. `pnpm db:drift` keeps the TypeScript honest by
comparing it against the live catalog — not against a migration journal, which is
a different question.
