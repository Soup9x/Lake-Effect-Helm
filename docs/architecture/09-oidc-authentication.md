# Lake Effect Helm — Generic OpenID Connect

Helm now has four doors: Microsoft Entra (SSO), a local password, RADIUS, and
any identity provider that speaks OpenID Connect. This document covers the
fourth. It assumes [`07-local-authentication.md`](07-local-authentication.md)
and shares its custody model with
[`08-radius-authentication.md`](08-radius-authentication.md).

The reason it exists is narrow. Entra is hardcoded to one vendor, in the
deployment's environment. An MSP running Authentik or Keycloak — which is most
of the ones that run their own identity — had no door at all, and "add Okta
support, then add Zitadel support" is a treadmill rather than a feature.

---

## 1. Nothing here names a product

Helm stores **four things**: the issuer URL, the client ID, the client secret,
and the scopes. That is the whole of the configuration, because it is the whole
of what the protocol defines as deployment-specific.

Everything else — the authorization endpoint, the token endpoint, the JWKS URI,
which response types are available, whether PKCE is offered — is read at sign-in
time from the issuer's discovery document at
`{issuer}/.well-known/openid-configuration`.

That is the difference between implementing OIDC and implementing support for a
product. A provider that did not exist when this was written works, as long as
it publishes a discovery document.

> The discovery path is appended to the **whole issuer, path included**. A
> Keycloak realm at `https://sso/realms/helm` discovers at
> `https://sso/realms/helm/.well-known/openid-configuration`, not at the host
> root. This is the single most common setup mistake, and the connection test
> names it explicitly when it sees a 404.

---

## 2. Where the client secret lives

Exactly where the RADIUS shared secret lives, for exactly the same reason.

This value is needed **before anybody is signed in**, by the one role that runs
pre-authentication (`helm_auth`), with no tenant context and no actor to
attribute a reveal to. Pushing it through `helm.reveal_secret()` would mean
inventing a pre-auth actor and writing an audit row per login attempt in the
deployment, including the failed ones from a password spray.

So it is enveloped by the same KEK that wraps every tenant DEK: wrapped DEK in
the row, the secret sealed under it with AES-256-GCM, and an AAD binding the
ciphertext to this tenant and this purpose. The DEK's encryption context is
`helm:purpose=oidc-client-secret`, distinct from both the tenant key context and
the RADIUS one, so a wrapped DEK copied between tables fails to unwrap.

`helm_app` — the role that renders every page — **holds no privilege on
`oidc_provider`, by column.** It reaches the non-secret settings through
`helm.oidc_settings()`, whose result type does not contain the envelope columns
at all, and writes the secret through `helm.set_oidc_provider()` without being
able to read back what it wrote. `0410` asserts all of this at migration time
and `db/tests/security.sql` §36 asserts it again against a built database.

Configuring it takes `tenant:write`, which only `super_admin` holds. Changing
how an entire MSP authenticates is a strictly larger act than configuring an
integration, and `integration:manage` reaches down to tier3.

---

## 3. Two settings that are security decisions

Both default to off, and both are written out in full on the settings page
rather than hidden behind an "advanced" disclosure, because both change who can
get in.

### `link_by_email`

May an OIDC identity attach to an **existing** Helm account with the same
address?

Auth.js calls this "dangerous", and it is right to. With it on, anybody who can
set a user's email address in the identity provider can take over the matching
Helm account. With it **off**, a pre-provisioned account can never use this door
at all: the identity has nothing to attach to, and Auth.js raises
`OAuthAccountNotLinked`.

So it is neither safe-by-default nor optional-in-practice. It is a judgement
about how much the deployment trusts its own directory. For an Authentik or
Keycloak the MSP runs itself, it is usually fine; for a consumer IdP it is not.

### `allow_signup`

May a successful sign-in **create** an account for an address Helm has never
seen?

Note what this does and does not mean. A new `app_user` has no membership, and
without a membership it can see nothing at all — no organisation, no asset, no
credential. So this is the difference between an unknown address being turned
away at the door and being given an empty account an administrator must then
grant. It is not the difference between locked and unlocked.

Enforced in the `signIn` callback, which `@auth/core` runs **before** the
adapter creates anything, so a refusal writes no row at all rather than creating
one and tidying it up.

### Both off

Switched on with neither is a real state and is reported rather than refused:
anyone who linked earlier can still sign in, which is a legitimate lockdown. It
is also a dead end for a first-time setup, so the settings page says so.

---

## 4. The provider is built per request

Auth.js normally takes a fixed provider list at construction. Helm's is in the
database, and an administrator adds one while the server is running — so a list
fixed at first use would make "restart the container" a documented step in
adding a sign-in method.

`NextAuth()` accepts a function of the request, so the config is rebuilt per
request, and the provider is resolved only on the paths that need it:

| Path | What is resolved |
| --- | --- |
| `/api/auth/signin/<slug>` | that one provider |
| `/api/auth/callback/<slug>` | the same, coming back |
| `/api/auth/providers` | **all** enabled providers |
| `/api/auth/signin` | all enabled providers |
| anything else | nothing — no query, no DEK unwrap |

