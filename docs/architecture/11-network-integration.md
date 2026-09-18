# Lake Effect Helm — UniFi Network Integration

Documentation goes stale because keeping it current is manual. A client's switch
stack changes and nobody updates the page. This reads the controller instead:
switches, access points, gateways and the devices connected to them, refreshed
on a schedule, encrypted, and scoped to one client.

Helm **reads**. It never writes to a controller. There is no adopt, no restart,
no configuration change — a stolen Helm database cannot be used to reconfigure
a client's network.

---

## 1. Which API this targets, and the version floor

**UniFi Network Integration API**, `https://{host}/proxy/network/integration/v1`,
authenticated with an `X-API-KEY` header. It requires **UniFi Network 9.x or
later on UniFi OS 9.3.43 or later**.

That floor is a real deployment constraint, not a note. A controller below it
answers 404 on every path this integration uses, and "404" reads like a wrong
URL rather than an out-of-date console — so the connection test names the
version requirement explicitly when it sees that shape.

Two other UniFi APIs exist and are deliberately not used:

| API | Why not |
| --- | --- |
| Classic controller (`/api/s/{site}/stat/device`) | An API key does not authenticate it. It wants a cookie session and a CSRF header, so a design that stored a key and called these would 401 on every poll. |
| Site Manager (`api.ui.com`) | Helm is an on-premises product. Routing a client's inventory through Ubiquiti's cloud to read a controller on the same LAN is a dependency nobody asked for, and it stops working when the client's WAN does. |

**Assumption stated plainly:** this integration assumes a self-hosted controller
— a UDM, a Cloud Key, or Network Server on the customer's own hardware —
reachable from the Helm server over the LAN or a VPN. Everything below about
certificates follows from that.

---

## 2. Self-signed certificates are the normal case

A self-hosted UniFi console presents a self-signed certificate on a private IP.
Not an edge case, not a misconfiguration: **the default state of the product**.
Most consoles will never have a publicly trusted certificate, because there is
no public name to issue one for.

A design that simply requires a trusted chain therefore fails on the majority of
real deployments, and the predictable consequence is an operator reaching for a
global "ignore TLS errors" switch — which disables verification for every
controller at once, permanently, on the say-so of whoever was frustrated that
afternoon. That switch does not exist in Helm, and the schema makes it
unrepresentable rather than merely discouraged:

```sql
CONSTRAINT unifi_mapping_no_blanket_disable
  CHECK (tls_verify OR tls_pinned_sha256 IS NOT NULL)
```

The exception is **per mapping**, names **one certificate**, and records **who
accepted it**:

- verification is on by default;
- an operator may pin a specific SHA-256 fingerprint for one controller;
- pinning requires `tls_exception_ack_by` and `tls_exception_ack_at`, enforced
  by a second CHECK;
- a pinned mapping accepts that certificate **and no other** — if the console is
  rebuilt or its certificate is replaced, the next poll fails loudly rather than
  trusting whatever answered.

Pinning is strictly stronger than CA verification against a local device, and
the UI says so, because it looks from the outside exactly like the thing it is
not.

### How the pin is enforced

In `Agent.createConnection`, before the socket is handed to the HTTP layer.

This ordering is the security property. `checkServerIdentity` is **not called**
when `rejectUnauthorized: false`, so the obvious implementation silently checks
nothing. The agent instead completes the TLS handshake itself, compares the peer
certificate's fingerprint, and destroys the socket on a mismatch — so the API
key is never written to a connection that has not been authenticated.

Node's `fetch` gives no hook that runs before the request is written. That is
why this client is built on `node:https`.

A fingerprint is never typed in or pinned from the settings form. It is shown by
a connection test — which reads the certificate **without sending the API key**
— and accepted by its own button. An operator cannot pin a certificate they have
not been shown.

---

## 3. The API key is a vault credential, not a column

`unifi_site_mapping.api_key_secret_id` is a foreign key into `secret`. There is
no `api_key_enc` column, and a migration guard fails the build if one appears.

