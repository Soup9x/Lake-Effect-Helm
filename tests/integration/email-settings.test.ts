/**
 * Configuring the relay, and choosing what to be told about.
 *
 * WHAT ONLY THIS LEVEL ANSWERS:
 *
 *   1. helm_app CANNOT READ THE PASSWORD, through the route or otherwise. The
 *      column grants are 0690's load-bearing control and a guard asserts the
 *      shape; this asserts the behaviour, including that a GET returns a
 *      boolean rather than a redacted string somebody could un-redact.
 *   2. PLAINTEXT NEEDS A SIGNATURE, and the record names a person.
 *   3. A PIN IS A CERTIFICATE AND IS CHECKED. The fingerprint is derived, so
 *      the two cannot disagree.
 *   4. THE TS AND SQL LISTS OF NOTIFICATION KINDS AGREE. Three copies exist by
 *      necessity — a CHECK, a validator function, and the constant a form
 *      renders from — and this is what stops them drifting.
 *   5. A PREFERENCE IS PRIVATE. Not gated on a permission, because the policy
 *      IS the authorisation; so the test that matters is that one person
 *      cannot read or write another's.
 */
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { withTenant } from '../../src/lib/db/client';
import { resetServices, setKekProvider } from '../../src/lib/services';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import {
  actor, buildHarness, connectPools, disconnectPools, IDS, resetDatabase, superuserSql,
} from './harness';
import { GET as getSmtp, PUT as putSmtp } from '../../src/app/api/tenant/smtp/route';
import {
  GET as getKinds, PUT as putKinds,
} from '../../src/app/api/account/notifications/route';
import {
  DEFAULT_NOTIFICATION_KINDS, NOTIFICATION_KINDS, OVERSIGHT_KINDS,
} from '../../src/lib/notifications/kinds';
import { FakeSmtp } from '../support/fake-smtp';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

const ADMIN = actor(IDS.tenant1, IDS.admin1);
let harness: ReturnType<typeof buildHarness>;
let currentUser: SessionUser | null = null;
let certificate = '';

const USERS = {
  admin: { id: IDS.admin1, email: 'admin@northwind.test' },
  tech: { id: IDS.tech1, email: 'tech1@northwind.test' },
  viewer: { id: IDS.acmeViewer, email: 'viewer@acme.test' },
} as const;

const request = (url: string, method = 'GET', payload?: unknown) =>
  new NextRequest(new Request(`http://helm.test${url}`, {
    method,
    ...(payload === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
  }));

async function read(response: Response) {
  const raw = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch { /* a non-JSON body is its own diagnostic */ }
  return { status: response.status, payload, raw };
}

async function su<T>(fn: (sql: ReturnType<typeof superuserSql>) => Promise<T>): Promise<T> {
  const sql = superuserSql();
  try { return await fn(sql); } finally { await sql.end({ timeout: 5 }); }
}

const VALID = {
  enabled: true,
  host: 'mail.northwind.test',
  port: 587,
  security: 'starttls' as const,
  tlsVerify: true,
  username: 'helm',
  password: 'relay-secret',
  fromAddress: 'helm@northwind.test',
  fromName: 'Lake Effect Helm',
  allowedRecipientDomains: ['northwind.test'],
};

const save = (payload: Record<string, unknown>) =>
  putSmtp(request('/api/tenant/smtp', 'PUT', payload));

beforeAll(async () => {
  resetDatabase();
  connectPools();
  harness = buildHarness();
  setKekProvider(harness.kek);
  useSessionResolver(async () => currentUser);
  await harness.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'smtp settings tests' });
  // A real certificate, so the pin tests are about a certificate rather than
  // about a string that happens to look like one.
  const relay = await FakeSmtp.start();
  certificate = relay.certificatePem;
  await relay.stop();
}, 120_000);

afterEach(async () => {
  await su(async (sql) => {
    await sql`DELETE FROM smtp_setting`;
    await sql`DELETE FROM user_notification_preference`;
  });
});

afterAll(async () => {
  resetServices();
  await disconnectPools();
});

