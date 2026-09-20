/**
 * Permanent deletion, driven through the routes.
 *
 * db/tests/security.sql §41 covers what the database refuses. This covers what
 * the API says about it, which is a different failure: a rail that raises
 * correctly and surfaces as a bare 500 tells the person the product is broken
 * rather than that they need to archive first.
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import {
  actor, buildHarness, connectPools, disconnectPools, IDS, resetDatabase, superuserSql,
  type Harness,
} from './harness';
import { DELETE as deleteOrganization } from '../../src/app/api/organizations/[organizationId]/route';
import { DELETE as deleteAsset } from '../../src/app/api/assets/[nodeId]/route';

let h: Harness;
let currentUser: SessionUser | null = null;

const del = (url: string, params: Record<string, string>, route: typeof deleteOrganization) =>
  route(
    new NextRequest(new Request(`http://helm.test${url}`, { method: 'DELETE' })),
    { params: Promise.resolve(params) } as never,
  );

const json = async (r: Response) => (await r.json()) as Record<string, any>;

async function su<T>(fn: (sql: ReturnType<typeof superuserSql>) => Promise<T>): Promise<T> {
  const sql = superuserSql();
  try { return await fn(sql); } finally { await sql.end({ timeout: 5 }); }
}

const countOrg = (id: string) =>
  su(async (sql) => {
    const [r] = await sql<{ n: string }[]>`SELECT count(*) AS n FROM organization WHERE id = ${id}::uuid`;
    return Number(r!.n);
  });

beforeAll(async () => {
  resetDatabase();
  connectPools();
  h = buildHarness();
  resetServices();
  setKekProvider(h.kek);
  useSessionResolver(async () => currentUser);
  await h.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'delete tests' });
}, 120_000);

beforeEach(async () => {
  currentUser = { id: IDS.admin1, email: 'admin@northwind.test' };
  await su(async (sql) => {
    await sql`UPDATE organization SET archived_at = NULL`;
    await sql`UPDATE asset_node SET archived_at = NULL`;
    await sql`UPDATE membership SET role_key = 'tier1' WHERE user_id = ${IDS.tech1}::uuid`;
  });
});

afterAll(async () => { await disconnectPools(); });

describe('deleting a client', () => {
  it('refuses a LIVE client, and says what to do about it', async () => {
    const response = await del(`/api/organizations/${IDS.orgGlobex}`,
      { organizationId: IDS.orgGlobex }, deleteOrganization);
    const body = await json(response);

    expect(response.status).toBe(400);
    // Not a 500, and not a bare 403: the rail raises check_violation with
    // DETAIL 'archive_first', and the route turns that into an instruction.
    expect(body.error.message).toMatch(/archive this client first/i);
    expect(await countOrg(IDS.orgGlobex)).toBe(1);
  });

  it('deletes an archived client and everything under it, in one call', async () => {
    await su((sql) => sql`
      UPDATE organization SET archived_at = now() WHERE id = ${IDS.orgAcme}::uuid
    `);

    const response = await del(`/api/organizations/${IDS.orgAcme}`,
      { organizationId: IDS.orgAcme }, deleteOrganization);
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body.deleted).toBe(true);
    // The counts the confirmation dialog quotes back, measured server-side
    // before the rows went.
    expect(body.destroyed.assets).toBeGreaterThan(0);

    expect(await countOrg(IDS.orgAcme)).toBe(0);
    const leftovers = await su(async (sql) => {
      const [r] = await sql<{ assets: string; secrets: string; docs: string }[]>`
        SELECT
          (SELECT count(*) FROM asset_node      WHERE organization_id = ${IDS.orgAcme}::uuid) AS assets,
          (SELECT count(*) FROM secret          WHERE organization_id = ${IDS.orgAcme}::uuid) AS secrets,
          (SELECT count(*) FROM search_document WHERE organization_id = ${IDS.orgAcme}::uuid) AS docs
      `;
      return r!;
    });
    expect(Number(leftovers.assets)).toBe(0);
    expect(Number(leftovers.secrets)).toBe(0);
    expect(Number(leftovers.docs)).toBe(0);

    // The property the whole feature rests on.
    const audit = await su(async (sql) => {
      const [r] = await sql<{ n: string }[]>`
        SELECT count(*) AS n FROM audit_log WHERE organization_id = ${IDS.orgAcme}::uuid
      `;
      return Number(r!.n);
    });
    expect(audit).toBeGreaterThan(0);
  });

  it('refuses an actor without organization:delete even on an archived client', async () => {
    await su(async (sql) => {
      await sql`UPDATE organization SET archived_at = now() WHERE id = ${IDS.orgGlobex}::uuid`;
      await sql`UPDATE membership SET role_key = 'tier3' WHERE user_id = ${IDS.tech1}::uuid`;
    });
    currentUser = { id: IDS.tech1, email: 'tech1@northwind.test' };

    const response = await del(`/api/organizations/${IDS.orgGlobex}`,
      { organizationId: IDS.orgGlobex }, deleteOrganization);

    // tier3 holds every permission but three, and organization:delete is one of
    // them. Archiving needs only asset:write, which it has.
    expect(response.status).toBe(403);
    expect(await countOrg(IDS.orgGlobex)).toBe(1);
  });
});

describe('deleting a credential', () => {
  let nodeId: string;
  let orgId: string;

  beforeEach(async () => {
    // Its own client, created per test. The suite above deletes Acme, and a
    // fixture shared with a test that destroys it makes the order load-bearing.
    orgId = await su(async (sql) => {
      const [org] = await sql<{ id: string }[]>`
        INSERT INTO organization (tenant_id, slug, name)
        VALUES (${IDS.tenant1}::uuid, ${'zz-' + Math.random().toString(36).slice(2, 10)},
                'ZZ Delete Fixture')
        RETURNING id
      `;
      return org!.id;
    });

    const created = await h.secrets.create(
      actor(IDS.tenant1, IDS.admin1),
      { organizationId: orgId, kind: 'password', label: 'deletable credential' },
      'a-stored-value',
    );
    nodeId = await su(async (sql) => {
      const [node] = await sql<{ id: string }[]>`
        INSERT INTO asset_node (tenant_id, organization_id, node_type, name)
        VALUES (${IDS.tenant1}::uuid, ${orgId}::uuid, 'credential', 'deletable credential')
        RETURNING id
      `;
      await sql`
        INSERT INTO credential (id, tenant_id, credential_type, username, secret_id)
        VALUES (${node!.id}::uuid, ${IDS.tenant1}::uuid, 'local_admin', 'svc',
                ${created.secretId}::uuid)
      `;
      return node!.id;
    });
  });

  it('refuses a LIVE credential', async () => {
    const response = await del(`/api/assets/${nodeId}`, { nodeId }, deleteAsset);
    expect(response.status).toBe(400);
    expect((await json(response)).error.message).toMatch(/archive this credential first/i);
  });

  it('deletes an archived credential and leaves the client standing', async () => {
    await su((sql) => sql`UPDATE asset_node SET archived_at = now() WHERE id = ${nodeId}::uuid`);

    const response = await del(`/api/assets/${nodeId}`, { nodeId }, deleteAsset);
    expect(response.status).toBe(200);
    expect((await json(response)).deleted).toBe(true);

    expect(await countOrg(orgId)).toBe(1);
    const gone = await su(async (sql) => {
      const [r] = await sql<{ n: string }[]>`
        SELECT count(*) AS n FROM asset_node WHERE id = ${nodeId}::uuid
      `;
      return Number(r!.n);
    });
    expect(gone).toBe(0);
  });
});
