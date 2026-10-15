# Lake Effect Helm — Outbound Notifications

`0400` removed two-person approval from credential exports and said, in as many
words, that detection replaces prevention. Detection that lives only in a log
nobody opens is not detection. This is the other half of that change: an export
shows up in a channel somebody reads, within a minute of happening.

---

## 1. This is not a second webhook system

`0110` shipped `webhook_endpoint` and `webhook_delivery`, with retry fields, a
dedupe constraint and a trigger that refuses secret-bearing payloads. **Nothing
was ever wired to them** — no route inserted a delivery, no worker drained one.
They were scaffolding, mirrored in Drizzle and otherwise dead.

The first attempt at `0420` created a `webhook_destination` table alongside
them. That would have left two webhook systems in the schema, one live and one
dead, which is exactly the stale-configuration problem this project has had to
clean up twice. So the existing tables were brought up to the job instead.

`0690` added a second **transport** to the same tables rather than a second
mechanism, for the same reason: a `transport` column with a delivery branch and
no way to create such a row would be this section's mistake with a better
comment. §10 has it.

Three things about them were wrong, and are corrected rather than worked around:

| Was | Now | Why it mattered |
| --- | --- | --- |
| `url text NOT NULL`, plaintext | enveloped, with `url_host` and a 12-hex `url_digest` for display | For Discord and Teams the URL **is** the credential. It sat in a table any tenant-wide role of rank 60+ could read. |
| `signing_secret_id` → the credential vault | inside the same envelope | Reading it needed `helm.reveal_secret()`, which needs an actor and writes an audit row — one per webhook delivery, in a system about to deliver a webhook per audit row. |
| one payload shape | `format` per destination | The `0110` comment claimed one `{ text }` body covered "Slack, Teams and anything with an inbound URL". Two-thirds right. |

---

## 2. Discord was never working

Slack accepts a bare `text`. The legacy Office 365 Teams connector accepted one
too. **Discord refuses it with a 400** — it wants `content` or `embeds` — and a
400 from a chat platform looks exactly like a bad URL.

`src/lib/notifications/format.ts` builds four shapes:

- **generic** — Helm's own flat JSON. This is the one somebody writes a receiver
  against, so the shape is a contract rather than a convenience.
- **slack** — `{ text, attachments }`. The whole sentence goes in `text`,
  because that is the notification preview.
- **discord** — `content` **and** `embeds`. Content alone is unreadable in a
  channel; an embed alone produces a push notification saying only "Lake Effect
  Helm sent a message". Discord's 25-field and 1024-character embed limits are
  enforced in code — exceeding either is a 400.
- **teams** — an Adaptive Card inside `{ type: 'message', attachments: [...] }`,
  which is what Power Automate **Workflows** accepts. The `@type: MessageCard`
  format is deliberately not emitted: those connectors are retired, and
  defaulting to the dead format would send every new deployment down a path
  Microsoft has closed.

**The words are identical across all four.** `subject` is built in SQL by
`helm.notification_subject()`, so a Discord embed, a Teams card and a generic
POST say the same sentence about the same event. Formatting differs between
platforms; facts do not.

---

## 3. What can reach a payload

This is the load-bearing control of the whole feature, and it is an
**allow-list**.

`helm.notification_payload(event, metadata)` names every field that leaves, one
key at a time, per event type. An audit action that grows a new metadata field
does **not** start appearing in notifications — somebody has to come here and
add it.

A denylist would default the other way: new field ships, notification carries
it, and the first anybody knows is when it is in a chat channel.

```
export.requested   kind, format, include_secrets, expires_in_hours
export.rendered    record_count, secret_count, byte_size, omissions, encryption_method
secret.revealed    purpose, sensitivity, label, version, step_up
access.denied      cause, purpose, sensitivity, required_rank, actor_rank
…
```

`label` is a credential's **name** — "ACME Domain Admin" — not its contents. It
is already in `search_document`, and without it a notification says only that
something was revealed, which nobody can act on. The settings page states
plainly that notifications name clients, assets and credentials, because the
moment to decide whether a channel should carry that is when choosing the
channel.

### The trigger behind it

`helm.reject_secret_bearing_payload()` is the second line, and it was
strengthened here. The `0110` version tested `NEW.payload ? key` — **top-level
keys only** — so `{"detail": {"password": "..."}}` passed. Survivable while
nothing wrote to the table; not survivable now that these rows are POSTed to a
chat platform.