// ---------------------------------------------------------------------------

describe('the relay', () => {
  it('is unconfigured and says so, before anybody has been near it', async () => {
    currentUser = USERS.admin;
    const { status, payload } = await read(await getSmtp(request('/api/tenant/smtp')));
    expect(status).toBe(200);
    expect(payload.configured).toBe(false);
    expect(payload.enabled).toBe(false);
    expect(payload.passwordSet).toBe(false);
  });

  it('can be configured by an administrator', async () => {
    currentUser = USERS.admin;
    const { status, payload, raw } = await read(await save(VALID));
    expect(status, raw).toBe(200);
    expect(payload.configured).toBe(true);
    expect(payload.host).toBe('mail.northwind.test');
    expect(payload.passwordSet).toBe(true);
  });

  it('never returns the password, in any form', async () => {
    currentUser = USERS.admin;
    await save(VALID);
    const { payload, raw } = await read(await getSmtp(request('/api/tenant/smtp')));

    // Not the plaintext, and not a redacted stand-in either: the field is a
    // boolean the database computed, so there is nothing to un-redact.
    expect(raw).not.toContain('relay-secret');
    expect(payload.passwordSet).toBe(true);
    expect(Object.keys(payload)).not.toContain('password');
    expect(Object.keys(payload)).not.toContain('secretCiphertext');
  });

  it('cannot have its envelope read by the request role at all', async () => {
    currentUser = USERS.admin;
    await save(VALID);
    // The behavioural half of 0690's guard 2: a column privilege, not a policy.
    await expect(
      withTenant(ADMIN, (tx) => tx`SELECT secret_ciphertext FROM smtp_setting`),
    ).rejects.toThrow(/permission denied/);
  });

  it('keeps the stored password when a save omits it', async () => {
    /*
     * The three-way field. Saving the host should not require re-typing a
     * password the browser never received — so absent means keep, '' means
     * clear, and a value means replace. A caller gets this wrong by assuming
     * absent means clear, which silently breaks authentication on the next
     * send.
     */
    currentUser = USERS.admin;
    await save(VALID);
    const before = await su((sql) => sql<{ ciphertext: Buffer | null }[]>`
      SELECT secret_ciphertext AS ciphertext FROM smtp_setting
    `);

    const { password: _omitted, ...withoutPassword } = VALID;
    const { payload } = await read(await save({ ...withoutPassword, host: 'mail2.northwind.test' }));
    expect(payload.host).toBe('mail2.northwind.test');
    expect(payload.passwordSet, 'omitting the password cleared it').toBe(true);

    const after = await su((sql) => sql<{ ciphertext: Buffer | null }[]>`
      SELECT secret_ciphertext AS ciphertext FROM smtp_setting
    `);
    expect(after[0]!.ciphertext?.equals(before[0]!.ciphertext!)).toBe(true);
  });

  it('clears the password when sent an empty string', async () => {
    currentUser = USERS.admin;
    await save(VALID);
    const { payload } = await read(await save({ ...VALID, password: '' }));
    expect(payload.passwordSet).toBe(false);

    const rows = await su((sql) => sql<{ ciphertext: Buffer | null }[]>`
      SELECT secret_ciphertext AS ciphertext FROM smtp_setting
    `);
    expect(rows[0]!.ciphertext).toBeNull();
  });

  it('refuses a password with no username, which is a relay nobody can log in to', async () => {
    currentUser = USERS.admin;
    // A CHECK constraint (smtp_password_needs_username) refuses the row. It
    // used to come back as a 500; the handler now maps a check_violation to a
    // 400 without repeating the constraint's name to the caller.
    const { status, payload } = await read(await save({ ...VALID, username: null }));
    expect(status).toBe(400);
    expect((payload.error as { message: string }).message).not.toMatch(/smtp_|constraint|relation/);
    expect(await su((sql) => sql`SELECT 1 FROM smtp_setting`)).toEqual([]);
  });

  it('cannot be configured by a technician', async () => {
    currentUser = USERS.tech;
    const { status, payload } = await read(await save(VALID));
    expect(status).toBe(403);
    const error = (payload.error ?? {}) as { message?: string };
    expect(
      error.message,
      "refused, but not by the route's tenant:write gate",
    ).toBe('missing permission: tenant:write');
    expect(await su((sql) => sql`SELECT 1 FROM smtp_setting`)).toEqual([]);
  });

  it('cannot be written directly even by somebody holding tenant:write', async () => {
    // The route's gate is not the only one: helm_app has no INSERT or UPDATE,
    // so a caller that found another path is still refused.
    await expect(
      withTenant(ADMIN, (tx) => tx`
        UPDATE smtp_setting SET host = 'evil.test'
      `),
    ).rejects.toThrow(/permission denied/);
  });

  it('can be read by anybody, because a toggle needs to know if mail works', async () => {
    currentUser = USERS.admin;
    await save(VALID);

    for (const who of [USERS.tech, USERS.viewer]) {
      currentUser = who;
      const { status, payload } = await read(await getSmtp(request('/api/tenant/smtp')));
      expect(status, `${who.email} could not read the relay state`).toBe(200);
      expect(payload.enabled).toBe(true);
      expect(payload.passwordSet).toBe(true);
    }
  });
});

