/**
 * Microsoft 365 sync (0990), through the real routes and worker against a
 * stub Entra and Graph.
 *
 *   AUTHORITY     integration:m365:manage.
 *   NOTHING BAD   a sign-in Microsoft refuses saves nothing.
 *   CONTAINMENT   Graph only; a secret from the MSP or this client only; a
 *                 nextLink outside Graph never receives the token.
 *   IMPORT        licensed people as contacts, paid subscriptions as licences,
 *                 verified domains as domains — each switchable.
 *   PRESERVATION  a person's edits to a contact stay; an address or number
 *                 they removed is not put back.
 *   ADOPTION      somebody already documented with that address is linked.
 *   PARTIAL       a missing permission fails that part only.
 */
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import { withTenant } from '../../src/lib/db/client';
import {
  IDS, buildHarness, connectPools, disconnectPools, resetDatabase, superuserSql, type Harness,
} from './harness';
import { GET as getM365, PUT as putM365 } from '../../src/app/api/integrations/m365/route';
import { DELETE as deleteM365 } from '../../src/app/api/integrations/m365/[connectionId]/route';
import { POST as syncNow } from '../../src/app/api/integrations/m365/[connectionId]/sync/route';
import { m365SyncJob } from '../../src/workers/m365-sync';
import { useGraphTransport } from '../../src/lib/m365/client';
import type { M365Connection } from '../../src/lib/m365/queries';
import type { JobContext, JobLogger } from '../../src/workers/runtime';
import { FakeGraph, type FakeGraphTenant } from '../support/fake-graph';

let h: Harness;
const graph = new FakeGraph();
let currentUser: SessionUser | null = null;
const asUser = (id: string, email: string) => {
  currentUser = { id, email };
};
const asAdmin = () => asUser(IDS.admin1, 'admin@northwind.test');

const APP_ID = '0b3a1f0e-1111-4c2d-9e7f-123456789abc';
const SECRET = 'm365-app-secret-that-must-never-appear-in-a-response';
const LICENSED = [{ skuId: 'sku-bp' }];

const GRACE = {
  id: 'user-grace', givenName: 'Grace', surname: 'Hopper', jobTitle: 'Office manager',
  mail: 'grace@acme.test', businessPhones: ['+1 555 0100'], mobilePhone: '+1 555 0199',
  accountEnabled: true, userType: 'Member', assignedLicenses: LICENSED,
};
const ALAN = {
  id: 'user-alan', givenName: 'Alan', surname: 'Turing', mail: 'alan@acme.test',
  accountEnabled: true, userType: 'Member', assignedLicenses: LICENSED,
};
const SHARED_MAILBOX = {
  id: 'user-info', displayName: 'Info', mail: 'info@acme.test', accountEnabled: false, userType: 'Member', assignedLicenses: [],
};
const GUEST = {
  id: 'user-guest', displayName: 'Vendor Rep', mail: 'rep@vendor.test', accountEnabled: true, userType: 'Guest', assignedLicenses: LICENSED,
};

function acmeTenant(overrides: Partial<FakeGraphTenant> = {}): FakeGraphTenant {
  return {
    clientSecret: SECRET,
    displayName: 'Acme Manufacturing Ltd',
    users: [GRACE, ALAN, SHARED_MAILBOX, GUEST],
    skus: [
      { skuId: 'sku-bp', skuPartNumber: 'SPB', capabilityStatus: 'Enabled', prepaidUnits: { enabled: 25 }, consumedUnits: 2 },
      { skuId: 'sku-free', skuPartNumber: 'FLOW_FREE', capabilityStatus: 'Enabled', prepaidUnits: { enabled: 10000 }, consumedUnits: 1 },
    ],
    domains: [
      { id: 'acme.test', isVerified: true, isDefault: true },
      { id: 'acme-shop.test', isVerified: true },
      { id: 'acmecorp.onmicrosoft.com', isVerified: true, isInitial: true },
    ],
    ...overrides,
  };
}

const CONNECT = {
  organizationId: IDS.orgAcme,
  tenant: 'acmecorp.onmicrosoft.com',
  clientId: APP_ID,
  clientSecret: SECRET,
  syncEnabled: true,
  intervalMinutes: 360,
  syncUsers: true,
  syncLicences: true,
  syncDomains: true,
};

