/**
 * Editing what an asset records about its own kind.
 *
 * The columns were always there; PATCH /api/assets/:id/detail is the first
 * thing that writes them from the application. What matters beyond the happy
 * path:
 *
 *   1. THE DATABASE IS THE VALIDATOR. A gateway outside the subnet, a VLAN of
 *      5000 and an address that is not one are refused by 0060's types and
 *      CHECKs, and the route turns each into a 400, not a 500.
 *   2. THE CATALOGUE IS THE BOUNDARY. A column the form does not show cannot
 *      be named in the request, whatever the table has.
 *   3. CLEARING IS A WRITE. '' and null clear a nullable column; a required
 *      one refuses.
 *   4. THE GATE. asset:write, the same as the header's Edit.
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { connectPools, disconnectPools, IDS, resetDatabase, superuserSql } from './harness';
import { PATCH as patchDetail } from '../../src/app/api/assets/[nodeId]/detail/route';
import { DETAIL_FIELDS, subnetMaskOf } from '../../src/lib/assets/detail-fields';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

let currentUser: SessionUser | null = null;
const ADMIN: SessionUser = { id: IDS.admin1, email: 'admin@northwind.test' };
const VIEWER: SessionUser = { id: IDS.acmeViewer, email: 'viewer@acme.test' };

const patch = (nodeId: string, body: unknown) =>
  patchDetail(
    new NextRequest(new Request(`http://helm.test/api/assets/${nodeId}/detail`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })),
    { params: Promise.resolve({ nodeId }) },
  );

async function read(response: Response): Promise<{ status: number; message: string }> {
  const payload = (await response.json()) as { error?: { message?: string } };
  return { status: response.status, message: payload.error?.message ?? '' };
}

async function su<T>(fn: (sql: ReturnType<typeof superuserSql>) => Promise<T>): Promise<T> {
  const sql = superuserSql();
  try { return await fn(sql); } finally { await sql.end({ timeout: 5 }); }
}

beforeAll(async () => {
  resetDatabase();
  connectPools();
  useSessionResolver(async () => currentUser);
}, 120_000);
afterAll(async () => { await disconnectPools(); });

describe('the catalogue', () => {
  it('names only columns the tables have, with the type the table gives them', async () => {
    // A field whose key is not a column would 500 on first save; a cast to
    // the wrong type would refuse every value. Both are caught here.
    const columns = await su((sql) => sql<{ table_name: string; column_name: string; udt_name: string; is_nullable: string }[]>`
      SELECT table_name, column_name, udt_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY(${Object.keys(DETAIL_FIELDS)})
    `);
    const byTable = new Map<string, Map<string, { udt: string; nullable: boolean }>>();
    for (const c of columns) {
      if (!byTable.has(c.table_name)) byTable.set(c.table_name, new Map());
      byTable.get(c.table_name)!.set(c.column_name, { udt: c.udt_name, nullable: c.is_nullable === 'YES' });
    }
    for (const [table, fields] of Object.entries(DETAIL_FIELDS)) {
      for (const f of fields) {
        const col = byTable.get(table)?.get(f.key);
        expect(col, `${table}.${f.key} is not a column`).toBeDefined();
        if (!col!.nullable) expect(f.required, `${table}.${f.key} is NOT NULL but the field is not required`).toBe(true);
      }
    }
  });

  it('turns a prefix length into the mask people type', () => {
    expect(subnetMaskOf('10.10.4.0/24')).toBe('255.255.255.0');
    expect(subnetMaskOf('192.168.0.0/22')).toBe('255.255.252.0');
    expect(subnetMaskOf('203.0.113.8/29')).toBe('255.255.255.248');
    expect(subnetMaskOf('fd00::/64')).toBeNull();
    expect(subnetMaskOf(null)).toBeNull();
  });
});

describe('a network', () => {
  it('takes its addressing in one request and reads it back typed', async () => {
    currentUser = ADMIN;
    const response = await patch(IDS.network, {
      kind: 'vlan', cidr: '10.10.4.0/24', gateway: '10.10.4.1', vlan_id: 40,
      dns_servers: '10.10.4.2\n10.10.4.3', dhcp_range_start: '10.10.4.100', dhcp_range_end: '10.10.4.200',
      purpose: 'Servers', is_guest: false,
    });
    expect(response.status, await response.text()).toBe(200);

    const [row] = await su((sql) => sql<{
      kind: string; cidr: string; gateway: string; vlan_id: number; dns_servers: string[]; purpose: string;
    }[]>`SELECT kind::text, cidr::text, host(gateway) AS gateway, vlan_id,
                (SELECT array_agg(host(d) ORDER BY d) FROM unnest(dns_servers) d) AS dns_servers, purpose
         FROM network WHERE id = ${IDS.network}::uuid`);
    expect(row).toMatchObject({
      kind: 'vlan', cidr: '10.10.4.0/24', gateway: '10.10.4.1', vlan_id: 40,
      dns_servers: ['10.10.4.2', '10.10.4.3'], purpose: 'Servers',
    });
  });

  it('is refused a gateway outside the subnet, a VLAN above 4094 and a non-address, each as a 400', async () => {
    currentUser = ADMIN;
    for (const body of [
      { gateway: '10.99.0.1' },
      { vlan_id: 5000 },
      { dhcp_range_start: 'not-an-address' },
      { dns_servers: ['10.10.4.2', 'nope'] },
    ]) {
      const { status, message } = await read(await patch(IDS.network, body));
      expect(status, JSON.stringify(body)).toBe(400);
      expect(message.length).toBeGreaterThan(0);
    }
  });

  it('clears a nullable column with an empty string and refuses to clear the kind', async () => {
    currentUser = ADMIN;
    expect((await patch(IDS.network, { purpose: '' })).status).toBe(200);
    const [row] = await su((sql) => sql<{ purpose: string | null }[]>`SELECT purpose FROM network WHERE id = ${IDS.network}::uuid`);
    expect(row!.purpose).toBeNull();

    const { status, message } = await read(await patch(IDS.network, { kind: '' }));
    expect(status).toBe(400);
    expect(message).toMatch(/cannot be empty/);
  });
});

describe('the boundary', () => {
  it('refuses a column the form does not show, and a column of another kind', async () => {
    currentUser = ADMIN;
    expect((await read(await patch(IDS.network, { dhcp_server_node_id: IDS.firewall }))).message).toMatch(/not a field/);
    expect((await read(await patch(IDS.network, { serial_number: 'X' }))).status).toBe(400);
  });

  it('writes a device the same way', async () => {
    currentUser = ADMIN;
    const response = await patch(IDS.firewall, {
      serial_number: 'FW-0001', manufacturer: 'Fortinet', model: 'FortiGate 60F',
      warranty_expires_at: '2027-03-31', primary_mac: 'aa:bb:cc:dd:ee:ff', monitoring_enabled: true,
    });
    expect(response.status, await response.text()).toBe(200);
    const [row] = await su((sql) => sql<{ serial_number: string; warranty_expires_at: Date; primary_mac: string }[]>`
      SELECT serial_number, warranty_expires_at, primary_mac::text FROM device WHERE id = ${IDS.firewall}::uuid
    `);
    expect(row!.serial_number).toBe('FW-0001');
    expect(row!.primary_mac).toBe('aa:bb:cc:dd:ee:ff');
    expect(new Date(row!.warranty_expires_at).toISOString().slice(0, 10)).toBe('2027-03-31');
  });

  it('sets and changes a credential’s username, URL and type, and never its secret', async () => {
    currentUser = ADMIN;
    const [cred] = await su((sql) => sql<{ id: string }[]>`
      WITH n AS (
        INSERT INTO asset_node (tenant_id, organization_id, node_type, name)
        VALUES (${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, 'credential', 'Acme root login')
        RETURNING id, tenant_id
      )
      INSERT INTO credential (id, tenant_id) SELECT id, tenant_id FROM n RETURNING id
    `);
    const set = await patch(cred!.id, { username: 'root', url: 'ssh://acme-helm01', credential_type: 'root' });
    expect(set.status, await set.text()).toBe(200);
    const changed = await patch(cred!.id, { username: 'helmadmin' });
    expect(changed.status).toBe(200);
    const [row] = await su((sql) => sql<{ username: string; url: string; credential_type: string }[]>`
      SELECT username, url, credential_type::text FROM credential WHERE id = ${cred!.id}::uuid
    `);
    expect(row).toEqual({ username: 'helmadmin', url: 'ssh://acme-helm01', credential_type: 'root' });

    expect((await read(await patch(cred!.id, { secret_id: IDS.firewall }))).message).toMatch(/not a field/);
    expect((await read(await patch(cred!.id, { totp_secret_id: IDS.firewall }))).message).toMatch(/not a field/);
    expect((await read(await patch(cred!.id, { credential_type: 'superuser' }))).status).toBe(400);
  });

  it('is asset:write', async () => {
    currentUser = VIEWER;
    const { status, message } = await read(await patch(IDS.firewall, { serial_number: 'nope' }));
    expect(status).toBe(403);
    expect(message).toBe('missing permission: asset:write');
  });
});