describe('plaintext', () => {
  it('is refused without an acknowledgement', async () => {
    currentUser = USERS.admin;
    const { status, payload } = await read(await save({
      ...VALID, security: 'plaintext', port: 25,
    }));
    expect(status).toBe(400);
    expect(JSON.stringify(payload)).toContain('clear text');
    expect(await su((sql) => sql`SELECT 1 FROM smtp_setting`)).toEqual([]);
  });

  it('is accepted with one, and the record names a person and a time', async () => {
    currentUser = USERS.admin;
    const { status, raw } = await read(await save({
      ...VALID, security: 'plaintext', port: 25, acknowledgePlaintext: true,
    }));
    expect(status, raw).toBe(200);

    const [row] = await su((sql) => sql<{
      security: string; at: Date | null; by: string | null;
    }[]>`
      SELECT security, plaintext_acknowledged_at AS at, plaintext_acknowledged_by AS by
      FROM smtp_setting
    `);
    expect(row!.security).toBe('plaintext');
    // A timestamp AND an actor: "who accepted this and when" is the question
    // somebody asks a year later, and a boolean cannot answer it.
    expect(row!.at).not.toBeNull();
    expect(row!.by).toBe(IDS.admin1);
  });

  it('clears the acknowledgement when the relay moves back to TLS', async () => {
    // Otherwise a stale timestamp against a STARTTLS relay reads as somebody
    // having accepted a risk that is not being taken.
    currentUser = USERS.admin;
    await save({ ...VALID, security: 'plaintext', port: 25, acknowledgePlaintext: true });
    await save({ ...VALID, security: 'starttls', port: 587 });

    const [row] = await su((sql) => sql<{ at: Date | null; by: string | null }[]>`
      SELECT plaintext_acknowledged_at AS at, plaintext_acknowledged_by AS by FROM smtp_setting
    `);
    expect(row!.at).toBeNull();
    expect(row!.by).toBeNull();
  });
});

