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

The exports page is where four eyes becomes visible. A requester fills in the
form — the credentials checkbox is labelled with its consequence rather than
left as an unexplained toggle — and the job appears in the history as `queued`
with no approve control for them. A colleague with `export:approve` sees a
review banner at the top of the same page and confirms, having been told
explicitly that their approval is recorded against their account and is bound to
the scope as it stands.

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
| `/organizations/:id` | One client: sites, contacts, expiring items, credentials with reveal controls, assets. |
| `/assets/:nodeId` | One asset, its type-specific detail, its **dependencies**, and its credentials. The dependency list is why this page exists: "what breaks if I take this offline" is answered by the graph, not by a description field somebody wrote in 2021. |
| `/expirations` | Certificates, domains, warranties, licences and contracts in one list, filtered by a severity that is computed at read time. |
| `/search` | A plain GET form, not live filtering — a keystroke-per-request design puts a partial hostname on the wire and in the server log on every character. |
| `/exports` | The ledger and the approval queue. Readable by anyone who may create an export, so "who exported this client's credentials and who approved it" needs no administrator. |
| `/audit` | The trail, and the chain-integrity panel most audit UIs omit: `chain_seq` minus `anchored_seq` is how much history is currently protected only by the database. |
| `/settings` | Key custody, integration health, and what each background worker may decrypt. Nothing is editable — worker authorisation is fixed by trigger, because a UI that can widen the sync worker's purposes is a UI that can hand it the vault. |

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
- A requester queues a credential export and sees **no** approve control; a
  second person sees the review banner and approves; `export_job` records both
  names and the scope digest.
- The worker renders it, encrypts it, and writes the passphrase to its sink.
- The bundle downloads in full (33,627 bytes), and unpacks with that passphrase
  to a JSON document naming `approvedBy: Second Approver` and a PDF that opens
  in an independent reader.