const req = (method: string, path: string, payload?: unknown) =>
  new NextRequest(new Request(`https://helm.test${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  }));
const json = async <T = Record<string, unknown>>(response: Response) => (await response.json()) as T;
const ctxFor = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

function silentLogger(): JobLogger {
  const make = (): JobLogger => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => make() });
  return make();
}
async function runSync(): Promise<Record<string, number>> {
  const ctx: JobContext = { log: silentLogger(), stopping: () => false };
  return (await m365SyncJob().run(ctx)).counts ?? {};
}

async function su<T>(fn: (sql: ReturnType<typeof superuserSql>) => Promise<T>): Promise<T> {
  const sql = superuserSql();
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
const makeDue = () => su((sql) => sql`UPDATE integration_connection SET last_sync_at = NULL WHERE provider = 'microsoft_graph'`);

async function connect(body: Record<string, unknown> = CONNECT): Promise<M365Connection[]> {
  asAdmin();
  const response = await putM365(req('PUT', '/api/integrations/m365', body));
  expect(response.status).toBe(200);
  return (await json<{ connections: M365Connection[] }>(response)).connections;
}

interface ContactRow {
  id: string; first_name: string; last_name: string; title: string | null; email: string | null;
  emails: string[]; phones: string[];
}
const linkedContacts = () => su((sql) => sql<ContactRow[]>`
  SELECT c.id, c.first_name, c.last_name, c.title, c.email::text AS email,
         coalesce((SELECT array_agg(e.address::text ORDER BY e.position) FROM contact_email e WHERE e.contact_id = c.id), '{}') AS emails,
         coalesce((SELECT array_agg(p.number || ':' || p.label ORDER BY p.position) FROM contact_phone p WHERE p.contact_id = c.id), '{}') AS phones
  FROM m365_contact_link l JOIN contact c ON c.id = l.contact_id
  ORDER BY c.first_name
`);

beforeAll(async () => {
  resetDatabase();
  connectPools();
  h = buildHarness();
  resetServices();
  setKekProvider(h.kek);
  useSessionResolver(async () => currentUser);
  await h.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'm365 tests' });
  await h.keys.provision(IDS.tenant2, IDS.admin2, { reason: 'm365 tests' });
  useGraphTransport(graph.transport());
}, 180_000);

afterEach(async () => {
  currentUser = null;
  graph.reset();
  await su(async (sql) => {
    await sql`DELETE FROM contact WHERE id IN (SELECT contact_id FROM m365_contact_link)`;
    await sql`DELETE FROM contact WHERE email IN ('grace@acme.test', 'old-grace@acme.test')`;
    await sql`DELETE FROM asset_node WHERE id IN (
      SELECT node_id FROM external_identity ei JOIN integration_connection c ON c.id = ei.connection_id
      WHERE c.provider = 'microsoft_graph' AND ei.external_type <> 'm365_domain')`;
    await sql`DELETE FROM asset_node WHERE node_type = 'domain' AND name = 'acme-shop.test'`;
    await sql`DELETE FROM integration_connection WHERE provider = 'microsoft_graph'`;
  });
});

afterAll(async () => {
  useGraphTransport(null);
  await disconnectPools();
});

describe('connecting a client', () => {
  it('signs in to their tenant before saving, and keeps the secret in the vault', async () => {
    graph.tenants.set('acmecorp.onmicrosoft.com', acmeTenant());
    asAdmin();
    const response = await putM365(req('PUT', '/api/integrations/m365', CONNECT));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(SECRET);
    const body = JSON.parse(text) as { connections: M365Connection[]; tested: { tenantName: string } };
    expect(body.tested.tenantName).toBe('Acme Manufacturing Ltd');
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0]).toMatchObject({
      organizationId: IDS.orgAcme, tenant: 'acmecorp.onmicrosoft.com', tenantName: 'Acme Manufacturing Ltd',
      clientId: APP_ID, secretSet: true, status: 'configured',
    });

    const token = graph.requests.find((r) => r.url.includes('/oauth2/v2.0/token'))!;
    expect(token.url).toBe('https://login.microsoftonline.com/acmecorp.onmicrosoft.com/oauth2/v2.0/token');
    expect(token.form).toMatchObject({ grant_type: 'client_credentials', scope: 'https://graph.microsoft.com/.default' });

    const [stored] = await su((sql) => sql<{ organization_id: string; kind: string }[]>`
      SELECT s.organization_id, s.kind::text AS kind FROM integration_connection c
      JOIN secret s ON s.id = (c.credential_secret_ids ->> 'client_secret')::uuid
      WHERE c.provider = 'microsoft_graph'`);
    expect(stored).toEqual({ organization_id: IDS.orgInternal, kind: 'api_key' });
  });

  it('saves nothing when Microsoft refuses the sign-in, and says why', async () => {
    graph.tenants.set('acmecorp.onmicrosoft.com', acmeTenant({ clientSecret: 'a different one' }));
    asAdmin();
    const response = await putM365(req('PUT', '/api/integrations/m365', CONNECT));
    expect(response.status).toBe(400);
    const body = await json<{ error: { message: string; details?: { remedy?: string } } }>(response);
    expect(body.error.message).toMatch(/AADSTS7000215/);
    expect(body.error.details?.remedy).toMatch(/Value, not its ID/);
    const [row] = await su((sql) => sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM integration_connection WHERE provider = 'microsoft_graph'`);
    expect(row?.n).toBe(0);
  });

  it('reuses one app’s secret for another client without pasting it again', async () => {
    graph.tenants.set('acmecorp.onmicrosoft.com', acmeTenant());
    const [acme] = await connect();
    const connections = await connect({
      ...CONNECT, organizationId: IDS.orgGlobex, tenant: 'globex.onmicrosoft.com',
      clientSecret: undefined, reuseSecretFrom: acme!.id,
    });
    expect(connections).toHaveLength(2);
    const ids = await su((sql) => sql<{ secret: string }[]>`
      SELECT credential_secret_ids ->> 'client_secret' AS secret FROM integration_connection
      WHERE provider = 'microsoft_graph'`);
    expect(new Set(ids.map((r) => r.secret)).size).toBe(1);
  });

  it('refuses somebody without integration:m365:manage, and lets them read', async () => {
    graph.tenants.set('acmecorp.onmicrosoft.com', acmeTenant());
    const [acme] = await connect();
    asUser(IDS.tech1, 'tech1@northwind.test');
    expect((await putM365(req('PUT', '/api/integrations/m365', CONNECT))).status).toBe(403);
    expect((await syncNow(req('POST', `/x`), ctxFor({ connectionId: acme!.id }))).status).toBe(403);
    expect((await deleteM365(req('DELETE', `/x`), ctxFor({ connectionId: acme!.id }))).status).toBe(403);
    const read = await json<{ connections: M365Connection[] }>(await getM365(req('GET', '/api/integrations/m365')));
    expect(read.connections).toHaveLength(1);

    asUser(IDS.admin2, 'admin@rival.test');
    const rival = await json<{ connections: M365Connection[] }>(await getM365(req('GET', '/api/integrations/m365')));
    expect(rival.connections).toHaveLength(0);
  });

  it('cannot be pointed anywhere but Graph, or at another client’s secret', async () => {
    graph.tenants.set('acmecorp.onmicrosoft.com', acmeTenant());
    await connect();
    const admin = { tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' as const };
    await expect(withTenant(admin, async (tx) =>
      tx`UPDATE integration_connection SET base_url = 'https://graph.evil.test' WHERE provider = 'microsoft_graph'`,
    )).rejects.toThrow(/graph\.microsoft\.com only/);
    await expect(withTenant(admin, async (tx) =>
      tx`UPDATE integration_connection SET config = config || '{"tenant_id": "evil.test/../../x"}' WHERE provider = 'microsoft_graph'`,
    )).rejects.toThrow(/not an Entra tenant/);

    const globexKey = await h.secrets.create(admin,
      { organizationId: IDS.orgGlobex, kind: 'api_key', label: 'Globex key' }, 'globex-key-value');
    await expect(withTenant(admin, async (tx) => tx`
      UPDATE integration_connection
      SET credential_secret_ids = jsonb_build_object('client_secret', ${globexKey.secretId}::text)
      WHERE provider = 'microsoft_graph'`,
    )).rejects.toThrow(/MSP's organisation or this client's/);
  });
});

