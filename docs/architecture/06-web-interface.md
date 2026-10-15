# Lake Effect Helm — Web Interface

Next.js App Router, Tailwind CSS v4 and a shadcn/ui-shaped component layer.
Every page is a server component rendering inside one authenticated shell; the
few client components exist for specific reasons, each given below.

---

## 1. Where data comes from

Server components call the service layer **directly**, in the same process, not
over HTTP to Helm's own API. There is no second hop, no serialisation round
trip, and — the point that matters — no second authorisation path: a page opens
`withTenant()` exactly as a route handler does, and RLS decides what it sees.

The consequence is that there are no "is this user allowed" branches in the
pages. A client's co-managed read-only user and an MSP super admin run the same
query on the dashboard and get different numbers, because the policies differ,
not because the code does. The branch that checks a role in the UI is the branch
that eventually gets the condition backwards.

Navigation *is* filtered by role, and that is a courtesy rather than a control:
typing the URL of a hidden page produces an empty result or a database refusal,
never a leak. It exists so a read-only client user is not shown five links that
all say "not permitted".

---

## 2. Identity, and the tenant switcher

`getServerIdentity()` is the render-path equivalent of `resolveIdentity()`. It
resolves the session user, lists their memberships through
`helm.memberships_for_user()`, and picks the active tenant.

The selection differs from the API in one way. The API takes `X-Helm-Tenant`
because an API client sends headers; a browser navigating between pages sends
cookies, so the switcher writes one. That cookie is a client-controlled value,
which is fine: it is only ever a *request* for a tenant. The request is checked
against the user's memberships here, and checked again by
`helm.set_session_context()` from the membership row. Setting it by hand to
another MSP's id produces the same result as not setting it at all.

An unrecognised cookie — stale from a revoked membership — falls back to the
first membership rather than erroring. The API is stricter, because a wrong
tenant in an API call is a bug worth surfacing; in a browser it is a person
whose access changed.

**The switcher switches MSP tenants, not client organisations.** A technician at
one MSP has one tenant and never sees it open. Client organisations are
navigated to *within* a tenant, because they are data, not an identity boundary
— conflating the two would imply that "switch to Acme" restricts what you can
see, when in fact the organisation scope on your membership did that at sign-in.

Two ways of arriving without access are told apart:
`NotAuthenticatedError` offers a sign-in, `NoMembershipError` says plainly that
signing in again will not help. A former employee whose account still exists
will otherwise loop through a login that keeps succeeding.

---

## 3. Secret material never reaches a server component

`RevealButton` is a client component that fetches from the API, and that is not
a stylistic choice. A server component rendering the plaintext would put it in
the RSC payload, in Next's data cache, in any reverse proxy between the server
and the browser, and in the browser's back-forward cache. Fetching it into a
client component keeps the plaintext in one tab's memory, tied to the click that
asked for it and to the audit row the database wrote in the same transaction.

Three further behaviours:

- **It auto-hides** after 45 seconds and drops the value from state, so a
  technician who walks away from a screen-shared session does not leave a domain
  admin password on it.
- **Copy is a separate audited call**, not a local clipboard write of a value
  already on screen. "Was it copied" is a different question from "was it looked
  at" — one of them means it probably left the building.
- **A refusal renders its cause and its audit event id.** When a technician says
  "it says I can't see this", support answers with one audit lookup instead of a
  log trawl.

`[data-secret]` elements are hidden in print stylesheets. A revealed password on
a printed page is the filing-cabinet problem the vault was supposed to remove.

---

## 4. The export flow

The exports page is where the cost of an export is made visible. A requester
fills in the form — the credentials checkbox is labelled with its consequence
rather than left as an unexplained toggle — and the job appears in the history
as `queued`, renderable straight away.

**There is no approve control, deliberately.** `0400` removed two-person
approval; one account with `secret:export` is now sufficient. Since nothing
stops the export, the page is built to make it *seen* instead: the dashboard
carries a fixed banner counting credential exports produced in the last seven
days, the request form says plainly that each credential is audited
individually, and every job on the page names its requester, its reason and its
download count. Revocation stays available to a senior reviewer, so an export
that should not have happened can still be pulled back before it is fetched.

