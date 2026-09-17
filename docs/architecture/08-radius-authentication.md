# Lake Effect Helm — RADIUS Authentication

Helm has three doors: Microsoft Entra (SSO), a local password, and RADIUS. This
document covers the third. It assumes
[`07-local-authentication.md`](07-local-authentication.md), because RADIUS is
layered onto that path rather than beside it.

The reason it exists is narrow and practical. An MSP's technicians already
authenticate against a RADIUS server to reach the firewalls, switches and VPN
concentrators they work on all day — usually with an MFA push attached. Putting
Helm behind the same directory means one set of credentials, one place to
offboard somebody, and one MFA prompt, rather than a password in Helm that
outlives the account it was meant to mirror.

---

## 1. What it does not change

**Not a fourth kind of session.** A RADIUS sign-in produces the same
`auth_session` row the other two produce. The only difference is one column:
`auth_method`, recorded so the account page can say how you got in and so an
incident can be reconstructed. Nothing branches on it.

**Not an account source.** RADIUS authenticates accounts that already exist in
Helm; it does not create them. An address with no Helm account is never sent to
the directory at all — if it were, Helm would be a way for anybody who can reach
the sign-in page to enumerate somebody else's directory. Adding a technician is
still an act on the People page, which is where the role and the organisation
scope get decided, and neither of those is something a RADIUS server knows.

This is the deliberate limitation to be aware of before turning it on: **RADIUS
replaces the password check, not the invitation.**

---

## 2. Graceful degradation is the whole design

The local password exists because the morning the identity provider is down is
the morning the vault is needed. A third door that could block the second one
would defeat that, so the rule is absolute:

> **Anything other than an Access-Accept falls through to the local password.**

A rejection falls through. A timeout falls through. A reply that fails to verify
falls through. An exception from the crypto layer falls through. There is no
configuration in which enabling RADIUS can prevent a break-glass account from
signing in with the password it already had.

What the operator gets instead of a lockout is a record: a failed or unreachable
directory is written to `auth_attempt` as `radius_unavailable`. That outcome is
deliberately **absent** from the throttle's partial indexes, so a server outage
cannot lock out the people it is already failing — while still being visible to
anybody asking "when did we stop using the directory?".

---

## 3. Order of operations

The sequence in `attemptLocalLogin()` is the security property:

1. **Challenge and throttle state**, in one call. There is no arrangement of
   this code that checks a password before the rate limit.
2. **Refuse a throttled or locked attempt** without hashing *and without
   contacting RADIUS*. This ordering is what stops Helm becoming a
   password-spray amplifier pointed at somebody else's directory.
3. **RADIUS**, when the tenant has it configured and the address has an account.
4. **Local password**, on anything but an Access-Accept.
5. **Record the outcome**, including the ones that never reached a password.

Step 3 is gated on the ACCOUNT existing, not on a local credential existing.
Those look interchangeable and are not: `helm.local_login_challenge()` reports
`found` for a local credential, so gating on it confines RADIUS to people who
already have a password in Helm — precisely the set that does not need it. There
is a regression test for this in `tests/integration/radius.test.ts`.

### The honest caveat

The RADIUS round trip happens only for addresses that have an account, so a
deployment with RADIUS enabled leaks account existence through timing. The
signal is a LAN round trip — single-digit milliseconds — against the ~260ms of
Argon2 every attempt pays regardless, so it is small and noisy rather than
absent. Removing it entirely would mean sending decoy packets to somebody else's
RADIUS server on every unknown address, which is a worse thing to do than the
leak it fixes.

---

## 4. The protocol

`src/lib/auth/radius.ts` is a hand-written RFC 2865 client. It was written
rather than depended on: the packet format is a hundred lines, the npm options
are unmaintained or unaudited, and this code sits directly on the authentication
path of a credential vault.

**The Response Authenticator is the whole security model.** RADIUS runs over
UDP, which anybody on the path can forge. What stops a spoofed Access-Accept is
that the server signs its reply:

```
ResponseAuth = MD5(Code | ID | Length | RequestAuth | Attributes | Secret)
```

Only the holder of the shared secret can produce that. A client that skips the
check — and there are several that do, or that check it only on Access-Reject —
accepts an authentication from any host that can get a datagram in first.
`verifyResponse()` is therefore not optional hardening; it is the reason this is
authentication at all. Two tests in `tests/unit/radius.test.ts` exist solely to
prove a forged accept is refused.

Also implemented:

- **Message-Authenticator** (RFC 3579) on every request, and verified on any
  reply that carries one. Modern servers increasingly refuse requests without it.
- **A fresh Request Authenticator per attempt.** Re-sending an identical
  datagram on retry would be the obvious optimisation and is wrong: that value
  is the nonce the User-Password stream cipher is keyed from, and reusing it
  leaks the XOR of the two plaintexts.
- **Retry only on silence.** A rejection is not retried — it cannot change, and
  re-sending looks like an attack.
- **Bounded parsing.** An attribute claiming a length past the end of the packet,
  or a length below 2 (which would not advance the cursor and would hang the
  sign-in path), is refused.