This is the difference between one credential path and two. Storing the key in a
bespoke encrypted column would have meant re-earning, for this one integration:
the reveal ladder, an audit row per access, rotation, versioning, and the
`helm_app`-writes-but-never-reads boundary. Each would have been re-implemented
slightly differently, and the one place a credential lives outside the audit
trail is the one place nobody looks.

Instead:

- the settings route writes the key through `SecretService.createInTransaction`,
  in the same transaction as the mapping, so a failure cannot leave a mapping
  pointing at nothing or an orphaned credential in the vault;
- `helm.is_integration_credential()` was extended to recognise it, which is what
  lets `helm.reveal_secret(..., 'integration')` hand it to the sync worker;
- the worker reveals it as `system_sync`, which is pinned to the `integration`
  purpose — so a poll leaves the same trail a technician revealing a password
  would;
- a **connection test also reveals it**, with a stated reason, because testing a
  credential is using it;
- the foreign key is composite `(api_key_secret_id, tenant_id)`, so a mapping
  cannot reference another tenant's secret even if RLS were somehow off, and
  `ON DELETE RESTRICT`, so the credential cannot be deleted out from under a
  live mapping.

### The reveal floor

`min_role_rank` on the stored secret is `min(configurer's own rank, 80)`.

The first attempt hardcoded 60 and was wrong at both ends. Too high, and the
person holding `integration:network:manage` cannot create the credential at all
— an invisible second gate on top of the permission, which is the design this
set out not to have. Too high the other way, and `system_sync` (rank 80) cannot
reveal the key, so every poll fails with a denial that reads like a bug.

The actor's own rank is the honest floor: whoever configured the controller can
read back what they stored, anybody more junior cannot, and the clamp keeps the
worker from being locked out of a key it needs.

---

## 4. `integration:network:manage`

A new permission, deliberately narrow, held by **super_admin and tier3 only**.

It is not `tenant:write`: making a technician a super_admin so they can type in
a controller URL would hand them the tenant's authentication settings and key
custody at the same time. It is not a shared `integration:manage` either, which
would bundle a client's network gear with the notification webhooks and whatever
lands in that bucket next.

The point is delegation. `tier3` holds this permission and does **not** hold
`tenant:write` — a senior technician can be trusted with a client's controller
without being handed the MSP. That pairing is asserted in the security suite,
because it is the property that quietly disappears the day someone consolidates
permissions "for simplicity".

The gate is applied twice, and neither check is redundant: once in the route, so
the request is refused before any work happens and with a message that names the
missing permission; once inside `helm.set_unifi_mapping()`, so a caller reaching
the function by any other path is refused by the database. The second one is
what actually holds.

`system_sync` does **not** hold it. The worker polls controllers; it does not
configure them, and a stolen sync token must not be able to repoint a mapping at
a collector the attacker owns.

---

## 5. What is encrypted, and what is not

Per field, not per table.

**Encrypted** — MAC, IP, hostname, serial, and a user's custom name. A MAC
follows hardware between networks. A hostname is routinely `james-laptop`. A
serial is what a warranty claim is made against. These identify a machine and
frequently a person.

**Not encrypted** — model, firmware version, device state, uptime, signal
strength, switch port, VLAN, SSID. Telemetry with no confidentiality
requirement.

Blanket-encrypting the whole payload is the tempting shortcut and it buys
nothing. It protects data that needs no protection, at the cost of a DEK unwrap
per row per read, and it makes the inventory useless: *"which access points are
still on old firmware"* stops being answerable in SQL the moment firmware is
ciphertext. The security suite asserts both halves — that the identifying
columns are `bytea`, and that the telemetry beside them is not.

Each encrypted column holds `nonce || tag || ciphertext` in one `bytea`. The AAD
is rebuilt from `(tenant, asset id, field)` rather than stored, so a column
copied between rows fails to open rather than showing one device's hostname
under another's name.

### The asset id has to exist before the ciphertext does

Because the AAD names it. The upsert function therefore takes the id rather than
letting the column default mint one.