describe('the sync worker', () => {
  it('imports people, paid subscriptions and verified domains', async () => {
    graph.tenants.set('acmecorp.onmicrosoft.com', acmeTenant());
    await connect();
    const counts = await runSync();
    expect(counts).toMatchObject({ connections: 1, failed: 0 });

    const contacts = await linkedContacts();
    expect(contacts.map((c) => [c.first_name, c.last_name, c.email])).toEqual([
      ['Alan', 'Turing', 'alan@acme.test'],
      ['Grace', 'Hopper', 'grace@acme.test'],
    ]);
    expect(contacts[1]).toMatchObject({ title: 'Office manager', phones: ['+1 555 0100:work', '+1 555 0199:mobile'] });

    const licences = await su((sql) => sql<{ name: string; organization_id: string; seats_purchased: number; seats_used: number }[]>`
      SELECT n.name, n.organization_id, l.seats_purchased, l.seats_used
      FROM external_identity ei JOIN asset_node n ON n.id = ei.node_id JOIN license l ON l.id = n.id
      WHERE ei.external_type = 'm365_sku'`);
    expect(licences).toEqual([{ name: 'Microsoft 365 Business Premium', organization_id: IDS.orgAcme, seats_purchased: 25, seats_used: 2 }]);

    // acme.test was already documented for Acme, so it is linked rather than
    // duplicated; acme-shop.test is new; the onmicrosoft one is left out.
    const domains = await su((sql) => sql<{ name: string; id: string }[]>`
      SELECT d.domain_name::text AS name, d.id FROM external_identity ei JOIN domain d ON d.id = ei.node_id
      WHERE ei.external_type = 'm365_domain' ORDER BY 1`);
    expect(domains.map((d) => d.name)).toEqual(['acme-shop.test', 'acme.test']);
    expect(domains.find((d) => d.name === 'acme.test')!.id).toBe(IDS.domain);

    asAdmin();
    const [row] = (await json<{ connections: M365Connection[] }>(await getM365(req('GET', '/x')))).connections;
    expect(row).toMatchObject({ status: 'active', contacts: 2, licences: 1, domains: 2, lastError: null });
    expect(row!.lastRun).toMatchObject({ status: 'success' });
  });

  it('imports only the parts switched on', async () => {
    graph.tenants.set('acmecorp.onmicrosoft.com', acmeTenant());
    await connect({ ...CONNECT, syncUsers: false, syncDomains: false });
    await runSync();
    expect(await linkedContacts()).toHaveLength(0);
    expect(graph.requests.some((r) => r.url.includes('/v1.0/users'))).toBe(false);
    expect(graph.requests.some((r) => r.url.includes('/v1.0/subscribedSkus'))).toBe(true);
  });

  it('keeps a person’s edits, follows Microsoft’s changes, and does not put back what was removed', async () => {
    graph.tenants.set('acmecorp.onmicrosoft.com', acmeTenant({ users: [GRACE] }));
    await connect();
    await runSync();
    const [grace] = await linkedContacts();

    // Somebody corrects the title and deletes the mobile number.
    await withTenant({ tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' }, async (tx) => {
      await tx`UPDATE contact SET title = 'Head of Operations' WHERE id = ${grace!.id}::uuid`;
      await tx`DELETE FROM contact_phone WHERE contact_id = ${grace!.id}::uuid AND label = 'mobile'`;
    });

    // Microsoft 365 then reports a new surname, title, address and desk phone.
    graph.tenants.set('acmecorp.onmicrosoft.com', acmeTenant({
      users: [{ ...GRACE, surname: 'Murray Hopper', jobTitle: 'Office lead', mail: 'grace.hopper@acme.test', businessPhones: ['+1 555 0101'] }],
    }));
    await makeDue();
    await runSync();

    const [after] = await linkedContacts();
    expect(after).toMatchObject({
      id: grace!.id,
      last_name: 'Murray Hopper',
      title: 'Head of Operations',
      email: 'grace.hopper@acme.test',
      emails: ['grace.hopper@acme.test'],
      // The desk number it added is updated; the mobile somebody removed stays removed.
      phones: ['+1 555 0101:work'],
    });

    const history = await su((sql) => sql<{ actor_type: string }[]>`
      SELECT actor_type FROM entity_change WHERE entity_id = ${grace!.id}::uuid AND kind = 'updated'`);
    expect(history.some((h) => h.actor_type === 'service_account')).toBe(true);
  });

  it('adopts somebody already documented with that address', async () => {
    const [existing] = await withTenant({ tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' }, async (tx) =>
      tx<{ id: string }[]>`
        INSERT INTO contact (tenant_id, organization_id, first_name, last_name, email, notes)
        VALUES (${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, 'G.', 'Hopper', 'Grace@Acme.test', 'Prefers phone')
        RETURNING id`);
    graph.tenants.set('acmecorp.onmicrosoft.com', acmeTenant({ users: [GRACE] }));
    await connect();
    await runSync();

    const contacts = await linkedContacts();
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({ id: existing!.id, first_name: 'G.', title: 'Office manager' });
    const [kept] = await su((sql) => sql<{ notes: string }[]>`SELECT notes FROM contact WHERE id = ${existing!.id}::uuid`);
    expect(kept?.notes).toBe('Prefers phone');
  });

  it('keeps going when one permission is missing, and says which', async () => {
    graph.tenants.set('acmecorp.onmicrosoft.com', acmeTenant({ forbidden: ['/v1.0/users'] }));
    await connect();
    await runSync();

    asAdmin();
    const [row] = (await json<{ connections: M365Connection[] }>(await getM365(req('GET', '/x')))).connections;
    expect(row!.lastRun).toMatchObject({ status: 'partial' });
    expect(row!.lastRun!.error).toMatch(/User\.Read\.All/);
    expect(row).toMatchObject({ licences: 1, domains: 2, contacts: 0 });
  });

  it('never follows a next page outside Graph with the token', async () => {
    graph.tenants.set('acmecorp.onmicrosoft.com', acmeTenant());
    graph.pageSize = 1;
    graph.hostileNextLink = 'https://collector.evil.test/v1.0/users?page=2';
    await connect();
    await runSync();
    expect(graph.requests.some((r) => r.url.startsWith('https://collector.evil.test'))).toBe(false);

    asAdmin();
    const [row] = (await json<{ connections: M365Connection[] }>(await getM365(req('GET', '/x')))).connections;
    expect(row!.lastRun!.error).toMatch(/outside Graph/);
  });

  it('pages through every user', async () => {
    graph.tenants.set('acmecorp.onmicrosoft.com', acmeTenant());
    graph.pageSize = 1;
    await connect();
    await runSync();
    expect(await linkedContacts()).toHaveLength(2);
    expect(graph.requests.filter((r) => r.url.includes('/v1.0/users')).length).toBe(4);
  });

  it('reports a domain documented for another client instead of moving it', async () => {
    graph.tenants.set('globex.onmicrosoft.com', { ...acmeTenant(), domains: [{ id: 'acme.test', isVerified: true }] });
    await connect({ ...CONNECT, organizationId: IDS.orgGlobex, tenant: 'globex.onmicrosoft.com' });
    await runSync();

    const [owner] = await su((sql) => sql<{ organization_id: string }[]>`
      SELECT organization_id FROM asset_node WHERE id = ${IDS.domain}::uuid`);
    expect(owner!.organization_id).toBe(IDS.orgAcme);
    asAdmin();
    const [row] = (await json<{ connections: M365Connection[] }>(await getM365(req('GET', '/x')))).connections;
    expect(row!.lastRun!.error).toMatch(/another client.*acme\.test/);
  });

  it('updates seats, runs again on request, and keeps what it imported when disconnected', async () => {
    graph.tenants.set('acmecorp.onmicrosoft.com', acmeTenant());
    const [acme] = await connect();
    await runSync();
    expect(await runSync()).toEqual({});

    graph.tenants.set('acmecorp.onmicrosoft.com', acmeTenant({
      skus: [{ skuId: 'sku-bp', skuPartNumber: 'SPB', capabilityStatus: 'Enabled', prepaidUnits: { enabled: 30 }, consumedUnits: 27 }],
    }));
    asAdmin();
    expect((await syncNow(req('POST', '/x'), ctxFor({ connectionId: acme!.id }))).status).toBe(200);
    await runSync();
    const [licence] = await su((sql) => sql<{ seats_purchased: number; seats_used: number; id: string }[]>`
      SELECT l.id, l.seats_purchased, l.seats_used FROM license l JOIN external_identity ei ON ei.node_id = l.id
      WHERE ei.external_type = 'm365_sku'`);
    expect(licence).toMatchObject({ seats_purchased: 30, seats_used: 27 });

    asAdmin();
    expect((await deleteM365(req('DELETE', '/x'), ctxFor({ connectionId: acme!.id }))).status).toBe(200);
    const [kept] = await su((sql) => sql<{ n: number }[]>`
      SELECT (SELECT count(*) FROM license WHERE id = ${licence!.id}::uuid)::int
           + (SELECT count(*) FROM contact WHERE email IN ('grace@acme.test', 'alan@acme.test'))::int AS n`);
    expect(kept!.n).toBe(3);
    await su((sql) => sql`DELETE FROM asset_node WHERE id = ${licence!.id}::uuid`);
    await su((sql) => sql`DELETE FROM contact WHERE email = 'alan@acme.test'`);
  });
});
