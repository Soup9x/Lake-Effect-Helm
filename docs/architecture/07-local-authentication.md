# Lake Effect Helm — Local Authentication

Everything about local passwords in Helm follows from one sentence, so it is
worth putting first:

> **An MSP whose identity provider is down must still be able to reach its
> clients' credentials.**

That is usually the same outage. If Entra is unreachable because Microsoft is
having a bad morning, the mailbox a password-reset email would land in is down
too. Local accounts are not a convenience feature, a migration aid, or a
concession to people who dislike SSO. They are the break-glass path, and every
decision below is what that implies.

---

## 1. What it is not

**Not a second session system.** Local sign-in produces the same `auth_session`
row the Entra adapter produces, read through the same cookie by the same
resolver. Nothing downstream — not the API layer, not RLS, not the audit log —
can tell which door somebody came through, and nothing downstream needs to.
"This technician left, cut their access now" means exactly one thing.

**Not an Auth.js provider.** Auth.js's Credentials provider forces
`strategy: 'jwt'`. Helm deliberately chose database sessions (see
`src/lib/auth/config.ts`) because a JWT cannot be revoked before it expires, and
an MSP revokes access often enough that this is a routine operation rather than
an incident. So local login is implemented *beside* Auth.js rather than inside
it: `helm.create_local_session()` writes the row, and the login route sets the
cookie Auth.js reads.

The alternative — accept JWTs for local sign-in only — would mean revocation
behaved differently depending on which door somebody used, discovered during an
offboarding.

---

## 2. Where the work happens, and why

| | Database | Application |
| --- | --- | --- |
| Hashing and verification | — | ✅ Argon2id |
| Throttle counters and lockout state | ✅ | — |
| Password history retention | ✅ | — |
| Reuse detection | — | ✅ (each hash has its own salt) |
| Reset token single-use | ✅ (`UPDATE … WHERE used_at IS NULL`) | — |
| Policy (length, composition, identity) | — | ✅ |

Hashing is **not** in PostgreSQL, deliberately. Its comparison operators are not
constant-time, a hash passed as a SQL literal lands in `pg_stat_activity` and the
statement log, and `pgcrypto`'s `crypt()` offers nothing stronger than bcrypt.
The database stores an opaque PHC string and never inspects it beyond a shape
check.

Throttling is **not** in Redis, equally deliberately. Redis is optional in this
product precisely so correctness never depends on it, and a rate limit that
silently stops limiting when a cache is unavailable is not a rate limit.

---

## 3. Hashing

Argon2id at `m=65536, t=3, p=1` — 64 MiB, three passes, about 260 ms on a
server core. OWASP's 2024 floor is `m=19456, t=2`; Helm runs above it because
sign-in is not a hot path (a technician signs in a handful of times a day and
the session then lasts eight hours) while offline cracking of an exfiltrated
table *is* the threat model. Memory cost is what makes a GPU or an ASIC a poor
fit, so that is the parameter that got raised most.

The parameters live inside each stored hash:

```
$argon2id$v=19$m=65536,t=3,p=1$<salt>$<digest>
```

which means they can be raised later without a mass reset. `needsRehash()`
compares a stored hash against the current parameters, and a login that finds a
weaker one re-hashes in the background — the plaintext is in hand exactly once,
at that moment. Anything unparseable returns `true`: "I cannot tell how strong
this is" should upgrade, not leave it alone.

### The dummy verify

An address with no account still costs a full Argon2 verification, against a
fixed hash computed lazily at first use.

Without it, "no such user" returns in about a millisecond and "wrong password"
in about 260 — a user-enumeration oracle readable with a stopwatch, over the
internet, on the one login form that still answers during an outage. The
accounts worth enumerating are an MSP's administrators.

`helm.local_login_challenge()` therefore returns a row for *every* address, with
`found = false` and a NULL hash, rather than returning zero rows. Making the
caller do the dummy verify is a design that cannot be accidentally optimised
away by someone adding an early return.

---

## 4. Policy

Twelve characters, not eight. NIST SP 800-63B puts the floor at eight and drops
composition rules, which is right for the general public; a local Helm password
unlocks every credential its holder's role can reach, and the people typing it
are technicians with password managers.

