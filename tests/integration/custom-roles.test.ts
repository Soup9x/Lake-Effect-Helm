/**
 * Custom roles (0830): a tenant defines a role permission by permission.
 *
 *   1. ONLY tenant:write DEFINES ROLES, and a role is visible only inside the
 *      tenant that made it.
 *   2. A ROLE IS EXACTLY ITS PERMISSIONS. The person who holds it gets those
 *      and nothing else, and an edit reaches them on their next request.
 *   3. NOBODY HANDS OUT WHAT THEY DO NOT HOLD. The rank rule (0350) is not
 *      enough once roles are custom: a tier3 holds user:write but not
 *      tenant:write, and must not be able to assign a low-rank role that
 *      carries it — to anybody, themselves included.
 *   4. A ROLE CANNOT CROSS TENANTS, even by key, even through the functions
 *      that read past row-level security.
 *   5. THE GUARD RAILS HOLD: access level bounds, MSP-only permissions off
 *      client roles, unique names, no deleting a role somebody holds.
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { withTenant } from '../../src/lib/db/client';
import { getServerIdentity } from '../../src/lib/auth/server-identity';
import { connectPools, disconnectPools, IDS, resetDatabase, superuserSql } from './harness';
import { GET as listRoute, POST as createRoute } from '../../src/app/api/roles/route';
import { DELETE as deleteRoute, PUT as updateRoute } from '../../src/app/api/roles/[roleKey]/route';
import { GET as usersRoute, POST as inviteRoute } from '../../src/app/api/users/route';
import { PATCH as patchUser } from '../../src/app/api/users/[userId]/route';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

const TIER3_ID = '1b000000-0000-0000-0000-0000000000a3';
let currentUser: SessionUser | null = null;
const ADMIN: SessionUser = { id: IDS.admin1, email: 'admin@northwind.test' };
const TECH: SessionUser = { id: IDS.tech1, email: 'tech1@northwind.test' };
const TIER3: SessionUser = { id: TIER3_ID, email: 'tier3@northwind.test' };
const ADMIN2: SessionUser = { id: IDS.admin2, email: 'admin@contoso.test' };

const req = (method: string, url: string, payload?: unknown) =>
  new NextRequest(new Request(`http://helm.test${url}`, {
    method,
    ...(payload === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
  }));
const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) });
async function read(response: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  const raw = await response.text();
  return { status: response.status, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} };
}
async function permissionsOf(tenantId: string, actorId: string): Promise<string[]> {
  return withTenant({ tenantId, actorId, actorType: 'user' }, async (_tx, session) => [...session.permissions].sort());
}

let networkKey = '';
let sneakyKey = '';

beforeAll(async () => {
  resetDatabase();
  // A tier3 for the escalation cases: user:write, no tenant:write. Written as
  // the superuser with no session, which is what bootstrap looks like.
  const sql = superuserSql();
  try {
    await sql`INSERT INTO app_user (id, email, name) VALUES (${TIER3_ID}, 'tier3@northwind.test', 'Tier Three')`;
    await sql`INSERT INTO membership (tenant_id, user_id, role_key, org_scope_all, org_scope, require_step_up)
              VALUES (${IDS.tenant1}, ${TIER3_ID}, 'tier3', true, NULL, false)`;
  } finally {
    await sql.end({ timeout: 5 });
  }
  connectPools();
  useSessionResolver(async () => currentUser);
}, 120_000);
afterAll(async () => { await disconnectPools(); });

describe('defining a role', () => {
  it('is tenant:write only', async () => {
    for (const who of [TECH, TIER3]) {
      currentUser = who;
      const { status } = await read(await createRoute(req('POST', '/api/roles', {
        name: 'Nope', rank: 40, mspStaff: true, permissions: ['asset:read'],
      })));
      expect(status, who.email).toBe(403);
    }
  });

  it('creates a role with exactly the permissions chosen, audited', async () => {
    currentUser = ADMIN;
    const created = await read(await createRoute(req('POST', '/api/roles', {
      name: 'Network Engineer', description: 'Networks and the credentials for them.',
      rank: 60, mspStaff: true, permissions: ['asset:read', 'secret:read', 'asset:read'],
    })));
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    networkKey = created.body.key as string;
    expect(networkKey).toMatch(/^custom_[a-z0-9]+$/);

    const list = await read(await listRoute(req('GET', '/api/roles')));
    const role = (list.body.roles as { key: string; permissions: string[]; isCustom: boolean; holders: number }[])
      .find((r) => r.key === networkKey);
    expect(role).toMatchObject({ isCustom: true, holders: 0, permissions: ['asset:read', 'secret:read'] });
    expect((list.body.permissions as unknown[]).length).toBeGreaterThan(20);

    const sql = superuserSql();
    try {
      const [audit] = await sql<{ metadata: { key: string; permissions: string[] } }[]>`
        SELECT metadata FROM audit_log WHERE action = 'role.created' ORDER BY occurred_at DESC LIMIT 1`;
      expect(audit!.metadata).toMatchObject({ key: networkKey, permissions: ['asset:read', 'secret:read'] });
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('is invisible to another tenant', async () => {
    currentUser = ADMIN2;
    const list = await read(await listRoute(req('GET', '/api/roles')));
    expect((list.body.roles as { key: string }[]).map((r) => r.key)).not.toContain(networkKey);
    const rows = await withTenant({ tenantId: IDS.tenant2, actorId: IDS.admin2, actorType: 'user' }, (tx) =>
      tx`SELECT key FROM app_role WHERE key = ${networkKey}`);
    expect(rows).toHaveLength(0);
    const perms = await withTenant({ tenantId: IDS.tenant2, actorId: IDS.admin2, actorType: 'user' }, (tx) =>
      tx`SELECT 1 FROM role_permission WHERE role_key = ${networkKey}`);
    expect(perms).toHaveLength(0);
  });

  it('refuses what the guard rails forbid', async () => {
    currentUser = ADMIN;
    const cases: [unknown, number][] = [
      [{ name: 'Client with export', rank: 30, mspStaff: false, permissions: ['secret:export'] }, 403], // MSP-only on a client role
      [{ name: 'Client too high', rank: 40, mspStaff: false, permissions: [] }, 400],                    // client ceiling is 30
      [{ name: 'Staff too low', rank: 20, mspStaff: true, permissions: [] }, 400],                       // staff floor is 40
      [{ name: 'Tier 2 Technician', rank: 60, mspStaff: true, permissions: [] }, 409],                   // a built-in name
      [{ name: 'network engineer', rank: 60, mspStaff: true, permissions: [] }, 409],                    // its own, any case
      [{ name: 'Made up', rank: 60, mspStaff: true, permissions: ['asset:fly'] }, 400],                  // no such permission
    ];
    for (const [payload, expected] of cases) {
      const { status, body } = await read(await createRoute(req('POST', '/api/roles', payload)));
      expect(status, `${JSON.stringify(payload)} → ${JSON.stringify(body)}`).toBe(expected);
    }
  });
});

describe('holding a role', () => {
  it('gives exactly its permissions, and an edit reaches the holder on the next request', async () => {
    currentUser = ADMIN;
    const assigned = await read(await patchUser(req('PATCH', `/api/users/${IDS.tech1}`, { roleKey: networkKey }), params({ userId: IDS.tech1 })));
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    expect(await permissionsOf(IDS.tenant1, IDS.tech1)).toEqual(['asset:read', 'secret:read']);

    // And they can still sign in. The membership lookup runs before a tenant
    // is chosen, where app_role's policy hides custom roles; joining it there
    // would have matched no membership and refused the holder at the door.
    currentUser = TECH;
    const identity = await getServerIdentity();
    expect(identity.roleKey).toBe(networkKey);
    expect(identity.memberships.find((m) => m.tenantId === IDS.tenant1)?.roleName).toBe('Network Engineer');
    currentUser = ADMIN;

    const edited = await read(await updateRoute(req('PUT', `/api/roles/${networkKey}`, {
      name: 'Network Engineer', description: '', rank: 60, permissions: ['asset:read', 'asset:write'],
    }), params({ roleKey: networkKey })));
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(await permissionsOf(IDS.tenant1, IDS.tech1)).toEqual(['asset:read', 'asset:write']);

    const sql = superuserSql();
    try {
      const [audit] = await sql<{ metadata: { added: string[]; removed: string[] } }[]>`
        SELECT metadata FROM audit_log WHERE action = 'role.updated' ORDER BY occurred_at DESC LIMIT 1`;
      expect(audit!.metadata).toMatchObject({ added: ['asset:write'], removed: ['secret:read'] });
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('cannot be deleted while somebody holds it', async () => {
    currentUser = ADMIN;
    const refused = await read(await deleteRoute(req('DELETE', `/api/roles/${networkKey}`), params({ roleKey: networkKey })));
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/still held by 1 member/);
  });

  it('built-in roles are not editable', async () => {
    currentUser = ADMIN;
    expect((await updateRoute(req('PUT', '/api/roles/tier2', { name: 'x', rank: 60, permissions: [] }), params({ roleKey: 'tier2' }))).status).toBe(400);
  });
});

describe('no escalation through a custom role', () => {
  it('a tier3 cannot assign a role that carries a permission they lack — not even a low-ranked one', async () => {
    currentUser = ADMIN;
    const sneaky = await read(await createRoute(req('POST', '/api/roles', {
      name: 'Quiet Administrator', rank: 40, mspStaff: true, permissions: ['asset:read', 'tenant:write'],
    })));
    expect(sneaky.status, JSON.stringify(sneaky.body)).toBe(200);
    sneakyKey = sneaky.body.key as string;

    currentUser = TIER3;
    // Not offered...
    const users = await read(await usersRoute(req('GET', '/api/users')));
    const offered = (users.body.grantableRoles as { key: string }[]).map((r) => r.key);
    expect(offered).toContain(networkKey);
    expect(offered).not.toContain(sneakyKey);
    // ...and not accepted, for somebody else or by invitation.
    const onOther = await read(await patchUser(req('PATCH', `/api/users/${IDS.tech1}`, { roleKey: sneakyKey }), params({ userId: IDS.tech1 })));
    expect(onOther.status).toBe(403);
    expect(JSON.stringify(onOther.body)).toMatch(/tenant:write/);
    const invited = await read(await inviteRoute(req('POST', '/api/users', { email: 'new@northwind.test', roleKey: sneakyKey, orgScopeAll: true })));
    expect(invited.status).toBe(403);
    // ...and not for themselves either, even straight at the table.
    await expect(withTenant({ tenantId: IDS.tenant1, actorId: TIER3_ID, actorType: 'user' }, (tx) =>
      tx`UPDATE membership SET role_key = ${sneakyKey} WHERE user_id = ${TIER3_ID}::uuid`)).rejects.toThrow(/permissions you do not hold/);
    expect(await permissionsOf(IDS.tenant1, TIER3_ID)).not.toContain('tenant:write');
  });

  it('a tier3 cannot define one either, and an admin cannot give a role more than they hold', async () => {
    currentUser = TIER3;
    expect((await createRoute(req('POST', '/api/roles', { name: 'Mine', rank: 80, mspStaff: true, permissions: [] }))).status).toBe(403);
    // Straight at the function, past the route's permission check.
    await expect(withTenant({ tenantId: IDS.tenant1, actorId: TIER3_ID, actorType: 'user' }, (tx) =>
      tx`SELECT helm.create_custom_role('Mine', '', 80, true, ARRAY['asset:read'])`)).rejects.toThrow(/tenant:write is required/);
    // And the catalogue itself stays closed to the request role.
    await expect(withTenant({ tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' }, (tx) =>
      tx`INSERT INTO app_role (key, name, description, rank, is_tenant_wide, is_system, tenant_id)
         VALUES ('custom_direct', 'Direct', '', 40, true, false, ${IDS.tenant1}::uuid)`)).rejects.toThrow(/permission denied/);
  });
});

describe('no crossing tenants', () => {
  it('another tenant cannot assign, edit or delete this tenant\'s role, even by key', async () => {
    currentUser = ADMIN2;
    const invited = await read(await inviteRoute(req('POST', '/api/users', { email: 'x@contoso.test', roleKey: networkKey, orgScopeAll: true })));
    expect(invited.status).toBeGreaterThanOrEqual(400);
    expect((await updateRoute(req('PUT', `/api/roles/${networkKey}`, { name: 'Hijacked', rank: 40, permissions: [] }), params({ roleKey: networkKey }))).status).toBe(404);
    expect((await deleteRoute(req('DELETE', `/api/roles/${networkKey}`), params({ roleKey: networkKey }))).status).toBe(404);

    // The functions that read past RLS are covered by the trigger, which
    // refuses even the superuser.
    const sql = superuserSql();
    try {
      await expect(sql`INSERT INTO membership (tenant_id, user_id, role_key, org_scope_all, org_scope)
                       VALUES (${IDS.tenant2}, ${IDS.tech1}, ${networkKey}, true, NULL)`).rejects.toThrow(/belongs to another tenant/);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

describe('cleaning up', () => {
  it('deletes a role once nobody holds it', async () => {
    currentUser = ADMIN;
    await read(await patchUser(req('PATCH', `/api/users/${IDS.tech1}`, { roleKey: 'tier1' }), params({ userId: IDS.tech1 })));
    const gone = await read(await deleteRoute(req('DELETE', `/api/roles/${networkKey}`), params({ roleKey: networkKey })));
    expect(gone.status, JSON.stringify(gone.body)).toBe(200);
    const list = await read(await listRoute(req('GET', '/api/roles')));
    expect((list.body.roles as { key: string }[]).map((r) => r.key)).not.toContain(networkKey);
  });
});
