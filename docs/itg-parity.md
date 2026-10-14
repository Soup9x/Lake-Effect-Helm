# IT Glue parity — gap analysis

Reference product: IT Glue. This is an information-architecture comparison, not a
visual one: Helm keeps its own look, wording and assets.

Assessed against `main` at `0eebae3`. 76 tables, 61 migrations, next free
migration number **0600** (the `09xx` range is seed data and stays last).

**Updated as groups land.** Group A and group B are in the "Landed" section
below; their rows above read **Exists**.

**The short version:** far more of this exists than the feature list assumes.
The documentation model (#5) is built and versioned — what it lacks is an
authoring screen. The client sidebar (#3) is built. Cross-client expirations
(#6) are built. The genuinely absent things are four: sidebar customization,
the Global completion grid, the Personal section, and the user-profile
preferences. Several "widgets" are already-stored data needing only a reader.

---

## Summary table

| # | Feature | Status | Where it lives / what's missing |
| --- | --- | --- | --- |
| 1 | Four top-nav scopes | **Partial** | `src/components/shell/top-nav.tsx` has all four. `Personal`→`/account` and `Global`→`/search` are aliases, not sections — **group L** makes them real pages |
| 1 | Global search in header | **Exists** | `/search`, `src/app/api/search/route.ts` |
| 1 | Recent-items dropdown | **Partial** | Data and API exist (`user_recent_view`, `/api/workspace/recent`); no header dropdown, no per-type icons — **group L** |
| 1 | Notifications + help icons | **Missing** | `webhook_endpoint` is outbound-only; there is no in-app notification surface — **group L**, with notifications conditional on K's channel |
| 1 | User menu | **Exists** | Top-right account menu |
| 2 | Recents + Favorites strip | **Exists** | `components/client-strip.tsx` — two avatar rows above the table, clients only; the mixed-type dropdown is #1 |
| 2 | Clients table, star, Name, Status | **Exists** | `components/clients-table.tsx`; status shows the real six-stage value, grouped by the filter |
| 2 | **Type** (Client/Prospect/Vendor/…) | **Exists** | `organization.relationship` (0600). Named `relationship`, not `type`, because four `*_type` columns already exist; labelled "Type" in the UI |
| 2 | Sync Status column | **Exists** | Last `integration_sync_run` per client via LATERAL; "Not linked" where no integration is mapped |
| 2 | Result count, sorting, column chooser | **Exists** | The same three shell components, now composed by `clients-table.tsx` alongside `BulkBar` so bulk actions survived |
| 2 | Client logo + initials fallback | **Partial** | `components/client-avatar.tsx` renders `logo_url` with an initials fallback. **Upload is still group I** |
| 3 | Per-client sidebar, collapsible, counts | **Exists** | `shell/sidebar.tsx`, `src/lib/nav/org-categories.ts`, collapse persisted per browser |
| 3 | Core asset entries | **Exists** | 16 categories incl. Domain Tracker, SSL Tracker, Locations, Networks, Passwords. Only "Checklists" absent — see #8 |
| 3 | Apps & Services in sidebar | **Exists** | Tenant's own `flexible_asset_type` rows with their configured icons — which a person can now create, as of C |
| 3 | "Customize Sidebar" link | **Missing** | See #4 |
| 3 | Quick Notes, inline | **Exists** | `organization.quick_notes`, `components/notes-card.tsx` |
| 3 | Credential Strength + buckets | **Exists** | `components/client-widgets.tsx` — four buckets from `v_secret_metadata.strength_score`, bucketed by `lib/ui/strength.ts`. A `Strength` filter on the Credentials section reaches the rows behind each count |
| 3 | Documentation Health ring | **Missing** | `client_health` widget is a different measure; "not viewed recently"/"stale" needs defining |
| 3 | Recently Viewed By You (this client) | **Exists** | `listRecentInOrganization()`. Assets only — the client's own row is in the history by the time the page renders, so an unfiltered query led with the page you were on |
| 3 | Important Contacts | **Partial** | `contact` + `organization.primary_contact_id`; no "important" flag — **group L** adds one plus the widget |
| 3 | Recently Updated (this client) | **Exists** | `listRecentlyUpdated()` — `updated_at`/`updated_by` across assets, sites, contacts and documents. **Not `audit_log`:** the gap analysis said it was, and it is not. See the note below |
| 3 | Popular Credentials | **Exists** | `secret.access_count` + `last_accessed_at`, both incremented inside `helm.reveal_secret()` straight after its `secret.revealed` audit write. A test asserts the count equals the audited reveals |
| 3 | Upcoming Expirations + due tag | **Exists** | "Expiring" section, `expiration` table, `criticality` |
| 3 | Locations | **Exists** | "Sites" section |
| 3 | Activity Feed | **Exists** | `listClientActivity()` on the client page, `organization_id`-scoped. Distinguishes "no activity" from "no `audit:read`" |
| 4 | Customize Your Sidebar | **Missing** | No table, no page. `user_dashboard.widgets` is the precedent to copy |
| 5 | Flexible/custom asset types | **Exists** | Schema was always complete and versioned. Group C added the authoring screen (`/settings/asset-types`), the field builder (`lib/flexible/fields.ts`), and the three routes it needed: `GET`/`PATCH` on one type and `POST .../versions` to publish. C2 added the record form itself, the record `PATCH` route and the `flexible_asset` rendering path the asset page never had |
| 6 | Assets completion grid + % badges | **Missing** | Needs a per-type/per-client coverage query |
| 6 | Per-client completion scores | **Missing** | `client_health` widget is adjacent, not the same |
| 6 | Cross-client expirations, filterable | **Exists** | `/expirations` page + `/api/expirations`, filters by severity and org |
| 7 | My Tasks | **Missing** | `sop_step`/`sop_run_step` have no assignee and no due date |
| 7 | Personal Credentials (private vault) | **Missing** | `credential` is org-scoped via `asset_node`. Needs a policy decision — see below |
| 8 | Reusable checklist templates → per client | **Partial** | `sop`/`sop_version`/`sop_step` (template) and `sop_run`/`sop_run_step` (instance) already model exactly this |
| 8 | Assignable tasks + due dates | **Missing** | Columns absent on both step tables |
| 8 | Email notification on assign/due | **Missing** | No email channel anywhere; `webhook_endpoint` is Discord/Teams/Slack |
| 9 | Domain tracker fields | **Exists** | `domain`: registrar, registered_at, expires_at, nameservers, dns_provider, dnssec, transfer_locked |
| 9 | SSL tracker fields | **Exists** | `ssl_certificate`: issuer, not_before, not_after, subject_alt_names, fingerprint, key_algorithm |
| 9 | Both feed Upcoming Expirations | **Exists** | `expiration.kind` + `source_table`/`source_id` |
| 9 | Auto-fill expiry (RDAP + TLS probe) | **Missing** | Not among the ten worker jobs. `expiration.refreshed_at` is the slot waiting for it |
| 10 | Change password | **Exists** | `/api/auth/local/change-password` |
| 10 | First/last name split | **Partial** | `app_user.name` is one field |
| 10 | MFA status, enable/disable | **Partial** | `mfa_enrolled_at`, `auth_authenticator` |
| 10 | One-time MFA recovery token | **Missing** | No column, no route |
| 10 | Time zone | **Missing** | `timezone` exists on `organization` and `site`, not on a user |
| 10 | Theme (default/light/dark) | **Missing** | No stored preference |
| 10 | Email notification toggles | **Missing** | Depends on an email channel existing at all |
| 10 | "Enable side panel" | **Missing** | No stored preference; credentials open as a page |

---

## Design notes on the four that need a decision before code

### Personal Credentials is a security-model change, not a feature

Every secret in Helm is reachable through `helm.reveal_secret()` under
tenant + organization RLS, and super_admin holds `tenant:write`. A private
vault means rows that **no other user may read, including a tenant
administrator**, which the current policy shape cannot express.

Three questions to answer first, because each changes the schema:

1. Does break-glass access apply? If an administrator can reveal a personal
   credential in an emergency, it is not private, and the UI must not claim
   otherwise.
2. Do personal credentials appear in offboarding export bundles? If a
   technician leaves, does their vault go to the handover pack or vanish?
3. Are they encrypted under the tenant DEK (so a tenant key rotation covers
   them) or a per-user key (so they survive differently)?

My recommendation: tenant DEK, `owner_user_id` on the secret, an RLS policy
that adds `owner_user_id = helm.current_user_id()` and **excludes** them from
export bundles and cross-client search, with administrator access refused
rather than audited. That is defensible and simple. But it is your call, and
it should be written down before the migration.

### Credential Strength is nearly free, and the empty bucket is already right

`secret.current_strength_score` and `current_plaintext_length` are maintained
on write, so the widget is a `GROUP BY` over a bucket expression — no
decryption, no backfill job, no new write path. Secrets stored before that
column existed are `NULL`, which maps cleanly onto ITG's "Not evaluated"
bucket rather than needing a migration to invent a value.

### Checklists should extend SOPs, not add tables

`sop` → `sop_version` → `sop_step` is the template, `sop_run` → `sop_run_step`
is the instance. That is ITG's checklist model already. What is missing is
two columns on each step table (`assigned_to`, `due_at`) plus an index for
"tasks assigned to me". Adding a parallel `checklist` tree would leave two
half-used features.

Naming: the sidebar should probably say "Checklists" for the runs and keep
"SOPs" for the templates, rather than exposing the internal word twice.

### Sidebar customization should copy the dashboard's pattern exactly

`user_dashboard.widgets` is a jsonb layout validated by
`helm.dashboard_layout_valid()` in `0370`, with `WIDGET_KEYS` in
`src/lib/workspace/widgets.ts` as the TS mirror and a test asserting the two
lists agree. Reuse that shape for sidebar order and visibility, including the
test — it is the thing that stops a key being added in one place only.

### One operational note

A new worker job for the RDAP/TLS refresh needs its own advisory lock key.
Keys run `0x48_45_4c_4d_01` … `0x..0a` and a duplicate crash-loops the worker
on startup — this repo has already lost three days to exactly that. Use
`0x48_45_4c_4d_0b`; `tests/unit/worker-jobs.test.ts` will catch a collision.

---

## Proposed order of work

Smallest high-impact first. Each group is its own branch, migration(s), tests
and PR.

| Group | Scope | Migration | Why here |
| --- | --- | --- | --- |
| **A** | Clients list parity: reuse `data-table`/`column-menu`/`filter-toolbar` on `/organizations`; add Recents + Favorites strip; `organization.type` enum; surface Status and Sync Status | 0600 | Pure reuse of components already written. Highest visible change per line of code |
| **B** | Client-page widgets from data already stored: Credential Strength buckets, Popular Credentials, Recently Updated, Recently Viewed (org-scoped), Activity Feed | none | No schema at all. Four widgets out of existing columns and `audit_log` |
| **C** | Flexible asset **type authoring UI** — create/edit a type, its fields, icon, colour | none | Unblocks the documentation model. The engine exists; nobody can drive it. Needed three API routes too — see below |
| **C2** | Records: the schema-driven **record** form behind the dead `+ New` button, a record `PATCH` route, and the `flexible_asset` rendering path `/assets/[nodeId]` never had | none | C lets a type be defined. Without this a record of one cannot be created, cannot be corrected, and renders none of its fields |
| **D** | Sidebar customization (per-user + admin default), "Customize Sidebar" link | 0620 | Follows the dashboard pattern; small and self-contained |
| **E** | Profile/preferences: user timezone, theme, side-panel toggle, first/last name, MFA recovery token | 0630 | Mostly additive columns; the theme toggle touches every view, so do it before more views exist |
| **F** | Checklists: `assigned_to` + `due_at` on both step tables, My Tasks under Personal | 0640 | Delivers half of the Personal section by extending SOPs |
| **G** | Global section: completion grid with % badges, per-client completion scores | 0650 (materialised counts, if needed) | Needs C done first so custom types are real; the heaviest query work |
| **H** | Domain/SSL auto-refresh worker job (RDAP + TLS probe), manual entry fallback | 0660 | Outbound network from the worker — needs a decision on egress in an air-gapped install |
| **I** | Documentation Health ring; client logo upload | 0670 | Health needs "stale" and "not viewed recently" defined; logo needs an upload path reusing the documents storage |
| **J** | Personal Credentials vault | 0680 | Blocked on the policy questions, now answered in Decisions |
| **K** | Email channel + notification toggles | 0690 | New outbound dependency (SMTP config, secrets, docs); unlocks #8's reminder and #10's toggles |
| **L** | Header and navigation parity: recent-items dropdown, notifications and help icons, Personal and Global as real landing pages, Important Contacts | 0700 | Last because three of its four parts are *assembly* — the dropdown, My Tasks, Personal Credentials and the completion grid all have to exist before a page can collect them |

**Migration numbers shifted by one slot.** 0610 went to B2
(`0610_audit_secret_row_visibility.sql`), which was not in the original plan, so
D onwards moved up. The numbers above are intentions rather than reservations —
the next free number at the time of writing is what a group actually takes.

Deferred, flagged rather than silently dropped:

- **Checklist email reminders (#8)** — folded into K, since they cannot work
  before an email channel exists.

### Group L in detail

Four parts, and the ordering is the point: L is deliberately last because most
of it is assembly over things earlier groups build.

**The recent-items dropdown** reads `user_recent_view` through the existing
`/api/workspace/recent` route — the data, the API and the pruning have been
there since 0370. What is missing is a header control and per-type icons. This
is the one part of L that could have been done at any time; it sits here so the
header is changed once rather than four times.

**Notifications and the help icon.** The help icon is a link. Notifications are
not: an in-app notification surface needs a *store*, and `webhook_endpoint` is
outbound-only. So this is conditional on K — if K has landed, the icon reads
whatever K's channel records; if not, it ships as a visible stub that says
there is nothing to show rather than a bell that silently never lights. A bell
that cannot be distinguished from an empty inbox is worse than no bell.

**Personal and Global as real pages.** Today `Personal` → `/account` and
`Global` → `/search` are aliases, which is why they look like parity on the
summary table and are not. Personal collects My Tasks (F) and Personal
Credentials (J); Global collects the completion grid (G) alongside the existing
cross-client expirations and an assets view. Both are therefore blocked on F,
G and J — building them earlier would mean shipping two pages with one card
each and revisiting them three times.

**Important Contacts** is the only part needing schema: a flag on `contact`,
plus the client-page widget that lists them. `organization.primary_contact_id`
already exists and is a different thing — one primary contact, versus the
handful a technician wants on the client page. The widget is small; it is in L
because it is a header/navigation-adjacent "where do I find the person to call"
feature rather than because it depends on anything.

## Landed

### Group A — clients list parity (migration 0600)

Three things worth knowing beyond the table above.

**`relationship` is a second axis, not a rename.** `status` already had a
`prospect` value and `is_msp_internal` already meant "us", so the first draft
of 0600 tied them together with
`CHECK ((relationship = 'prospect') = (status = 'prospect'))`. That is wrong:
relationship `prospect` with status `former` is a prospect that went cold, and
the constraint forbids recording it. There is now a test that fails by name if
anyone adds it back.

**`is_msp_internal` survives untouched.** It carries a unique index — at most
one per tenant — and means "this row is us". ITG's Internal is an ordinary
label. The backfill makes the MSP's organisation `internal`, and the
implication runs one way only.

**Both fixture files needed the new column.** `fixtures.sql` and
`fixtures-integration.sql` insert organisations *after* 0600 runs, so its
backfill never sees them and the MSP's own organisation came out labelled
"Client". Caught by the backfill test, not by review.

**One shared component changed:** `DataTable` gained
`clearSelectionSignal`. Selection lives inside it, so a bulk bar rendered
outside had no way to untick anything — Clear would hide the bar and leave
every checkbox set. That is the smallest seam that fixes it without making
selection a controlled prop for every caller.

### Group B — client-page widgets (no migration)

Five cards above the sections on `/organizations/{id}`: Credential strength,
Most used credentials, You looked at, Recently updated, Activity. Every one
reads a column or table that already existed. Six things worth knowing.

**The gap analysis was wrong about Recently Updated.** It said `audit_log`
holds it. It does not. Helm audits security-relevant *events* — reveals,
rotations, exports, refusals — and deliberately does not audit ordinary field
edits: no write route calls `helm.audit()` for a corrected serial number, and
an audit trail that logged every typo is one nobody reads. What does record
them is `updated_at`, maintained by `helm.touch_updated_at()`, with
`updated_by` set by each write route. So "Recently updated" reads that, and
"Activity" reads `audit_log`, and **neither is derivable from the other**:

- rotating a password moves `secret.updated_at`, not the credential's
  `asset_node.updated_at`, so it appears in Activity (`secret.rotated`) and
  not in Recently updated;
- correcting a hostname moves `asset_node.updated_at` and writes no audit row,
  so it appears in Recently updated and not in Activity.

The two cards sit side by side for that reason, and each says so in a footer
line rather than leaving a reader to work out why an edit is missing.

**Popular Credentials reads the audited path, as the brief required.**
`access_count` and `last_accessed_at` are incremented *inside*
`helm.reveal_secret()`, immediately after its `helm.audit('secret.revealed')`
call (0590). There is no second counter. A test asserts
`secret.access_count = count(audit_log WHERE action = 'secret.revealed')` per
secret, so a future path that bumps one without the other fails the suite.

**`access_count` is a `bigint`, which postgres.js returns as a string.** Ten
reads sorted below two, because `'2' > '10'`. The page coerces with `Number()`
before sorting and a test asserts both the order and the type — ten versus two
specifically, because that is the smallest pair where a lexical sort and a
numeric one disagree.

**No new authorization logic, deliberately.** `audit_log`'s policy already
carries all of it:

```
tenant_id = helm.current_tenant_id()
AND helm.has_permission('audit:read')
AND (helm.is_tenant_wide()
     OR (organization_id IS NOT NULL
         AND helm.org_in_scope(organization_id)
         AND helm.node_visible(node_id)))
```

An actor without `audit:read` therefore gets an empty array from a query that
*succeeded* — identical, from the widget's side, to a client nothing has
happened to. The page passes `session.permissions.includes('audit:read')` so
the card can say "your role does not include reading the audit log" instead of
"nothing recorded yet". Tested by rendering the page as `client_read_only`.

**Read counts are gated on `secret:reveal`.** `access_count` and
`last_accessed_at` are columns on `v_secret_metadata`, and `secret_rls_select`
gates that view on org scope and `helm.secret_node_visible()` — **not** on
`secret:read`, let alone `secret:reveal`. So RLS hands both to a
`client_read_only` actor as readily as to a technician; they were always
readable and simply had nowhere to surface. The first cut of this card
displayed them to anyone who could open the client page, which would have put
"the MSP read our domain admin password 47 times" on a customer's screen. It
is now restricted, at the user's direction, to roles holding `secret:reveal`.

`secret:reveal` is the right gate because it is the permission that *produces*
the number: every increment happens inside `helm.reveal_secret()`, which
refuses an actor without it. So the count is answerable only by somebody who
could have done the revealing. In the shipped catalogue that is `super_admin`,
`tier1`, `tier2` and `api_service` — and **not** `client_admin`, which holds
`secret:read` and `audit:read` but not `secret:reveal`.

**The gate is on the data, not the rendering**, and that distinction is the
substance of it. The client page is a server component: anything it hands a
child is serialised into the RSC payload and reaches the browser whether or
not a card draws it. Building the list and hiding the card would have
delivered every count to exactly the actor it was being withheld from. So the
page passes an empty array and the numbers never leave the server; the card's
`canSeeAccessCounts` prop exists only so it can say which kind of empty it is.
A test asserts the payload, not the markup: `accessCount` must not appear as a
key anywhere in the tree the page returns.

That test needed the right actor to mean anything. A sabotage run gating on
`secret:read` instead passed everything, because `client_read_only` holds
neither permission and could not tell them apart. `client_admin` is now a
fixture actor for exactly that reason — it is the only one that distinguishes
`secret:read` from `secret:reveal`, and it is also the role the restriction is
most about.

**Known under-report, found while building this.** Fixed in B2 — see below.

### Group B2 — audit visibility for secret rows (migration 0610)

**The bug.** Every `helm.audit()` call about a secret passes the **secret's**
id as `helm.audit()`'s sixth parameter, which is `p_node_id`:

```sql
helm.audit('secret.rotated', 'secret', v_secret.id, 'success',
           v_secret.organization_id, v_secret.id, ...)
--                                   ^^^^^^^^^^^ p_node_id
```

The `audit_log` policy then asked `helm.node_visible(node_id)` of it, and that
is `EXISTS (SELECT 1 FROM asset_node WHERE id = node_id AND NOT
is_internal_only)`. No `asset_node` has a secret's id, so the predicate was
false for every secret row and every reader who is not tenant-wide. A
`client_admin` — which holds `audit:read` deliberately, because 0390's own
header says "a co-managed customer being able to see who touched their
documentation is a feature" — saw none of it.

It failed **closed**, which is why it survived: it hid rows rather than leaking
them, so nothing ever looked wrong. It surfaced because group B put an activity
feed on the client page and that feed was empty for exactly one role.

**The policy, not the data.** The obvious fix is to pass the owning credential
node's id, and it is not enough: it cannot reach a single row already written.
`audit_log` is append-only, and `node_id` is inside
`helm.audit_canonical_form()`, so it is covered by `row_hash` and by the
per-tenant hash chain. Rewriting it would invalidate the chain, which is the
one property that makes the table evidence. So 0610 changes the predicate only,
to ask `helm.secret_node_visible(entity_id)` — a function that already existed
for exactly this shape, and which resolves a secret to the credential nodes
pointing at it. Internal-only documentation therefore stays hidden: the fix
un-hides only what 0390 meant to leave visible.

**Scope: `secret.created` and `secret.rotated` only, deliberately.**
`secret.revealed` carries the same wrong `node_id` and the same one-line change
would un-hide it. It is excluded, because the two groups disclose different
things: created/rotated say "this client's documentation changed, by whom,
when", while revealed says "your MSP read this password, at this time". The
second line was drawn one commit earlier — the Most used credentials card was
gated on `secret:reveal` so a customer would not learn how often their MSP read
a credential — and un-hiding `secret.revealed` here would hand that back with
timestamps attached, through a different door. A test fails by name if the CASE
is ever widened, so whoever widens it has to revisit the card too.

**Settled:** `secret.revealed`, `secret.reveal_denied` and `secret.copied`
stay hidden from an org-scoped reader. See decision 7.

### Group C — the type authoring UI (no migration)

The documentation model has been complete since 0080: a type, immutable
published schema versions, records validated against them, `x-helm-secret`
fields split out and encrypted. What it never had was a screen, so in practice
only the person who wrote the API ever created a type. C adds the screen and
the three routes it needed — `GET`/`PATCH` on one type, and `POST
.../versions` to publish, without which "edit a type's fields" was not awkward
but unexpressible.

**The form edits fields, not a schema.** `src/lib/flexible/fields.ts` owns the
conversion both ways and is unit-tested against the real schema guard. The
round trip is load-bearing rather than tidy: published versions are immutable,
so editing a type means publishing a new version, which means loading the
stored schema back into a field list first. A one-way conversion would make
"edit" mean "start again".

**The builder cannot emit a `pattern`.** `schema-guard.ts` exists largely
because a hand-written regular expression compiles to a RegExp with no timeout,
and a backtracking one hangs the event loop for every tenant. Ajv has
`addFormats()` registered, so date, uri and email are real validation in a
library rather than a string somebody typed on a Friday. The guard stays the
backstop for API clients; the UI simply does not hand over the foot-gun.

**Publishing is not saving, and the dialog says so.** It names the version it
will create, how many records exist, and — when the new shape is incompatible —
that they will be flagged.

**`needs_migration` is now written, and cleared.** The column, its partial
index and the "Needs migration" flag on the type page have existed since 0080
with nothing ever setting them. See decision 8 for why it is written from a
schema comparison rather than per-record validation.

**A guard that was not working, found and fixed.** `searchable_fields` and
`secret_fields` hold JSON **pointers** — 0240's indexing trigger does
`substring(v_path from 2)` before `data ->> v_key`. Nothing documented it and
nothing checked it, and the consequence was not only that a bare name indexes
nothing: `inspection.secretFields` are pointers, so the route's
`secretFields.includes(f)` never matched a bare name, and
`flexible_version_secrets_not_searchable` compares those same two arrays, so
the CHECK did not fire either. **A secret field could be stored as
searchable.** Nothing leaked — the same off-by-one mangles the key into a NULL
lookup, and a secret's value never reaches `data` at all — but the guard was
decorative. Both routes now refuse anything that is not a pointer resolving to
a property the schema declares, which is what makes the checks beneath it mean
something. Verified against the running database.

**Still missing, deliberately, as C2:** the `+ New` button on a flexible asset
type's page is dead and there is no record form anywhere, so a type can now be
defined but a record of it still cannot be created through the UI. Landed in
C2, below.

### Group C2 — records: create, read, edit (no migration)

Scoped as "fix the dead `+ New` button". Reconnaissance found three gaps, not
one, and the group was widened to cover all three rather than ship a button
that creates records nobody can read:

| Gap | Was | Now |
| --- | --- | --- |
| Create | `+ New` was a styled element with no handler; the only way to a record was an API call | `FlexibleRecordForm`, a form over `schemaToFields()` of the type's current published version |
| Edit | No `PATCH` for a record existed anywhere, so a typo was permanent | `PATCH /api/flexible-assets/records/[recordId]` |
| Read | `DETAIL_TABLES` on `/assets/[nodeId]` had no `flexible_asset` entry, so `detailFor()` returned `{}` and **every record in the product rendered "No type-specific detail recorded" over the whole of its contents** | a `flexible_asset` branch that decodes the record against its pinned schema, labels each field, and lists its secret fields in the Credentials card |

The third was the one worth widening for. It is not a missing nicety: a record's
entire payload was invisible, which makes "create a record" a feature that
writes data nobody can read back.

**One field model, two screens.** The form is generated from
`src/lib/flexible/fields.ts` — the same module the type editor writes with — so
a field added in Settings appears on the record form with no second
implementation of anything. `toDocument()` is the only new logic: HTML inputs
produce strings, Ajv runs with `coerceTypes: false` on purpose, so something has
to convert, and the place that knows each field's kind is the right one. It is
unit-tested differentially against the real schema the real builder emits.

**Errors come from the server, next to the field.** The API returns
`details.fields` as JSON Pointers, so the form renders each message against the
control it names rather than reimplementing a second validator in the browser.
A pointer the form does not recognise falls back to the form-level message, so
nothing is swallowed.

**A secret box is always blank, and blank means unchanged.** A record's secret
values live in `flexible_asset_secret` and are never sent to a browser. See
decision 10 — without the `heldSecrets` hand-off, `required` on a secret field
makes every edit fail unless the technician retypes the password.

**What C2 deliberately does not do.** It never deletes a `flexible_asset_secret`
row. A field that stops being secret in a later version leaves its stored secret
attached to the record, where it stays listed in the Credentials card under its
own name rather than being quietly orphaned or removed. Deleting stored
encrypted material is a data-retention decision, not a side effect of a template
edit, and `flexible_secret_secret_fk` is `ON DELETE RESTRICT` precisely so that
it cannot happen by accident.

**One thing the tests caught that review would not have.** The asset page's new
secrets arm joins through `flexible_asset_type`, which is tenant-scoped and NOT
organisation-scoped (0200) — so a client-side role sees nothing from it. Without
that join the arm would have listed a flexible record's secret to a client
administrator, and the secret's label is `"<template> — <field>"`, which names a
template their role may not read. RLS permits the row (`flexible_asset_secret`
is scoped to the record, not to the template), so nothing would have refused it.
The join makes one policy decide both halves of the page.

## Decisions

The four questions this document opened with have been answered. Recorded here
because the groups they govern are not built yet, and a decision that lives
only in a conversation gets re-litigated.

1. **Personal Credentials (J).** Tenant DEK; `owner_user_id` on `secret`; RLS
   adds `owner_user_id = helm.current_user_id()`. **No break-glass** — admins
   are *refused*, not audited, so the UI can honestly call it private.
   Excluded from offboarding export bundles, client exports and cross-client
   search. A deactivated user's personal secrets stay locked rather than
   deleted; a `super_admin` can purge them and can never read them. To be
   written up in `docs/security-model.md` as part of J.
2. **Completion grid (G).** Excludes archived clients, inactive clients and
   `is_msp_internal` by default, with a filter toggle to include them.
3. **"Not viewed recently" (I).** Tenant-wide, from `audit_log` — documentation
   health is a property of the document, not of the viewer. 180-day threshold,
   configurable in tenant settings.
4. **Domain/SSL refresh (H).** Opt-in, off by default, enabled in tenant
   settings. With it off, or when egress fails, manual entry keeps working and
   the UI shows "last checked: never/failed" rather than erroring. An
   air-gapped install must keep working with zero configuration. Lock key
   `0x48_45_4c_4d_0b`.

5. **Credential read counts (B).** `access_count` and `last_accessed_at` are
   shown only to roles holding `secret:reveal` — the permission that produces
   the number, since every increment happens inside `helm.reveal_secret()`.
   RLS does not withhold these columns, so this is a product restriction
   enforced in the page: an actor without the permission is handed an empty
   array, so no count is serialised into the RSC payload. `client_admin` sees
   the audit trail for its own organisation and not the reveal counts.

6. **Audit visibility for secret rows (B2).** The `audit_log` policy asks
   `helm.secret_node_visible(entity_id)` for `secret.created` and
   `secret.rotated`, and `helm.node_visible(node_id)` for everything else. Not
   widened to the whole `secret.*` family, because `secret.revealed` would
   reverse decision 5. Fixed in the policy rather than in the stored `node_id`
   because the hash chain covers that column and rewriting it would invalidate
   history.

7. **Reveal activity stays hidden from clients (B2, settled).**
   `secret.revealed`, `secret.reveal_denied` and `secret.copied` remain
   invisible to an org-scoped reader, consistent with decision 5. The two are
   the same disclosure reached by different routes — a count on a card, or a
   per-event log with an actor and a timestamp — so they are governed together.
   If read activity is ever shown to clients it will be one deliberate
   "transparency" feature that flips both at once, not a side effect of a
   predicate fix. `tests/integration/audit-visibility.test.ts` fails by name if
   the CASE in 0610 is widened, which is the tripwire that sends whoever widens
   it back to this entry.

8. **`needs_migration` is written from a schema comparison, not per-record
   validation (C).** The column means "no longer conforming", and the literal
   reading is per-record — but stored `data` is the post-split document with
   every secret removed, so `validateRecord()` fails `required` on every secret
   field for every record, always. Doing it properly means reinstating a
   placeholder per secret, which is a second query per record and a second
   place that has to agree with the splitter. So the question is asked of the
   schemas: can the new one reject a document the old one accepted? If not,
   nothing is flagged; if so, every record on an older version is. That
   over-reports when a particular record survives an incompatible change, which
   is the direction a "somebody should look at this" flag should err in, and it
   keeps the commonest edit — a new optional field — from flagging anything.
   Soundness is tested differentially against Ajv rather than against a list of
   pairs believed compatible. One corollary is pinned by a test: reverting to an
   earlier schema is NOT automatically compatible, because removing a property
   rejects any record that carries it.

9. **An edit validates against the type's CURRENT version, not the record's
   pinned one (C2).** Pinning exists so a record is never retroactively
   invalid, which is a statement about READING it. Writing is a new act and
   belongs under the current rules — and validating against the pinned version
   would strand a record on its original schema, because a field added since
   could never be filled in: the schema that would accept it is not the one
   being checked against. So a successful edit IS the migration. It moves
   `type_version_id` forward, sets `validated_at` and clears `needs_migration`,
   which turns that flag from a permanent mark into something a technician can
   act on — open the record, fill in what the new schema wants, save. Nothing
   else in Helm clears it. The corollary is that a record whose template
   dropped a field cannot be saved until the stale key goes, which is exactly
   what `additionalProperties: false` means; the form stops rendering the field,
   so the save stops sending it. READING still uses the pinned version, because
   that is the schema with a label for every key actually in `data` — rendering
   against the current version would silently drop a field removed since, and
   show a reader less than the record contains.

10. **A stored secret counts as present for `required` (C2).** A record's secret
    values live in `flexible_asset_secret`, never in `data`, so the form cannot
    prefill them and a blank box has to mean "unchanged". But `required` on a
    secret field then fails every edit that does not retype the password, and a
    form that demands a credential to fix a typo in a hostname is a form people
    work around. `PATCH` reads the record's existing `flexible_asset_secret`
    rows and passes them as `heldSecrets`, which satisfies `required` without
    putting anything in `secrets` — nothing is rotated and nothing is read.
    **This is the per-secret query decision 8 rejected, and the distinction
    holds:** there it was one query per record across potentially hundreds of
    records, to compute a flag; here it is one query for the single record being
    edited, which is already identified. A supplied value rotates through
    `rotateInTransaction` so the old version stays readable; an omitted one is
    untouched. Creating is NOT exempt: with no stored value to stand in for,
    `required` means required. The reinstatement is filtered to fields the
    version being validated against still declares secret — a record keeps its
    stored secret when a later version turns that field back into an ordinary
    one, and standing the placeholder in there would validate the
    sixteen-character stand-in instead of the value the technician typed.

11. **Rendering a record's secret fields is not a new disclosure (C2).** The
    asset page lists a record's secret fields in the Credentials card, with the
    same `RevealButton` a credential's password gets, because it is the same
    material written through the same audited path and `secret:reveal` is the
    same gate. No RLS and no permission changed. What DID need care is who the
    row is listed to: the arm joins through `flexible_asset_type`, whose 0200
    policy admits only tenant-wide actors, so a client-side role sees nothing
    from it — see the note in the C2 section for what that join prevents.

Two further decisions taken at the same time:

- **Checklists (F)** extend SOPs. No parallel tree. `sop`/`sop_version`/
  `sop_step` already model a reusable template and `sop_run`/`sop_run_step`
  model a per-client instance; F adds `assigned_to` and `due_at`. The comment
  in `src/lib/nav/org-categories.ts` saying Helm has no checklist table is
  wrong and is corrected as part of F.
- **Sidebar customization (D)** mirrors `user_dashboard.widgets`, including the
  catalogue/validator agreement test.