None of the UI state is the control. The database refuses self-approval,
re-approval, approval by a machine identity, and rendering a job whose scope
changed after review. The buttons only stop a person clicking something certain
to fail.

Download is a `fetch` rather than a plain anchor so the response headers can be
read: the server returns the bundle's SHA-256, which is shown to the person so
they can verify the file survived whatever channel they hand it over on.

---

## 5. Pages

| Route | What it answers |
| --- | --- |
| `/dashboard` | What needs attention today, across every client. Two banners only — expired items and exports awaiting approval — because a dashboard that surfaces eight kinds of warning trains people to scroll past all of them. |
| `/organizations` | Every client, with counts from independently RLS-scoped subqueries rather than a join that would fan out. |
| `/organizations/:id` | One client: five widgets, then sites, contacts, expiring items, credentials with reveal controls, assets and documents. |
| `/assets/:nodeId` | One asset, its type-specific detail, its **dependencies**, and its credentials. The dependency list is why this page exists: "what breaks if I take this offline" is answered by the graph, not by a description field somebody wrote in 2021. A flexible asset record renders here too, against the schema version it is pinned to — see *Filling in an asset type* — and a procedure gets its step editor, its published versions and the control that starts a run, see *Writing a procedure, and following one*. A domain or a certificate also carries the card that reports what the registry or the server last said, beside what somebody recorded — see *What the outside world says*. |
| `/runs/:runId` | One checklist run: its steps, where it got to, who each one belongs to and when it is due. Deliberately not under `/organizations/:id` — a run belongs to the person working through it as much as to the client it is for, which is where My Tasks links. |
| `/tasks` | My Tasks: checklist steps assigned to the reader, soonest first, defaulting to the incomplete ones. The first page in Helm that is about a PERSON rather than a client, and the only one where "mine" is a filter — resolved in SQL against `helm.current_actor_id()`, so there is no id in the URL to edit. |
| `/expirations` | Certificates, domains, warranties, licences and contracts in one list, filtered by a severity that is computed at read time. |
| `/coverage` | Every client against every kind of documentation: counts per cell, a dash where there is nothing. The one page in Helm whose value is the empty cells — so a gap is styled to be found and a count is quiet. Shows **coverage**, never "completeness": Helm sees what was documented, not what exists. |
| `/search` | A plain GET form, not live filtering — a keystroke-per-request design puts a partial hostname on the wire and in the server log on every character. |
| `/exports` | The export ledger. Readable by anyone who may create an export, so "who exported this client's credentials, and when" needs no administrator. There is no approval queue: `0400` removed two-person approval (see above). |
| `/audit` | The trail, and the chain-integrity panel most audit UIs omit: `chain_seq` minus `anchored_seq` is how much history is currently protected only by the database. |
| `/settings` | Key custody, integration health, and what each background worker may decrypt. Worker **authorisation** is not editable and never will be — it is fixed by trigger, because a UI that can widen the sync worker's purposes is a UI that can hand it the vault. Two things on this page are editable and neither is an authorisation: whether Helm may reach **outward** at all (*Turning on outbound checks*), and where the line falls between current and stale documentation (*What has gone quiet*). |
| `/settings/asset-types` | The tenant's own documentation types. The flexible-asset engine has been complete and versioned since 0080; this is the screen it never had, so a type no longer arrives only by API call or by SQL. |

### Defining an asset type

`/settings/asset-types` edits a **field list**, not JSON Schema. The conversion
in both directions lives in `src/lib/flexible/fields.ts` and is unit-tested
against the real `schema-guard.ts`, so the screen holds no opinion about JSON
Schema at all — and in particular cannot emit a `pattern`, which is the one
thing a hand-authored schema can contain that takes the event loop down for
every tenant. Ajv has `addFormats()` registered, so date, uri and email are
real validation in a library instead.

Both conversion directions are required, not symmetrical for neatness. A
published version is immutable by trigger, so editing a type means publishing
version N+1 — which means loading the stored schema back into a field list
first. A lossy load would make "change one field" silently rewrite the other
eleven.