This was a real bug, caught by a test that decrypts a synced asset end to end
rather than by reading the code. The insert succeeded, the row looked perfect,
and **every sealed field on it was permanently unreadable** — the AAD named an
id no row had. Nothing detected it because nothing decrypted it. A migration
guard now reads the function definition and fails if the `VALUES` list stops
naming `p_asset_id`.

A second case of the same shape: a peer inserting the same MAC between the
lookup and the insert wins the `ON CONFLICT` and hands back **its** id, leaving
the fields just written bound to an id that no longer applies. The worker
detects the mismatch and re-seals against the id that won.

---

## 6. Identity is the MAC blind index

`network_assets.mac_blind_index` is HMAC-SHA256 of the normalised MAC under a
per-tenant subkey, and it is the upsert key: `(tenant_id, mac_blind_index)` is
unique.

This is what makes re-sync idempotent without storing a searchable MAC. It also
means normalisation must be exact — UniFi has reported MACs as
`aa:bb:cc:dd:ee:ff`, `AA-BB-CC-DD-EE-FF` and `aabbccddeeff` across versions and
endpoints, and an HMAC over two spellings of one address produces two different
indexes, which would silently create a second row for the same device on every
poll, forever. Anything that is not twelve hex digits is skipped rather than
guessed at.

`asset_ip_history` records address changes append-on-change, indexed the same
blind way, so *"what had 10.2.0.47 last Tuesday"* is answerable without storing
a queryable IP.

### `HELM_BLIND_INDEX_KEY_B64` is required, not optional, for this integration

Elsewhere it is optional: unset means no password-reuse detection and no offline
verification oracle, which is a legitimate trade (see
`01-security-model.md` §4).

Here there is no key to compute the upsert key with, so there is no way to tell
a device seen before from a new one. The worker **refuses to poll anything** and
says so once per run, rather than filling the inventory with duplicates or
quietly doing nothing. Set it before configuring a controller.

---

## 7. A poll never overwrites what a person wrote

`custom_name_enc`, `asset_tag`, `department`, `notes` and `maintenance_status`
are absent from the upsert's `UPDATE` branch. A technician who names a switch
"core stack — DO NOT REBOOT" keeps that name across every subsequent sync.

Enforced two ways, because a behavioural test only catches the columns it
happens to name:

- a migration guard reads the function definition and fails on
  `(custom_name_enc|asset_tag|department|notes|maintenance_status)\s*=\s*EXCLUDED`;
- an integration test edits every one of them, re-syncs with changed telemetry,
  and asserts all five survived while the telemetry moved.

`organization_id` is in the same list. A device is not silently reassigned to a
different client by a poll.

---

## 8. Scheduling, fairness and races

Each mapping carries its own `poll_interval_seconds` — a busy site and a quiet
one do not want the same number — and its own `next_poll_at`. The worker ticks
every 30 seconds and polls whatever is due; the tick is the granularity of
"due", not the polling rate.

**One tenant's failure does not delay another's.** Each mapping is claimed,
polled and finished independently, inside its own transaction and its own tenant
context. A controller that hangs costs its own 20-second request budget and
nothing else's.

**Two runs cannot race one mapping.** `helm.claim_unifi_poll()` takes the mapping
row with `FOR UPDATE SKIP LOCKED` and pushes `next_poll_at` forward in the same
statement, so a second runtime is refused immediately rather than queueing behind
the first and polling the controller again once it commits. This project has
shipped a bug of exactly this shape before, so the test forces the interleaving
rather than hoping for it: one transaction claims and is held open while a second
connection asks for the same mapping.

**Failures back off.** `helm.finish_unifi_poll()` records the error and
exponentially delays the next attempt, capped at an hour. A controller taken off
the network for a fortnight is retried hourly, not every thirty seconds for two
weeks.

**Devices that stop being reported go offline, not missing.** Marking is bounded
by the instant the poll started, so devices seen during a slow poll are not
flipped off by the finish that follows them.

---

## 9. What a connection test proves, and what it does not