MD5 is not a choice: RFC 2865 specifies it for the authenticators and the
password cipher. RADIUS is therefore only as strong as the shared secret and the
network it runs on, which is why it belongs on a management VLAN and why Helm
refuses a shared secret under 16 characters at configuration time.

---

## 5. Where the shared secret lives

The shared secret authenticates the *server to Helm*. Anyone who can read it can
forge an Access-Accept and sign in as anybody in the directory, so it is
custodially a password hash, not a client credential.

It is **not** in `secret_version` with everything else, and the reason is
structural. It is needed BEFORE anybody is signed in, by the one role that runs
pre-authentication (`helm_auth`), with no tenant context and no actor to
attribute a reveal to. Pushing it through `helm.reveal_secret()` would mean
either inventing a pre-authentication actor or writing an audit row for every
login attempt in the deployment, including the failed ones from a spray.

So `radius_config` carries its own envelope, identical in construction to the
one the vault uses:

| Column | What it is |
| --- | --- |
| `wrapped_dek`, `kek_id`, `wrap_provider` | A DEK wrapped by the master KEK — Vault transit or the on-prem keyfile (see [`03-crypto-operations.md`](03-crypto-operations.md)) |
| `secret_ciphertext`, `secret_nonce`, `secret_tag` | The shared secret under AES-256-GCM |
| `secret_aad` | Binds the ciphertext to this tenant and this field |

The AAD is load-bearing: a row copied from one tenant into another fails to open
rather than authenticating somebody against the wrong directory. There is a test
that copies the row and asserts the failure.

### Who can read it

| Role | `radius_config` |
| --- | --- |
| `helm_auth` | Full — it is the only role on the sign-in path |
| `helm_app` | **Nothing**, on any column |
| `helm_worker`, `helm_auditor`, `helm_key_admin` | Nothing |

`helm_app` writes the secret through `helm.set_radius_config()` — a
SECURITY DEFINER function that takes ciphertext — and cannot read back what it
wrote. The application encrypts, because it holds the KEK provider; the database
has never held it.

This is worth asserting rather than assuming, because `0220_grants.sql` sets
`ALTER DEFAULT PRIVILEGES` granting `helm_app` full DML on tables created by
later migrations. `radius_config` therefore arrived readable and had to be
explicitly revoked. A migration-time guard in `0360` and §23 of
`db/tests/security.sql` both fail loudly if that revocation is ever lost.

---

## 6. Who may configure it

`tenant:write`, which only `super_admin` holds.

`tier3` holds every permission except `organization:delete`, `tenant:write` and
`key:rotate` — so gating on `integration:manage` would have put "change how the
entire MSP signs in" in a senior technician's hands. Changing the authentication
path is a strictly larger act than configuring an integration.

Reading the settings — but never the secret — is open to any tenant-wide role,
because a Tier 3 engineer taking a "why can I not sign in" call needs to know
whether the directory is in the path.

---

## 7. Testing a configuration

Two buttons, because there are two different failures that look identical from a
settings page:

**Test connection** sends an Access-Request for an account that cannot exist.
The expected answer is Access-Reject, and that is a **pass**: a reject is a
signed reply, and only the holder of the shared secret can sign one. What fails
is silence (unreachable, firewalled, or the server does not recognise this NAS
client) or a reply that does not verify (the secret does not match). The
distinction is reported, because "check the secret" and "check the firewall" are
different afternoons.

Note for operators: this produces one failed authentication in the RADIUS
server's log, because that is exactly what it is. On a server with alerting on
failed logins, expect it.

**Test an account** runs real credentials end to end. It is the only way to find
out whether the server's policy actually admits Helm's users, which a rejection
for a nonexistent account cannot tell you.

---

## 8. Sessions

`auth_session` gained four columns in `0360`: `created_at`, `auth_method`, `ip`
and `user_agent`. They exist so the account page can show somebody where they
are signed in and let them end a session.

`helm_app` still cannot touch `auth_session` — §21 of `db/tests/security.sql` —
so the account page reaches it through SECURITY DEFINER functions that resolve
the owner from the session context. None of them takes a user id as an argument;
a definer function that did would be an account-takeover primitive.

Sessions are identified by `helm.session_ref()`: sha256 of the token, hex,
truncated to 32 characters. The page needs a handle to revoke by, and a live
bearer token rendered into HTML is a session anybody reading over a shoulder can
take. `sessionRef()` in `src/lib/auth/session-cookie.ts` computes the same value
in Node so a token never travels as a query parameter; a test runs both and
compares.

`auth_method` defaults to `'sso'` because the Auth.js adapter INSERTs three
columns and knows nothing about the rest. A default naming a password would
mislabel every SSO session in the deployment.

---

## 9. Verification

```bash
pnpm test:sql                              # §23-25: custody, session helpers, who may configure
pnpm vitest run tests/unit/radius.test.ts  # the protocol, against a real UDP server
pnpm vitest run tests/integration/radius.test.ts
```

The unit suite runs against `tests/support/fake-radius.ts`, a genuine RFC 2865
responder on a loopback port — it decodes the User-Password with the shared
secret and signs its reply. Not a mock, because the two things most worth
testing are the password cipher and the reply signature, and those are precisely
what a mock would fake.