**Publishing is not saving.** The dialog names the version it will create and
how many records exist, because with no records a new version is a correction
and with four hundred it is four hundred rows somebody has to look at.
`flexible_asset_record.needs_migration` is written from a schema comparison
(`lib/flexible/compatibility.ts`): if the new schema cannot reject a document
the old one accepted, nothing is flagged. A record's `type_version_id` is not
moved, because it records which schema the data was written against — and
0240's indexing trigger reads that version's `searchable_fields`.

### Filling in an asset type

`FlexibleRecordForm` is generated from `schemaToFields()` over the type's
current published version, so the two screens share one field model and there
is no second place a field's kind, label or help text is decided. It is the
`+ New` button on a type's page and the "Edit fields" control on a record's own
page; those are the same component in two modes.

`toDocument()` is the only logic the form adds, and it exists because Ajv runs
with `coerceTypes: false` while an HTML input produces nothing but strings.
Three rules, each with a failure mode behind it: a blank optional field is
**omitted** rather than sent as `""` (an empty string fails `format: 'email'`
and `format: 'date'`, so sending it reports "not a valid address" for a box
nobody was required to fill in); a blank **secret** is omitted because blank
means *unchanged*; a boolean is **always** sent, because omitting `false` makes
"no" and "unanswered" the same document.

**Validation errors are the server's.** The record routes return
`details.fields` as JSON Pointers, and the form renders each message against
the control it names. There is no second validator in the browser — `required`
is marked for the browser's own benefit and the schema remains the authority.

**Reading uses the pinned version; editing uses the current one.** The pinned
schema is the one with a label for every key actually in `data`, so rendering
against it cannot drop a field the template removed since. A save is checked
against the current version, so a successful edit moves `type_version_id`
forward and clears `needs_migration` — which is what makes that flag
actionable rather than permanent. A field the new version no longer declares
disappears from the form, so the save stops sending it, which is what
`additionalProperties: false` requires.

**A secret field's box is always blank.** Its value lives in
`flexible_asset_secret` and never reaches a browser. `PATCH` reads the record's
existing secret rows and treats them as satisfying `required`, so editing a
hostname does not demand the password beside it; a value typed into the box
rotates the stored secret through the audited path, leaving the previous
version readable. A record's secret fields are listed in the Credentials card
with the same reveal control a credential's password gets — and that query
joins through `flexible_asset_type`, which is tenant-scoped and not
organisation-scoped (0200), so a client-side role is shown nothing from it. The
secret's label is `"<template> — <field>"`, so without that join the page would
name a template the reader's role may not read.

### Writing a procedure, and following one

A procedure is an `asset_node` of type `sop`, so it lives on `/assets/:nodeId`
like every other asset — but its substance is an ordered list of steps, and that
list is a card rather than a detail field.

**Three tables and one rule.** `sop_step` is the living definition, editable at
any time. `sop_version` is an immutable published snapshot of it, append-only by
trigger. `sop_run_step` holds a run's steps **copied by value** from a version's
snapshot. The rule that connects them is 0090's: *"a run snapshots the SOP
version it executed against. Pointing a run at a living, editable document would
let today's edit rewrite yesterday's evidence."* So editing a template never
changes a run that is already open, and starting a run uses the published text
even when the draft on screen says something else — which is why the card says
so, in those words, beside the Start control.

**Publishing is not saving**, the same distinction the asset-type screens make
one layer up, for the same reason and with the same consequence: correcting a
published version means publishing the next one, because the row cannot be
revised.

**The step list is replaced, not patched.** `sop_step_position_uk` is
`UNIQUE (sop_id, position)` and not DEFERRABLE, so an UPDATE that shuffles
positions can collide partway through a statement depending on the order rows
are visited — a defect that shows up only on reorder and only sometimes.
Deleting the list and inserting it back has no such window, and nothing
references `sop_step.id`, so the replace cannot orphan anything.

**A run drives three statuses** — pending, done, skipped — out of the seven
`sop_step_status` holds. The other four each want behaviour nothing has built
yet; the enum keeps them and the page offers no control for them.

