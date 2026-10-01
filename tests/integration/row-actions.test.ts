/**
 * The two row actions, through their routes.
 *
 * REMOVING MEANS DIFFERENT THINGS and the tests say which: an asset archives and
 * survives, a contact and a site soft-delete and do not come back, and nothing
 * anywhere destroys credential material — which is the property that matters,
 * because a trash icon on a grid row is one click away from a password.
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import {
  buildHarness, connectPools, disconnectPools, IDS, resetDatabase, superuserSql, type Harness,
} from './harness';
import { POST as createCredential } from '../../src/app/api/secrets/route';
import { POST as createContact } from '../../src/app/api/contacts/route';
import { DELETE as deleteContact } from '../../src/app/api/contacts/[contactId]/route';
import { POST as createSite } from '../../src/app/api/sites/route';
import { DELETE as deleteSite } from '../../src/app/api/sites/[siteId]/route';
import { POST as bulkArchive } from '../../src/app/api/bulk/archive/route';
import { PATCH as patchSecret } from '../../src/app/api/secrets/[secretId]/route';
import { PATCH as patchAsset } from '../../src/app/api/assets/[nodeId]/route';

let h: Harness;
let currentUser: SessionUser | null = null;
const asUser = (id: string, email: string) => { currentUser = { id, email }; };

const req = (method: string, payload?: unknown) =>
  new NextRequest(new Request('https://helm.test/api/x', {
    method,
    headers: { 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  }));
const body = async (r: Response) => (await r.json()) as Record<string, unknown>;

async function scalar(sql: string): Promise<string | null> {
  const db = superuserSql();
  try {
    const [row] = await db.unsafe<Record<string, string | null>[]>(sql);
    return row ? Object.values(row)[0] ?? null : null;
  } finally {
    await db.end({ timeout: 5 });
  }
}

async function makeCredential(label: string): Promise<{ credentialId: string; secretId: string }> {
  const response = await createCredential(req('POST', {
    organizationId: IDS.orgAcme, label, value: 'a-password-long-enough-for-this',
    credentialType: 'service_account',
  }));
  expect(response.status).toBe(200);
  return (await body(response)) as unknown as { credentialId: string; secretId: string };
}

beforeAll(async () => {
  resetDatabase();
  connectPools();
  h = buildHarness();
  resetServices();
  setKekProvider(h.kek);
  useSessionResolver(async () => currentUser);
  await h.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'row action tests' });
  asUser(IDS.admin1, 'admin@northwind.test');
}, 180_000);

afterAll(async () => { await disconnectPools(); });

// ---------------------------------------------------------------------------
describe('removing an asset archives it', () => {
  it('takes it off the list without destroying it', async () => {
    const { credentialId } = await makeCredential('Archive me');

    const response = await bulkArchive(req('POST', {
      target: 'node', ids: [credentialId], archived: true,
    }));
    expect(response.status).toBe(200);

    expect(await scalar(
      `SELECT archived_at IS NOT NULL AS archived FROM asset_node WHERE id='${credentialId}'`)).toBe(true);
    // The row and its credential survive: archiving is not deletion.
    expect(await scalar(
      `SELECT count(*)::text FROM credential WHERE id='${credentialId}'`)).toBe('1');
  });

  /*
   * The property that makes a trash icon on a password row acceptable at all.
   */
  it('leaves the credential material completely intact', async () => {
    const { credentialId, secretId } = await makeCredential('Still readable');
    await bulkArchive(req('POST', { target: 'node', ids: [credentialId], archived: true }));

    const revealed = await h.secrets.reveal(
      { tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' },
      secretId, { purpose: 'view' });
    try {
      expect(revealed.value.expose()).toBe('a-password-long-enough-for-this');
    } finally {
      revealed.value.dispose();
    }
  });

  it('restores through the same endpoint', async () => {
    const { credentialId } = await makeCredential('Round trip');
    await bulkArchive(req('POST', { target: 'node', ids: [credentialId], archived: true }));
    await bulkArchive(req('POST', { target: 'node', ids: [credentialId], archived: false }));

    expect(await scalar(
      `SELECT archived_at IS NULL AS live FROM asset_node WHERE id='${credentialId}'`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('removing a contact', () => {
  async function makeContact(last: string): Promise<string> {
    const response = await createContact(req('POST', {
      organizationId: IDS.orgAcme, firstName: 'Test', lastName: last,
    }));
    expect(response.status).toBe(200);
    return ((await body(response)) as { contactId: string }).contactId;
  }

  it('soft-deletes it', async () => {
    const id = await makeContact('Removable');
    const response = await deleteContact(req('DELETE'), { params: Promise.resolve({ contactId: id }) });
    expect(response.status).toBe(200);
    expect((await body(response)).name).toBe('Test Removable');

    expect(await scalar(`SELECT deleted_at IS NOT NULL AS gone FROM contact WHERE id='${id}'`)).toBe(true);
  });

  it('is gone from the list the grid reads', async () => {
    const id = await makeContact('Invisible');
    await deleteContact(req('DELETE'), { params: Promise.resolve({ contactId: id }) });
    expect(await scalar(
      `SELECT count(*)::text FROM contact WHERE id='${id}' AND deleted_at IS NULL`)).toBe('0');
  });

  it('refuses to remove the same contact twice', async () => {
    const id = await makeContact('Once');
    await deleteContact(req('DELETE'), { params: Promise.resolve({ contactId: id }) });
    const second = await deleteContact(req('DELETE'), { params: Promise.resolve({ contactId: id }) });
    expect(second.status).toBe(404);
  });

  it('refuses a read-only client user', async () => {
    const id = await makeContact('Protected');
    asUser(IDS.acmeViewer, 'viewer@acme.test');
    const response = await deleteContact(req('DELETE'), { params: Promise.resolve({ contactId: id }) });
    expect(response.status).toBe(403);
    asUser(IDS.admin1, 'admin@northwind.test');
  });
});

// ---------------------------------------------------------------------------
describe('removing a site', () => {
  it('soft-deletes it and reports what it orphaned', async () => {
    const created = await createSite(req('POST', {
      organizationId: IDS.orgAcme, name: 'Closing Branch',
    }));
    const siteId = ((await body(created)) as { site: { id: string } }).site.id;

    // Something recorded at that site.
    const { credentialId } = await makeCredential('At the branch');
    await patchAsset(req('PATCH', { siteId }), { params: Promise.resolve({ nodeId: credentialId }) });

    const response = await deleteSite(req('DELETE'), { params: Promise.resolve({ siteId }) });
    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(payload.orphaned).toMatchObject({ assets: 1 });

    // The site is hidden; the asset survives and simply has no site.
    expect(await scalar(`SELECT deleted_at IS NOT NULL AS gone FROM site WHERE id='${siteId}'`)).toBe(true);
    expect(await scalar(
      `SELECT count(*)::text FROM asset_node WHERE id='${credentialId}'`)).toBe('1');
  });
});

// ---------------------------------------------------------------------------
describe('permissions', () => {
  it('hides a record from the client', async () => {
    const { credentialId } = await makeCredential('Internal');
    const response = await patchAsset(req('PATCH', { isInternalOnly: true }),
      { params: Promise.resolve({ nodeId: credentialId }) });
    expect(response.status).toBe(200);
    expect(await scalar(
      `SELECT is_internal_only FROM asset_node WHERE id='${credentialId}'`)).toBe(true);
  });

  it('tightens the reveal policy on a credential', async () => {
    const { secretId } = await makeCredential('Tighten me');
    const response = await patchSecret(
      req('PATCH', { sensitivity: 'critical', requiresStepUp: true, requiresReason: true, minRoleRank: 80 }),
      { params: Promise.resolve({ secretId }) });
    expect(response.status).toBe(200);

    const db = superuserSql();
    try {
      const [row] = await db<{ sensitivity: string; min_role_rank: number;
                               requires_step_up: boolean; requires_reason: boolean }[]>`
        SELECT sensitivity::text, min_role_rank, requires_step_up, requires_reason
        FROM secret WHERE id = ${secretId}::uuid
      `;
      expect(row).toMatchObject({
        sensitivity: 'critical', min_role_rank: 80,
        requires_step_up: true, requires_reason: true,
      });
    } finally {
      await db.end({ timeout: 5 });
    }
  });

  /*
   * The escalation guard. Somebody must not be able to set a floor above their
   * own head — it would lock the credential away from themselves and from
   * everybody at their level, and only a higher rank could undo it.
   */
  it('refuses a minimum role above the actor’s own rank', async () => {
    const { secretId } = await makeCredential('Out of reach');
    asUser(IDS.tech1, 'tech1@northwind.test'); // tier1, rank 40

    const response = await patchSecret(req('PATCH', { minRoleRank: 100 }),
      { params: Promise.resolve({ secretId }) });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await scalar(`SELECT min_role_rank::text FROM secret WHERE id='${secretId}'`))
      .not.toBe('100');

    asUser(IDS.admin1, 'admin@northwind.test');
  });

  it('refuses a read-only client user outright', async () => {
    const { credentialId } = await makeCredential('Not yours to change');
    asUser(IDS.acmeViewer, 'viewer@acme.test');
    const response = await patchAsset(req('PATCH', { isInternalOnly: true }),
      { params: Promise.resolve({ nodeId: credentialId }) });
    expect(response.status).toBe(403);
    asUser(IDS.admin1, 'admin@northwind.test');
  });
});