That last row matters: `/api/auth/session` is hit on page loads and must not
cost a key operation.

The `/api/auth/providers` row is the one that was learned the hard way. The
first version resolved only from a slug in the path, reasoning correctly that a
session check needs no provider — and missed that the browser's `signIn()` asks
`/api/auth/providers` **first** and posts only to a provider it finds there. The
button fetched a list the provider was absent from and fell back to reloading
the sign-in page. Only a real browser showed it.

### Starting a sign-in is a POST

Related, and also learned by driving a browser:

```
GET  /api/auth/signin?provider=x    the query string is ignored; redirects back
                                    to the custom sign-in page
GET  /api/auth/signin/x             rejected as an unsupported action
POST /api/auth/signin/x + csrf      starts the flow
```

The sign-in page rendered the first of those as an ordinary link for Entra,
which meant the Microsoft button returned the visitor to the page they were
already on. Both buttons now go through `signIn()` from `next-auth/react`, which
performs the CSRF fetch and the POST.

---

## 5. Which door a session came through

`auth_session.auth_method` gained `'oidc'`, separate from `'sso'`. Folding a
self-hosted Keycloak in with Entra would lose exactly the distinction somebody
reading an audit trail during an incident is looking for.

The Auth.js adapter inserts a session with only the three columns it knows
about, so the column would default to `'sso'`. Helm wraps the adapter's
`createSession` and stamps the method afterwards, through
`helm.stamp_session_method()` — `SECURITY DEFINER`, granted to `helm_auth`
alone, because `helm_app` must never reach `auth_session` (§21 of the security
model, asserted in `0220` and again in §36).

A failed stamp never fails the sign-in. The session is already valid; the label
is metadata.

> **A migration note worth reading.** `'oidc'` is added by
> `0405_auth_method_oidc.sql`, a file containing one statement. A new enum value
> cannot be used in the transaction that adds it, and `db/migrate.ts` runs one
> transaction per file — while `scripts/rebuild-test-db.sh` applies each file
> with `psql`, where every statement commits on its own. So a migration that
> added the value and used it would pass every local test and fail during a
> production upgrade. `tests/integration/migrate-guard.test.ts` now runs the
> real migrator over the whole of `db/sql` for this reason.

---

## 6. What the connection test proves

**Proves:** the issuer resolves from this server, TLS verifies against the
container's trust store, the document parses, it really is an OIDC configuration
rather than a plain OAuth 2.0 one, the issuer it declares matches the one that
was typed, and it offers the authorization code flow.

**Does not prove:** that the client ID and secret are correct, or that the
redirect URI is registered. Only a real authorization round-trip shows that, and
a round-trip needs a person at a browser.

The settings page says so on success, in as many words. A green tick that means
less than it appears to is worse than no tick: it moves the discovery of a
broken setup from a settings page to somebody's Monday morning.

The issuer-match check is worth calling out. Pointing at the wrong Keycloak
realm, or at a proxy that rewrites the host, returns a perfectly valid document
for a *different* issuer. Every token it then signs fails verification, with an
error that appears during somebody's first real sign-in rather than here.

---

## 7. The redirect URI

`{origin}/api/auth/callback/{slug}`, computed from the request and **never
stored**. It has to be the URL the callback will actually arrive at, and behind
Caddy that means the forwarded host. A stored copy would drift from reality, and
this is the one value in an OIDC setup whose mismatch produces an error at the
provider rather than anywhere an operator would think to look.

The slug is therefore **immutable once set**, enforced in
`helm.set_oidc_provider()` and again in the API route with a message naming the
remedy. Changing it means removing the provider and configuring it again, which
is the same work the provider side needs anyway.

The settings page shows the exact string with a copy button.

---

## 8. What the public sign-in page may know

A label and a path. `helm.oidc_signin_options()` returns `slug` and
`display_name` and nothing else.

The issuer is withheld even though it is not secret: a public page naming the
deployment's internal identity provider tells an unauthenticated visitor where
to point their next scan.

If the auth pool is unreachable the page logs the failure and renders the local
password form anyway. The morning the database is having a bad day is the
morning somebody needs the break-glass path.

---

## 9. Configuration

**No environment variables.** Everything is in the database, under Settings.

The one environmental value is `NODE_EXTRA_CA_CERTS`, needed when the provider
presents a certificate from a private CA — which on-premises it usually does.
Node reads it at start-up, so it cannot be set by the application. See
[`../deployment/docker-on-prem.md`](../deployment/docker-on-prem.md) §6.1.

Never work around a verification failure by disabling verification. The client
secret travels to the token endpoint that certificate authenticates.

---

## 10. Where it is tested

| File | What it establishes |
| --- | --- |
| `tests/integration/oidc.test.ts` | discovery against a stub issuer that breaks in each real way; custody of the client secret; the AAD binding; who may configure a door |
| `tests/integration/migrate-guard.test.ts` | every migration applies under the real one-transaction-per-file runner |
| `db/tests/security.sql` §36 | the grant boundary, per column, and that `helm_app` still cannot reach `auth_session` |
