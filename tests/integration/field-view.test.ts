/**
 * Field view (1250): a phone session that is read-only ON THE SERVER.
 *
 * What is asserted is the enforcement, not the pages: a session whose
 * auth_session row says field_mode is refused every write except the audited
 * reads, whatever route it calls; entering Field view needs only the session
 * and honours the administrator's switch; leaving it needs the password again;
 * phone sessions are held to their own, shorter idle and absolute limits; and
 * only somebody with tenant:write may change any of that.
 */
import { NextRequest } from 'next/server';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { enforceSessionPolicy } from '../../src/lib/auth/session-policy';
import { setLocalPassword } from '../../src/lib/auth/local';
import { sessionCookieName, storedSessionToken } from '../../src/lib/auth/session-cookie';
import { GET as getPolicy, PUT as putPolicy } from '../../src/app/api/tenant/field-view/route';
import { POST as enterField } from '../../src/app/api/auth/field/enter/route';
import { POST as upgradeField } from '../../src/app/api/auth/field/upgrade/route';
import { GET as listOrganizations, POST as createOrganization } from '../../src/app/api/organizations/route';
import { POST as resetRoute } from '../../src/app/api/auth/local/reset/route';
import { DELETE as totpDelete, POST as totpRoute } from '../../src/app/api/account/totp/route';
import { POST as changePassword } from '../../src/app/api/auth/local/change-password/route';
import { GET as downloadExport } from '../../src/app/api/exports/[exportJobId]/download/route';
import { connectPools, disconnectPools, IDS, resetDatabase, superuserSql } from './harness';

const ADMIN_EMAIL = 'admin@northwind.test';
const ADMIN_PASSWORD = 'seventeen purple lanterns';

let currentUser: SessionUser | null = null;
const asAdmin = () => { currentUser = { id: IDS.admin1, email: ADMIN_EMAIL }; };
const asTech = () => { currentUser = { id: IDS.tech1, email: 'tech1@northwind.test' }; };

