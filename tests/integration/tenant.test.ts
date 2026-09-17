/**
 * Renaming the MSP itself.
 *
 * `tenant_rls_update` has existed since 0200 and has always been gated on
 * `tenant:write`, a permission only `super_admin` holds. Nothing had ever
 * exercised it, so these tests are the first thing to find out whether the
 * policy does what it says.
 *
 * The interesting subject is tier3: it holds every permission except
 * organization:delete, tenant:write and key:rotate, so it can do almost
 * everything else in this product and must still be refused here.
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

import { PATCH as patchTenant } from '../../src/app/api/tenant/route';

let h: Harness;
let currentUser: SessionUser | null = null;
const asUser = (id: string, email: string) => {
  currentUser = { id, email };
};

const patch = (payload: unknown) =>
  new NextRequest(
    new Request('http://helm.test/api/tenant', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );

const body = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

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

async function tenantRow(id: string) {
  const sql = superuserSql();
  try {
    const [row] = await sql<{ name: string; slug: string }[]>`
      SELECT name, slug FROM tenant WHERE id = ${id}::uuid
    `;
    return row!;
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

describe('PATCH /api/tenant', () => {
  it('renames the MSP', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await patchTenant(patch({ name: 'Northwind Managed Services LLC' }));
    expect(response.status).toBe(200);
    expect(((await body(response)).tenant as { name: string }).name).toBe(
      'Northwind Managed Services LLC',
    );
    expect((await tenantRow(IDS.tenant1)).name).toBe('Northwind Managed Services LLC');
  });

  it('leaves the slug alone', async () => {
    // The slug is what memberships and audit rows resolve through. A rebrand
    // must not invalidate a year of history.
    const before = await tenantRow(IDS.tenant1);

    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await patchTenant(
      patch({ name: 'Renamed Again', slug: 'renamed-again', tenantSlug: 'renamed-again' }),
    );
    expect(response.status).toBe(200);

    const after = await tenantRow(IDS.tenant1);
    expect(after.name).toBe('Renamed Again');
    expect(after.slug).toBe(before.slug);
  });

  it('refuses tier3, which holds almost everything else', async () => {
    await setTechRole('tier3');
    const before = await tenantRow(IDS.tenant1);

    asUser(IDS.tech1, 'tech1@northwind.test');
    const response = await patchTenant(patch({ name: 'Should Not Apply' }));
    expect(response.status).toBe(403);

    expect((await tenantRow(IDS.tenant1)).name).toBe(before.name);
  });

  it('refuses a client-side role', async () => {
    asUser(IDS.acmeAdmin, 'it@acme.test');
    expect((await patchTenant(patch({ name: 'Client Takeover' }))).status).toBe(403);
  });

  it('cannot reach another tenant', async () => {
    // admin2 is a super_admin — of tenant 2. The policy scopes the UPDATE to
    // the caller's own tenant, so tenant 1 is untouched and tenant 2 is what
    // changes.
    const before1 = await tenantRow(IDS.tenant1);

    asUser(IDS.admin2, 'admin@rival.test');
    const response = await patchTenant(patch({ name: 'Rival Renamed' }));
    expect(response.status).toBe(200);

    expect((await tenantRow(IDS.tenant1)).name).toBe(before1.name);
    expect((await tenantRow(IDS.tenant2)).name).toBe('Rival Renamed');
  });

  it('refuses an empty patch', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    expect((await patchTenant(patch({}))).status).toBe(400);
  });
});