### Being given a step

A run step can belong to somebody and be due at a time, which turns a checklist
into work that can be handed out.

**The assignee is a membership, not a user.** Every other person column in the
schema records who DID something, so a plain `app_user` reference is right for
them. An assignee is a claim about the future, and a step assigned to somebody
with no membership in this tenant is work nobody will ever see — My Tasks reads
through RLS and RLS starts from the tenant. So the constraint is composite
against `membership (tenant_id, user_id)`, and the row is unrepresentable rather
than merely refused. The route adds the one thing a key cannot ask about,
`status = 'active'`: a revoked colleague can still hold a task, because the work
exists and somebody must take it over, but nobody can be handed a new one.

**`/tasks` defaults to incomplete and mine**, because a list that opens on
everything ever assigned is a list nobody reads twice. Each filter is a link
rather than a control, so a view can be bookmarked and sent to somebody. "Mine"
is compared against `helm.current_actor_id()` in SQL, so it cannot be made to
mean somebody else by editing a URL.

**A pending step on an abandoned run is not a task.** Abandoning a run leaves
its steps alone — how far it got is the point — so a query that asked only about
step status would offer them forever.

**Overdue is computed in the database**, not in the component. A date compared
to `Date.now()` during render answers one way on the server and another in the
browser, which is a hydration mismatch, and the dashboard count needs the same
answer. One predicate, three readers.

**The due date crosses the browser boundary twice**, and that is where a
deadline can drift. `<input type="datetime-local">` holds local wall clock with
no zone; the column is a timestamptz. `toDateTimeLocalInput` and
`fromDateTimeLocalInput` in `lib/ui/format.ts` are the pair, built from the
local getters rather than by slicing `toISOString()` — slicing puts UTC into a
field the browser reads as local, so every open-and-save would push the deadline
by the offset. They are unit-tested as a round trip under a forced non-UTC time
zone, because in UTC the correct conversion and the broken one are identical.

### Your own account

`/account` holds what is yours rather than the tenant's: the password, the
sessions, and since group E the name halves, a time zone and a default theme.
All four of the latter live on `app_user` because they are per-PERSON, not
per-tenant — unlike the dashboard and drawer layouts, which are keyed
`(tenant_id, user_id)` because what they hold is per-tenant.

`PATCH /api/account` writes them in **one scoped UPDATE**, not through a
SECURITY DEFINER function. `app_user` holds no credential material — that is
`local_credential` — and `helm_app` may read and write it under RLS, so the
route's `WHERE id = <actor>` plus `app_user_rls_update` are two locks where a
definer function running as `postgres` would be one. The predicate is not
redundant: that policy is `id = current_actor_id() OR has_permission('user:write')`,
because an administrator edits colleagues from the People page.

**The display name is composed, not competing.** `name` stays the display
column so nothing that selects it changes, and a trigger derives it from the
halves on any save that includes them. The form shows the box as read-only when
the halves are set, because a third independently-typed answer would be one the
trigger silently discards. With both halves empty the box is editable, which is
the case for a mononym and for cleaning up what a directory import produced.