Three stages, in this order, and the order is the security property:

1. **Read the certificate without trusting it.** A TLS connection that sends
   nothing, just to learn the fingerprint. Showing an operator a certificate must
   not cost them the API key.
2. **Decide whether we can talk at all.** Trusted chain, or a matching pin.
   Neither, and the test **stops here** and reports the fingerprint for the
   operator to accept. It does not quietly proceed.
3. **Only then use the key.** `GET /sites` — the cheapest call that exercises
   authentication, the version floor and the site id together.

What it cannot prove is that the key has scope on every endpoint the sync uses.
`/sites` answering does not guarantee `/devices` will. The response says so
rather than showing a tick that means more than it does.

---

## 10. Webhooks: a shortcut, never a dependency

Part 2 adds an inbound receiver so a device going offline shows up in seconds
rather than at the next poll. Everything about its design follows from one
constraint:

**Webhook delivery is not guaranteed on a UniFi console.** Registration is not
part of the documented Integration API surface for Network 9.x, support varies
by build, and no version number reliably predicts it. An integration whose
correctness depended on it would be broken on an unknown fraction of
deployments with no way to tell which.

So the poll stays the source of truth and the receiver only ever writes state
the poll would have written anyway. A migration guard and a security assertion
both check that no polling function so much as mentions webhooks — because the
way this guarantee dies is somebody making the poll "smarter" by consulting
webhook state.

A controller that refuses registration is recorded as `unsupported` and the
settings card says so in those words: *nothing is wrong and nothing is missing —
polling covers everything; live events would only have been faster.* It is not
styled as an error, because it is not one.

### The receiver

`POST /api/network/webhook/{mappingId}`

Order of operations, which is the security property:

1. **Read the raw body as bytes.** `request.text()`, not `request.json()`: the
   signature covers exactly what was transmitted, and parsing then
   re-serialising does not reproduce it — key order, whitespace and number
   formatting all move. A receiver that verifies a round-tripped body verifies
   something the sender never signed.
2. **Look the mapping up by the id in the path.** One row, by primary key.
3. **Verify HMAC-SHA256 over the body**, constant-time. Nothing is parsed,
   decoded or written before this succeeds.
4. **Only then** open a tenant context and act, as `system_sync` — the same
   machine identity the poll runs as, so the audit trail has one actor for these
   rows rather than two.

An unknown mapping and a bad signature return the **same** refusal, so the
endpoint cannot be used to discover which mapping ids exist. Refusals are `202`
rather than `4xx`: a controller that receives an error retries, and a controller
retrying a request Helm will never accept is a loop neither side can break.

**Documented assumption.** The Integration API does not publish a webhook
signing format. Helm therefore *defines* the one it verifies — HMAC-SHA256 over
the exact body, hex, under any of `x-unifi-signature`, `x-ubnt-signature`,
`x-webhook-signature`, `x-hub-signature-256` or `x-signature`, with an optional
`sha256=` prefix. If a future console signs differently, `SIGNATURE_HEADERS` and
`verifySignature` in `src/lib/unifi/webhook-secret.ts` are the two things to
change, and polling keeps working meanwhile.

### Why the signing secret is a column when the API key is not

This looks inconsistent with §3 and is not.

The receiver is **unauthenticated**. Verifying the signature is what establishes
whose request it is, so the secret must be readable before there is an actor for
`helm.reveal_secret()` to attribute a read to or a tenant context to open one
under. And a reveal per inbound event would write an audit row per inbound
event — burying the threat records this exists to produce under records of Helm
reading its own key. `0420` reached the same conclusion for the outbound signing
secret, and this follows its shape rather than inventing a third.

What that costs is bought back elsewhere: the envelope is self-contained and
sealed under a purpose-bound DEK, bound by AAD to `(tenant, mapping)` so a row
copied between mappings or deployments fails to open, absent from
`helm.unifi_mappings()` entirely, and **revoked** when the receiver is turned
off rather than merely hidden. The controller's API key — the one a person can
ask to see, which unlocks the whole inventory — is still a reference into
`secret`, and a security assertion checks specifically that.

