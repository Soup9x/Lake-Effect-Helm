/**
 * Users, memberships and role assignment.
 *
 * This is the feature that decides who becomes an administrator, so most of it
 * is about refusals. The one that matters is escalation: `tier3` holds every
 * permission except three, so it holds `user:write`, and the membership
 * policies check only the tenant and that permission. Before 0350 a rank-80
 * technician could mint a rank-100 super_admin membership for themselves.
 *
 * That check lives in a trigger rather than in the route, and these tests drive
 * it through the route to prove the translation is right — a 403 an
 * administrator can act on, rather than a 500 with a Postgres error code.
 */
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import {
  buildHarness,
  connectPools,
  disconnectPools,
  IDS,
  resetDatabase,
  superuserSql,
  type Harness,
} from './harness';

import { GET as listUsers, POST as inviteUser } from '../../src/app/api/users/route';
import { DELETE as revokeUser, PATCH as patchUser } from '../../src/app/api/users/[userId]/route';

let h: Harness;
let currentUser: SessionUser | null = null;
const asUser = (id: string, email: string) => {
  currentUser = { id, email };
};

const request = (url: string, init: RequestInit = {}) =>
  new NextRequest(new Request(`http://helm.test${url}`, init));

const send = (method: string) => (url: string, payload: unknown) =>
  request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
const post = send('POST');
const patch = send('PATCH');

const body = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

const withParams = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

