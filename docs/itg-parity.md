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
| 1 | Four top-nav scopes | **Partial** | `src/components/shell/top-nav.tsx` has all four. `Personal`→`/account` and `Global`→`/search` are aliases, not sections |
| 1 | Global search in header | **Exists** | `/search`, `src/app/api/search/route.ts` |
| 1 | Recent-items dropdown | **Partial** | Data and API exist (`user_recent_view`, `/api/workspace/recent`); no header dropdown, no per-type icons |
| 1 | Notifications + help icons | **Missing** | `webhook_endpoint` is outbound-only; there is no in-app notification surface |
| 1 | User menu | **Exists** | Top-right account menu |
| 2 | Recents + Favorites strip | **Exists** | `components/client-strip.tsx` — two avatar rows above the table, clients only; the mixed-type dropdown is #1 |
| 2 | Clients table, star, Name, Status | **Exists** | `components/clients-table.tsx`; status shows the real six-stage value, grouped by the filter |
| 2 | **Type** (Client/Prospect/Vendor/…) | **Exists** | `organization.relationship` (0600). Named `relationship`, not `type`, because four `*_type` columns already exist; labelled "Type" in the UI |
| 2 | Sync Status column | **Exists** | Last `integration_sync_run` per client via LATERAL; "Not linked" where no integration is mapped |
| 2 | Result count, sorting, column chooser | **Exists** | The same three shell components, now composed by `clients-table.tsx` alongside `BulkBar` so bulk actions survived |
| 2 | Client logo + initials fallback | **Partial** | `components/client-avatar.tsx` renders `logo_url` with an initials fallback. **Upload is still group I** |
| 3 | Per-client sidebar, collapsible, counts | **Exists** | `shell/sidebar.tsx`, `src/lib/nav/org-categories.ts`, collapse persisted per browser |
| 3 | Core asset entries | **Exists** | 16 categories incl. Domain Tracker, SSL Tracker, Locations, Networks, Passwords. Only "Checklists" absent — see #8 |
| 3 | Apps & Services in sidebar | **Exists** | Tenant's own `flexible_asset_type` rows with their configured icons |
| 3 | "Customize Sidebar" link | **Missing** | See #4 |
| 3 | Quick Notes, inline | **Exists** | `organization.quick_notes`, `components/notes-card.tsx` |
| 3 | Credential Strength + buckets | **Exists** | `components/client-widgets.tsx` — four buckets from `v_secret_metadata.strength_score`, bucketed by `lib/ui/strength.ts`. A `Strength` filter on the Credentials section reaches the rows behind each count |
| 3 | Documentation Health ring | **Missing** | `client_health` widget is a different measure; "not viewed recently"/"stale" needs defining |
| 3 | Recently Viewed By You (this client) | **Exists** | `listRecentInOrganization()`. Assets only — the client's own row is in the history by the time the page renders, so an unfiltered query led with the page you were on |
| 3 | Important Contacts | **Partial** | `contact` + `organization.primary_contact_id`; no "important" flag |
| 3 | Recently Updated (this client) | **Exists** | `listRecentlyUpdated()` — `updated_at`/`updated_by` across assets, sites, contacts and documents. **Not `audit_log`:** the gap analysis said it was, and it is not. See the note below |
| 3 | Popular Credentials | **Exists** | `secret.access_count` + `last_accessed_at`, both incremented inside `helm.reveal_secret()` straight after its `secret.revealed` audit write. A test asserts the count equals the audited reveals |
| 3 | Upcoming Expirations + due tag | **Exists** | "Expiring" section, `expiration` table, `criticality` |
| 3 | Locations | **Exists** | "Sites" section |
| 3 | Activity Feed | **Exists** | `listClientActivity()` on the client page, `organization_id`-scoped. Distinguishes "no activity" from "no `audit:read`" |
| 4 | Customize Your Sidebar | **Missing** | No table, no page. `user_dashboard.widgets` is the precedent to copy |
| 5 | Flexible/custom asset types | **Partial** | **Schema is complete and versioned**: `flexible_asset_type` (icon, colour, client_visible), `flexible_asset_type_version` (json_schema, ui_schema, secret_fields, searchable_fields), `flexible_asset_record`, `flexible_asset_secret`, API `/api/flexible-assets/{types,records}`, render page. **Missing: any UI to define or edit a type.** Today a type arrives by API call or SQL |
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
| **C** | Flexible asset **type authoring UI** — create/edit a type, its fields, icon, colour | none (maybe one for field ordering) | Unblocks the whole documentation model. The engine exists; nobody can drive it |
| **D** | Sidebar customization (per-user + admin default), "Customize Sidebar" link | 0610 | Follows the dashboard pattern; small and self-contained |
| **E** | Profile/preferences: user timezone, theme, side-panel toggle, first/last name, MFA recovery token | 0620 | Mostly additive columns; the theme toggle touches every view, so do it before more views exist |
| **F** | Checklists: `assigned_to` + `due_at` on both step tables, My Tasks under Personal | 0630 | Delivers half of the Personal section by extending SOPs |
| **G** | Global section: completion grid with % badges, per-client completion scores | 0640 (materialised counts, if needed) | Needs C done first so custom types are real; the heaviest query work |
| **H** | Domain/SSL auto-refresh worker job (RDAP + TLS probe), manual entry fallback | 0650 | Outbound network from the worker — needs a decision on egress in an air-gapped install |
| **I** | Documentation Health ring; client logo upload | 0660 | Health needs "stale" and "not viewed recently" defined; logo needs an upload path reusing the documents storage |
| **J** | Personal Credentials vault | 0670 | Last, deliberately — blocked on the three policy questions above |
| **K** | Email channel + notification toggles | 0680 | New outbound dependency (SMTP config, secrets, docs); unlocks #8's reminder and #10's toggles |

Deferred, flagged rather than silently dropped:

- **In-app notifications and help icon (#1)** — needs a notification *store*,
  which is a feature in its own right, not a header icon.
- **Checklist email reminders (#8)** — folded into K, since they cannot work
  before an email channel exists.

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

**Open question for the product owner:** should `secret.revealed`,
`secret.reveal_denied` and `secret.copied` also become visible to a scoped
reader with `audit:read`? It is one line. It is not taken here because it
reverses the preceding decision.

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

Two further decisions taken at the same time:

- **Checklists (F)** extend SOPs. No parallel tree. `sop`/`sop_version`/
  `sop_step` already model a reusable template and `sop_run`/`sop_run_step`
  model a per-client instance; F adds `assigned_to` and `due_at`. The comment
  in `src/lib/nav/org-categories.ts` saying Helm has no checklist table is
  wrong and is corrected as part of F.
- **Sidebar customization (D)** mirrors `user_dashboard.widgets`, including the
  catalogue/validator agreement test.
