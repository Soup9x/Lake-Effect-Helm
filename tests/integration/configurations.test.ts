/**
 * A configuration: the device, its contact and its interfaces, written and
 * read as one thing (0800).
 *
 * WHAT MATTERS BEYOND THE HAPPY PATH:
 *
 *   1. ONE REQUEST, ONE TRANSACTION. A refusal in the interfaces (an address
 *      that is not one) leaves no node behind.
 *   2. THE PRIMARY INTERFACE IS THE DEVICE'S ADDRESS, by trigger, so the list
 *      column and the search index read one place.
 *   3. A CONNECTION IS A LINK. Naming the switch on an interface draws the
 *      graph edge the Dependencies card and the impact query use.
 *   4. THE CONTACT IS ONE OF THE CLIENT'S. Another client's person is refused;
 *      a removed person leaves the device, not the tenant, nulled.
 *   5. THE GATE: asset:write, as every asset write.
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { withTenant } from '../../src/lib/db/client';
import { actor, connectPools, disconnectPools, IDS, resetDatabase, superuserSql } from './harness';
import { POST as createDevice } from '../../src/app/api/devices/route';
import { GET as getDevice, PATCH as patchDevice } from '../../src/app/api/devices/[deviceId]/route';
import { POST as createContact } from '../../src/app/api/contacts/route';
import { listInterfaces } from '../../src/lib/assets/devices';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

let currentUser: SessionUser | null = null;
const ADMIN: SessionUser = { id: IDS.admin1, email: 'admin@northwind.test' };
const VIEWER: SessionUser = { id: IDS.acmeViewer, email: 'viewer@acme.test' };
const asAdmin = actor(IDS.tenant1, IDS.admin1);

const req = (method: string, url: string, payload?: unknown) =>
  new NextRequest(new Request(`http://helm.test${url}`, {
    method,
    ...(payload === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
  }));
const params = (deviceId: string) => ({ params: Promise.resolve({ deviceId }) });

async function ok<T>(response: Response): Promise<T> {
  const raw = await response.text();
  expect(response.status, raw).toBe(200);
  return JSON.parse(raw) as T;
}
async function su<T>(fn: (sql: ReturnType<typeof superuserSql>) => Promise<T>): Promise<T> {
  const sql = superuserSql();
  try { return await fn(sql); } finally { await sql.end({ timeout: 5 }); }
}

interface DeviceOut {
  id: string; name: string; status: string; contactId: string | null;
  detail: Record<string, unknown>;
  interfaces: { ipAddress: string | null; macAddress: string | null; isPrimary: boolean; connectedToNodeId: string | null }[];
}

let acmeContact: string;

beforeAll(async () => {
  resetDatabase();
  connectPools();
  useSessionResolver(async () => currentUser);
  currentUser = ADMIN;
  acmeContact = (await ok<{ contactId: string }>(await createContact(req('POST', '/api/contacts', {
    organizationId: IDS.orgAcme, firstName: 'Sam', lastName: 'Sysadmin',
  })))).contactId;
}, 120_000);
afterAll(async () => { await disconnectPools(); });

const FULL = {
  organizationId: IDS.orgAcme,
  name: 'ACME-NAS01',
  deviceType: 'nas',
  status: 'active',
  detail: {
    serial_number: 'NAS-7781', asset_tag: 'A-0042', manufacturer: 'Synology', model: 'DS1522+',
    purchased_at: '2025-02-10', purchased_by: 'Northwind', warranty_expires_at: '2028-02-10',
    installed_at: '2025-02-14', installed_by: 'Tech One', physical_position: 'Rack 2, U8',
    hostname: 'acme-nas01', default_gateway: '10.10.4.1', platform: 'linux', operating_system: 'DSM', os_version: '7.2',
  },
  interfaces: [
    { name: 'LAN1', ipAddress: '10.10.4.20', macAddress: '00:11:32:aa:bb:01', port: 'Gi1/0/12', isPrimary: true, connectedToNodeId: IDS.network },
    { name: 'LAN2', ipAddress: '10.10.4.21', macAddress: '00:11:32:aa:bb:02' },
  ],
};

describe('creating a configuration', () => {
  it('writes every section and reads it back whole', async () => {
    currentUser = ADMIN;
    const { device } = await ok<{ device: DeviceOut }>(await createDevice(req('POST', '/api/devices', { ...FULL, contactId: acmeContact })));
    expect(device.name).toBe('ACME-NAS01');
    expect(device.contactId).toBe(acmeContact);
    expect(device.detail).toMatchObject({ serial_number: 'NAS-7781', model: 'DS1522+', platform: 'linux', hostname: 'acme-nas01' });
    expect(device.interfaces).toHaveLength(2);
    expect(device.interfaces[0]).toMatchObject({ ipAddress: '10.10.4.20', isPrimary: true, connectedToNodeId: IDS.network });

    // The primary interface became the device's address and MAC.
    expect(device.detail.primary_ip).toMatch(/^10\.10\.4\.20/);
    expect(device.detail.primary_mac).toBe('00:11:32:aa:bb:01');

    // And the connection is a link in the graph.
    const links = await su((sql) => sql<{ relation: string }[]>`
      SELECT relation::text FROM asset_link
      WHERE source_node_id = ${device.id}::uuid AND target_node_id = ${IDS.network}::uuid
    `);
    expect(links.map((l) => l.relation)).toEqual(['connects_to']);
  });

  it('leaves nothing behind when an interface is refused', async () => {
    currentUser = ADMIN;
    const response = await createDevice(req('POST', '/api/devices', {
      ...FULL, name: 'Half-written', interfaces: [{ name: 'eth0', ipAddress: 'not an address' }],
    }));
    expect(response.status).toBe(400);
    const rows = await su((sql) => sql<{ n: number }[]>`SELECT count(*)::int AS n FROM asset_node WHERE name = 'Half-written'`);
    expect(rows[0]!.n).toBe(0);
  });

  it('refuses a contact of another client', async () => {
    currentUser = ADMIN;
    const { contactId: globexPerson } = await ok<{ contactId: string }>(await createContact(req('POST', '/api/contacts', {
      organizationId: IDS.orgGlobex, firstName: 'Gil', lastName: 'Globex',
    })));
    const response = await createDevice(req('POST', '/api/devices', { ...FULL, name: 'Wrong person', contactId: globexPerson }));
    expect(response.status).toBe(400);
  });

  it('is asset:write', async () => {
    currentUser = VIEWER;
    expect((await createDevice(req('POST', '/api/devices', FULL))).status).toBe(403);
  });
});

describe('correcting a configuration', () => {
  it('PATCHes any section and replaces the interfaces whole', async () => {
    currentUser = ADMIN;
    const { device } = await ok<{ device: DeviceOut }>(await createDevice(req('POST', '/api/devices', { ...FULL, name: 'To correct' })));
    const { device: after } = await ok<{ device: DeviceOut }>(await patchDevice(req('PATCH', `/api/devices/${device.id}`, {
      status: 'maintenance',
      deviceType: 'server',
      detail: { serial_number: 'NAS-7782', warranty_expires_at: '' },
      interfaces: [{ name: 'bond0', ipAddress: '10.10.4.30', isPrimary: true }],
    }), params(device.id)));
    expect(after.status).toBe('maintenance');
    expect(after.detail.device_type).toBe('server');
    expect(after.detail.serial_number).toBe('NAS-7782');
    expect(after.detail.warranty_expires_at).toBeNull();
    expect(after.interfaces).toHaveLength(1);
    expect(after.detail.primary_ip).toMatch(/^10\.10\.4\.30/);

    const { device: read } = await ok<{ device: DeviceOut }>(await getDevice(req('GET', `/api/devices/${device.id}`), params(device.id)));
    expect(read.interfaces[0]!.ipAddress).toBe('10.10.4.30');
  });

  it('nulls the contact, not the tenant, when the person is removed', async () => {
    currentUser = ADMIN;
    const { contactId } = await ok<{ contactId: string }>(await createContact(req('POST', '/api/contacts', {
      organizationId: IDS.orgAcme, firstName: 'Leaving', lastName: 'Soon',
    })));
    const { device } = await ok<{ device: DeviceOut }>(await createDevice(req('POST', '/api/devices', { ...FULL, name: 'Orphaned', contactId })));
    await su((sql) => sql`DELETE FROM contact WHERE id = ${contactId}::uuid`);
    const rows = await su((sql) => sql<{ contact_id: string | null; tenant_id: string }[]>`
      SELECT contact_id, tenant_id FROM device WHERE id = ${device.id}::uuid
    `);
    expect(rows[0]).toEqual({ contact_id: null, tenant_id: IDS.tenant1 });
    expect(await withTenant(asAdmin, (tx) => listInterfaces(tx, device.id))).toHaveLength(2);
  });
});
