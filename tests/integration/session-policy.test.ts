/**
 * The session policy (0890): an administrator sets the idle timeout, the
 * absolute lifetime, the step-up window and the lockout, and every session is
 * held to the strictest policy of the tenants its person belongs to.
 *
 * What is asserted is the enforcement, not the arithmetic: a session idle past
 * the timeout or older than the limit is ENDED when it is read (deleted, not
 * merely refused), a live one is touched, the lockout follows the threshold,
 * and only somebody with tenant:write may change any of it or sign everybody
 * out.
 */
import { NextRequest } from 'next/server';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { enforceSessionPolicy } from '../../src/lib/auth/session-policy';
import { attemptLocalLogin, setLocalPassword } from '../../src/lib/auth/local';
import { GET as getPolicy, PUT as putPolicy } from '../../src/app/api/auth/session-policy/route';
import { POST as endSessions } from '../../src/app/api/auth/session-policy/end-sessions/route';
import { connectPools, disconnectPools, IDS, resetDatabase, superuserSql } from './harness';

let currentUser: SessionUser | null = null;
const asUser = (id: string, email: string) => { currentUser = { id, email }; };

const request = (method: string, payload?: unknown) =>
  new NextRequest(new Request('https://helm.test/api/auth/session-policy', {
    method,
    headers: { 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  }));
const noParams = { params: Promise.resolve({}) };
const body = async (r: Response) => (await r.json()) as Record<string, unknown>;

const DEFAULTS = {
  idleMinutes: 480, absoluteHours: null, stepUpMinutes: 15, lockoutThreshold: 5, lockoutMaxMinutes: 15,
  requireLocalTotp: false,
};

let su: ReturnType<typeof superuserSql>;

/** A session row as Auth.js or the local sign-in would write it, aged as asked. */
async function plantSession(userId: string, ages: { idleMinutes?: number; ageHours?: number } = {}) {
  const token = randomBytes(32).toString('base64url');
  await su`
    INSERT INTO auth_session (session_token, user_id, expires, created_at, last_seen_at)
    VALUES (${token}, ${userId}::uuid, now() + interval '1 day',
            now() - make_interval(hours => ${ages.ageHours ?? 0}),
            now() - make_interval(mins => ${ages.idleMinutes ?? 0}))
  `;
  return token;
}
const exists = async (token: string) =>
  (await su`SELECT 1 FROM auth_session WHERE session_token = ${token}`).length === 1;

beforeAll(async () => {
  resetDatabase();
  connectPools();
  su = superuserSql();
  useSessionResolver(async () => currentUser);
}, 180_000);

afterEach(async () => {
  currentUser = null;
  await su`DELETE FROM session_policy`;
  await su`DELETE FROM auth_session`;
});

afterAll(async () => {
  await su.end({ timeout: 5 });
  await disconnectPools();
});

describe('setting it', () => {
  it('reads the defaults until somebody saves, then what they saved', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    expect((await body(await getPolicy(request('GET'), noParams))).policy).toMatchObject(DEFAULTS);

    const saved = {
      idleMinutes: 30, absoluteHours: 12, stepUpMinutes: 10, lockoutThreshold: 4, lockoutMaxMinutes: 60,
      requireLocalTotp: true,
    };
    const put = await putPolicy(request('PUT', saved), noParams);
    expect(put.status).toBe(200);
    expect((await body(put)).policy).toMatchObject(saved);
  });

  it('refuses a value outside the bounds, saying so', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    expect((await putPolicy(request('PUT', { ...DEFAULTS, idleMinutes: 2 }), noParams)).status).toBe(400);
  });

  it('is not a technician’s to change', async () => {
    asUser(IDS.tech1, 'tech1@northwind.test');
    expect((await putPolicy(request('PUT', DEFAULTS), noParams)).status).toBe(403);
  });
});

describe('enforcing it when a session is read', () => {
  it('keeps a live session, and moves its last-seen time forward when it is stale', async () => {
    const token = await plantSession(IDS.admin1, { idleMinutes: 5 });
    expect(await enforceSessionPolicy(token)).toBe('live');
    const [row] = await su<{ fresh: boolean }[]>`
      SELECT now() - last_seen_at < interval '10 seconds' AS fresh FROM auth_session WHERE session_token = ${token}`;
    expect(row!.fresh).toBe(true);
  });

  it('ends a session idle past the timeout', async () => {
    await su`INSERT INTO session_policy (tenant_id, idle_minutes) VALUES (${IDS.tenant1}::uuid, 30)`;
    const idle = await plantSession(IDS.admin1, { idleMinutes: 31 });
    const active = await plantSession(IDS.admin1, { idleMinutes: 29 });
    expect(await enforceSessionPolicy(idle)).toBe('idle');
    expect(await exists(idle)).toBe(false);
    expect(await enforceSessionPolicy(active)).toBe('live');
  });

  it('ends a session older than the absolute limit, however active', async () => {
    await su`INSERT INTO session_policy (tenant_id, absolute_hours) VALUES (${IDS.tenant1}::uuid, 12)`;
    const old = await plantSession(IDS.admin1, { ageHours: 13 });
    expect(await enforceSessionPolicy(old)).toBe('expired');
    expect(await exists(old)).toBe(false);
  });

  it('leaves a person alone whom no tenant of theirs has limited', async () => {
    // Tenant 2's policy does not reach somebody who is only in tenant 1.
    await su`INSERT INTO session_policy (tenant_id, idle_minutes) VALUES (${IDS.tenant2}::uuid, 5)`;
    const token = await plantSession(IDS.admin1, { idleMinutes: 60 });
    expect(await enforceSessionPolicy(token)).toBe('live');
  });

  it('says a session that is not there is missing', async () => {
    expect(await enforceSessionPolicy('not-a-session-token-at-all-0123456789')).toBe('missing');
  });
});

describe('the lockout', () => {
  it('follows the threshold the policy sets', async () => {
    await su`INSERT INTO session_policy (tenant_id, lockout_threshold) VALUES (${IDS.tenant1}::uuid, 3)`;
    await setLocalPassword({ userId: IDS.admin1, password: 'seventeen purple lanterns' });
    try {
      for (let i = 0; i < 3; i += 1) {
        await attemptLocalLogin({ email: 'admin@northwind.test', password: `wrong ${i}`, ip: '203.0.113.9' });
      }
      const [row] = await su<{ locked: boolean }[]>`
        SELECT locked_until IS NOT NULL AS locked FROM local_credential WHERE user_id = ${IDS.admin1}::uuid`;
      expect(row!.locked).toBe(true);
    } finally {
      await su`DELETE FROM local_credential WHERE user_id = ${IDS.admin1}::uuid`;
      await su`DELETE FROM auth_attempt`;
    }
  });
});

describe('signing everybody else out', () => {
  it('ends every other member’s sessions and keeps the caller’s own', async () => {
    const mine = await plantSession(IDS.admin1);
    const theirs = await plantSession(IDS.tech1);
    const otherTenant = await plantSession(IDS.admin2);

    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await endSessions(request('POST'), noParams);
    expect(response.status).toBe(200);
    expect((await body(response)).ended).toBe(1);

    expect(await exists(mine)).toBe(true);
    expect(await exists(theirs)).toBe(false);
    expect(await exists(otherTenant), 'another tenant’s people are not this tenant’s to sign out').toBe(true);
  });

  it('is not a technician’s to do', async () => {
    asUser(IDS.tech1, 'tech1@northwind.test');
    expect((await endSessions(request('POST'), noParams)).status).toBe(403);
  });
});