describe('the certificate pin', () => {
  it('stores a certificate and reports its fingerprint, not the PEM', async () => {
    currentUser = USERS.admin;
    const { status, payload, raw } = await read(await save({
      ...VALID, tlsPinnedCertificate: certificate,
    }));
    expect(status, raw).toBe(200);

    // A fingerprint is what an operator compares against what their relay
    // reports; a wall of base64 on a settings page is something people scroll
    // past. Derived from the stored PEM, so the two cannot disagree.
    expect(payload.pinnedFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(raw).not.toContain('BEGIN CERTIFICATE');
  });

  it('refuses a private key pasted into the certificate field', async () => {
    // The paste accident that would put a private key in a settings table.
    currentUser = USERS.admin;
    const { status } = await read(await save({
      ...VALID,
      tlsPinnedCertificate:
        '-----BEGIN PRIVATE KEY-----\nMIIBOgIBAAJBAKj\n-----END PRIVATE KEY-----',
    }));
    // smtp_pin_shape, a CHECK: a 400 now rather than the 500 it used to be.
    expect(status).toBe(400);
    expect(await su((sql) => sql`SELECT 1 FROM smtp_setting`)).toEqual([]);
  });

  it('refuses a pin on a plaintext relay, where no certificate is ever presented', async () => {
    currentUser = USERS.admin;
    const { status, payload } = await read(await save({
      ...VALID,
      security: 'plaintext',
      port: 25,
      acknowledgePlaintext: true,
      tlsPinnedCertificate: certificate,
    }));
    expect(status).toBe(400);
    expect(JSON.stringify(payload)).toContain('no certificate is ever presented');
  });

  it('refuses verification off with no pin, which accepts anybody', async () => {
    currentUser = USERS.admin;
    const { status, payload } = await read(await save({ ...VALID, tlsVerify: false }));
    expect(status).toBe(400);
    expect(JSON.stringify(payload)).toContain('accepts any');
  });

  it('allows verification off WITH a pin, because the pin is the verification', async () => {
    currentUser = USERS.admin;
    const { status, raw } = await read(await save({
      ...VALID, tlsVerify: false, tlsPinnedCertificate: certificate,
    }));
    expect(status, raw).toBe(200);
  });

  it('keeps the pin when a later save does not paste it again', async () => {
    // The form never re-sends a stored PEM — the box says "Stored — paste a
    // new one to replace it". Saving the host again used to drop the pin, and
    // with verification off the second save was then refused outright.
    currentUser = USERS.admin;
    const first = await read(await save({
      ...VALID, tlsVerify: false, tlsPinnedCertificate: certificate,
    }));
    expect(first.status, first.raw).toBe(200);
    const fingerprint = first.payload.pinnedFingerprint;
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const second = await read(await save({ ...VALID, host: 'mail2.northwind.test', tlsVerify: false }));
    expect(second.status, second.raw).toBe(200);
    expect(second.payload.host).toBe('mail2.northwind.test');
    expect(second.payload.pinnedFingerprint).toBe(fingerprint);
  });

  it('clears the pin when sent an empty string, and refuses that with verification off', async () => {
    currentUser = USERS.admin;
    await save({ ...VALID, tlsVerify: false, tlsPinnedCertificate: certificate });

    const refused = await read(await save({ ...VALID, tlsVerify: false, tlsPinnedCertificate: '' }));
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.payload)).toContain('accepts any');

    const cleared = await read(await save({ ...VALID, tlsVerify: true, tlsPinnedCertificate: '' }));
    expect(cleared.status, cleared.raw).toBe(200);
    expect(cleared.payload.pinnedFingerprint).toBeNull();
  });

  it('drops the pin when the relay moves to plaintext', async () => {
    currentUser = USERS.admin;
    await save({ ...VALID, tlsPinnedCertificate: certificate });
    const { status, payload, raw } = await read(await save({
      ...VALID, security: 'plaintext', port: 25, acknowledgePlaintext: true,
    }));
    expect(status, raw).toBe(200);
    expect(payload.pinnedFingerprint).toBeNull();
  });
});

describe('the recipient domains', () => {
  it('are stored lower-case, however they were typed', async () => {
    currentUser = USERS.admin;
    const { payload } = await read(await save({
      ...VALID, allowedRecipientDomains: ['NorthWind.TEST', 'Partner.Example'],
    }));
    expect(payload.allowedRecipientDomains).toEqual(['northwind.test', 'partner.example']);
  });

  it('default to the sending domain when the list is empty', async () => {
    currentUser = USERS.admin;
    await save({ ...VALID, allowedRecipientDomains: [] });

    const [row] = await withTenant(ADMIN, (tx) => tx<{ own: boolean; other: boolean }[]>`
      SELECT helm.email_recipient_allowed(helm.current_tenant_id(), 'helpdesk@northwind.test') AS own,
             helm.email_recipient_allowed(helm.current_tenant_id(), 'attacker@evil.test') AS other
    `);
    expect(row!.own, 'a tenant should always be able to notify itself').toBe(true);
    expect(row!.other, 'an address outside the sending domain was allowed').toBe(false);
  });
});

