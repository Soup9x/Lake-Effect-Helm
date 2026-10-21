/**
 * Copying an entry, giving a copied credential its password, contacts at a
 * location, and a domain's details at creation (1020), through the real routes.
 *
 *   COPY          the shared fields and the kind's row come across under a new
 *                 name; a password, a seed and an external check's findings do
 *                 not; a domain takes the new name as its domain name, and a
 *                 name already taken is a 409; procedures are refused.
 *   SET PASSWORD  only on a credential with none; a second is a 409.
 *   LOCATIONS     a contact goes at one of its own client's locations only.
 *   CREATE        a domain's details are stored with it, in one transaction.
 *   WHO MAY       asset:write to copy; secret:write as well to set a password.
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import {
  IDS, buildHarness, connectPools, disconnectPools, resetDatabase, superuserSql, type Harness,
} from './harness';
import { POST as copyEntry } from '../../src/app/api/assets/[nodeId]/copy/route';
import { PUT as setPassword } from '../../src/app/api/assets/[nodeId]/password/route';
import { POST as createAsset } from '../../src/app/api/assets/route';
import { POST as createSecret } from '../../src/app/api/secrets/route';
import { PATCH as patchContact } from '../../src/app/api/contacts/[contactId]/route';
import { siteAddress } from '../../src/lib/sites/address';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

let h: Harness;
let currentUser: SessionUser | null = null;
const ADMIN: SessionUser = { id: IDS.admin1, email: 'admin@northwind.test' };
const VIEWER: SessionUser = { id: IDS.acmeViewer, email: 'viewer@acme.test' };

const req = (method: string, payload: unknown) =>
  new NextRequest(new Request('https://helm.test/api/x', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }));
const nodeParams = (nodeId: string) => ({ params: Promise.resolve({ nodeId }) });
const json = async <T = Record<string, unknown>>(r: Response) => (await r.json()) as T;
const message = async (r: Response) => ((await r.json()) as { error?: { message?: string } }).error?.message ?? '';

async function su<T>(fn: (sql: ReturnType<typeof superuserSql>) => Promise<T>): Promise<T> {
  const sql = superuserSql();
  try { return await fn(sql); } finally { await sql.end({ timeout: 5 }); }
}

const copy = (nodeId: string, name: string) => copyEntry(req('POST', { name }), nodeParams(nodeId));

beforeAll(async () => {
  resetDatabase();
  connectPools();
  h = buildHarness();
  resetServices();
  setKekProvider(h.kek);
  useSessionResolver(async () => currentUser);
  await h.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'entry copy tests' });
}, 180_000);
afterAll(async () => { await disconnectPools(); });

describe('copying an entry', () => {
  it('copies a device’s shared fields and its own row under the new name', async () => {
    currentUser = ADMIN;
    await su((sql) => sql`
      UPDATE asset_node SET tags = '{edge,hq}', notes = 'Rack 2', criticality = 5 WHERE id = ${IDS.firewall}::uuid`);
    await su((sql) => sql`
      UPDATE device SET manufacturer = 'Fortinet', model = 'FortiGate 60F', serial_number = 'FW-1' WHERE id = ${IDS.firewall}::uuid`);

    const response = await copy(IDS.firewall, 'acme-fw-02');
    expect(response.status, await response.clone().text()).toBe(200);
    const { asset } = await json<{ asset: { id: string; nodeType: string } }>(response);
    expect(asset.nodeType).toBe('device');

    const [row] = await su((sql) => sql<{
      name: string; organization_id: string; tags: string[]; notes: string; criticality: number;
      manufacturer: string; model: string; device_type: string;
    }[]>`
      SELECT n.name, n.organization_id, n.tags, n.notes, n.criticality, d.manufacturer, d.model, d.device_type::text
      FROM asset_node n JOIN device d ON d.id = n.id WHERE n.id = ${asset.id}::uuid`);
    const [original] = await su((sql) => sql<{ device_type: string; organization_id: string }[]>`
      SELECT d.device_type::text, n.organization_id FROM device d JOIN asset_node n ON n.id = d.id WHERE d.id = ${IDS.firewall}::uuid`);
    expect(row).toMatchObject({
      name: 'acme-fw-02', organization_id: original!.organization_id, tags: ['edge', 'hq'], notes: 'Rack 2',
      criticality: 5, manufacturer: 'Fortinet', model: 'FortiGate 60F', device_type: original!.device_type,
    });
  });

  it('copies a credential without its password, which can then be set — once', async () => {
    currentUser = ADMIN;
    const made = await createSecret(req('POST', {
      organizationId: IDS.orgAcme, label: 'Acme root', value: 'original-password-long-enough',
      credentialType: 'root', username: 'root', url: 'ssh://acme-helm01',
    }));
    expect(made.status).toBe(200);
    const { credentialId } = await json<{ credentialId: string }>(made);

    const copied = await copy(credentialId, 'Acme root (copy)');
    expect(copied.status).toBe(200);
    const { asset } = await json<{ asset: { id: string } }>(copied);
    const [row] = await su((sql) => sql<{ username: string; url: string; secret_id: string | null; totp_secret_id: string | null }[]>`
      SELECT username, url, secret_id, totp_secret_id FROM credential WHERE id = ${asset.id}::uuid`);
    expect(row).toEqual({ username: 'root', url: 'ssh://acme-helm01', secret_id: null, totp_secret_id: null });

    const set = await setPassword(req('PUT', { value: 'the-copy-has-its-own' }), nodeParams(asset.id));
    expect(set.status, await set.clone().text()).toBe(200);
    const { secretId } = await json<{ secretId: string }>(set);
    const revealed = await h.secrets.reveal(
      { tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' }, secretId, { purpose: 'view' });
    try {
      expect(revealed.value.expose()).toBe('the-copy-has-its-own');
    } finally {
      revealed.value.dispose();
    }

    const again = await setPassword(req('PUT', { value: 'a-second-one' }), nodeParams(asset.id));
    expect(again.status).toBe(409);
    expect(await message(again)).toMatch(/already has a password/);
  });

  it('gives a copied domain its new name, refuses one already taken, and leaves the check’s findings behind', async () => {
    currentUser = ADMIN;
    await su((sql) => sql`
      UPDATE domain SET registrar = 'Gandi', registry_expires_at = now() + interval '200 days'
      WHERE id = ${IDS.domain}::uuid`);
    const [original] = await su((sql) => sql<{ domain_name: string }[]>`
      SELECT domain_name::text FROM domain WHERE id = ${IDS.domain}::uuid`);
    const taken = original!.domain_name;

    const response = await copy(IDS.domain, 'acme-copied.test');
    expect(response.status, await response.clone().text()).toBe(200);
    const { asset } = await json<{ asset: { id: string } }>(response);
    const [row] = await su((sql) => sql<{ domain_name: string; registrar: string; registry_expires_at: Date | null }[]>`
      SELECT domain_name::text, registrar, registry_expires_at FROM domain WHERE id = ${asset.id}::uuid`);
    expect(row).toEqual({ domain_name: 'acme-copied.test', registrar: 'Gandi', registry_expires_at: null });

    const duplicate = await copy(IDS.domain, taken);
    expect(duplicate.status).toBe(409);
    expect(await message(duplicate)).toMatch(/already documented as a domain/);
  });

  it('refuses a procedure, an unknown entry, and somebody without asset:write', async () => {
    currentUser = ADMIN;
    const procedure = await copy(IDS.sopOffboard, 'Offboarding (copy)');
    expect(procedure.status).toBe(400);
    expect(await message(procedure)).toMatch(/cannot be copied/);
    expect((await copy('00000000-0000-4000-8000-000000000000', 'x')).status).toBe(404);

    currentUser = VIEWER;
    expect((await copy(IDS.firewall, 'nope')).status).toBe(403);
  });
});

describe('a contact’s location', () => {
  it('is one of its own client’s, and can be changed or cleared', async () => {
    currentUser = ADMIN;
    const [acmeSite, globexSite] = await su(async (sql) => [
      (await sql<{ id: string }[]>`
        INSERT INTO site (tenant_id, organization_id, name) VALUES (${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, 'Acme HQ')
        RETURNING id`)[0]!.id,
      (await sql<{ id: string }[]>`
        INSERT INTO site (tenant_id, organization_id, name) VALUES (${IDS.tenant1}::uuid, ${IDS.orgGlobex}::uuid, 'Globex HQ')
        RETURNING id`)[0]!.id,
    ]);
    const [contact] = await su((sql) => sql<{ id: string }[]>`
      INSERT INTO contact (tenant_id, organization_id, first_name, last_name)
      VALUES (${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, 'Dana', 'Reception') RETURNING id`);
    const patch = (siteId: string | null) =>
      patchContact(req('PATCH', { siteId }), { params: Promise.resolve({ contactId: contact!.id }) });

    const assigned = await patch(acmeSite!);
    expect(assigned.status).toBe(200);
    expect((await json<{ contact: { siteId: string } }>(assigned)).contact.siteId).toBe(acmeSite);

    const elsewhere = await patch(globexSite!);
    expect(elsewhere.status).toBe(400);
    expect(await message(elsewhere)).toMatch(/belongs to a different client/);

    const cleared = await patch(null);
    expect((await json<{ contact: { siteId: string | null } }>(cleared)).contact.siteId).toBeNull();
  });
});

describe('creating a domain with its details', () => {
  it('stores them with it, and a refused one leaves nothing behind', async () => {
    currentUser = ADMIN;
    const response = await createAsset(req('POST', {
      organizationId: IDS.orgAcme, nodeType: 'domain', name: 'acme-new.test', domainName: 'acme-new.test',
      detail: {
        registrar: 'Cloudflare', expires_at: '2027-06-30', auto_renew: true,
        nameservers: 'ns1.example.net\nns2.example.net', dnssec_enabled: true,
      },
    }));
    expect(response.status, await response.clone().text()).toBe(200);
    const { asset } = await json<{ asset: { id: string } }>(response);
    const [row] = await su((sql) => sql<{ registrar: string; expires_at: Date; auto_renew: boolean; nameservers: string[]; dnssec_enabled: boolean }[]>`
      SELECT registrar, expires_at, auto_renew, nameservers, dnssec_enabled FROM domain WHERE id = ${asset.id}::uuid`);
    expect(row).toMatchObject({
      registrar: 'Cloudflare', auto_renew: true, nameservers: ['ns1.example.net', 'ns2.example.net'], dnssec_enabled: true,
    });
    expect(new Date(row!.expires_at).toISOString().slice(0, 10)).toBe('2027-06-30');

    const refused = await createAsset(req('POST', {
      organizationId: IDS.orgAcme, nodeType: 'domain', name: 'acme-bad.test', domainName: 'acme-bad.test',
      detail: { expires_at: 'next tuesday' },
    }));
    expect(refused.status).toBe(400);
    expect(await message(refused)).toMatch(/Expires must be a date/);
    const [left] = await su((sql) => sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM asset_node WHERE name = 'acme-bad.test'`);
    expect(left!.n).toBe(0);
  });
});

describe('a location’s address', () => {
  it('reads as one line, with the country only when it is not the default', () => {
    expect(siteAddress({
      address_line1: '1 Lake Shore Dr', address_line2: 'Suite 400', city: 'Buffalo', region: 'NY',
      postal_code: '14202', country: 'US',
    })).toBe('1 Lake Shore Dr, Suite 400, Buffalo, NY 14202');
    expect(siteAddress({ address_line1: '10 Bay St', city: 'Toronto', region: 'ON', postal_code: 'M5J 2R8', country: 'CA' }))
      .toBe('10 Bay St, Toronto, ON M5J 2R8, CA');
    expect(siteAddress({ city: 'Erie', country: 'US' })).toBe('Erie');
    expect(siteAddress({ country: 'US' })).toBeNull();
  });
});