const request = (method: string, path: string, opts: { token?: string; payload?: unknown } = {}) =>
  new NextRequest(new Request(`https://helm.test${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { cookie: `${sessionCookieName()}=${opts.token}` } : {}),
    },
    ...(opts.payload === undefined ? {} : { body: JSON.stringify(opts.payload) }),
  }));
const noParams = { params: Promise.resolve({}) } as never;
const body = async (r: Response) => (await r.json()) as Record<string, any>;

const DEFAULTS = {
  enabled: true, idleMinutes: 10, absoluteHours: 12, criticalOnPhone: 'step_up',
  sections: ['logins', 'devices', 'contacts', 'locations', 'vault'],
};

let su: ReturnType<typeof superuserSql>;

async function plantSession(
  userId: string,
  opts: { field?: boolean; idleMinutes?: number; ageHours?: number } = {},
) {
  const token = randomBytes(32).toString('base64url');
  await su`
    INSERT INTO auth_session (session_token, user_id, expires, created_at, last_seen_at, field_mode)
    VALUES (${storedSessionToken(token)}, ${userId}::uuid, now() + interval '1 day',
            now() - make_interval(hours => ${opts.ageHours ?? 0}),
            now() - make_interval(mins => ${opts.idleMinutes ?? 0}),
            ${opts.field ?? false})
  `;
  return token;
}
const fieldFlag = async (token: string) =>
  (await su<{ field_mode: boolean }[]>`SELECT field_mode FROM auth_session WHERE session_token = ${storedSessionToken(token)}`)[0]
    ?.field_mode;

beforeAll(async () => {
  resetDatabase();
  connectPools();
  su = superuserSql();
  useSessionResolver(async () => currentUser);
  await setLocalPassword({
    userId: IDS.admin1,
    password: ADMIN_PASSWORD,
    context: { email: ADMIN_EMAIL, name: 'Admin' },
    reason: 'test setup',
    connection: 'auth',
  });
}, 180_000);

afterEach(async () => {
  currentUser = null;
  await su`DELETE FROM field_view_policy`;
  await su`DELETE FROM session_policy`;
  await su`DELETE FROM auth_session`;
  await su`DELETE FROM auth_attempt`;
  await su`UPDATE local_credential SET locked_until = NULL, failed_attempts = 0`;
});

afterAll(async () => {
  await su.end({ timeout: 5 });
  await disconnectPools();
});

describe('the Mobile access settings', () => {
  it('reads the defaults until somebody saves, then what they saved, with an audit row', async () => {
    asAdmin();
    expect((await body(await getPolicy(request('GET', '/api/tenant/field-view'), noParams))).policy)
      .toMatchObject(DEFAULTS);

    const saved = {
      enabled: true, idleMinutes: 5, absoluteHours: 4, criticalOnPhone: 'block', sections: ['logins', 'contacts'],
    };
    const put = await putPolicy(request('PUT', '/api/tenant/field-view', { payload: saved }), noParams);
    expect(put.status).toBe(200);
    expect((await body(put)).policy).toMatchObject(saved);

    const audits = await su`SELECT 1 FROM audit_log WHERE action = 'field_view_policy.updated'`;
    expect(audits.length).toBeGreaterThan(0);
  });

  it('refuses a value outside the bounds, or a section that does not exist', async () => {
    asAdmin();
    for (const bad of [{ idleMinutes: 1 }, { absoluteHours: 100 }, { sections: ['billing'] }, { criticalOnPhone: 'maybe' }]) {
      const r = await putPolicy(request('PUT', '/api/tenant/field-view', { payload: { ...DEFAULTS, ...bad } }), noParams);
      expect(r.status).toBe(400);
    }
  });

  it('is not a technician’s to change', async () => {
    asTech();
    const r = await putPolicy(request('PUT', '/api/tenant/field-view', { payload: DEFAULTS }), noParams);
    expect(r.status).toBe(403);
  });
});

describe('a Field view session is read-only on the server', () => {
  it('may read, and may not write, whatever route it calls', async () => {
    asAdmin();
    const token = await plantSession(IDS.admin1, { field: true });

    const read = await listOrganizations(request('GET', '/api/organizations', { token }), noParams);
    expect(read.status).toBe(200);

    const write = await createOrganization(request('POST', '/api/organizations', {
      token,
      payload: { slug: 'from-phone', name: 'From phone', status: 'active', relationship: 'client', timezone: 'UTC' },
    }), noParams);
    expect(write.status).toBe(403);
    expect(JSON.stringify(await body(write))).toMatch(/read-only/);
    expect(await su`SELECT 1 FROM organization WHERE slug = 'from-phone'`).toHaveLength(0);
  });

  it('leaves an ordinary session alone', async () => {
    asAdmin();
    const token = await plantSession(IDS.admin1);
    const write = await createOrganization(request('POST', '/api/organizations', {
      token,
      payload: { slug: 'from-desk', name: 'From desk', status: 'active', relationship: 'client', timezone: 'UTC' },
    }), noParams);
    expect(write.status).toBeLessThan(300);
  });
});

describe('the routes that find the signed-in person their own way', () => {
  // These three authenticate through getServerIdentity(), not the API's
  // identity resolver, so the read-only rule has to be applied by hand in
  // each. tests/unit/field-routes.test.ts keeps that list honest.
  it('will not issue a reset link for a colleague from Field view', async () => {
    asAdmin();
    const token = await plantSession(IDS.admin1, { field: true });
    const r = await resetRoute(request('POST', '/api/auth/local/reset', {
      token, payload: { email: 'tech1@northwind.test', outOfBand: true },
    }));
    expect(r.status).toBe(403);
    expect(JSON.stringify(await body(r))).toMatch(/read-only/);
    expect(await su`SELECT 1 FROM password_reset`).toHaveLength(0);
  });

  it('will not set up, confirm or remove an authenticator from Field view', async () => {
    asAdmin();
    const token = await plantSession(IDS.admin1, { field: true });
    for (const action of ['start', 'confirm', 'recovery']) {
      const r = await totpRoute(request('POST', '/api/account/totp', { token, payload: { action, code: '000000' } }));
      expect(r.status, action).toBe(403);
    }
    const removed = await totpDelete(request('DELETE', '/api/account/totp', { token, payload: { password: ADMIN_PASSWORD } }));
    expect(removed.status).toBe(403);
    expect(await su`SELECT 1 FROM local_totp WHERE user_id = ${IDS.admin1}::uuid`).toHaveLength(0);
  });

  it('will not change the password from Field view, even with the current one', async () => {
    asAdmin();
    const token = await plantSession(IDS.admin1, { field: true });
    const r = await changePassword(request('POST', '/api/auth/local/change-password', {
      token, payload: { currentPassword: ADMIN_PASSWORD, newPassword: 'twenty-one silver bicycles' },
    }));
    expect(r.status).toBe(403);
  });

  it('will not hand an export to a Field view session, though it is a GET', async () => {
    asAdmin();
    const token = await plantSession(IDS.admin1, { field: true });
    const id = '11111111-2222-4333-8444-555555555555';
    const r = await downloadExport(
      request('GET', `/api/exports/${id}/download`, { token }),
      { params: Promise.resolve({ exportJobId: id }) } as never,
    );
    expect(r.status).toBe(403);
    expect(JSON.stringify(await body(r))).toMatch(/Field view/);
  });
});

describe('entering and leaving Field view', () => {
  it('enters with nothing but the session', async () => {
    asAdmin();
    const token = await plantSession(IDS.admin1);
    const r = await enterField(request('POST', '/api/auth/field/enter', { token }));
    expect(r.status).toBe(200);
    expect(await fieldFlag(token)).toBe(true);
  });

  it('will not enter when an administrator switched Field view off', async () => {
    asAdmin();
    await su`INSERT INTO field_view_policy (tenant_id, enabled) VALUES (${IDS.tenant1}::uuid, false)`;
    const token = await plantSession(IDS.admin1);
    const r = await enterField(request('POST', '/api/auth/field/enter', { token }));
    expect(r.status).toBe(403);
    expect(await fieldFlag(token)).toBe(false);
  });

  it('stays in Field view on a wrong password', async () => {
    asAdmin();
    const token = await plantSession(IDS.admin1, { field: true });
    const r = await upgradeField(request('POST', '/api/auth/field/upgrade', {
      token, payload: { password: 'not the password' },
    }));
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await fieldFlag(token)).toBe(true);
  });

  it('leaves for the full site with the password, and may then write', async () => {
    asAdmin();
    const token = await plantSession(IDS.admin1, { field: true });
    const r = await upgradeField(request('POST', '/api/auth/field/upgrade', {
      token, payload: { password: ADMIN_PASSWORD },
    }));
    expect(r.status).toBe(200);
    expect(await fieldFlag(token)).toBe(false);

    const write = await createOrganization(request('POST', '/api/organizations', {
      token,
      payload: { slug: 'after-upgrade', name: 'After upgrade', status: 'active', relationship: 'client', timezone: 'UTC' },
    }), noParams);
    expect(write.status).toBeLessThan(300);
  });
});

describe('phone sessions have their own limits', () => {
  it('ends a phone session idle past the Field view timeout, and not a desk session', async () => {
    const phone = await plantSession(IDS.admin1, { field: true, idleMinutes: 11 });
    const desk = await plantSession(IDS.admin1, { idleMinutes: 11 });
    expect(await enforceSessionPolicy(phone)).toBe('idle');
    expect(await fieldFlag(phone)).toBeUndefined();
    expect(await enforceSessionPolicy(desk)).toBe('live');
  });

  it('ends a phone session older than the Field view lifetime, however active', async () => {
    const phone = await plantSession(IDS.admin1, { field: true, ageHours: 13 });
    expect(await enforceSessionPolicy(phone)).toBe('expired');
  });

  it('follows what the administrator set', async () => {
    await su`INSERT INTO field_view_policy (tenant_id, idle_minutes) VALUES (${IDS.tenant1}::uuid, 30)`;
    const phone = await plantSession(IDS.admin1, { field: true, idleMinutes: 20 });
    expect(await enforceSessionPolicy(phone)).toBe('live');
  });
});
