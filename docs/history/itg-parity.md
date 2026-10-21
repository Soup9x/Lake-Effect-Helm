# IT Glue parity — gap analysis

Reference product: IT Glue. This is an information-architecture comparison, not a
visual one: Helm keeps its own look, wording and assets.

> **Historical.** Every group in this plan has landed or been dropped. The
> document is kept for its decisions log (the "Decisions" section) and as the
> record of why each feature looks the way it does; the counts and migration
> numbers below are as they were when the plan was written, not now.

Assessed against `main` at `0eebae3`. 76 tables, 61 migrations, next free
migration number **0600** (the `09xx` range is seed data and stays last).

**Updated as groups land.** Landed groups are in the "Landed" section below and
their rows above read **Exists**. One row reads **Dropped**: Personal
Credentials, see decision 14.

**The short version:** far more of this exists than the feature list assumes.
The documentation model (#5) is built and versioned, and since C and C2 it has
the authoring screen and the record form it lacked. The client sidebar (#3) is
built, and since D it is arrangeable. Cross-client expirations (#6) are built.
What remains genuinely absent is the Global completion grid, the Personal
section and the user-profile preferences. Several "widgets" are already-stored
data needing only a reader.

**One thing on this list is not being built at all.** Personal Credentials
(#7) is dropped rather than deferred: it needs a privacy guarantee Helm's
policy shape cannot express, and the answer is a Bitwarden/Vaultwarden
integration outside this plan rather than a second security model inside it.
Decision 14 has the reasoning; nothing is being built for it now.

---

## Summary table

| # | Feature | Status | Where it lives / what's missing |
| --- | --- | --- | --- |
| 1 | Four top-nav scopes | **Exists** | L. All four, and Personal and Global are real landing pages now (`/personal`, `/global`) rather than aliases for one of their own sub-pages. Each `owns` every route in its scope, so the tab lights up from anywhere inside it |
| 1 | Global search in header | **Exists** | `/search`, `src/app/api/search/route.ts` |
| 1 | Recent-items dropdown | **Exists** | L. And the component already existed — `src/components/recently-viewed.tsx`, popover, fetch-on-open, per-type icons — with nothing rendering it; the header carried a History icon linking to `/dashboard` instead. The third thing in this codebase found built and unwired |
| 1 | Notifications + help icons | **Exists**, bell only | L (0700). `user_notification` is the first notification table pointing INWARDS: 0110, 0420 and 0690 built three outbound queues and none can express "this person has not seen this". Filled by the audit fan-out (addressed by decision 31's rule) and by a trigger on `task_reminder`. **The help icon was removed rather than wired** — it was a second copy of the floating Support badge, same icon and same destination; see decision 38 |
| 1 | User menu | **Exists** | Top-right account menu |
| 2 | Recents + Favorites strip | **Exists** | `components/client-strip.tsx` — two avatar rows above the table, clients only; the mixed-type dropdown is #1 |
| 2 | Clients table, star, Name, Status | **Exists** | `components/clients-table.tsx`; status shows the real six-stage value, grouped by the filter |
| 2 | **Type** (Client/Prospect/Vendor/…) | **Exists** | `organization.relationship` (0600). Named `relationship`, not `type`, because four `*_type` columns already exist; labelled "Type" in the UI |
| 2 | Sync Status column | **Exists** | Last `integration_sync_run` per client via LATERAL; "Not linked" where no integration is mapped |
| 2 | Result count, sorting, column chooser | **Exists** | The same three shell components, now composed by `clients-table.tsx` alongside `BulkBar` so bulk actions survived |
| 2 | Client logo + initials fallback | **Exists** | I (0680). `organization_logo` — bytes on the document store, encrypted with the tenant DEK, served through an authenticated route under an ETag. Not an `attachment` row: a logo is chrome, and as an attachment it would appear in the client's document tree and in export bundles. SVG refused by a sniffer and a CHECK. `logo_url` still works and an upload wins — `src/lib/ui/logo.ts` is the one place that chooses |
| 3 | Per-client sidebar, collapsible, counts | **Exists** | `shell/sidebar.tsx`, `src/lib/nav/org-categories.ts`, collapse persisted per browser |
| 3 | Core asset entries | **Exists** | 16 categories incl. Domain Tracker, SSL Tracker, Locations, Networks, Passwords. "Checklists" is still absent as a *word*, and deliberately: the rows live under SOPs, which F1 made usable. What is missing is the recurring part — see #8 |
| 3 | Apps & Services in sidebar | **Exists** | Tenant's own `flexible_asset_type` rows with their configured icons — which a person can now create, as of C |
| 3 | "Customize Sidebar" link | **Exists** | At the foot of the drawer, below "More" — group D |
| 3 | Quick Notes, inline | **Exists** | `organization.quick_notes`, `components/notes-card.tsx` |
| 3 | Credential Strength + buckets | **Exists** | `components/client-widgets.tsx` — four buckets from `v_secret_metadata.strength_score`, bucketed by `lib/ui/strength.ts`. A `Strength` filter on the Credentials section reaches the rows behind each count |
| 3 | Documentation Health ring | **Exists** | I (0680). `v_documentation_health` — three disjoint counts over a client's non-archived `asset_node` rows (revised recently / revised long ago / never revised) plus how many nobody has opened lately, beside the ring rather than in it. **Counts, never a score**, and a migration guard fails if a `score` or `percent` column ever appears on the view — decision 20. Windows per tenant, 180 days by default |
| 3 | Recently Viewed By You (this client) | **Exists** | `listRecentInOrganization()`. Assets only — the client's own row is in the history by the time the page renders, so an unfiltered query led with the page you were on |
| 3 | Important Contacts | **Exists**, derived | L. No sixth boolean: `contact` already carries `is_primary`, `is_technical`, `is_billing`, `is_emergency` and `is_authorised`, plus `organization.primary_contact_id` — six ways to say "this one matters". The widget ranks the flags that exist instead, so it is right the moment somebody fills in what they already had. Decision 35 |
| 3 | Recently Updated (this client) | **Exists** | `listRecentlyUpdated()` — `updated_at`/`updated_by` across assets, sites, contacts and documents. **Not `audit_log`:** the gap analysis said it was, and it is not. See the note below |
| 3 | Popular Credentials | **Exists** | `secret.access_count` + `last_accessed_at`, both incremented inside `helm.reveal_secret()` straight after its `secret.revealed` audit write. A test asserts the count equals the audited reveals |
| 3 | Upcoming Expirations + due tag | **Exists** | "Expiring" section, `expiration` table, `criticality` |
| 3 | Locations | **Exists** | "Sites" section |
| 3 | Activity Feed | **Exists** | `listClientActivity()` on the client page, `organization_id`-scoped. Distinguishes "no activity" from "no `audit:read`" |
| 4 | Customize Your Sidebar | **Exists** | Group D: `user_sidebar` + `tenant_sidebar_default` (migration 0620), one dialog for both scopes. The `secondary` flag became the default rather than the only answer |
| 5 | Flexible/custom asset types | **Exists** | Schema was always complete and versioned. Group C added the authoring screen (`/settings/asset-types`), the field builder (`lib/flexible/fields.ts`), and the three routes it needed: `GET`/`PATCH` on one type and `POST .../versions` to publish. C2 added the record form itself, the record `PATCH` route and the `flexible_asset` rendering path the asset page never had |
| 6 | Assets completion grid + % badges | **Exists** | G. `/coverage` — every client against every kind of documentation, counts per cell, gaps as a dash. No migration: measured instead, see the landed section |
| 6 | Per-client completion scores | **Exists** | G, as **coverage** rather than completeness — "7 of 11 kinds documented", carrying its own denominator. Decision 20 says why a single "% documented" would be a number people learn to ignore |
| 6 | Cross-client expirations, filterable | **Exists** | `/expirations` page + `/api/expirations`, filters by severity and org |
| 7 | My Tasks | **Exists** | F2. `/tasks`, defaulting to incomplete and mine, over `sop_run_step.assigned_to`/`due_at` (0650). The open count is in the dashboard's fixed strip, and L's `/personal` leads with the five most urgent and links to the filtered page |
| 7 | Personal Credentials (private vault) | **Dropped** | Not built natively. Personal credentials will come from a Bitwarden/Vaultwarden integration — decision 14. The vault design that was drafted for it is kept below as background for that work |
| 8 | Reusable checklist templates → per client | **Exists** | F1. `sop`/`sop_step` authored on `/assets/{id}`, published into an immutable `sop_version`, and `sop_run`/`sop_run_step` started against a client with the step copy 0090 describes. F2 added `assigned_to` and `due_at` to runs and their steps. Reminders are K |
| 8 | Assignable tasks + due dates | **Exists** | F2 (0650). `assigned_to` + `due_at` on `sop_run` and `sop_run_step`, the assignee a composite key to `membership` so work cannot be given to somebody who cannot see it |
| 8 | Email notification on assign/due | **Exists** | K (0690). `task_reminder` + two worker jobs (`0x…0c` raises, `0x…0d` delivers). One message when a step is assigned to somebody else, then three days before / the day before / on the day, once each and nothing once the step is done. Needs a relay the tenant configures — Helm ships with none, see decision 29 |
| 9 | Domain tracker fields | **Exists** | `domain`: registrar, registered_at, expires_at, nameservers, dns_provider, dnssec, transfer_locked |
| 9 | SSL tracker fields | **Exists** | `ssl_certificate`: issuer, not_before, not_after, subject_alt_names, fingerprint, key_algorithm |
| 9 | Both feed Upcoming Expirations | **Exists** | `expiration.kind` + `source_table`/`source_id` |
| 9 | Auto-fill expiry (RDAP + TLS probe) | **Exists** | H (0670), the eleventh worker job. **Off until somebody turns it on** — `external_check_setting` per tenant, lock key `0x48_45_4c_4d_0b`. The answer is written BESIDE the recorded value (`domain.registry_expires_at`, `ssl_certificate.observed_not_after`), never over it, and a disagreement is shown rather than resolved. `expiration.refreshed_at` is still unused: the dashboard deliberately still counts the recorded date — decision 23 |
| 10 | Change password | **Exists** | `/api/auth/local/change-password` |
| 10 | First/last name split | **Exists** | Group E: `first_name`/`last_name` on `app_user`, with `name` still the display column and a trigger composing it |
| 10 | MFA status, enable/disable | **Partial** | `mfa_enrolled_at`, `auth_authenticator` |
| 10 | One-time MFA recovery token | **Deferred** | Group E deliberately did not build it: nothing reads `mfa_enrolled_at` and the sign-in path enforces no second factor, so a bypass token would be a second password — see decision 15 |
| 10 | Time zone | **Exists** | Group E: `app_user.timezone`, validated against `pg_timezone_names`. Shared facts stay UTC-suffixed; a reader's own sessions show their local time beside it |
| 10 | Theme (default/light/dark) | **Exists** | Group E: `app_user.theme` is the account DEFAULT; the shell's existing per-browser toggle still overrides it locally |
| 10 | Email notification toggles | **Exists** | K (0690). `user_notification_preference.kinds`, a checkbox per kind on `/account`. **Private**: RLS admits only the owner's row, so no administrator can set somebody else's and there is no screen that could — decision 33. Both on by default, and an empty list means *nothing* rather than the default |
| 10 | "Enable side panel" | **Deferred** | Group E deliberately did not store it: there is no side panel to switch. Needs the panel first — see decision 15 |

---

## Design notes on the ones that needed a decision before code

### Personal Credentials is a security-model change, not a feature

**SUPERSEDED BY 1030.** The vault was later built natively, on exactly the
answers recorded below — owner-only with administrator access refused, the
tenant data key, excluded from exports and search, deleted with the
membership — see `db/sql/1030_personal_vault.sql`. The rest of this section is
the reasoning as it stood.

**BACKGROUND, NOT A PLAN. Group J is dropped — see decision 14.** Personal
credentials will come from a Bitwarden/Vaultwarden integration rather than a
native vault, and nothing in this section is being built. It is kept because
the questions below are the ones that integration will have to answer too, and
re-deriving them later from scratch would be wasted work.

Every secret in Helm is reachable through `helm.reveal_secret()` under
tenant + organization RLS, and super_admin holds `tenant:write`. A private
vault means rows that **no other user may read, including a tenant
administrator**, which the current policy shape cannot express. That is the
whole reason this was a security-model change rather than a feature, and it is
also the reason handing the problem to a dedicated password manager is a
reasonable answer: Bitwarden already has a user-owned key hierarchy, so Helm
would not be asked to express a privacy guarantee its policy shape was never
built for.

Three questions were to be answered first, because each changed the schema.
They survive the change of approach — an integration has to answer all three,
just at a different boundary:

1. Does break-glass access apply? If an administrator can reveal a personal
   credential in an emergency, it is not private, and the UI must not claim
   otherwise.
2. Do personal credentials appear in offboarding export bundles? If a
   technician leaves, does their vault go to the handover pack or vanish?
3. Are they encrypted under the tenant DEK (so a tenant key rotation covers
   them) or a per-user key (so they survive differently)?

The native-vault answer that was recorded, and is now superseded: tenant DEK,
`owner_user_id` on the secret, an RLS policy adding
`owner_user_id = helm.current_user_id()`, **excluded** from export bundles and
cross-client search, with administrator access refused rather than audited. It
is written down here because the shape of the answer is the useful part — in an
integration, "refused rather than audited" becomes a property of the vault
Helm is talking to rather than of a Helm policy, and questions 2 and 3 stop
being Helm's to decide at all.

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
| **D** | Sidebar customization (per-user + admin default), "Customize Sidebar" link — **landed** | 0620 | Follows the dashboard pattern; small and self-contained |
| **E** | Profile/preferences: user timezone, theme, first/last name — **landed**. Side-panel toggle and MFA recovery token deferred, decision 15 | 0630 | Mostly additive columns; the theme toggle touches every view, so do it before more views exist |
| **F1** | Checklists you can actually use: template authoring, publishing a version, starting a run against a client, the run page, SOP rows in the integration fixture — **landed** | 0640, for the purge conflict publishing exposed | 0090 modelled all of this and nothing in the application ever created a run. Assignment is meaningless until a run exists |
| **F2** | `assigned_to` + `due_at` on run steps, a default assignee and due date on the run, My Tasks, an open-task count — **landed** | 0650, plus 0660 for a defect it exposed | Delivers half of the Personal section by extending SOPs |
| **G** | Global section: completion grid with % badges, per-client completion scores — **landed** | none; the measurements are in the landed section | Needs C done first so custom types are real; the heaviest query work |
| **H** | Domain/SSL auto-refresh worker job (RDAP + TLS probe), manual entry fallback — **landed** | 0670 | Outbound network from the worker — needs a decision on egress in an air-gapped install |
| **I** | Documentation Health ring; client logo upload — **landed** | 0680 | Health needs "stale" and "not viewed recently" defined; logo needs an upload path reusing the documents storage |
| ~~**J**~~ | ~~Personal Credentials vault~~ — **dropped**, see decision 14 | — | Superseded by a future Bitwarden/Vaultwarden integration, which is not in this plan |
| **K** | Email channel + notification toggles — **landed** | 0690 | New outbound dependency (SMTP config, secrets, docs); unlocks #8's reminder and #10's toggles. It also gave 0420's notification destinations a second transport, because a `transport` column nothing can create is the scaffolding §1 of the notifications doc warns about |
| **L** | Header and navigation parity — **landed** | 0700 | Last because three of its four parts are *assembly*. The assumption that held: the dropdown and both landing pages were composition over finished work. The assumption that did not: "notifications are conditional on K" — K's channel is email and all three of its queues point outwards, so L had to build the inbox itself |

**On the migration numbers.** Two shifts have happened and both are recorded
here so nobody reuses a number:

- **0610 is B2's** (`0610_audit_secret_row_visibility.sql`), which was not in
  the original plan, so D onwards moved up a slot. **0610 must not be reused.**
- **0620 is D's** (`0620_sidebar_customization.sql`), landed.
- **Dropping J freed 0680**, so K and L moved down into the gap: K is 0680 and
  L is 0690. Nothing was built for J, so there is no orphaned file and no
  number to retire.
- **F1 needed no migration for its feature** — 0090 had the whole model
  already, which was the finding the group turned on. It needed one for the
  client-purge conflict it exposed: **0640 is F1's**
  (`0640_purgeable_sop_versions.sql`, decision 17). **0640 must not be
  reused.**
- **F2 took 0650** (`0650_run_step_assignment.sql`) and **0660**
  (`0660_topology_set_null_repair.sql`), the second for a pre-existing defect
  its own work exposed — see decision 19. Both numbers are spent.
- **G needed no migration at all.** The plan reserved "0670 (materialised
  counts, if needed)" and the measurements said not needed — see the landed
  section. So **H is 0670**, I 0680, K 0690 and L 0700, and nothing is
  reserved for G.

The numbers above are intentions rather than reservations — the next free
number at the time of writing is what a group actually takes.

Deferred, flagged rather than silently dropped:

- **Checklist email reminders (#8)** — folded into K, since they cannot work
  before an email channel exists.

### Future, and deliberately not in this plan

Things that are wanted and are NOT being built as part of the parity pass. Kept
here so "not in the plan" is a statement rather than a silence, and so nobody
re-opens the question by finding a gap in the parity table.

- **Bitwarden/Vaultwarden integration.** The replacement for group J's native
  Personal Credentials vault (decision 14). Personal credentials live in a
  password manager that already has a user-owned key hierarchy, and Helm links
  to or reads from it rather than storing private secrets under a policy shape
  that was never built to hide a row from a tenant administrator. Nothing is
  being built for this now — no schema, no route, no placeholder. The design
  questions it will have to answer are kept under *Personal Credentials is a
  security-model change* above.

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
outbound-only. K has landed and did **not** provide one — its channel is email
and its queues (`task_reminder`, `webhook_delivery`) are both outbound, so
neither is a per-person inbox. What K did leave L is the shape to extend:
`user_notification_preference.kinds` is a jsonb set with a SQL validator and a
TypeScript mirror precisely so an in-app kind is a value and not a migration
per kind, and `helm.notification_kinds_valid()` is the one place that decides
what is legal. So L still owns the store. Until it exists the icon ships as a
visible stub that says there is nothing to show rather than a bell that
silently never lights: a bell that cannot be distinguished from an empty inbox
is worse than no bell.

**Personal and Global as real pages.** Today `Personal` → `/account` and
`Global` → `/search` are aliases, which is why they look like parity on the
summary table and are not. Personal collects My Tasks (F) and profile /
preferences (E); Global collects the completion grid (G) alongside the existing
cross-client expirations and an assets view. Both are therefore blocked on E, F
and G — building them earlier would mean shipping two pages with one card each
and revisiting them twice.

**NO PERSONAL CREDENTIALS SECTION ON PERSONAL**, and no placeholder or empty
state for one either. J is dropped (decision 14) and a card reading "personal
credentials are coming" is a promise the plan has stopped making — worse than
an absence, because somebody would wait for it. When the Bitwarden/Vaultwarden
integration happens it can add its own section; until then Personal is My Tasks
and preferences, and that is the whole page.

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

### Group D — a sidebar somebody can arrange (migration 0620)

The drawer's sixteen categories were split into a primary eight and a "More"
disclosure by a hardcoded `secondary` flag. A reasonable guess at what a
technician reaches often — and the same guess for an MSP whose work is networks
as for one whose work is licence renewals. There was no table, no page, and the
"Customize Sidebar" link the parity list asks for had nowhere to go.

**The split is now a list somebody owns.** The categories they name are the
primary section, in their order; everything else falls through to "More", which
holds *every* remaining category, so nothing a person removes becomes
unreachable. Removing something hides it from the first glance; it does not take
it away.

**`secondary` kept its job and lost its monopoly.** `DEFAULT_SIDEBAR` is derived
from the flag, so somebody who has never touched the control sees precisely the
drawer they saw before this change. Promoting a category in the registry now
changes the default and does not move it for anybody who has already chosen.

**Copied from `user_dashboard`, deliberately, down to the shape of the
validator.** 0370 chose jsonb over a `(category, position)` table because a
reorder would otherwise be a delete-and-reinsert of a list the database never
reasons about, and 0530 is the migration that widens such a list when the
interface grows. Both apply here unchanged, so a reader who knows one now knows
both. `reorder()` is imported from the dashboard's module rather than copied —
its own comment names the off-by-one a second copy grows.

**Three levels, and a missing row is not an empty one.** A user's own row wins,
then the tenant default, then the code. Somebody who emptied their drawer has
expressed a preference, so `[]` does *not* fall through — if it did they would
watch the control appear to do nothing, repeatedly. `DELETE` on the user route
removes the row rather than storing a copy of the default, which is what keeps a
later change by an administrator reaching them.

**Not in `tenant.settings`.** `PATCH /api/tenant`'s header says why `settings` is
not settable through a generic endpoint: it is a jsonb bag several features read,
and a caller patching the whole object overwrites an invariant it never knew
about. A feature with a rule of its own gets a table with that rule on it.

**No new permission.** The tenant default is gated on `tenant:write`, which only
`super_admin` holds, named in the route *and* in the RLS policy so the two cannot
drift. The settings page reads the same grant it already read for the rename form
— which is why that field is now `can_write_tenant` rather than `can_rename`: two
cards reading one permission.

**One deliberate asymmetry in the RLS.** `tenant_sidebar_default` is readable by
anyone in the tenant and writable only with `tenant:write`, so it does *not* use
`helm.apply_tenant_rls(..., false)`. That predicate is `is_tenant_wide()`, which
would hide the row from exactly the client-side roles whose drawer is supposed to
render from it: they would silently get the code default, and an administrator
would have set a default that quietly did not apply to half their users. Nothing
in the row is sensitive to read — it is a list of slugs already in the shipped
source.

**Flexible asset types are not customisable here,** and that is a decision rather
than an omission: they are tenant data, so they cannot appear in an IMMUTABLE
validator's literal list, and the drawer already lists the ones with at least one
record. "Do I want this in my sidebar" is already answered by whether anything is
documented under it.

### Group E — profile and preferences (migration 0630)

Three of the five items on this group's list, with the other two deferred for
the same reason and that reason written down rather than left as a gap.

**What landed.** `first_name`/`last_name` on `app_user` with `name` still the
display column, so the forty-odd queries selecting `u.name` are untouched and a
trigger composes it from the halves; `timezone`, validated against
`pg_timezone_names`; and `theme` as the account default.

**The columns are on `app_user`, not in a preferences table,** because they are
per-PERSON and not per-tenant. `user_dashboard` (0370) and `user_sidebar` (0620)
are keyed `(tenant_id, user_id)` because what they hold *is* per-tenant — a
layout of one tenant's categories means nothing in another. Somebody working for
two MSPs through one account has one name, one time zone and one pair of eyes,
and a theme keyed by tenant would change colour when they switched.

**No new database functions, which is a correction rather than a
simplification.** The plan was to copy `helm.set_my_profile()` from 0360 — a
SECURITY DEFINER "write my own profile" entry point — and extend it. A guard
written into 0630 caught the premise as false: `app_user` *is* readable and
writable by `helm_app` under RLS (0220's deny list covers the `auth_*` tables and
`secret_version`, not `app_user`, because the password hash lives in
`local_credential`), and `set_my_profile()` is owned by `postgres`, so it runs as
a superuser with RLS switched off — its `WHERE id = v_actor` is its *only*
confinement. A plain scoped `UPDATE` is therefore both simpler and safer: the
route's predicate and `app_user_rls_update` are two locks where a definer
function has one.

**The route's `WHERE id` is load-bearing and looks redundant,** which is why
there is a test aimed squarely at it. `app_user_rls_update` is
`id = helm.current_actor_id() OR helm.has_permission('user:write')` — because an
administrator edits colleagues from the People page — so the policy alone would
let a `super_admin`'s "save my preferences" rewrite every row in the tenant.

**The theme has two homes and one precedence rule.** `ThemeToggle` has stored
the choice in `localStorage` since the theme was built, and its header argued
against ever putting it on the server: per-browser, costs no request, cannot
fail. All of that is still true and none of it is undone. What it could not do
is the thing the parity item asks for — sign in on a new machine and Helm is
light again, forever. So the account value is a **default** and the local choice
is an **override**: localStorage, then `app_user.theme`, then
`prefers-color-scheme`. That is the same precedence `globals.css` already uses
one level down, so it is one chain with three links rather than a new idea. A
second pre-paint inline script (`ThemeSync`) applies the account value only when
the first script set nothing, and deliberately does **not** write
`localStorage` — writing would turn the default into a permanent local override
and a later change would never reach that browser again.

**The time zone does something, which was not true of the first draft.** A
stored preference nothing reads is the placeholder problem this plan has just
finished removing elsewhere. `formatDateTimeLocal()` renders UTC *and* the
reader's own local time, and it is used on the one surface where the reader is
the subject rather than a shared fact: their own sessions. An expiry date, a
rotation due date and an audit timestamp stay UTC-suffixed and unconverted —
"expires 2026-03-01" meaning three different instants is how a certificate
lapses on a Sunday, and that rule is not being relaxed.

### Group F1 — checklists you can actually use (migration 0640, for the purge conflict it exposed)

The group that found its feature already built. 0090 modelled procedures,
immutable published versions, runs that snapshot the version they executed
against, and per-step execution state — and **nothing in the application had
ever written `sop_version`, `sop_run` or `sop_run_step`.** The only SOP
reference in `src/` was the export collector reading templates; the category
page said in a comment that "SOPs are the one category with no create path";
the integration fixture had no SOP rows at all. A complete model with no way in,
which is why F1 needed no schema for its own feature.

**What landed.** Create a procedure (`POST /api/sops`, its own route because
`/api/assets` excludes `sop` on purpose — a procedure's payload is its steps);
edit its columns (`PATCH /api/sops/[sopId]`); replace its ordered step list
(`PUT .../steps`); publish (`POST .../versions`); start a run against a client
(`POST /api/sop-runs`); drive a run (`PATCH /api/sop-runs/[runId]/steps/[stepId]`
and `PATCH /api/sop-runs/[runId]`). `sop` joined `DETAIL_TABLES` so a procedure's
own columns render, the template card carries the steps, versions and the three
controls, the run page is at `/runs/[runId]`, and open and finished runs are
listed on the client page.

**A RUN FOLLOWS THE VERSION IT STARTED FROM, FOREVER,** which is the one
property worth testing hardest. 0090: "a run snapshots the SOP version it
executed against. Pointing a run at a living, editable document would let
today's edit rewrite yesterday's evidence." So the run's steps are copied **from
the published snapshot, not from `sop_step`** — the distinction that matters when
a template has been edited since it was published, because then the draft and the
snapshot disagree and only one of them is what the run says it followed.

**The step list is replaced wholesale rather than patched,** because
`sop_step_position_uk UNIQUE (sop_id, position)` is not DEFERRABLE: an UPDATE
shuffling positions can collide halfway through depending on the order rows are
visited, which is a bug that appears only sometimes and only on reorder. Nothing
references `sop_step.id` — a run copies by value — so the replace cannot orphan
a run or rewrite anybody's evidence.

**The snapshot hash is computed in SQL, over the stored jsonb.** `jsonb::text`
is canonical (Postgres normalises key order and whitespace on storage), so
`digest(snapshot::text, 'sha256')` gives the same bytes whichever process wrote
the object. Hashing the JavaScript string would hash one serialiser's formatting
and a reader recomputing it from the row would get a different answer — which is
the only check the column exists to support.

**Three step states, not seven.** `sop_step_status` carries pending,
in_progress, done, skipped, blocked, failed and not_applicable. The run page
drives the three a person working through a list can reach; see decision 16.

**What `+ New` opens is now one answer rather than five conditions.** The
generic asset form's condition was "this category has a node_type", which is
true of a procedure — a procedure IS an `asset_node` of type `sop` — so it
claimed the SOPs category alongside the new procedure form, and a
`category !== 'sops'` guard was the only thing between a right screen and a
wrong one. `createFormFor()` in `src/lib/nav/org-categories.ts` returns exactly
one form, so two cannot open.

**Three things found while building it, none of them fixed here:**

1. **A published procedure can never be deleted at all**, which is consistent
   with the product's archive-not-delete stance and stays true. What could not
   stay true is its consequence: **a client with a published procedure could not
   be purged**, because `helm.delete_organization`'s cascade
   `asset_node → sop → sop_version` fired the append-only trigger and failed the
   whole operation. `tests/integration/delete.test.ts` went red on this branch
   for exactly that reason. Fixed in **migration 0640** under decision 17 —
   which is a rail change, so it was approved rather than assumed.
2. **`client_admin` holds `sop:execute` but is rank 30**, and `sop_run`'s RLS
   requires rank 40, so a client administrator passes the route's permission
   gate and is then refused by the database. Failing closed, so not changed
   here; reconciling the seed with the policy is a permission decision beyond
   this group.
3. **`handler.ts`'s `insufficient_privilege` branch returns the raw Postgres
   message** — `new row violates row-level security policy for table "x"` names
   an internal table to whoever asked. First seen in group D; it affects every
   route that relies on a policy refusal rather than its own check, and it wants
   its own PR.

**Tests: 38 integration (`tests/integration/checklists.test.ts`), 23 unit
(`sop-steps`), 6 unit (`create-forms`), plus a procedure row in `pages.test.ts`.
21 deliberate sabotages, 14 caught immediately and 7 not** — every one of the
seven a hole in the tests rather than in the code, each fixed with the reason
written where it was fixed. The two worth naming:

- **Reading the live `sop_step` rows instead of the published snapshot survived
  the whole suite.** The test for "a run follows the version it started from"
  edited the template *after* the run began, and at the moment of the copy the
  live rows still agreed with the snapshot — so both implementations passed. The
  missing case is an edit *between* publish and run, which is also the sentence
  the template card shows the person pressing the button. That test exists now.
- **Deleting a route's `permissions` option changed nothing**, because every
  actor who lacks `sop:write` or `sop:execute` is also below the role rank the
  matching policy demands: both layers refuse, with the same 403. The tests now
  assert the gate's own message, so they can tell which layer spoke.

### Group F2 — work somebody is given (migrations 0650 and 0660)

F1 made a checklist runnable. This makes it work that belongs to somebody, which
is the parity item "tasks assigned to me".

**What landed.** `assigned_to` and `due_at` on `sop_run` and on `sop_run_step`;
an assignee and due date on the start-a-run dialog, stamped onto every step;
per-step handover from the run page; `/tasks`, defaulting to incomplete and
mine, with filters for overdue, everything and anyone; and **My open tasks** in
the dashboard's fixed counter strip, which is where that file's own rule puts it
— "the things that mean somebody has to do something today" are not widgets,
because a number that can be switched off is a number that will be.

**THE ASSIGNEE IS A COMPOSITE KEY TO `membership`, NOT TO `app_user`.** Every
other person column in the schema — `sop.owner_user_id`, `completed_by`,
`created_by` — references `app_user(id)`, and that is right for them: they
record who DID something, so the actor was by definition present. An assignee is
the opposite, a claim about the future, and assigning a step to somebody with no
membership in this tenant creates work nobody will ever see, because My Tasks
reads through RLS and RLS starts from the tenant. `membership` already carries
`UNIQUE (tenant_id, user_id)`, so `FOREIGN KEY (tenant_id, assigned_to)` makes
invisible work unrepresentable rather than merely refused by a route.

The route additionally requires an **active** membership, which a foreign key
cannot express, and the asymmetry is deliberate: a revoked colleague can still
HOLD a task, because the work exists and somebody has to take it over, but
nobody can be handed a new one.

**"Mine" is resolved in SQL, not from a parameter.** `listMyTasks` compares
against `helm.current_actor_id()`, so there is no id in the URL to change and no
way to ask for somebody else's list by editing one.

**`overdue` is computed in the database.** A client component comparing a date
to `Date.now()` during render answers one way on the server and another in the
browser moments later, which is a hydration mismatch — and it would put the
meaning of "overdue" in three places, since the dashboard count needs it too.
One predicate, in SQL, read by everybody.

**The run's assignee is a default, applied once.** Starting a run stamps it onto
every step; a step's value is then concrete. The alternative — leaving a step
NULL and inheriting the run's at read time — makes the central query
`COALESCE(s.assigned_to, r.assigned_to) = me` across a join, which no index can
serve, on what will be the most-opened page in the product. It also makes
"assigned to nobody" and "assigned to whoever owns the run" the same state, so a
step could never be taken off somebody.

**What the sabotage pass found, and it was not in F2.** 20 deliberate
breakages, 14 caught immediately and 5 not. Two were real test gaps, now
closed; three are not independently observable and each says so where it lives.
One of the five opened something larger:

Writing a bare composite `ON DELETE SET NULL` on the new assignee key broke no
test — **and it should have broken `db/tests/security.sql` §41(g)**, the
assertion 0510 left behind precisely to stop the thirty-first such constraint.
Postgres reports `pg_constraint.confdelsetcols` as **NULL**, not `{}`, when no
column list was given, so `confdelsetcols = '{}'::int2[]` evaluated to NULL, the
`EXISTS` came back false, and the check reported ok with the defect present.

Repairing the predicate immediately failed, on a constraint nobody had touched:
`topology_node_asset_fk`, added in 0570 — after 0510's sweep — with the bare
form over `(asset_node_id, tenant_id)`. Measured consequence:

```
DELETE FROM asset_node WHERE id = <a device on a site drawing>
ERROR: null value in column "tenant_id" of relation "topology_node"
       violates not-null constraint
```

So **deleting any asset that appeared on a site topology drawing failed**, and
since `helm.delete_organization` ends by deleting all of a client's
`asset_node` rows, **a client with a drawing could not be purged** — the same
shape as the `sop_version` conflict F1 found one migration earlier, reached from
the other direction. 0660 repairs it with the column list 0570's own header
describes ("a drawing is client data" and survives on its own), and §41(g) can
now see the shape it was written for. Decision 19.

### Group G — documentation coverage (no migration)

The grid of every client against every kind of documentation, at `/coverage`,
reached from the client list until L builds the Global page that collects it.

**WHAT THE NUMBER MEANS IS THE WHOLE GROUP.** Helm can see what has been
documented. It cannot see what EXISTS — a client with no ISP circuit is not an
incompletely documented client, they are a client with no ISP circuit, and
nothing in the database tells those apart. So a single "73% documented" would be
wrong for most clients most of the time, and a score people learn to ignore is
worse than no score. What is factual is **coverage**: this client has at least
one record of 7 of the 11 kinds you document. That sentence is true, it carries
its own denominator, and the grid shows the four empty cells behind it so the
number can be acted on rather than argued with. Decision 20.

**The empty cells are the feature.** Every other view in Helm shows what is
there; this one is worth opening because it shows what is not — so a gap renders
as a dash styled to be found, a count links through to the category it came
from, and the row says how many kinds are missing.

**No traffic lights.** A red/amber/green threshold on a coverage percentage is
an invented constant pretending to be a judgement — there is no answer to "is
70% bad" that holds across MSPs — and `v_client_health` already owns
red/amber/green for something that IS defined, expiry severity.

**Field-level completeness is deliberately absent,** and decision 8 is why: a
flexible record's stored `data` has every secret field removed by the splitter,
so a naive "fields filled / fields defined" under-reports by exactly the number
of secret fields on every record, always. Doing it properly means excluding the
version's `secret_fields` pointers — real work, a different measure, and
documentation health is group I's subject.

**NO MIGRATION, AND THE RESERVATION IS RELEASED.** The plan reserved "0670
(materialised counts, if needed)". They are not needed, on measurement rather
than optimism. Against a synthetic estate of 404 clients and 60,009 asset nodes:

| query | time |
| --- | --- |
| the whole tenant, one grouped pass | 430 ms |
| the same aggregate as superuser, no RLS | 40 ms |
| the flexible arm as two UNIONed aggregates instead | 997 ms |
| **fifty clients, the shape that shipped** | **79 ms** |

So the grid asks for one page of clients rather than all of them, which is both
fast enough and simply correct — the query matches the screen. A
trigger-maintained counter table would have been a second source of truth to
keep honest, for a page that is now 79 ms.

**THE 10× BETWEEN THE FIRST TWO ROWS IS NOT THIS GRID'S, AND IS WORTH
SOMEBODY'S ATTENTION.** `helm.org_in_scope(organization_id)` and
`helm.internal_visible(is_internal_only)` are STABLE SQL functions carrying
`SET search_path`, and **a SET clause makes a SQL function un-inlinable** — so
each is a real function call, twice per row, 120,018 calls for one grid.
Verified directly rather than inferred: an identical two-line function with the
SET clause plans as `Filter: probe_with_set(organization_id)` where the same
function without it plans as `Filter: (organization_id IS NOT NULL)`.

Every RLS-filtered aggregate in the product pays this, including the dashboard's
counter strip. It is **reported and not changed**: removing a search_path pin
from a function that every policy calls is a security decision about hardening
against search_path attacks, it would change the cost and safety profile of
every policy in the schema at once, and G does not need it. It wants its own
look, with a decision taken deliberately.

**Columns come from `ORG_CATEGORIES`,** so the grid names things exactly as the
sidebar does — "Domain Tracker", not "Ssl certificate" — and a category added
there appears here with no second list to remember. The tenant's own flexible
types follow, and only the ones that are active AND have a published version: a
type nobody can create records of is a draft, not a gap, and a retired type
should stop being measured rather than start reading zero.

`documents`, `contacts` and `locations` are absent because they are not
`asset_node` rows and this aggregate counts nodes. They are real documentation
and a later pass could add them from their own tables; noted here rather than
left as a silent omission.

**Tests: 15 integration, 13 unit, 3 page rows and 2 value assertions. 13
sabotages, 11 caught immediately and 2 not** — both real gaps in my tests,
both now closed:

- **Dropping the `ORDER BY` from the client page query broke nothing.** The
  fixture inserts internal, Acme, Globex, which is already the order the test
  asserted — so it passed on heap order alone. The companion "does not repeat or
  skip a client across pages" test was worse than useless here: it compared
  paginated reads against the *same function* unpaginated, so a shared ordering
  bug cancelled out on both sides. There is now a fourth client whose name sorts
  first and which is inserted last, so insert order and expected order disagree.
- **Dropping `deleted_at IS NULL` broke nothing,** because the fixture has
  nothing soft-deleted. Unlike F2's membership check, RLS is *not* doing this
  one: `organization_rls_select` is `tenant_id = … AND org_in_scope(id)` and
  says nothing about deletion, so that predicate is the only thing keeping a
  deleted client off the grid. Now tested in both the rows and the total.

### Group H — what the outside world says (migration 0670)

The eleventh worker job: RDAP for a domain's registry expiry, a TLS handshake
for what a server actually serves. Plus the switch that turns it on, and the
card on the asset page that reports what came back.

**OFF UNTIL SOMEBODY TURNS IT ON, and that is structural rather than a default.**
`helm.external_check_backlog()` joins `external_check_setting`, so a tenant with
no row contributes no work and an air-gapped install reports idle forever. There
is no environment variable to forget and no configuration that makes traffic
leave the building on an upgrade. The endpoint is part of the payload, not a
hidden constant: somebody enabling this can see, and change, where their
clients' domain names are sent. Decision 4.

**THE PROBE WRITES BESIDE, NEVER OVER — AND THE DISAGREEMENT IS THE PRODUCT.**
0110's house rule is that sync never overwrites a field a technician edited by
hand, and its implementation is "inbound values only fill fields that are still
NULL". Taken literally that defeats a *refresh* job: nothing would ever be
refreshed, only first-filled. So H keeps the rule's intent and gets the feature
by giving the outside world its own columns — `registry_expires_at` beside
`expires_at`, `observed_not_after` beside `not_after`. Both values exist, and
"you recorded March, the registry says January" is the most useful sentence this
feature can produce. Overwriting would have destroyed it; blank-filling would
have hidden it. Decision 22.

**AND THE EXPIRY DASHBOARD STILL COUNTS THE RECORDED DATE,** which the card says
out loud whenever the two disagree. Re-pointing `v_expiration_dashboard` at the
observed column would silently change what every install's alerts mean the
moment an administrator ticked a box. Decision 23 — flagged as the open
question it is, not quietly settled either way.

**'unsupported' IS NOT 'failed'.** A ccTLD that publishes no `expiration` event
will never publish one; a registry that is down will be back. Showing both in
red teaches people to ignore red. `external_check_status` has three values for
that reason, and the card renders the third as "Not available" with a note that
it will not be retried differently.

**`last_checked_at` IS NOT ADVANCED BY A FAILURE,** deliberately. It means "when
did we last successfully learn something", which is what "last checked: never"
has to mean on screen. A failed probe that advanced it would make a domain
nobody has ever successfully looked up read as recently checked. `next_check_at`
*is* pushed out on failure, to the tenant's full interval — the difference
between a job that retries politely and one that hammers a registry having a
bad day.

**A BUG THIS GROUP'S OWN TESTS CAUGHT, worth recording because it would have
shipped looking like it worked.** The first version of the job read its backlog
as `helm_worker` and then ran `UPDATE domain SET … WHERE id = $1`. That role is
subject to RLS like any other, and with no tenant context every one of those
writes matched **zero rows** — and an UPDATE matching zero rows is not an error.
The job logged a tidy `failed: 1` for a probe whose result it had just thrown
away. Nothing in SQL could have caught it; the integration test did, because it
asserts the row afterwards rather than the job's return value. The fix is the
shape `unifi-sync.ts` already used: the backlog returns each tenant's own
`system_sync` service account and every write goes back inside that tenant
through `withTenant(…, { role: 'worker' })`. The cross-tenant read stays on the
bare worker because the backlog function is SECURITY DEFINER.

**Two locks, because they answer different questions.** One advisory lock per
job name (`0x48_45_4c_4d_0b`) keeps two schedulers from running the job at once;
a row claim — `FOR UPDATE SKIP LOCKED` plus `next_check_at` pushed forward by a
claim window — keeps two *workers* off the same domain, and survives a worker
that dies mid-probe, which an advisory lock does not because it dies with its
session. 0430's reasoning, unchanged.

**NULL `next_check_at` means never checked, which means due,** so the due
indexes are deliberately not partial: a partial index `WHERE next_check_at IS
NOT NULL` would exclude exactly the rows that have never been looked at.

**Egress, and what the test environment taught.** A test aimed at RFC 5737
reserved address space passed for the wrong reason: this container's egress
gateway intercepts outbound TLS and completes a handshake for *any* address,
presenting its own certificate (issuer "Egress Gateway SDS Issuing CA", subject
`default.domain`). So "unreachable" was being proven against a host that
answered. The probes are now tested against local fixture servers — a real TLS
host with a self-signed certificate, a real RDAP service, and a port that
accepts and says nothing — which is also what made the timeout path testable at
all. `FakeSilentPort.stop()` has to destroy held sockets: `server.close()` waits
for them, so a 400 ms probe timeout produced a 30 s test timeout.

**And one more thing the environment taught, after CI said so.** The
certificate test serves TLS on 443 because the worker probes 443, which works
as root and is EACCES on a GitHub runner — so the first CI round failed with a
bare 30-second timeout pointing at the test, naming neither the port nor the
permission. Both halves are fixed: the database job lowers
`net.ipv4.ip_unprivileged_port_start`, and the fixture servers now reject on a
failed bind with the errno and the remedy in the message, because all three had
the same resolve-only `listen` that turns a bind error into a hang. Decision 25.

**The RDAP client refuses to be redirected into clear text.** Redirects within
https are followed, because forwarding is the entire purpose of a redirector
like rdap.org; three hops maximum; and a hop whose scheme is not https throws
rather than being followed, because the answer is something somebody acts on.
The route refuses a non-https endpoint rather than coercing it — a URL silently
upgraded sends the request somewhere the person did not ask for.

**Tests: 21 integration, 21 unit, 2 page rows and 4 value assertions. 11
sabotages, 11 caught.** That clean sweep is not a claim about the tests being
good from the start — two of the tests that did the catching were written
minutes before the pass, because the thing that found the gaps in this group was
not sabotage but asking what had **no test at all**:

- **The route had no tests.** Every other block in the file seeds
  `external_check_setting` with the superuser, which proves the job reads the
  row and says nothing about who may write it — and "who may make a client's
  domain names leave the building" is the part of this feature worth gating. The
  `tenant:write` gate, the https refusal, the interval bounds and one end-to-end
  "the route is what makes the job start working" test now cover it.
- **The `IS NOT NULL` on the backlog's actor lookup looked like defensive
  noise.** `helm.worker_actor()` returns NULL for a service account somebody has
  disabled, which is an ordinary administrative act. Without that filter the job
  would be handed a row with no actor, and the throw would come out of the loop
  and abandon every other tenant's checks for that tick. Now tested by
  disabling the account and asserting the job goes idle instead.

What made the rest of the sabotages land was the RLS bug above: fixing it had
already forced every assertion in the integration file to read the row back
rather than trust the job's return value, and a test that checks the database is
a test a broken write cannot satisfy. `db/tests/security.sql` §48 pins the same
lesson at the SQL level — an `UPDATE` with no tenant context matches nothing and
does not raise — next to the four policies' actual behaviour, the https CHECK
and the interval bounds.

### Group I — what has gone quiet, and a logo somebody can upload (migration 0680)

Two features. The health ring on the client page, and bytes behind
`organization.logo_url` for the first time since 0010.

**THE DEFECT THIS GROUP TURNED ON, and it would have shipped looking like it
worked.** The obvious design for "not opened recently" is a `last_viewed_at`
column on `asset_node`. It was written, applied, and measured:

```
before view: updated_at age in days | 400
after  view: updated_at age in days |   0   ← and the view was recorded
```

`asset_node_touch` is `BEFORE UPDATE ... helm.touch_updated_at()`, which sets
`updated_at := now()` on **any** write to the row. So recording a view marked
the documentation as freshly *revised*. `stale_count` would then have counted
only the records nobody had looked at — which is the other measure wearing this
one's name, and which gets better the more people browse. A number that
improves when you read it is worse than no number.

Guarding the trigger was the alternative and is worse. Narrowing it to
`UPDATE OF <column list>` means a column added later silently stops bumping
`updated_at`; teaching `helm.touch_updated_at()` about view-only updates puts
table-specific knowledge in a function eleven tables share. The real lesson is
about meaning: `asset_node.updated_at` means "last revised", three features
depend on that, and a read path writing anything to that table leaves the
meaning one trigger away from false. So `node_view_stat` holds view traffic and
`asset_node` is not written by reads at all — the mistake is unavailable rather
than guarded. Two guards hold it from both ends: one fails the migration if
such a column reappears, one fails it if `asset_node_touch` is ever dropped.

**COUNTS, NEVER A SCORE**, which is decision 20 carried over from G rather than
re-argued. IT Glue puts a percentage in the middle of this ring; Helm puts the
number that needs attention there, and the legend holds three sentences that are
each either true or false:

| segment | what it says |
| --- | --- |
| current | revised inside the window |
| stale | revised, but longer ago than the window |
| never revised | created before the window and never revised since |

Disjoint and exhaustive over the client's non-archived `asset_node` rows, and
the card **checks that before it draws**: three independent SQL `FILTER` clauses
adding up is exactly the kind of property that is true when written and false
after an edit, so if it ever fails the card shows the counts and hides the
chart. A ring with a gap in it would be read as a fourth category.

`never revised` is `updated_at = created_at`, which is exact except for a record
created and edited inside one transaction — `now()` is transaction-scoped. No
write path does that today, and a row in the wrong segment is the right
direction for a proxy to fail in.

**The denominator is `asset_node` and nothing else**, deliberately: it is G's
denominator, so the coverage grid and this ring cannot come to disagree about
what a client "has". Documents, contacts and sites are real documentation and
are counted by neither; said here rather than left as a silent omission.

**DECISION 3's DATA SOURCE DID NOT EXIST**, and finding that out was most of the
design work. It specified "not viewed recently" as tenant-wide from `audit_log`:

- **`audit_log` has no view events, and must not.** It records
  security-relevant events, and `src/lib/clients/activity.ts` argues at length
  that it must not record ordinary edits. A fortiori not every page view: it is
  append-only, hash-chained and anchored hourly, so a read-traffic log makes the
  chain grow with browsing — and it would record **who read what**, which is the
  disclosure decisions 5 and 7 exist to prevent.
- **`user_recent_view` is a recents list, not a history.** `helm.record_view()`
  trims it to each user's 50 most recent rows, so a node drops off after 50
  newer views whatever its age. Aggregating it would report "never viewed" for
  anything a busy technician looked at 51 pages ago.

So the fact is stored, with no actor, by the function that already runs on every
node page view. **The carve-out:** a client read-only user must be able to cause
that write and holds no `asset:write`, so `helm.touch_node_view()` is `SECURITY
DEFINER` — one statement, tenant from the session rather than from its argument.
`helm_app` has `SELECT` and no write privilege, so the function is the only path
in and the gate is a missing privilege rather than a policy. Decision 26.

**THE LOGO IS NOT AN ATTACHMENT**, which was the tempting reuse. As an
attachment a logo would appear in the client's document tree, be deletable by
anyone holding `asset:write`, and be rendered into an export bundle as a file
the client never attached — and every query listing documents would have to
remember to exclude it, which is the filter class of defect this project keeps
finding. It reuses the document **storage** and crypto, which is what the plan
asked for: same filesystem store, same tenant DEK, same nonce pairing.

**SVG is refused**, by a byte sniffer and by a CHECK constraint. An SVG served
from Helm's origin can carry `<script>` and run with the reader's session, and
"it is only a logo" is how that gets waved through. The stored content type is
the **sniffed** one rather than the browser's claim, so `nosniff` and the bytes
always agree.

**Tests: 28 integration (health), 31 integration (logos), 24 unit, §49 of
`security.sql` at 25 assertions, 3 page value tests and 4 logo-resolution ones.
13 sabotages, 12 caught — 11 by tests and one by a migration guard — and 1 that
survived:**

- **Removing `archived_at IS NULL` from `listHealthSegment` broke nothing.** The
  view excludes archived rows and the list did not, but the test comparing each
  segment's list against its count never noticed, because the fixture has
  nothing archived. Three archived nodes now sit in that test, one in each
  segment's range, so a list that forgets the filter returns more rows than the
  count.

Three more things were found by writing assertions rather than by sabotaging
them, which is the pattern this pass keeps repeating:

- **0220's `ALTER DEFAULT PRIVILEGES` had already granted `helm_app` full DML on
  `node_view_stat`**, so the `SELECT`-only grant restricted nothing and the
  "only the definer function can write" claim was false. Guard 2b caught it on
  the migration's first run; an explicit `REVOKE` fixes it.
- **`open()` read the logo with the ACTIVE data key**, not the one the row
  names. After a rotation every logo uploaded beforehand would have failed to
  decrypt — a broken image on every client page, with no error anybody would
  connect to key management. The type checker caught it (`activeDataKey` takes
  no key id) and a test now pins it.
- **`propsOf()` in `pages.test.ts` only descended through `children`**, so a
  component passed through any other prop — `actions`, `trigger`, `icon` — was
  invisible to it. It walks every prop now. The failure direction was safe here,
  but a test asserting a component is *absent* would have passed for entirely
  the wrong reason.

And two inert Tailwind classes in already-merged code, found by a new guard
rather than by looking: `text-sev-ok` in H's external-check card (the token is
`--color-ok`) and `bg-surface-muted` in F2's tasks page. An unknown utility
generates nothing, so the class sits in the markup looking deliberate while the
element inherits its parent's colour — invisible to the type checker, the build,
and a person who assumes a muted icon was a design choice.
`tests/unit/colour-tokens.test.ts` now fails on any colour utility or inline
`var(--color-…)` naming a token `globals.css` does not declare.

### Group K — a mail relay of your own, and reminders that use it (migration 0690)

Three features that share one dependency: outbound email. A relay the tenant
configures, personal reminders about assigned checklist steps, and a second
transport for the notification destinations 0420 built.

**Helm sends no mail until somebody points it at a relay.** No hosted sender,
no bundled MTA — the same air-gapped default 0670 established for the external
checks, for the same reason: an on-premises install that starts talking to the
internet because it was upgraded is a surprise nobody consented to.
`smtp_setting` is one row per tenant, `enabled` defaulting to false, and a
tenant with no row contributes nothing anywhere.

**The relay password is the fourth envelope.** 0360 (RADIUS), 0410 (OIDC) and
0420 (webhook URL) each seal a secret the application needs and the database
must never be able to produce; this is the fourth, bound to the tenant because
there is exactly one row per tenant and the AAD has to name something stable.
`helm_app` holds no privilege on the envelope columns — asserted per column by
a guard, and behaviourally by §50, including that `SELECT *` fails for the same
reason a named column does.

**`checkServerIdentity` cannot pin a self-signed certificate.** This was
measured, not reasoned about, and the measurement changed the design — see
decision 29. What is stored is the certificate, in PEM, used as the only
acceptable CA; the fingerprint the settings page shows is derived from it, so
the two cannot disagree.

**A reminder belongs to a person, so it gets its own queue.**
`webhook_delivery` keys on `(endpoint, event_uid)` and every row belongs to a
destination; a reminder belongs to somebody and names a step. Sharing the table
would have meant a nullable endpoint and a dedupe key that means two things.
`task_reminder` carries `(step_id, kind, lead_day)` as its uniqueness, which is
0100's lead-day construction and the whole reason a sweep every hour is not a
nuisance: three days before, the day before, and on the day, once each, and
nothing at all once the step is complete.

**The notification destinations got a transport rather than a second
mechanism.** §1 of `docs/architecture/10-notifications.md` exists because 0110
shipped `webhook_endpoint` and `webhook_delivery` with retry fields and a
dedupe constraint that nothing was ever wired to. A `transport` column with a
delivery branch and no way to create such a row would be the same mistake with
a better comment, so `helm.webhook_endpoints()` and
`helm.set_webhook_endpoint()` were both reissued, the route and the card learned
the second transport, and the test that matters is an export audit row arriving
in a real mailbox through the same fan-out, the same queue and the same worker.

**Tests: 28 unit (transport), 26 integration (reminders), 29 integration
(settings and preferences), 8 integration (the destination surface, including
the end-to-end send), 5 page value tests, and §50 of `security.sql` at 28
assertions. 6 sabotages, 6 caught.** The more useful findings came from writing
the assertions rather than from breaking them:

- **`webhook_envelope_complete` refused every email destination**, and nothing
  in the migration noticed. 0420's version spells out `IS NOT NULL` seven
  times; 0690 had made the *other* envelope constraint
  (`webhook_secret_present`) conditional on the transport and missed this one —
  which, it turns out, was the only one that ever mattered, because
  `octet_length(NULL) > 0` is NULL and a CHECK passes on NULL. Found by the
  integration test trying to create a destination through the route. Both are
  conditional now, email requiring that *none* of the envelope columns is set,
  and guard 5b asserts the constraint's text mentions the transport so a later
  migration cannot reissue 0420's version and break it silently.
- **`audit:read` alone opened the reminder queue to a client administrator.**
  The first draft of `task_reminder_rls_select` was
  `user_id = current_actor_id() OR has_permission('audit:read')`.
  `client_admin` holds `audit:read` in the shipped catalogue and the table has
  no organisation to scope on, so a client administrator at one client could
  read reminders naming another client's steps — and learn that the other
  client exists. It now requires a tenant-wide seat for the oversight half.
  Decision 31.
- **`helm_app` and `helm_worker` could write `task_reminder` directly**, which
  0220's default privileges had granted and the policies did not catch: the
  INSERT and UPDATE policies check the tenant and not the person, deliberately,
  because the writers act for other people. So any signed-in member could have
  raised a reminder in somebody else's name or marked one sent. All five
  writers are `SECURITY DEFINER`, so the revoke costs nothing. The same
  correction 0680 had to make for `node_view_stat`, found the same way.
- **§37's `has_function_privilege` assertion caught the signature change** for
  free. It names `helm.set_webhook_endpoint`'s full argument list, and
  `has_function_privilege` *raises* on a signature that does not exist rather
  than returning false — so reissuing the function with two more parameters
  could not quietly leave the grant behind.
- **`recipientAllowed` was called outside a tenant context** and therefore
  refused every address. The zero-row-is-not-an-error family again, from the
  read side: `helm.email_recipient_allowed` is `STABLE` and not a definer
  function, so called on a bare connection it saw no `smtp_setting` row and
  answered no. Asking inside `withTenant` is the fix.
- **A pinned certificate reached the settings props as a PEM** in the first
  draft of the card's reader. It is a fingerprint now, derived, and a page test
  asserts the props contain no `BEGIN CERTIFICATE` — a pinned certificate is
  not secret, but a wall of base64 is something people scroll past and a
  fingerprint is what an operator can compare.

### Group L — the header tells the truth, and the bell has something to ring (migration 0700)

The last group, and the one that found the most in code that was already
merged. Three of its four parts were assembly, as the plan said. The fourth was
not, and two things it depended on turned out not to work at all.

**THE AUDIT FAN-OUT HAD NEVER RUN.** `fanOutNotifications` enumerated its
tenants with a raw `SELECT ... FROM tenant` on the bare worker pool. `tenant` is
behind RLS — `tenant_rls_select: id = helm.current_tenant_id()` — and a worker
connection sets no tenant context, so that query returned **zero rows on every
tick**. 0400 removed two-person approval from credential exports on the stated
understanding that these notifications replace it; the control it traded for was
not running.

Nothing caught it because every test calls `helm.fan_out_notifications()`
directly inside `withTenant()`, which is the right way to test the function and
skips the enumeration entirely. The deliver half beside it always used
`helm.notification_backlog()` — a `SECURITY DEFINER` function — which is why
only the fan-out was affected, and why the fix is just the house pattern every
other backlog already follows. This is the project's third zero-rows-under-RLS
defect (H's refresh worker, §49 and §50 of `security.sql` hold the other two)
and the first in a **read**, where there is no write to come back empty and
nothing at all to notice.

**AND RAISING A REMINDER REQUIRED A MAIL RELAY.** Both of 0690's reminder-raising
functions carried `JOIN smtp_setting m ON ... AND m.enabled`, so an install with
no mail created no `task_reminder` rows — and the trigger that lights the bell
never fired. Correct when email was the only output; wrong the moment there are
two channels, because an air-gapped MSP would have had a bell that could not
show the one thing it is most for. Removing it is safe because 0690 already
separated raising from sending: `helm.email_backlog()` still requires an enabled
relay, so a reminder raised without one sits `pending` until somebody configures
mail — which is what 0690's own comment describes.

Three of K's tests asserted the old rule and were rewritten rather than deleted,
to the stronger pair: the rows ARE created, and nothing is sent.

**The inbox is the first notification table pointing inwards.** 0110, 0420 and
0690 built three outbound queues; a `webhook_delivery` row belongs to a
destination and a `task_reminder` row is a message about to be sent, so not one
of them can express "this person has not seen this". That is what `read_at` is
for, and why the plan's line — *a bell that cannot be distinguished from an
empty inbox is worse than no bell* — could not be honoured until 0700.

**And the recent-items dropdown already existed.** `recently-viewed.tsx` — the
popover, the fetch-on-open, the dismiss handling, the per-type icons — with
nothing rendering it; the header carried a `History` icon linking to
`/dashboard`. The third thing found built and unwired, after 0110's webhook
tables and 0690's `transport` column. Hence the rule this pass keeps earning:
**before building a control, grep for it.**

**Tests: 16 integration (the inbox end to end), 2 page value tests, and 3 of
K's rewritten. 9 sabotages, 8 caught — 5 by migration guards, 3 by tests — and
1 that survived:**

- **Removing the lead day from the reminder's dedupe key broke nothing.** The
  assertion meant to hold it inserted ONE `due` row and checked the count went
  up by one — which passes with the lead removed entirely, because the row it
  compared against was a `task_assigned` row and the KIND already
  distinguished them. Two rows of the same kind differing only in lead is the
  only shape that tests what the key is for, and that is what the test does
  now.

Two more things fell out of writing the page tests rather than of sabotage: the
Global page named `export_request`, a table that does not exist (it is
`export_job`, with a different status vocabulary), and a comment inside a SQL
template literal quoted enum values in **backticks**, which ended the template
mid-comment. Both were caught before they left the branch, by the coverage guard
that insists every page under `(app)` has a line in `PAGES`.

## Decisions

The questions this document opened with have been answered. Recorded here
because the groups they govern are not built yet, and a decision that lives
only in a conversation gets re-litigated. Entry 1 is struck through rather than
deleted: the group it governed is dropped, and a decision that simply vanishes
is how the same argument gets had twice.

1. ~~**Personal Credentials (J).**~~ **Superseded by decision 14 — J is
   dropped.** The design this entry recorded (tenant DEK, `owner_user_id` on
   `secret`, RLS adding `owner_user_id = helm.current_user_id()`, no
   break-glass, excluded from export bundles and cross-client search) is not
   being built. It is kept as background under *Personal Credentials is a
   security-model change* above, because an integration has to answer the same
   questions at a different boundary. Nothing in the active plan depends on it,
   and `docs/security-model.md` is not written as part of this pass.
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

12. **A missing sidebar row and an empty one are different answers (D).** The
    fallback chain is decided by whether a ROW exists, never by whether the
    stored array is empty. An empty layout is somebody who wants the drawer to
    be nothing but "More", and treating it as "unset" would make the control
    appear broken to the one person who used it hardest. The same reasoning
    makes `DELETE` remove the row rather than write the default into it: a
    stored copy would silently stop tracking an administrator's later change,
    and nobody would be able to tell.

13. **The tenant default is read-open and write-gated (D).** Readable by every
    role in the tenant, because the drawer renders from it for client-side
    users too; writable only with `tenant:write`, named in the route and in the
    policy. This is why `tenant_sidebar_default` does not use the generic
    tenant-scoped policy set, whose read predicate would have hidden the row
    from the very roles it exists to serve. No new permission key; no change to
    any existing policy.

14. **Group J is dropped; personal credentials come from a Bitwarden /
    Vaultwarden integration (your call, recorded here).** Not built natively,
    now or as part of this parity pass. The reason the native vault was awkward
    is the reason the integration is a better fit: a private credential means a
    row **no other user may read, including a tenant administrator**, and
    Helm's policy shape — tenant + organisation RLS, with `super_admin` holding
    `tenant:write` — cannot express that without a second, parallel security
    model. Bitwarden and Vaultwarden already have a user-owned key hierarchy,
    so the guarantee lives where it is already enforced rather than being
    re-implemented beside a hierarchy built for shared MSP documentation.

    **What this means concretely:** no `owner_user_id`, no per-user RLS branch,
    no personal-vault exclusions in the export path, no
    `docs/security-model.md` for it, and no migration — 0680 was freed and K
    and L moved into the gap. Group L's Personal page collects My Tasks and
    profile/preferences only, with **no placeholder and no empty state** for
    personal credentials: a card promising a feature the plan no longer
    contains is worse than its absence, because somebody would wait for it.
    The integration itself is listed under *Future, and deliberately not in
    this plan* — nothing is being built for it now.

    The drafted vault design is kept as background rather than deleted, under
    *Personal Credentials is a security-model change*. The three questions it
    opens (break-glass, offboarding bundles, which key) do not go away with the
    change of approach; they move to a different boundary, and two of them stop
    being Helm's to answer.

15. **A preference is not stored until the thing it controls exists (E).** Two
    items on group E's list were deliberately *not* built, and both for the
    same reason rather than for want of time:

    - **"Enable side panel".** There is no side panel. Credentials open as a
      page and no sheet, drawer or overlay component exists anywhere in
      `src/components`, so the toggle would store a preference nothing reads.
      Building the panel — an overlay rendering path, routing, focus
      management — is a feature, not a preference, and belongs in a group of
      its own.
    - **One-time MFA recovery token.** `mfa_enrolled_at` and
      `auth_authenticator` exist in the schema, but **nothing in the
      application reads `mfa_enrolled_at`** and the sign-in path enforces no
      second factor. Every MFA reference in the codebase is about documenting a
      *client's* TOTP seed, not about signing in to Helm. A one-time token that
      bypasses a check which is not performed is a second password, and a
      security-sensitive one. It needs MFA sign-in enrolment first, which is
      its own group.

    This is the same rule decision 14 applies to Personal Credentials on the
    Personal page, stated generally: a control that stores an answer nobody
    acts on is worse than its absence, because somebody sets it and then
    reasons about a system that is not listening. Both rows read **Deferred**
    in the summary table rather than Missing, so the distinction between "not
    done" and "not done on purpose" survives in the one place people look.

16. **The other four step statuses, evidence and approval are deferred, not
    dropped (F1).** `sop_step_status` carries seven values; the run page drives
    three — pending, done, skipped. The other four each need behaviour that does
    not exist: `blocked` wants a reason and a way to unblock, `failed` wants an
    incident, `not_applicable` wants a recorded judgement, `in_progress` wants
    either a timer or a second control whose only job is to say "starting now".
    `sop_run_step.requires_evidence` and `evidence jsonb` want an attachment
    path, and `sop.requires_approval` with `sop_run.approved_by`/`approved_at`
    wants an approval queue and a notion of who may approve. All five stay in
    the schema — they are right, and 0090 was written with them in mind — and
    none gets a control until the thing behind it is built. A dropdown of seven
    words with behaviour behind three is the shape this plan has spent four
    groups removing, and it is the same rule as decision 15: a control that
    stores an answer nobody acts on is worse than its absence.

17. **A client purge takes their published procedures with it (F1, 0640).**
    Approved rather than assumed, because it widens a rail a previous migration
    deliberately fenced.

    `helm.delete_organization` ends with `DELETE FROM asset_node WHERE
    organization_id = …`, which cascades to `sop` and then to `sop_version` —
    and `sop_version` carries `helm.deny_mutation()`, so the whole purge fails
    with *"DELETE on sop_version is not permitted; this table is append-only"*,
    surfacing as a 403. Before F1 nothing could publish a version, so no row
    existed outside a fixture and the conflict was invisible. F1 ships
    publishing, so it is live: publish one checklist for a client and that
    client can never be deleted. `tests/integration/delete.test.ts` fails on the
    F1 branch for exactly this reason, which is the suite doing its job.

    Both failure modes were measured, not reasoned about:

    - a published version alone → the append-only trigger, as above;
    - with a run against it, and the trigger exempted →
      `update or delete on table "sop" violates foreign key constraint
      "sop_run_sop_fk"`, because `sop_run.sop_id` is ON DELETE RESTRICT;
    - deleting the runs first, then the versions inside a `helm.purging`
      window, then the nodes → succeeds.

    **Option A — a purge takes published procedures with it.** Point
    `sop_version`'s trigger at the existing `helm.deny_mutation_unless_purging()`
    (0520) and reissue `helm.delete_organization` to delete the client's runs and
    then their versions inside the purge window. The two locks are unchanged —
    the `helm.purging` GUC set with `SET LOCAL` inside a SECURITY DEFINER
    function, plus table ownership that `helm_app` does not have — so no
    ordinary path can touch a published version, and `audit_log` keeps the
    unexempted `deny_mutation()`, which is what makes permanent deletion
    defensible at all.

    What makes this a question rather than a patch: **0520 contains a guard that
    says this must not happen.** "AND SO ARE THE OTHER APPEND-ONLY TABLES. Only
    `secret_version` was meant to become purgeable", and it raises if the
    exemption appears on any other table. That guard runs at 0520's point in the
    sequence, so a later migration would not trip it — stepping around it
    silently is exactly what should not happen, so Option A means amending that
    stated intent in the open.

    The case for it: the one hard-delete path this product has already destroys
    credentials *and their entire version history*, which is far more sensitive
    than a checklist. "You cannot delete this client because somebody once
    published a procedure for them" is a worse product than "purging a client
    purges everything about them", and the audit log still records what was
    destroyed.

    **Option B, not taken — the rail stays absolute and the purge refuses
    clearly.** `helm.delete_organization` would check for published procedures
    up front and raise with a DETAIL the route turns into prose, the way
    `archive_first` already works. It is recorded because it is the honest
    alternative, and rejected because it leaves an existing, documented feature
    permanently broken for a reason nobody can act on: any client you ever
    published a checklist for would stay forever.

    **What 0640 does, and what it deliberately does not.** `sop_version`'s
    trigger now calls `helm.deny_mutation_unless_purging()`;
    `helm.delete_organization` deletes the client's runs, then their versions
    inside a `set_config('helm.purging', 'on', true)` window that is lowered
    immediately, then their nodes; and the count the confirmation dialog quotes
    back gained `checklist_runs`, because a run somebody is about to lose should
    be named before it goes. Unchanged: `audit_log` keeps the unexempted
    `deny_mutation()`, `UPDATE` on a published version is still refused outright
    even inside a purge, `flexible_asset_type_version` is untouched, and
    **deleting one published procedure is still impossible** — the exemption
    fires inside a client purge and nowhere else, so archiving remains the only
    way to retire a procedure that has ever been published.

    0520's guard is re-stated in 0640 with the allowed set `{secret_version,
    sop_version}`, and `db/tests/security.sql` §41(f) with it, so a third table
    joining the list still fails the build until somebody writes the migration
    that says why.

18. **A task is a step, and its assignee is a membership (F2, 0650).** Three
    choices that each had a plausible alternative, recorded because the
    alternatives are what a reader will wonder about.

    **The unit of work is a STEP, not a run.** What somebody is handed is
    "forward the mailbox", and one run can be split across several people — so
    My Tasks lists steps and names the run each belongs to, rather than listing
    runs and making somebody open each to find their part.

    **The run's assignee is a default, stamped once** rather than inherited at
    read time. Inheriting would make the central query
    `COALESCE(s.assigned_to, r.assigned_to) = me` across a join, which no index
    can serve, on the page people will open most; and it would make "assigned
    to nobody" and "assigned to whoever owns the run" the same state, so a step
    could never be taken off somebody. The cost is that reassigning a whole run
    is not a single act in F2 — the run's own columns are set at creation and
    are the record of what it was started as, and handover happens per step,
    which is where the work is. Bulk reassignment is a clear follow-up rather
    than something half-built.

    **`due_at` is a timestamptz, not a date.** The schema is split on purpose:
    warranties, domains and licences use `date`, because they expire on a day in
    the world and "expires 2026-03-01" meaning three different instants is how a
    certificate lapses on a Sunday. A task is the other case — "restart it at
    02:00" is a real step, and a task assigned to you is the one kind of date
    where the READER is the subject rather than a shared fact, which is exactly
    when decision 15's `formatDateTimeLocal()` renders local time beside UTC.
    Overdue is computed against `now()` in SQL, so it is correct for everybody
    wherever they read it.

19. **0510's sweep was one constraint short, and the test that should have
    caught it was blind (F2, 0660).** Not a judgement call so much as a defect
    worth recording where the next person will look, because the mechanism will
    recur.

    0510 repaired thirty composite `ON DELETE SET NULL` keys that nulled
    `tenant_id` along with the reference, and `db/tests/security.sql` §41(g) was
    written to stop the thirty-first. It could not: Postgres reports
    `pg_constraint.confdelsetcols` as **NULL**, not `{}`, when no column list
    was given, so the predicate `confdelsetcols = '{}'::int2[]` evaluated to
    NULL rather than true and the `EXISTS` came back false. The assertion
    reported ok for every bare constraint it was meant to catch.

    Found while adding F2's assignee key: writing it the wrong way on purpose
    broke no test. Fixing the predicate then failed immediately, on
    `topology_node_asset_fk` from 0570 — added after the sweep — and the
    consequence was live: deleting any asset that appeared on a site topology
    drawing raised *"null value in column tenant_id violates not-null
    constraint"*, which also meant a client with a drawing could not be purged.

    0660 repairs the constraint with the column list, restoring what 0570's own
    header says a drawing is ("client data", surviving on its own and simply
    letting go of a deleted asset). §41(g) keeps its NOT EXISTS form, now with
    `coalesce(confdelsetcols, '{}')`, plus a companion assertion that the
    predicate can still tell a bare key from a correct one — because a NOT
    EXISTS passes both when the schema is clean and when the question is broken,
    and that is the whole reason this went unnoticed.

20. **Coverage, not completeness — and the plan already said so (G).** The
    summary table asked for "a per-type/per-client coverage query", and the
    word was load-bearing. A cell is a count of records; a row's badge is "at
    least one record of N of the M kinds you document". Neither claims a client
    is M-minus-N records short of complete, because Helm cannot see what exists
    in the world — only what has been written down — and a client with no ISP
    circuit is not an incomplete record.

    Three consequences, each of which could have gone the other way:

    - **A column counts as covered on one record, not on a threshold.** "At
      least one exists" is the only claim the data supports.
    - **There are no traffic lights.** Any red/amber/green cutoff on a coverage
      percentage is an invented constant, and `v_client_health` already owns
      those three words for expiry severity, which is defined.
    - **The denominator is on screen.** The badge reads "7/11 · 64%", not
      "64%", so the number explains itself and the empty cells beside it are
      the thing to act on.

    What this gives up: a client who genuinely has no ISP circuit shows a gap
    they cannot close. The alternative — letting a tenant mark which kinds each
    client *should* have — is a real feature with a table and a screen behind
    it, and it is the right way to close that, not a guess dressed as a score.
    Recorded as the obvious follow-up rather than built.

21. **The RLS helpers cost 10× on an aggregate, and that is reported rather
    than fixed (G).** Measured while deciding whether G needed materialised
    counts: the same grouped count over 60,009 asset nodes is 40 ms as
    superuser and 430 ms under RLS.

    The cause is not the policy's logic but its packaging.
    `helm.org_in_scope()` and `helm.internal_visible()` are STABLE SQL
    functions carrying `SET search_path`, and a SET clause makes a SQL function
    un-inlinable, so each becomes a real function call per row — 120,018 calls
    for one grid. Proven directly: an identical two-line function with the SET
    clause plans as `Filter: probe_with_set(organization_id)`, and without it
    as `Filter: (organization_id IS NOT NULL)`.

    Every RLS-filtered aggregate pays this, the dashboard's counter strip
    included, so the upside of removing those pins is broad. So is the
    exposure: the `SET search_path` on a function every policy calls is
    hardening against search_path attacks, and dropping it changes the safety
    profile of the entire schema at once. That is a decision to take
    deliberately, with its own look at what each function can reach, and not a
    thing to slip into a group about a grid. G reaches 79 ms by asking for one
    page of clients, which it should do regardless.

22. **An observed value gets its own column, so a disagreement is visible (H).**
    0110's rule — sync never overwrites a hand-edited field — is implemented as
    "inbound values only fill fields that are still NULL", and a refresh job
    taking that literally would refresh nothing: every domain's expiry is
    already filled in by the person who documented it. Both alternatives lose
    the information. Overwriting destroys what somebody typed, which is the one
    thing 0110 exists to prevent; blank-filling silently keeps the stale value
    and reports success.

    So the registry and the server get columns of their own
    (`domain.registry_expires_at`, `ssl_certificate.observed_not_after`,
    `observed_fingerprint_sha256`) and the asset page shows the two side by
    side, calling out a difference of more than a day in its own line. A day of
    tolerance because the two are not the same kind of value: a recorded expiry
    is usually a date somebody typed and the registry's is a timestamp, so
    flagging `2027-01-01` against `2027-01-01T09:14:32Z` would cry wolf on every
    correctly documented domain.

    Nothing is reconciled automatically. "You recorded March, the registry says
    January" is a sentence a technician can act on; a silently corrected field
    is not.

23. **Expiry alerts still follow the recorded date, and this is left open (H).**
    `v_expiration_dashboard` (0100) projects `domain.expires_at` and
    `ssl_certificate.not_after` into the expiry feed, and H deliberately did not
    re-point it at the observed columns. Doing so would change what every
    install's expiry alerts mean the moment an administrator ticked a box —
    including for a tenant whose registry answer is wrong, or whose ccTLD
    publishes nothing and whose rows would go quiet.

    The honest consequence is that a domain whose registry says January while
    the record says March does not raise an alert until March, and that is a
    real limitation rather than a subtlety. It is handled by saying so: the card
    tells the reader which of the two dates the dashboard is counting, which
    beats being quietly clever.

    **The open question, recorded rather than decided:** whether an observed
    expiry sooner than the recorded one should drive the alert. The case for it
    is that the registry is usually right. The case against is that it makes a
    third party's uptime a determinant of whether a Helm install warns anybody,
    and that the failure is silent in the direction nobody checks. A deliberate
    answer wants its own look at `expiration.refreshed_at`, which is still the
    unused slot it has always been.

24. **A registry that cannot answer and a registry that will never answer are
    different statuses (H).** `external_check_status` is
    `ok | failed | unsupported`. A ccTLD that publishes no `expiration` event
    will not publish one tomorrow either; a 5xx will clear. Rendering both in
    red is how a status column stops being read. 'unsupported' covers both no
    expiry event and a 404 for the name, and the card says it will not be
    retried differently.

25. **CI lowers the unprivileged port floor rather than the probe gaining a
    port parameter (H).** `observeCertificate()` connects to 443 and the worker
    passes no port, because that is where TLS lives and `ssl_certificate`
    records no port — Helm does not document where a certificate is installed as
    a reachable address. So the integration test that proves the worker writes
    an observed certificate has to serve one on 443, which needs privilege the
    container I develop in has (root) and a GitHub runner does not.

    Three ways out, and the first two are worse. Threading a port through the
    worker so the test could pass is widening the product to suit the test, and
    the comment explaining it would be a lie about why the parameter exists.
    Dropping the assertion loses integration coverage of exactly the write path
    that **shipped broken once in this group** — the RLS bug above — and the
    unit suite cannot replace it, because the unit suite tests the probe and the
    bug was in the worker.

    So the database job sets `net.ipv4.ip_unprivileged_port_start=443`, scoped
    to an ephemeral container, with the reasoning in the workflow where somebody
    hits it. A contributor who cannot do that gets a legible failure rather than
    a mystery: `FakeTlsHost` now rejects on a failed bind, naming the port, the
    errno and the remedy.

    That second half was its own defect and cost the CI round that found this.
    `new Promise((resolve) => server.listen(port, host, resolve))` is the
    obvious spelling and it is a trap — a failed bind emits an unhandled
    'error', the promise never settles, and vitest reports "Test timed out in
    30000ms" against a line that mentions neither a port nor a permission. The
    same resolve-only pattern was in all three fixture servers.

26. **"Not viewed recently" is a column on its own table, written by a
    SECURITY DEFINER function, and decision 3's stated source was wrong (I).**
    Decision 3 said tenant-wide from `audit_log`. There are no view events in
    `audit_log` and there must not be: it is append-only, hash-chained and
    anchored hourly, so a read-traffic log grows the chain with browsing, and it
    would record who read what — the disclosure decisions 5 and 7 exist to
    prevent. `user_recent_view` is no use either: it is trimmed to each user's
    50 most recent rows, so it is a recents list and not a history.

    So `node_view_stat` holds `last_viewed_at` and `view_count` per node, with
    **no actor column at all** — the privacy property is structural rather than
    policed, because there is nowhere to put a name.

    Not on `asset_node`, and that is the measured half rather than a preference:
    `asset_node_touch` sets `updated_at := now()` on any write to the row, so a
    view recorded there marked the documentation as revised and a 400-day-old
    record measured as 0 days old. Keeping read traffic off that table is what
    lets `updated_at` go on meaning "last revised", which the Recently Updated
    widget, `activity.ts`'s documented split and the ring all depend on.

    The carve-out is one `SECURITY DEFINER` function doing one statement, taking
    the tenant from the session rather than its argument, with `helm_app`
    holding `SELECT` and no write privilege — so the function is the only path
    in and the gate is a missing privilege rather than a policy somebody could
    widen. Decision 3's 180 days and its "configurable" intent both survive; its
    mechanism does not.

27. **Health is three counts and a fourth number beside them, not a ring with a
    percentage in it (I).** Decision 20's rule applied to the obvious place
    somebody would break it. The segments are disjoint and exhaustive over a
    client's non-archived `asset_node` rows, each one a sentence that is true or
    false, and "nobody has opened it" sits outside the ring because it answers a
    different question: stale means the documentation may be wrong, unopened
    means nobody needs it — a correction and a retirement.

    Enforced rather than remembered: a guard in 0680 fails the migration if a
    `score`, `percent` or `ratio` column appears on `v_documentation_health`, and
    the card checks the three counts still account for the total before drawing
    anything.

    The thresholds are two per tenant rather than one, because an MSP may well
    accept a year without an edit while wanting to know about a quarter without
    a reader. Both default to decision 3's 180.

28. **A logo gets its own table, and never an `attachment` row (I).** Reusing
    `attachment` was the tempting path and is wrong three ways: the logo appears
    in the client's document tree, anybody holding `asset:write` can delete it,
    and it lands in an export bundle as a file the client never attached. Worse,
    every query that lists documents would have to remember to exclude it.

    It reuses the document **storage** and crypto — same filesystem store, same
    tenant DEK — so there is still one place that writes bytes to disk and one
    that encrypts them. `organization_id` is the primary key, so "one logo per
    client" is a property of the schema rather than a route that deletes first
    and hopes.

    **SVG is refused** by a byte sniffer and by a CHECK constraint: served from
    Helm's own origin an SVG can carry `<script>` and run with the reader's
    session. The stored content type is the sniffed one, never the browser's
    claim, so `nosniff` and the bytes agree. A tenant wanting a vector logo
    converts it, which is a smaller cost than stored XSS.

    `organization.logo_url` is kept rather than migrated: it holds whatever a
    technician pasted and an install may have it and no upload. An upload wins,
    and `src/lib/ui/logo.ts` is the single place that decides — three call sites
    render `ClientAvatar`, and a precedence rule written out three times is a
    rule that is wrong in one of them.

29. **A certificate is pinned by being the only acceptable CA, because a
    fingerprint cannot be enforced (K).** The first design stored a SHA-256
    fingerprint and compared it in `checkServerIdentity`. Measured against
    Node, that does not work in either direction: with
    `rejectUnauthorized: false` the callback is **never called**, and with
    `rejectUnauthorized: true` a self-signed chain is **refused before it
    runs** — so the hook fires only in the case where there was nothing to
    check. What works is `ca: [pem]` with `rejectUnauthorized: true`, which
    reports `authorized = true` for that certificate, refuses a different one,
    and behaves the same for implicit TLS and STARTTLS.

    So the column holds a certificate, not a digest, and the settings page
    shows a fingerprint derived from it. The route refuses verification-off
    with no pin, and refuses a pin on a plaintext connection — where no
    certificate is ever presented, so a pin is a configuration somebody
    believes is protecting them.

30. **Sending without TLS needs a signature, and the signature describes the
    setting in force (K).** `security = 'plaintext'` is savable, because a
    relay on a trusted VLAN is a real deployment and refusing it outright means
    somebody runs a plaintext relay Helm does not know about. But it requires
    `acknowledgePlaintext`, and a CHECK ties the acknowledgement to the mode:
    `(security = 'plaintext') = (plaintext_acknowledged_at IS NOT NULL AND
    plaintext_acknowledged_by IS NOT NULL)`. Moving to STARTTLS clears it, so
    the record always describes what is configured now rather than something
    accepted once in 2024.

31. **`audit:read` is not a tenant-wide seat, and a table with no organisation
    column cannot rely on it (K).** `task_reminder` names a person and a step,
    the step belongs to a run, and the run belongs to a client — but the
    reminder row carries no `organization_id`, so there is nothing for
    `helm.org_in_scope()` to test. The first policy therefore leaned on
    `audit:read` for the MSP's oversight and leaked: `client_admin` holds
    `audit:read`, so a client administrator could read every reminder in the
    tenant.

    The rule taken from this, which applies past K: **a permission is not a
    scope.** Where a row has no organisation to scope on, a client-side role is
    excluded by `helm.is_tenant_wide()` and not by the absence of a permission
    somebody may well hold. Both halves are asserted — a guard on the policy's
    text, and §50 reading a planted row from four different seats.

32. **A notification destination's transport is fixed once it exists (K).**
    Switching one would have to clear the envelope columns of the transport
    being left behind, re-validate against the other transport's rules, and
    decide what the delivery history now describes — all to save a "new
    destination" click. Worse, the obvious implementation is silently wrong:
    an email destination saved as a webhook carries no URL, so the route takes
    the update path, and `helm.update_webhook_endpoint()` does not touch
    `transport` — the screen would report a change that never happened. Refused
    with an explanation instead.

    Two smaller rules fall out of the same place. The **address is returned in
    full** where the URL never is, because for Discord and Teams the URL *is*
    the credential while an address is a destination somebody has to be able to
    read. And the **payload format and the signing secret are normalised away**
    for an email destination rather than refused: `format` names a webhook
    payload shape and a signature proves a POST body came from Helm, so both
    are fields nobody chose once the transport is email. The read-back reports
    what was stored, so nothing is hidden.

33. **A notification preference is private, and nobody can set somebody
    else's (K).** Same rule as `user_sidebar` and `user_dashboard`, with a
    stronger reason: what somebody chooses to be told about says something
    about what they are paying attention to. RLS admits only rows where
    `user_id = helm.current_actor_id()`, which makes the policy the
    authorisation — so the route is gated on no permission at all, and there is
    no administrator screen for it and no policy that would allow one. A client
    read-only user assigned a checklist step decides for themselves whether to
    hear about it.

    **An empty array is a real answer**, meaning "nothing" rather than "use the
    default". Both kinds are on when no row exists, because email is off at the
    tenant level until an administrator configures a relay — so nothing can
    arrive unasked-for, and defaulting off would mean the feature appears
    broken to everybody who was not told to go and switch it on.

34. **The relay has no test button, because a relay is proved by a real
    send (K).** The obvious control — "send a test message" on the settings
    card — would need the worker's role in a request handler to reach the
    password, and would be a second sending path that can disagree with the one
    that actually delivers. Instead the existing destination test is the test:
    add an email destination, press Test, and the outcome lands on the relay
    card, because every send records `last_send_ok`/`last_send_error` against
    `smtp_setting` whoever triggered it. The card says so rather than leaving
    the absence looking like an omission.

35. **Important Contacts is derived, not a sixth flag (L).** The plan said "a
    flag on `contact`". `contact` already carries `is_primary`,
    `is_technical`, `is_billing`, `is_emergency` and `is_authorised`, and
    `organization.primary_contact_id` is a sixth way to say it — so a seventh
    boolean called `is_important` would have had nothing to say about what
    distinguishes it from `is_primary`, and two people would have filled them
    in differently within a month.

    The widget ranks the flags that exist (emergency, then primary, then
    authorised) and caps the list. No migration, and it is correct the moment
    somebody fills in what they already had rather than on the day they learn
    a new checkbox exists. The client page's full contacts table is unchanged
    and still carries its Primary and Emergency badges.

36. **The in-app inbox is a table, and it points inwards (L).** 0110, 0420 and
    0690 built three notification queues and every one of them points
    outwards: a `webhook_delivery` row belongs to a destination, a
    `task_reminder` row is a message about to be sent. None can express "this
    person has not seen this", which is the whole of what a bell is — so
    `user_notification` exists, with `read_at`, and is the one notification
    table addressed to a person.

    Two sources, mirroring the outbound queue's two: the audit fan-out for
    oversight events, and a trigger on `task_reminder` for assigned work. A
    trigger rather than two call sites, so a third writer added later cannot
    forget. Written only by `SECURITY DEFINER` functions; `helm_app` holds
    `SELECT`, `DELETE`, and `UPDATE` on **`read_at` alone** — a column grant,
    because RLS cannot restrict a column and rewriting the subject of a
    notification about an export would be putting words in Helm's mouth.

    **No `audit:read` carve-out at all**, unlike `task_reminder`, which has one
    for a tenant-wide seat. What somebody has and has not read is a record of
    their attention; the oversight material itself is in the audit log, where
    anybody holding the permission can read it without reading somebody's
    unread count.

37. **The oversight kinds default off, and the task kinds stay on (L).** 0690
    shipped two kinds, both on when no preference row exists. 0700 adds four —
    `export_activity`, `credential_access`, `expiring_soon`, `operations` — and
    they default OFF, so `DEFAULT_NOTIFICATION_KINDS` is no longer "all of
    them".

    Being given work and a deadline is something to tell somebody without being
    asked. A feed of every export in the business is a subscription. And the
    practical half: defaulting them on would have meant **emailing every
    administrator about every export the moment 0700 applied**, because one
    preference set governs both channels — which is itself the decision, since
    honouring a preference in one channel and not the other is a half-measure
    somebody has to discover for themselves.

    One consequence worth stating: the bell is quiet on a fresh install until
    somebody opts in, so both empty states say *which* empty it is rather than
    letting "nothing here" read as neglect.

38. **Four of the header's five icons were removed rather than wired (L).**
    Documentation and Help both opened `/settings`, Assistant opened `/search`,
    and Recently viewed opened `/dashboard`. An icon that lies is worse than an
    absent one: somebody clicks it, lands somewhere unrelated, and learns to
    distrust the row.

    Recently viewed became the real popover — the component already existed.
    Documentation and Assistant are **gone**, because neither exists to wire and
    an icon promising a feature nobody is building is the same problem with an
    extra step.

    Help is gone too, and that one is a narrowing of what was asked for, so the
    reasoning is here rather than in a commit message. It was a second copy of
    the floating Support badge — same `LifeBuoy` icon, same `/settings`
    destination — and the badge's own comment calls itself the route to a human.
    A panel in its place would have had to carry either the deployment's version
    or a keyboard-shortcut list: there are no keyboard shortcuts beyond
    Escape-to-dismiss, and `src/app/api/health/route.ts` says in as many words
    that version numbers are reconnaissance and deliberately withholds one. So
    the panel would have been inventing content or quietly reversing a stated
    decision. The Support badge stays, so no route to help was lost.

39. **Global collects what exists and does not invent a cross-client asset list
    (L).** The plan's wording mentioned "an assets view"; there is no such page
    — `/assets/[nodeId]` is a single record. A filterable table over every asset
    in the tenant is a group of its own, with its own RLS and scope surface, not
    assembly. The Documentation coverage card answers "what do we have", which
    is what that wording was reaching for, and each card carries the one number
    that tells somebody whether to open it — **counts, never a score**, which is
    decision 20 applied to a menu.


Two further decisions taken at the same time:

- **Checklists (F)** extend SOPs. No parallel tree. `sop`/`sop_version`/
  `sop_step` already model a reusable template and `sop_run`/`sop_run_step`
  model a per-client instance; F adds `assigned_to` and `due_at`. The comment
  in `src/lib/nav/org-categories.ts` saying Helm has no checklist table was
  wrong — the premise, not just the conclusion — and F1 corrected it: the
  tables have existed since 0090 and the application now uses them. What has
  no equivalent is a *recurring* task list, which needs K's job channel.
- **Sidebar customization (D)** mirrors `user_dashboard.widgets`, including the
  catalogue/validator agreement test.