It now walks every key at every depth, via
`jsonb_path_query(payload, '$.** ? (@.type() == "object")')`. The type filter is
not optional: `$.**.keyvalue()` without it **raises** on the first scalar it
meets, and the first rewrite of this function did exactly that — which made it
accept every payload put to it, including a top-level `password` that the much
simpler `0110` check had caught. A probe against real inserts found it; reading
the code did not.

---

## 4. Where the URL lives

Same envelope construction as the RADIUS shared secret (`0360`) and the OIDC
client secret (`0410`), with two differences worth naming.

**What is sealed is a JSON document**, `{url, signingSecret}`, not a bare
string. The two are useless apart and are rewritten together, so one envelope
keeps the crypto surface to one seal and one open.

**Who can read it is `helm_worker`**, not `helm_auth`. Delivering is a
background job rather than a pre-authentication step. `helm_worker` is a MEMBER
of `helm_app` and membership runs one way — `helm_worker` inherits `helm_app`'s
privileges, not the reverse — so this grant does not reach the request path.
`0420` asserts that per column at migration time, and `db/tests/security.sql`
§37 asserts it again against a built database.

The AAD binds to the **endpoint**, not just the tenant. Unlike RADIUS and OIDC,
a tenant has many destinations, so tenant-only binding would let a row be copied
between two of its own.

`helm_app` writes the sealed URL through a `SECURITY DEFINER` function and reads
back a host and a twelve-character digest — enough to tell three Discord
webhooks apart, nothing like enough to be one.

---

## 5. Two sources, one queue

```
audit_log ──▶ helm.fan_out_notifications()  ─┐
                                             ├─▶ webhook_delivery ──▶ worker ──▶ platform
alert_event ─▶ helm.enqueue_notification()  ─┘
```

**The audit log is the main source.** The fan-out reads forward from a
per-tenant cursor, maps each row to an event with
`helm.notification_event_for()`, and inserts one delivery per subscribed
destination. Most audit actions map to nothing, which is what keeps it cheap: a
tenant doing ordinary work produces hundreds of rows an hour and queues none of
them.

The cursor is a `chain_seq`, not a timestamp. The audit chain is contiguous from
1 per tenant (§8 asserts it), so a sequence cannot skip a row the way
"everything since *t*" can when two transactions commit out of order.

**Expiry warnings are the other source.** They do not pass through the audit
log; they come from the projection in `0100` via `alert_event`, which already
has the lead-day idempotency that stops a nightly job re-alerting until the team
filters the channel. `deliverExpiryAlerts` now enqueues onto this queue instead
of POSTing directly — and falls back to the original `alert_rule.target` path
when no destination is subscribed, so a deployment configured before `0420`
keeps working.

Everything is idempotent through `UNIQUE (endpoint_id, event_uid)`. A cursor
that rewinds, a crash between the insert and the cursor update, or two workers
overlapping all produce the same row rather than a second message.

---

## 6. Delivery

`notifications.deliver` runs every minute. Backoff is computed **in the
database** rather than the worker, so two workers or a worker restarted
mid-batch cannot disagree about when a delivery is next due: one minute,
doubling, capped at an hour.

`dead` rather than `failed` when the attempts run out, because those are
different things to look at — failed means it will try again, dead means a human
has to.

Each outcome is recorded in its own transaction. Batching a tenant's results
would mean a crash after twenty successful POSTs rolls back the record that they
happened, and the next run sends them again.

A destination with a **signing secret** gets `x-helm-signature`, an HMAC-SHA256
over `timestamp.body`, with the timestamp inside the signed material so a
captured request cannot be replayed. Discord, Teams and Slack ignore it; a
receiver somebody wrote themselves can tell a real notification from anyone who
found the URL.

An **email** destination takes the same claim, the same backoff and the same
`record_notification_delivery()`, and differs only at the wire — see §10.

---

## 7. The test button queues, it does not send

`POST /api/notifications/:id/test` inserts a synthetic delivery and returns.

That is deliberate. A test that POSTed directly from the request would prove the
URL reachable from the web container and nothing else — while the things most
likely to be broken are everything in between: the worker running at all, the
KEK opening the envelope, the format the platform actually accepts. So the test
goes through the same path a real notification takes, and the result appears in
the delivery log a moment later, including the platform's own error text.

This is also why the mail relay has no test button of its own: the same
reasoning applies one layer down. Testing a relay from the request process would
need the worker's role to reach the password and would be a second sending path
that can disagree with the one that delivers. A test send to an email
destination exercises the real one, and its outcome is recorded against
`smtp_setting` — so the relay card reports it.

---

## 8. Configuration

**No environment variables.** Destinations live in the database, under Settings.