Rejected: anything containing the account's own name or email fragments
(`Dana.Whitfield#2024` is long, mixed-case and the first thing anyone targeting
Dana would try), the last five passwords, leading or trailing whitespace, control
characters, and a short list of the passwords that get typed into a new
deployment on its first day.

**Every problem is reported at once**, not one per attempt. Somebody submitting
six times to discover six rules is already having a bad day.

Reuse is checked by verifying the candidate against each stored PHC in turn —
the salts differ, so no comparison in SQL could do it. That is why the history is
capped at five in the schema: an unbounded history would make every password
change cost an unbounded number of Argon2 verifications, which is a
denial-of-service lever pointed at the server that has to check it.

---

## 5. Rate limiting and lockout

Two mechanisms with two different jobs.

**Lockout** is per account and imposes a wait: five wrong passwords → one
minute, doubling, capped at fifteen. It never becomes permanent.

**Rate limiting** is per account *and* per source address — ten and thirty
genuine failures in fifteen minutes — and stops Helm answering at all. The
address limit is what sees a spray across many accounts from one host, which no
per-account counter ever notices.

Three properties that took deliberate work:

**A refusal does not feed the counter that produced it.** Outcomes Helm itself
issued (`locked`, `rate_limited`) are recorded in the ledger but are excluded
from both counters. If they were not, an attacker who kept knocking after being
locked out would hold the window open indefinitely — and behind an office NAT,
one attacker would lock out every technician sharing the address. Only
`bad_password`, `no_such_account` and `disabled` accumulate.

**A throttled attempt costs no Argon2 time.** The challenge and the throttle
state come back from one database call, and the refusal happens before any
hashing. Otherwise the rate limiter becomes a lever for exhausting the server
rather than a defence against one.

**A lockout is escapable without a reset.** An administrator holding
`user:write` can call `helm.clear_local_lockout()` for a member of their own
tenant. During an outage that is considerably faster than issuing a reset code,
and it is the pressure valve that makes a strict lockout acceptable on a
break-glass account.

### The residual risk, stated

Anyone who knows an administrator's address can submit one wrong password every
fifteen minutes and keep that account locked. This is inherent to lockout
schemes and is bounded here: fifteen minutes maximum, an administrator can clear
it, and SSO is unaffected. The alternative — no lockout — is worse.

---

## 6. Reset

**The administrator-issued path is primary.** An administrator with `user:write`
issues a code for a member of their own tenant and the application shows it to
them once; they read it down the phone. No mail server, no dependency on
anything outside the host. This works during the outage.

**Self-service by email is the addition.** With `HELM_RESET_DELIVERY_URL` unset,
the endpoint *refuses* rather than accepting the request and dropping the mail.
A form that says "check your email" when nothing was sent produces a support call
and somebody who believes they are locked out permanently.

Properties:

* **Single-use is the database's guarantee**, not a check-then-act in the
  application: `UPDATE password_reset SET used_at = now() WHERE … AND used_at IS
  NULL`. Two simultaneous redemptions produce one winner.
* **The password is validated before the token is spent.** The obvious order —
  redeem, then check the new password — means somebody who mistypes it has
  burned the code *and*, because redemption deletes every session on the
  account, has been signed out of the one they were holding. A person locked out
  with a spent reset code during an outage is the exact failure this feature
  exists to prevent. `helm.peek_password_reset()` resolves whose token it is
  without consuming it; policy, reuse and hashing all happen first. A token
  peeked and then spent by somebody else in between fails at the redeem, which
  is correct.
* **Tokens are stored as SHA-256**, not Argon2. The token is 32 bytes of CSPRNG
  output — there is no dictionary to attack, and a slow hash would only make
  redemption a denial-of-service lever. (Same reasoning as API tokens; the
  opposite of the right answer for passwords, for the opposite reason.)
* **Issuing a second token invalidates the first.** "Request five resets and use
  the first one" does not work.
* **Changing the password by any other route invalidates outstanding tokens.** A
  code read down the phone yesterday stops working after today's change.
* **Redeeming deletes every session for that user.** A reset means somebody may
  have had this account; a live session that survives it makes the reset
  cosmetic — a stolen laptop stays signed in.
