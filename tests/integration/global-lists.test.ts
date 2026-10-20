/**
 * The Global tab's Assets, Configurations and Credentials lists: every client's
 * entries in one grid, narrowed by filters read from the URL.
 *
 * What is worth asserting is that each filter narrows what it names and no
 * more, that a filter value the list does not know is dropped rather than
 * trusted, that credentials stay out of Assets and in a list of their own that
 * carries no secret material, and that RLS — not the page — decides whose
 * entries anybody sees.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../../src/lib/db/client';
import {
  listGlobalAssets, listGlobalConfigurations, listGlobalCredentials,
  readAssetFilters, readConfigurationFilters, readCredentialFilters,
} from '../../src/lib/global/lists';
import { connectPools, disconnectPools, IDS, resetDatabase } from './harness';

type Actor = { tenantId: string; actorId: string; actorType: 'user' };
const asAdmin: Actor = { tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' };
const asAcmeViewer: Actor = { tenantId: IDS.tenant1, actorId: IDS.acmeViewer, actorType: 'user' };

const assets = (search: Record<string, string>, actor = asAdmin) =>
  withTenant(actor, (tx) => listGlobalAssets(tx, readAssetFilters(search)));
const configurations = (search: Record<string, string>, actor = asAdmin) =>
  withTenant(actor, (tx) => listGlobalConfigurations(tx, readConfigurationFilters(search)));
const credentials = (search: Record<string, string>, actor = asAdmin) =>
  withTenant(actor, (tx) => listGlobalCredentials(tx, readCredentialFilters(search)));
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
    await tx`INSERT INTO credential (id, tenant_id, username, url, credential_type)
             VALUES (${cred!.id}::uuid, ${IDS.tenant1}::uuid, 'administrator', 'https://acme-dc01.acme.test', 'domain_admin')`;
    const [globex] = await tx<{ id: string }[]>`
      INSERT INTO asset_node (tenant_id, organization_id, node_type, name)
      VALUES (${IDS.tenant1}::uuid, ${IDS.orgGlobex}::uuid, 'credential', 'Globex app server local admin')
      RETURNING id
    `;
    await tx`INSERT INTO credential (id, tenant_id, username, credential_type)
             VALUES (${globex!.id}::uuid, ${IDS.tenant1}::uuid, 'localadmin', 'local_admin')`;
    const [hidden] = await tx<{ id: string }[]>`
      INSERT INTO asset_node (tenant_id, organization_id, node_type, name, is_internal_only)
      VALUES (${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, 'credential', 'Acme MSP break-glass', true)
      RETURNING id
    `;
    await tx`INSERT INTO credential (id, tenant_id, username, credential_type)
             VALUES (${hidden!.id}::uuid, ${IDS.tenant1}::uuid, 'msp-breakglass', 'local_admin')`;
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

describe('the Credentials list', () => {
  it('lists every client’s credentials, by name, username and where they are used', async () => {
    const rows = await credentials({});
    expect(names(rows)).toEqual(expect.arrayContaining([
      'Acme domain admin', 'Acme MSP break-glass', 'Globex app server local admin',
    ]));
    expect(rows.every((r) => r.organization_id !== IDS.orgContoso)).toBe(true);
    const dc = rows.find((r) => r.name === 'Acme domain admin')!;
    expect(dc).toMatchObject({
      username: 'administrator', url: 'https://acme-dc01.acme.test', credential_type: 'domain_admin',
      organization_name: 'Acme Manufacturing',
    });
  });

  it('carries no secret material, only the vault entry’s label and policy', async () => {
    const [row] = await credentials({});
    expect(Object.keys(row!).sort()).toEqual([
      'archived', 'credential_type', 'has_totp', 'id', 'is_internal_only', 'min_role_rank', 'name',
      'organization_id', 'organization_name', 'requires_reason', 'requires_step_up', 'secret_id',
      'secret_label', 'sensitivity', 'site_name', 'status', 'updated_at', 'updated_by_name', 'url', 'username',
    ]);
  });

  it('narrows by type and by client', async () => {
    expect(names(await credentials({ type: 'domain_admin' }))).toEqual(['Acme domain admin']);
    expect(names(await credentials({ type: 'local_admin', client: IDS.orgGlobex }))).toEqual(['Globex app server local admin']);
    expect(names(await credentials({ view: 'internal' }))).toEqual(['Acme MSP break-glass']);
  });

  it('drops a type it does not know', async () => {
    expect((await credentials({ type: 'device' })).length).toBeGreaterThanOrEqual(3);
  });

  it('shows a client user their own client’s shared credentials only', async () => {
    const seen = names(await credentials({}, asAcmeViewer));
    expect(seen).not.toContain('Globex app server local admin');
    expect(seen).not.toContain('Acme MSP break-glass');
  });
});