/** Put tech1 on a given role, out of band, so a test can act AS that rank. */
async function setTechRole(roleKey: string): Promise<void> {
  const sql = superuserSql();
  try {
    await sql`
      UPDATE membership SET role_key = ${roleKey}
      WHERE tenant_id = ${IDS.tenant1}::uuid AND user_id = ${IDS.tech1}::uuid
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

beforeAll(async () => {
  resetDatabase();
  connectPools();
  h = buildHarness();
  resetServices();
  setKekProvider(h.kek);
  useSessionResolver(async () => currentUser);
  await h.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'test provisioning' });
}, 120_000);

afterEach(() => {
  currentUser = null;
});

afterAll(async () => {
  await disconnectPools();
});

describe('GET /api/users', () => {
  it('lists this tenant only, and offers no role above the caller', async () => {
    await setTechRole('tier3');
    asUser(IDS.tech1, 'tech@northwind.test');

    const response = await listUsers(request('/api/users'));
    expect(response.status).toBe(200);
    const payload = await body(response);

    const members = payload.members as { email: string }[];
    // admin2 belongs to tenant 2 and must not appear.
    expect(members.map((m) => m.email)).not.toContain('admin@rival.test');

    // tier3 ranks 80, so super_admin (100) must not be on the menu.
    const roles = payload.grantableRoles as { key: string; rank: number }[];
    expect(payload.myRank).toBe(80);
    expect(roles.map((r) => r.key)).not.toContain('super_admin');
    expect(roles.every((r) => r.rank <= 80)).toBe(true);
  });

  it('never marks the caller as editable', async () => {
    await setTechRole('tier3');
    asUser(IDS.tech1, 'tech@northwind.test');
    const payload = await body(await listUsers(request('/api/users')));
    const me = (payload.members as { userId: string; editable: boolean }[]).find(
      (m) => m.userId === IDS.tech1,
    );
    expect(me?.editable).toBe(false);
  });

  it('refuses a role without user:read', async () => {
    asUser(IDS.acmeViewer, 'viewer@acme.test');
    expect((await listUsers(request('/api/users'))).status).toBe(403);
  });
});

describe('POST /api/users — escalation', () => {
  it('REFUSES a rank-80 actor granting super_admin', async () => {
    // The whole reason 0350 exists.
    await setTechRole('tier3');
    asUser(IDS.tech1, 'tech@northwind.test');

    const response = await inviteUser(
      post('/api/users', {
        email: 'escalation@northwind.test',
        roleKey: 'super_admin',
        orgScopeAll: true,
      }),
    );
    expect(response.status).toBe(403);

    const sql = superuserSql();
    try {
      const [row] = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM membership m
        JOIN app_user u ON u.id = m.user_id
        WHERE u.email = 'escalation@northwind.test'
      `;
      expect(row!.n).toBe('0');
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('refuses promoting an EXISTING membership past the actor', async () => {
    await setTechRole('tier3');
    asUser(IDS.tech1, 'tech@northwind.test');

    const response = await patchUser(
      patch(`/api/users/${IDS.acmeAdmin}`, { roleKey: 'super_admin', orgScopeAll: true }),
      withParams({ userId: IDS.acmeAdmin }),
    );
    expect(response.status).toBe(403);

    const sql = superuserSql();
    try {
      const [row] = await sql<{ role_key: string }[]>`
        SELECT role_key FROM membership WHERE user_id = ${IDS.acmeAdmin}::uuid
      `;
      expect(row!.role_key).toBe('client_admin');
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('allows granting at and below the actor rank', async () => {
    await setTechRole('tier3');
    asUser(IDS.tech1, 'tech@northwind.test');
    const atRank = await inviteUser(
      post('/api/users', { email: 'peer@northwind.test', roleKey: 'tier3', orgScopeAll: true }),
    );
    expect(atRank.status).toBe(200);

    asUser(IDS.tech1, 'tech@northwind.test');
    const below = await inviteUser(
      post('/api/users', { email: 'junior@northwind.test', roleKey: 'tier1', orgScopeAll: true }),
    );
    expect(below.status).toBe(200);
  });
});

describe('POST /api/users — invitations', () => {
  it('attaches a membership to an existing account rather than duplicating it', async () => {
    // One human, one audit trail. Two app_user rows for one person would mean
    // two, which defeats the point of having one.
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await inviteUser(
      post('/api/users', {
        email: 'admin@rival.test', // exists already, in tenant 2
        roleKey: 'tier1',
        orgScopeAll: true,
      }),
    );
    expect(response.status).toBe(200);
    expect((await body(response)).userId).toBe(IDS.admin2);

    const sql = superuserSql();
    try {
      const [row] = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM app_user WHERE email = 'admin@rival.test'
      `;
      expect(row!.n).toBe('1');
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('refuses a second membership in the same tenant', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await inviteUser(
      post('/api/users', { email: 'tech1@northwind.test', roleKey: 'tier1', orgScopeAll: true }),
    );
    expect(response.status).toBe(409);
  });

  it('refuses a client-side role with tenant-wide scope', async () => {
    // A client_admin unpinned is a co-managed customer reading every other
    // customer's documentation.
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await inviteUser(
      post('/api/users', {
        email: 'unpinned@acme.test',
        roleKey: 'client_admin',
        orgScopeAll: true,
      }),
    );
    expect(response.status).toBe(400);
  });

  it('accepts a client-side role pinned to an organisation', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await inviteUser(
      post('/api/users', {
        email: 'pinned@acme.test',
        roleKey: 'client_admin',
        orgScopeAll: false,
        orgScope: [IDS.orgAcme],
      }),
    );
    expect(response.status).toBe(200);
  });

  it('will not make somebody a platform admin', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await inviteUser(
      post('/api/users', {
        email: 'platform@northwind.test',
        roleKey: 'tier1',
        orgScopeAll: true,
        isPlatformAdmin: true,
        is_platform_admin: true,
      }),
    );
    expect(response.status).toBe(200);

    const sql = superuserSql();
    try {
      const [row] = await sql<{ is_platform_admin: boolean }[]>`
        SELECT is_platform_admin FROM app_user WHERE email = 'platform@northwind.test'
      `;
      expect(row!.is_platform_admin).toBe(false);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

describe('PATCH and DELETE /api/users/[userId] — lockout', () => {
  it('refuses to let you change your own access', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await patchUser(
      patch(`/api/users/${IDS.admin1}`, { roleKey: 'tier1' }),
      withParams({ userId: IDS.admin1 }),
    );
    expect(response.status).toBe(403);
  });

  it('refuses to let you revoke your own access', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await revokeUser(
      request(`/api/users/${IDS.admin1}`, { method: 'DELETE' }),
      withParams({ userId: IDS.admin1 }),
    );
    expect(response.status).toBe(403);
  });

  it('lets one administrator revoke another', async () => {
    // Worth stating what this does NOT prove. refuseIfLastAdministrator() is a
    // backstop, not a reachable path: the caller needs user:write to be here at
    // all, and cannot revoke themselves, so at least one administrator always
    // remains and the count never reaches zero. It stays because the self-edit
    // ban above is a product decision that a future change could reverse, and
    // the cost of keeping it is one query.
    const sql = superuserSql();
    try {
      await sql`
        INSERT INTO app_user (id, email, name)
        VALUES ('1b000000-0000-0000-0000-0000000000ff', 'second@northwind.test', 'Second')
        ON CONFLICT (email) DO NOTHING
      `;
      await sql`
        INSERT INTO membership (tenant_id, user_id, role_key, org_scope_all)
        VALUES (${IDS.tenant1}::uuid, '1b000000-0000-0000-0000-0000000000ff'::uuid,
                'super_admin', true)
        ON CONFLICT DO NOTHING
      `;
    } finally {
      await sql.end({ timeout: 5 });
    }

    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await revokeUser(
      request(`/api/users/1b000000-0000-0000-0000-0000000000ff`, { method: 'DELETE' }),
      withParams({ userId: '1b000000-0000-0000-0000-0000000000ff' }),
    );
    expect(response.status).toBe(200);

    const sql2 = superuserSql();
    try {
      const [row] = await sql2<{ status: string }[]>`
        SELECT status::text FROM membership
        WHERE user_id = '1b000000-0000-0000-0000-0000000000ff'::uuid
      `;
      expect(row!.status).toBe('revoked');
    } finally {
      await sql2.end({ timeout: 5 });
    }
  });

  it('revokes rather than deletes, and takes the sessions with it', async () => {
    const sql = superuserSql();
    try {
      await sql`
        INSERT INTO auth_session (session_token, user_id, expires)
        VALUES ('revocation-test-token', ${IDS.acmeViewer}::uuid, now() + interval '1 day')
        ON CONFLICT (session_token) DO NOTHING
      `;
    } finally {
      await sql.end({ timeout: 5 });
    }

    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await revokeUser(
      request(`/api/users/${IDS.acmeViewer}?reason=offboarded`, { method: 'DELETE' }),
      withParams({ userId: IDS.acmeViewer }),
    );
    expect(response.status).toBe(200);

    const sql2 = superuserSql();
    try {
      const [membership] = await sql2<{ status: string; revoked_reason: string | null }[]>`
        SELECT status::text, revoked_reason FROM membership
        WHERE user_id = ${IDS.acmeViewer}::uuid
      `;
      // Kept, so audit rows still resolve to a person with a role.
      expect(membership!.status).toBe('revoked');
      expect(membership!.revoked_reason).toBe('offboarded');

      const [session] = await sql2<{ n: string }[]>`
        SELECT count(*)::text AS n FROM auth_session WHERE user_id = ${IDS.acmeViewer}::uuid
      `;
      expect(session!.n).toBe('0');
    } finally {
      await sql2.end({ timeout: 5 });
    }
  });
});