Two existing values matter: `DATABASE_URL_WORKER`, because the worker role is
the only one that can read a destination URL, and `NODE_EXTRA_CA_CERTS` if a
destination sits behind a private CA.

The **mail relay is configuration too, and also not an environment variable**:
`smtp_setting`, one row per tenant, under Settings. A relay with a private
certificate does not need `NODE_EXTRA_CA_CERTS` — the certificate is pasted
into the tenant's own row and becomes the only acceptable CA for that
connection, which is per-tenant where the env var is per-deployment. The one
place that still uses an env-var relay is the password-reset mail in
`src/lib/auth/reset-delivery.ts`, and it has to: a reset happens before sign-in,
so there is no tenant context and `helm_auth` cannot read `smtp_setting`.

---

## 10. The second transport (0690)

`webhook_endpoint.transport` is `'webhook'` or `'email'`. Everything before
this section is shared: the fan-out, the allow-list, the queue, the backoff, the
dedupe key, the test button, and `helm.record_notification_delivery()`. What
differs is four lines in `deliverOne` and which columns the row carries.

| | `webhook` | `email` |
| --- | --- | --- |
| target | enveloped URL, shown as host + 12-hex digest | `email_address`, **shown in full** |
| authentication of the target | the URL *is* the credential for Discord and Teams | none — an address is a destination |
| `format` | the payload shape the platform requires | forced to `generic`; an email has no payload shape |
| `signing_secret_set` | optional HMAC for a bespoke receiver | always false; a mailbox has the envelope sender |
| envelope columns | all seven, or the row is refused | **none** of the seven, or the row is refused |
| relay | — | the tenant's `smtp_setting`, which must exist and be enabled |

**Why the address is not treated as a credential.** It is the one asymmetry
somebody will query. A Discord webhook URL authorises posting to that channel —
anyone holding it can be Helm. An email address authorises nothing; it is where
the message goes. An administrator has to be able to read it to answer "where
are these alerts going", and every member's address is already on the users
screen.

**Both envelope constraints are conditional on the transport**, and that is
worth stating because only one of them ever mattered.
`webhook_secret_present` is `octet_length(secret_ciphertext) > 0`, which a NULL
ciphertext satisfies — a CHECK passes on NULL. `webhook_envelope_complete`
spells out `IS NOT NULL` seven times and refused every email destination
outright. `0690` guard 5b asserts the constraint's *text* mentions `transport`,
so a later migration cannot reissue `0420`'s version and silently make email
destinations unsaveable.

**A transport cannot be changed once the destination exists.** The route
refuses it. The reason is not purity: an email destination saved as a webhook
carries no URL, so the save takes the `update_webhook_endpoint()` path, and that
function does not touch `transport` — the screen would report a change that
never happened.

**An undeliverable email delivery stays pending rather than failing.**
`helm.claim_notifications()` will not claim an email row for a tenant with no
enabled relay. Claiming it would mean burning an attempt once a minute until it
is `dead`, so instead it waits, and turning the relay on delivers what has come
due.

**Reminders are a different queue on purpose.** `task_reminder` (also `0690`)
belongs to a *person* and names a step, where every `webhook_delivery` row
belongs to a destination. Sharing the table would have meant a nullable
`endpoint_id` and a dedupe key meaning two things. They share the sender
(`src/lib/email/sender.ts`) and nothing else — see
`docs/architecture/05-workers-and-exports.md` for the two jobs that drive it.

---

## 9. Where it is tested

| File | What it establishes |
| --- | --- |
| `tests/unit/notification-format.test.ts` | the shape each platform requires — that Discord never gets a bare `text`, that Teams is not the retired MessageCard, that the embed limits hold |
| `tests/integration/notifications.test.ts` | the whole pipeline to a real socket: audit row → fan-out → envelope → POST, exactly once; the allow-list dropping `scope`; the AAD refusing a copied row |
| `db/tests/security.sql` §37 | the grant boundary per column, that `helm_app` cannot insert a delivery, and that the payload check walks nested objects |
| `tests/integration/notifications.test.ts`, `an email destination` | the second transport end to end — an export audit row reaching a real mailbox through the same fan-out, queue and worker; the relay and recipient-domain gates at configuration time; that a transport cannot be switched; that a rename keeps the delivery history and a readdress does not; that a delivery waits while the relay is off |
| `db/tests/security.sql` §50 | the relay password unreachable from `helm_app` by any path including `SELECT *`, the recipient gate's answers, a preference readable only by its owner, and a reminder readable only by its owner or a tenant-wide seat |
| `tests/unit/email-transport.test.ts` | that the pin is a certificate and that it pins — a different certificate is refused, over STARTTLS and implicit TLS alike |
