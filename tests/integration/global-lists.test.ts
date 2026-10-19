/**
 * The Global tab's Assets and Configurations lists: every client's entries in
 * one grid, narrowed by filters read from the URL.
 *
 * What is worth asserting is that each filter narrows what it names and no
 * more, that a filter value the list does not know is dropped rather than
 * trusted, that credentials are not listed, and that RLS — not the page —
 * decides whose entries anybody sees.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../../src/lib/db/client';
import {
  listGlobalAssets, listGlobalConfigurations, readAssetFilters, readConfigurationFilters,
} from '../../src/lib/global/lists';
import { connectPools, disconnectPools, IDS, resetDatabase } from './harness';

type Actor = { tenantId: string; actorId: string; actorType: 'user' };
const asAdmin: Actor = { tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' };
const asAcmeViewer: Actor = { tenantId: IDS.tenant1, actorId: IDS.acmeViewer, actorType: 'user' };

const assets = (search: Record<string, string>, actor = asAdmin) =>
  withTenant(actor, (tx) => listGlobalAssets(tx, readAssetFilters(search)));
const configurations = (search: Record<string, string>, actor = asAdmin) =>
  withTenant(actor, (tx) => listGlobalConfigurations(tx, readConfigurationFilters(search)));
const names = (rows: { name: string }[]) => rows.map((r) => r.name);

beforeAll(async () => {
  resetDatabase();
  connectPools();
  await withTenant(asAdmin, async (tx) => {
    const [cred] = await tx<{ id: string }[]>`
      INSERT INTO asset_node (tenant_id, organization_id, node_type, name)
      VALUES (${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, 'credential', 'Acme domain admin')
      RETURNING id
    `;
    await tx`INSERT INTO credential (id, tenant_id, username) VALUES (${cred!.id}::uuid, ${IDS.tenant1}::uuid, 'administrator')`;
    await tx`UPDATE asset_node SET status = 'retired' WHERE id = ${IDS.domainController}::uuid`;
    await tx`UPDATE asset_node SET is_internal_only = true WHERE id = ${IDS.crmApp}::uuid`;
  });
}, 180_000);

afterAll(async () => {
  await disconnectPools();
});

describe('the Assets list', () => {
  it('lists every client’s assets, and never a credential', async () => {
    const all = names(await assets({}));
    expect(all).toEqual(expect.arrayContaining(['acme-fw-01', 'ACME-LAN VLAN 10', 'acme.test', 'globex-app-01']));
    expect(all).not.toContain('Acme domain admin');
    // The other tenant's firewall is not this tenant's to list.
    expect(all).not.toContain('contoso-fw-01');
  });

  it('narrows to one client, one type, one status, and one visibility', async () => {
    expect(names(await assets({ client: IDS.orgGlobex }))).toEqual(['globex-app-01']);
    expect(names(await assets({ type: 'domain' }))).toEqual(['acme.test']);
    expect(names(await assets({ status: 'retired' }))).toEqual(['ACME-DC01']);
    expect(names(await assets({ view: 'internal' }))).toEqual(['ACME CRM']);
    expect(names(await assets({ view: 'shared' }))).not.toContain('ACME CRM');
  });

  it('drops a filter value it does not know, rather than trusting it', async () => {
    // Asking for credentials by name widens to everything, credentials still out.
    const widened = names(await assets({ type: 'credential', client: 'not-a-uuid', status: 'gone' }));
    expect(widened).toContain('globex-app-01');
    expect(widened).not.toContain('Acme domain admin');
  });

  it('shows a client user their own client only, internal entries hidden', async () => {
    const seen = names(await assets({}, asAcmeViewer));
    expect(seen).toContain('acme-fw-01');
    expect(seen).not.toContain('globex-app-01');
    expect(seen).not.toContain('ACME CRM');
  });
});

describe('the Configurations list', () => {
  it('lists configurations only, across clients', async () => {
    expect(names(await configurations({})).sort()).toEqual(['ACME-DC01', 'acme-fw-01', 'globex-app-01'].sort());
  });

  it('narrows by device type and by client together', async () => {
    expect(names(await configurations({ type: 'server' })).sort()).toEqual(['ACME-DC01', 'globex-app-01'].sort());
    expect(names(await configurations({ type: 'server', client: IDS.orgAcme }))).toEqual(['ACME-DC01']);
  });

  it('carries what the grid shows: the client, the serial number', async () => {
    const [fw] = await configurations({ type: 'firewall' });
    expect(fw).toMatchObject({ name: 'acme-fw-01', organization_name: expect.any(String), serial_number: 'FGT60F0001' });
  });

  it('ignores a location without a client, which could name anybody’s', async () => {
    expect(readConfigurationFilters({ site: IDS.orgAcme }).site).toBeNull();
  });
});