describe('my notification kinds', () => {
  it('agree with the database about which kinds exist', async () => {
    /*
     * Three copies by necessity: the CHECK, helm.notification_kinds_valid(),
     * and NOTIFICATION_KINDS for a form that needs the list before it has asked
     * anything. This is what stops a kind being added in one place only — the
     * same construction D used for the sidebar slugs.
     */
    for (const kind of NOTIFICATION_KINDS) {
      const [row] = await withTenant(ADMIN, (tx) => tx<{ ok: boolean }[]>`
        SELECT helm.notification_kinds_valid(${tx.json([kind])}::jsonb) AS ok
      `);
      expect(row!.ok, `${kind} is in TypeScript but the validator refuses it`).toBe(true);
    }

    const [invalid] = await withTenant(ADMIN, (tx) => tx<{ ok: boolean }[]>`
      SELECT helm.notification_kinds_valid('["not_a_kind"]'::jsonb) AS ok
    `);
    expect(invalid!.ok, 'the validator accepts a kind TypeScript has never heard of').toBe(false);

    /*
     * AND THE OTHER DIRECTION, which the first half cannot see. Every assertion
     * above passes if SQL knows a kind TypeScript does not: the validator would
     * accept it, the CHECK would store it, and the account screen would render
     * no checkbox for it — a preference somebody holds and cannot change. 0700
     * made the SQL catalogue a function, so this is one query.
     */
    const [sqlSide] = await withTenant(ADMIN, (tx) => tx<{ kinds: string[] }[]>`
      SELECT helm.notification_kinds() AS kinds
    `);
    expect(
      [...sqlSide!.kinds].sort(),
      'SQL and TypeScript disagree about which kinds exist',
    ).toEqual([...NOTIFICATION_KINDS].sort());

    // The default set too, and that it is a subset — a default naming a kind
    // the CHECK refuses makes every preference row unwritable. 0700 guards it
    // at migration time; this is the behavioural half.
    const [defaults] = await withTenant(ADMIN, (tx) => tx<{ kinds: string[] }[]>`
      SELECT helm.default_notification_kinds() AS kinds
    `);
    expect([...defaults!.kinds].sort()).toEqual([...DEFAULT_NOTIFICATION_KINDS].sort());
    for (const kind of defaults!.kinds) {
      expect(NOTIFICATION_KINDS as readonly string[]).toContain(kind);
    }

    // And the oversight half agrees, because the account screen hides those
    // checkboxes from a seat that could never receive them.
    const [oversight] = await withTenant(ADMIN, (tx) => tx<{ kinds: string[] }[]>`
      SELECT array_agg(k ORDER BY k) AS kinds
      FROM unnest(helm.notification_kinds()) k
      WHERE k <> ALL (helm.default_notification_kinds())
    `);
    expect([...oversight!.kinds].sort()).toEqual([...OVERSIGHT_KINDS].sort());
  });

  it('default to my own work on and the oversight feeds off', async () => {
    currentUser = USERS.tech;
    const { status, payload } = await read(await getKinds(request('/api/account/notifications')));
    expect(status).toBe(200);
    // 0700 split the default. Being given work and a deadline is told without
    // being asked; a feed of every export in the business is opted into. This
    // asserts the SPLIT rather than the list, so adding a seventh kind does not
    // silently join somebody's defaults.
    expect(payload.kinds).toEqual([...DEFAULT_NOTIFICATION_KINDS]);
    expect(payload.kinds).toEqual(['task_assigned', 'task_due']);
    for (const kind of OVERSIGHT_KINDS) {
      expect(
        payload.kinds as string[],
        `${kind} is a feed of the whole tenant and must be opted into`,
      ).not.toContain(kind);
    }
    expect(payload.configured).toBe(false);
  });

  it('...and an oversight kind can be turned on, which is the point of it', async () => {
    currentUser = USERS.tech;
    const { status, payload } = await read(await putKinds(
      request('/api/account/notifications', 'PUT', {
        kinds: ['task_due', 'export_activity'],
      }),
    ));
    expect(status).toBe(200);
    // Stored in the catalogue's order, not the caller's, so two saves of the
    // same set produce the same array.
    expect(payload.kinds).toEqual(['task_due', 'export_activity']);
    expect(payload.configured).toBe(true);
  });

  it('say whether mail is configured at all', async () => {
    // A toggle with no relay behind it is a control that does nothing, and the
    // screen has to be able to say so.
    currentUser = USERS.tech;
    expect((await read(await getKinds(request('/api/account/notifications')))).payload
      .emailConfigured).toBe(false);

    currentUser = USERS.admin;
    await save(VALID);
    currentUser = USERS.tech;
    expect((await read(await getKinds(request('/api/account/notifications')))).payload
      .emailConfigured).toBe(true);
  });

  it('can be emptied, and an empty list is not the default', async () => {
    currentUser = USERS.tech;
    const { status, payload } = await read(
      await putKinds(request('/api/account/notifications', 'PUT', { kinds: [] })),
    );
    expect(status).toBe(200);
    expect(payload.kinds).toEqual([]);
    expect(payload.configured).toBe(true);

    // And it survives a re-read rather than falling back to the default, which
    // is the distinction that makes the control feel like it works.
    const again = await read(await getKinds(request('/api/account/notifications')));
    expect(again.payload.kinds).toEqual([]);
    expect(again.payload.configured).toBe(true);
  });

  it('are stored in the catalogue"s order, whatever order they arrive in', async () => {
    currentUser = USERS.tech;
    const { payload } = await read(await putKinds(
      request('/api/account/notifications', 'PUT', { kinds: ['task_due', 'task_assigned'] }),
    ));
    expect(payload.kinds).toEqual(['task_assigned', 'task_due']);
  });

  it('refuse a kind nobody has heard of', async () => {
    currentUser = USERS.tech;
    const { status } = await read(await putKinds(
      request('/api/account/notifications', 'PUT', { kinds: ['task_due', 'send_me_everything'] }),
    ));
    expect(status).toBe(400);
  });

  it('refuse a duplicate, which would make "is this on" depend on which copy is read', async () => {
    currentUser = USERS.tech;
    const { status } = await read(await putKinds(
      request('/api/account/notifications', 'PUT', { kinds: ['task_due', 'task_due'] }),
    ));
    expect(status).toBe(400);
  });

  it('are private: one person cannot see or set another"s', async () => {
    currentUser = USERS.tech;
    await putKinds(request('/api/account/notifications', 'PUT', { kinds: [] }));

    // The administrator reads their own default, not the technician's empty
    // list — the policy admits only rows belonging to the current actor.
    currentUser = USERS.admin;
    const { payload } = await read(await getKinds(request('/api/account/notifications')));
    expect(payload.kinds).toEqual([...DEFAULT_NOTIFICATION_KINDS]);
    expect(payload.configured).toBe(false);

    // And the row the technician wrote is invisible, not merely unreturned.
    const rows = await withTenant(ADMIN, (tx) => tx`
      SELECT 1 FROM user_notification_preference
    `);
    expect(rows, 'an administrator could read somebody else"s preference').toEqual([]);
  });

  it('go with the membership when somebody leaves the tenant', async () => {
    // Keyed to the membership rather than the user, so somebody in two tenants
    // decides separately for each and leaving one takes that choice with it.
    currentUser = USERS.tech;
    await putKinds(request('/api/account/notifications', 'PUT', { kinds: ['task_due'] }));
    expect(await su((sql) => sql`SELECT 1 FROM user_notification_preference`))
      .toHaveLength(1);

    await su((sql) => sql`
      DELETE FROM membership
      WHERE tenant_id = ${IDS.tenant1}::uuid AND user_id = ${IDS.tech1}::uuid
    `);
    expect(await su((sql) => sql`SELECT 1 FROM user_notification_preference`)).toEqual([]);
  });
});