### Threat records

A high or critical event writes two things in one transaction:

- an **audit row**, `network.threat_detected`, carrying severity, rule name and
  category — and no address, MAC or hostname;
- a **`network_threat_event` row** holding the source address, destination
  address and the controller's whole original event, envelope-encrypted with the
  tenant DEK exactly as `network_assets` encrypts a MAC.

The whole original goes in sealed rather than picked over field by field,
because a controller's event can carry addresses anywhere in its structure and
the alternative is deciding, for every future firmware, which new key is
sensitive.

**Why not a column on `audit_log`,** which is where a threat report obviously
belongs and where this nearly went:

- `audit_log.metadata` is documented and trigger-enforced as non-sensitive, and
  an IDS alert is nothing but sensitive. Putting addresses there would
  contradict the column's contract in the same schema that states it.
- `audit_log.row_hash` is computed from a canonical form pinned field by field —
  deliberately, so adding a column does not invalidate every hash already
  written. The flip side is that a new column would **not be covered by the
  chain**: encrypted detail sitting in `audit_log` would be the one part of an
  audit record alterable without detection.

Instead the audit row's metadata carries `detail_sha256`. The chain commits to a
digest of the ciphertext, so the detail is tamper-evident without the audit log
ever holding an address. A test asserts the digest matches the stored bytes.

A replayed alert is caught on the controller's own event id, not by the
signature — a replay *is* a validly signed request, and asking signature
verification to catch it would be asking the wrong question.

### What the fast path may and may not do

`helm.apply_webhook_telemetry()` names no user-owned column, exactly as
`helm.upsert_network_asset()` does not, and **cannot create an asset at all**.
The poll enumerates a site with the controller's own authority; an event arrives
over a path whose only check is a shared secret. Only one of those should be
able to put a new device into a client's documentation. An event for an unknown
MAC updates nothing and the next poll picks the device up properly.

Both rules are checked by reading the function definition, in a migration guard
and again in the security suite, because two write paths into one table is how a
rule ends up enforced on only one of them.

### Configuration, and the absence of an environment variable

There is none, and that is worth saying because this project has twice had to
clean up variables nothing read. The signing secret is generated per mapping,
32 bytes of CSPRNG, stored sealed and shown to the operator exactly once. The
callback URL is built from the request origin — the same value the OIDC redirect
URI uses, and for the same reason: the only thing that knows the address a
controller will reach Helm on is the request.

`HELM_BLIND_INDEX_KEY_B64` remains required, for the receiver as much as the
poll: matching an event to a device is a MAC blind-index lookup.

---

## 11. Files


| Path | What |
| --- | --- |
| `db/sql/0430_unifi_network_assets.sql` | Schema, permission, RLS, the upsert and claim functions, nine guards |
| `src/lib/unifi/client.ts` | Integration API client, pinning agent, certificate inspection |
| `src/lib/unifi/fields.ts` | Per-field sealing, MAC and IP normalisation |
| `src/workers/unifi-sync.ts` | The poll loop: claim, fetch, upsert, finish |
| `src/app/api/network/mappings/` | Configuration, deletion, connection test |
| `src/components/unifi-settings.tsx` | The settings card |
| `tests/support/fake-unifi.ts` | An HTTPS stub with a real self-signed certificate |
| `db/sql/0450_unifi_webhooks.sql` | Receiver schema, threat records, eight guards |
| `src/lib/unifi/webhook.ts` | The receiver: verify, then place, then apply |
| `src/lib/unifi/webhook-secret.ts` | Sealing and verifying the signing secret |
| `src/lib/unifi/events.ts` | Parsing what a console posts, tolerantly |
| `src/app/api/network/webhook/[mappingId]/` | The unauthenticated endpoint |

Removing a mapping does **not** delete the inventory. `network_assets.mapping_id`
is `ON DELETE SET NULL`, so losing a controller and losing a year of
documentation stay different acts — and only one of them was asked for.