**The theme has two homes and one precedence rule:** this browser's explicit
choice (`localStorage`, via the shell's toggle), then the account default
(`app_user.theme`), then `prefers-color-scheme`. That is the same precedence
`globals.css` already uses between an explicit choice and the system — one chain
with three links. `ThemeSync` is a second pre-paint inline script that applies
the account value only when the first set nothing, and never writes
`localStorage`: doing so would make the default a permanent local override and a
later change would never reach that browser.

**Time zones do not relax the UTC rule.** A shared fact — an expiry, a rotation
due date, an audit timestamp — stays UTC-suffixed and unconverted, because
"expires 2026-03-01" meaning three different instants is how a certificate
lapses on a Sunday. `formatDateTimeLocal()` is for the other case the format
module's header already names: a timestamp whose subject is the reader, which
today means their own sessions.

**Two preferences are deliberately not stored.** "Enable side panel" has no
panel to switch, and a one-time MFA recovery token would bypass a check the
sign-in path does not perform. Both appear as *Deferred* in the parity table
rather than silently absent; decision 15 has the reasoning.

### Arranging the drawer

The organization drawer's primary list is a per-user layout, not a hardcoded
split. `src/lib/nav/sidebar-layout.ts` owns the model: the categories somebody
names are the primary section in their order, and `splitSidebar()` sends
everything else to "More" — *everything*, so a category removed from the drawer
is hidden from the first glance rather than taken away.

`secondary` in the category registry still decides the DEFAULT, which is why a
person who has never opened the control sees exactly the drawer they saw before.
Three levels resolve a layout: the person's own row in `user_sidebar`, then
`tenant_sidebar_default`, then the code. A MISSING row falls through; an EMPTY
one does not, because somebody who wants nothing but "More" has said so.

The control is one component in two scopes — "Customise sidebar" at the foot of
the drawer writes `user_sidebar`, and the Default sidebar card in Settings writes
`tenant_sidebar_default` for anybody holding `tenant:write`. It is a Modal rather
than the dashboard's popover for a plain reason: it opens from a 15rem drawer
that narrows to 3.5rem, where a 20rem panel has nowhere to go.

Both tables are validated by `helm.sidebar_layout_valid()`, which mirrors the
registry — see db/sql/0620, and `tests/integration/sidebar.test.ts` for the test
that fails when the two lists drift. `tenant_sidebar_default` is readable by
every role in the tenant and writable only with `tenant:write`: the generic
tenant-scoped read predicate is `is_tenant_wide()`, which would have hidden the
default from the client-side roles whose drawer renders from it.

### What has gone quiet, and what nobody opens

A ring on the client page, and it holds **counts rather than a score**. IT Glue
puts a percentage in the middle of this; decision 20 is why Helm does not. Helm
can see what has been documented and not what EXISTS, so a blended "68% healthy"
is an invented weighting wearing a judgement's clothes — it starts an argument,
where "11 of 34 records have not been revised since they were created" starts a
morning's work. The middle of the ring holds the number that needs attention and
the legend holds three sentences, each either true or false of this client:

| segment | what it says |
| --- | --- |
| revised recently | edited inside the tenant's window |
| not revised lately | edited, but longer ago than the window |
| never revised | created before the window and never edited since |

Each count links through to the records behind it, because G's lesson applies
here too: a number nobody can reach behind is a number people stop believing.

**The card checks the arithmetic before it draws.** The three counts come back
from three independent SQL `FILTER` clauses, and "they partition the total" is
exactly the kind of property that is true when written and false after somebody
edits one. If it ever fails, the card renders the numbers and hides the chart
and says so — a ring with a gap in it would be read as a fourth category that
does not exist.

**"Nobody has opened it" sits beside the ring, not in it.** Stale means the
documentation may be wrong; unopened means nobody needs it. The first is a
correction and the second a retirement, and averaging them into one arc loses
both. It is also the newer number — nothing recorded views before 0680 — so on a
freshly upgraded install the card says that rather than letting "everything is
unopened" read as neglect.

**Helm records when a record was opened and never by whom**, which the settings
copy says out loud. `node_view_stat` has no actor column, so the privacy
property is structural: there is nowhere to write a name. See §9a of the
data-model document for why that table exists at all rather than a column on
`asset_node` — the short version is that a `BEFORE UPDATE` trigger made every
read look like a revision.

The windows live on `/settings` behind `tenant:write`, two of them, and the form
says that moving either changes what every client reads as at once.

### A logo somebody can upload

`organization.logo_url` has existed since 0010 and nothing could fill it except
by pasting a URL. Both sources now exist and **an upload wins** —
`src/lib/ui/logo.ts` is the one place that decides, because the clients list,
the client page and the recents strip all render `ClientAvatar` and a precedence
rule written out three times is wrong in one of them.

The control sits in the client page header rather than in a settings panel,
because that is where somebody notices the logo is missing. A read-only role
sees the avatar and no buttons: a client should still see their own logo.

**The preview is the stored image, not a local object URL.** A `FileReader`
preview shows what the browser read, which is not necessarily what the server
accepted — it sniffs the bytes and may store a different content type than the
browser claimed, and it refuses anything that is not PNG, JPEG, WebP or GIF. So
the upload completes, the route revalidates, and what appears is what is being
served. A `?v=` counter defeats the cache exactly once after a replacement,
since the URL does not change when the bytes do.

**An SVG is refused, and the form says why** rather than listing four formats
with no reason: served from this origin an SVG could run script with the
reader's session.

Served under an **ETag** that is the sha256 of the plaintext, cached `private`
with `must-revalidate`. The clients list renders one logo per row, so a second
page load costs one conditional request each and no bytes; `private` because a
shared cache holding these would serve one tenant's client logo to another
tenant's reader, which is a cross-tenant disclosure arranged by a header.

### Turning on outbound checks

The one editable thing on `/settings`, and the only switch in Helm that decides
whether network traffic leaves the building. It is off until somebody turns it
on, per tenant, and the modal says plainly what goes out when they do: the
domain names being looked up, to the RDAP endpoint named in the form, and a TLS
connection to each certificate's common name.

**The endpoint is in the form, not in the code.** A default (`https://rdap.org`,
a redirector) is offered because most installs want one, and it is a value on
the tenant's row rather than a constant in the worker — so an MSP running their
own RDAP mirror can point at it, and anybody can see where their clients' names
are being sent. It must be https: refused with a message naming the field,
never upgraded for them, because a silently rewritten URL sends the request
somewhere nobody chose.

Gated on `tenant:write`, which in the shipped catalogue is `super_admin` alone.
The route's gate and the table's RLS policies name the same permission, so they
cannot come to disagree — the same construction the tenant sidebar default
uses, for a stronger reason here. Reading the setting is open to every role,
because the card below needs it to tell "switched off" from "nobody has
answered".

The form re-seeds its draft when the dialog **opens**, not on mount: C2's lesson
about a modal that silently keeps an old draft after somebody saves elsewhere.

### What the outside world says

On a domain or a certificate, a card above Dependencies reporting what the
registry or the server last told us — beside what a person recorded, never over
it. `domain.registry_expires_at` sits next to `domain.expires_at` and
`ssl_certificate.observed_not_after` next to `not_after`, and when the two
differ by more than a day the card says so in its own line, with both dates.

**The disagreement is the point of the feature.** Reconciling it automatically
would mean choosing — overwrite what somebody typed, or ignore what the registry
says — and the useful answer is neither: "you recorded March, the registry says
January" is a sentence a technician can act on in a minute. A day of tolerance,
because a recorded expiry is usually a date somebody typed and the registry's is
a timestamp; without it the card would cry wolf on every correctly documented
domain.

**It also says which date the alerts follow,** because they follow the recorded
one. `v_expiration_dashboard` projects the hand-entered column and H left that
alone deliberately, rather than re-pointing every install's expiry warnings the
moment an administrator ticked a box. A reader looking at two dates needs to
know which one the dashboard is counting, and telling them beats being quietly
clever.

**"Never checked" has two meanings and the card distinguishes them.** Never
checked because nobody turned checking on is a setting; never checked because
the registry will not answer is a fault. So `enabled` is passed in and the
sentence changes — and a third status, `unsupported`, covers a ccTLD that
publishes no expiry event at all, rendered as "Not available" with a note that
it will not be retried differently. A card that showed all three in red would
teach people to ignore red.

The five probe columns are **absent from the generic detail list** on the same
page. They are rendered here as prose, and leaving them in the humanised
key/value list as well would say everything twice and badly —
`next_check_at` worst of all, since when a worker will get round to something is
nobody's business on an asset page.

### The client page's widgets

Five cards sit above the sections on `/organizations/:id`: credential strength
in four buckets, most-used credentials, what you looked at in this client,
recently updated, and the client's slice of the audit trail. They are in
`src/components/client-widgets.tsx` and they follow the dashboard's rule —
**no widget queries.** The server component fetches, the widget renders. Two of
the five are computed from rows the credentials list had already fetched, so
they cost no query at all and cannot disagree with the table beneath them.

Two things about them are worth stating here rather than only in the code.

**"Recently updated" and "Activity" read different sources and neither
substitutes for the other.** Helm audits security-relevant events — reveals,
rotations, exports, refusals — and does not audit ordinary field edits. Those
move `updated_at`/`updated_by` instead. So a rotation shows up in Activity and
not in Recently updated (it touches `secret`, not the credential's
`asset_node`), and a corrected hostname shows up in Recently updated and not
in Activity. Each card carries a footer line saying so, because a reader who
expects one list to contain everything will conclude an edit was lost.

**Reveal counts are gated on `secret:reveal`, in the page rather than the
card.** `v_secret_metadata.access_count` is not withheld by RLS —
`secret_rls_select` consults org scope and `helm.secret_node_visible()`, not
`secret:read` — so the restriction is a product decision. It is enforced on
the *data*: a server component serialises whatever it hands a child, so a card
that hid the list would still ship every count to the browser of the actor it
was withheld from. The page passes an empty array instead, and the card's
`canSeeAccessCounts` prop only decides which empty state to print.
`secret:reveal` is the gate because it is the permission that produces the
number — every increment is inside `helm.reveal_secret()` — so the count is
answerable only by a role that could have done the revealing.

**An empty audit feed says *which* kind of empty it is.** `audit_log`'s policy
requires `audit:read`, so an actor without it receives zero rows from a query
that succeeded. The page passes `session.permissions.includes('audit:read')`
to the widget, which then distinguishes "no audited events for this client
yet" from "your role does not include reading the audit log". Returning an
empty list and letting the UI guess is how somebody spends an afternoon
looking for events they are not allowed to see.

---

## 6. Development sign-in

Helm is on-premises, so the first thing an operator does is stand it up against
their own database — before Entra or SAML is configured. Without a way in,
"evaluate Helm" means "first configure enterprise SSO", and the predictable
result is a hand-rolled bypass with none of the guards.

So `HELM_DEV_SESSION_EMAIL` exists, and it is built with its refusal:

- It must be set explicitly. No default, no fallback.
- It **throws** when `NODE_ENV=production` — verified, and it is why the
  production smoke test in this work had to use a real Auth.js session.
- It resolves a real `app_user` row through the auth pool, exactly as the Auth.js
  adapter does. It cannot conjure an identity, and role, scope and permissions
  still come from the membership. It answers "who", and grants nothing.
- It says so on every start-up.

`installSessionResolver()` also stands down when a resolver is already
registered, so a test's fake identity is never silently replaced.

---

## 7. Two defects this work surfaced

**The API never installed the session resolver.** Registration was a side effect
of importing `auth/config.ts`, which only happens when the `/api/auth` route
module loads. A request reaching any other route first found no resolver and
failed with a bare 500. `tenantRoute()` now installs it before resolving
identity.

**`tenantRoute()` JSON-serialised a handler's own `Response`.** The export
download handler builds a `Response` with the bundle bytes; the wrapper passed it
to `json()`, and a `Response` has no enumerable own properties — so the browser
received the two bytes `{}` with a 200 status. Silent, and exactly the shape of
bug that reaches production: the status is right and the body is empty. Both
wrappers now return a handler-built `Response` untouched.

Neither was caught by the integration suite, because both live in the layer
between a route handler and an HTTP client and the suite calls handlers
directly. They were caught by driving the real thing in a browser.

---

## 8. Verification

The production build was driven end to end with Playwright against the live
database:

- Every page renders with real data.
- React hydrates and `RevealButton` decrypts a credential, producing a
  `secret.revealed` audit row with `purpose = view`.
- A requester queues a credential export with no second approver and it is
  immediately renderable; `export_job` records the requester and the reason, and
  `audit_log` carries `export.requested` plus one `secret.revealed` row per
  credential.
- The worker renders it, encrypts it, and writes the passphrase to its sink.
- The bundle downloads in full, and unpacks with that passphrase to a JSON
  document with a null `approvedBy` and a PDF that opens in an independent
  reader.