* **Redeeming does not sign you in.** A reset that handed back a session would
  turn a leaked link into a takeover with no further steps.
* **Failures are indistinguishable.** Expired, already used and never existed all
  return the same message. Distinguishing them tells whoever holds a leaked token
  which of the three it is.

---

## 7. Privilege separation

`local_credential`, `auth_attempt` and `password_reset` are `helm_auth`'s, the
same role that owns the Auth.js tables. A bug anywhere in the request path
cannot read a password hash, mint a reset token, or forge a session.

The interesting part is what `helm_app` *does* get, because the naive answer
("nothing") produces a settings page that cannot show you whether you have a
local password:

* **Column-level `SELECT`** on `local_credential`, excluding `password_phc` and
  `previous_phc`.
* **A row policy** scoped to `user_id = helm.current_actor_id()`, widened to the
  current tenant's members for callers holding `user:read` — which is what the
  administration screen needs before issuing a reset.
* **`v_my_local_credential`** and **`v_local_credential_status`**, both
  `security_invoker`, so the policy above is what scopes them.

### The trap this avoids

`0220_grants.sql` sets `ALTER DEFAULT PRIVILEGES … GRANT SELECT, INSERT, UPDATE,
DELETE ON TABLES TO helm_app` so that a table created by a later migration does
not silently arrive unreachable. That is a good default and exactly wrong here:
it would have handed `helm_app` and `helm_auditor` a `SELECT` on a column of
password hashes. Every table in `0340` opts out explicitly and takes back only
what it needs.

The opposite failure has also bitten this codebase before. A `security_invoker`
view granted to a role that holds no column grant behind it creates cleanly,
grants cleanly, and fails only when somebody opens the page — which is how
`v_secret_metadata` was unusable by `helm_app` for two development steps without
a single test noticing. The guard at the end of `0340` therefore asserts in
*both* directions: that no role but `helm_auth` can reach a hash, and that
`helm_app` *can* read every column its views select.

---

## 8. What is audited, and what is not

| Event | Audit chain | `auth_attempt` |
| --- | --- | --- |
| Password changed | ✅ (when in a tenant context) | — |
| Lockout cleared by an administrator | ✅ | — |
| Step-up completed | ✅ | — |
| Sign-in attempt, any outcome | — | ✅ |
| Reset redeemed or refused | — | ✅ |

`auth_attempt` is a throttling counter, not an audit record. Conflating them
would mean either an unprunable table of sign-in noise or a mutable audit log,
and both are worse. It is pruned hourly to a thirty-day window by
`auth.prune` in the worker: keeping it forever would turn a rate limiter into a
permanent record of every address every person ever signed in from.

The audit chain is per tenant. A password is a deployment-level fact about a
person, not a tenant-level one, which is why a reset redemption — which happens
with no tenant context at all — is recorded in `auth_attempt` only.

---

## 9. Bootstrap

`pnpm helm:bootstrap` sets a local password on the administrator it creates and
prints it once:

```
      admin@northwind.example.com
      quarry-silver-trestle-willow-kettle-51
```

A passphrase rather than a random string, from a 60-word list chosen for
unambiguity, because this one gets read aloud and typed from a terminal into a
browser. Five words plus two digits is roughly 36 bits, which is not enough on
its own — what carries the weight is that it is `must_change`, rate-limited,
locked out after five wrong guesses, and alive only until the administrator
signs in once.

The generator's output is run through `checkPasswordPolicy()` before use. That
is not ceremony: a generator that drifted out of step with the policy would
produce an administrator who cannot sign in, discovered at the worst moment.

---

## 10. Verification

```bash
pnpm test:sql      # §20-21: privilege separation, one session type
pnpm test          # tests/integration/local-auth.test.ts, 38 assertions
```

The integration suite runs against a live PostgreSQL 16 cluster and covers, among
others: that an unknown address and a wrong password take the same wall-clock
time; that twenty attempts against a locked account do not extend the lock; that
a spray across thirty addresses from one host trips the address limit while a
different host is unaffected; that a throttled attempt returns in under 100 ms;
that a reset kills existing sessions and works exactly once; and that `helm_app`
is refused on `password_phc` while still being able to read its own views.
