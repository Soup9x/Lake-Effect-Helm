/**
 * Change history (0970): every save of an asset, contact or location records
 * the fields it changed, as [before, after], with who made it.
 *
 * Asserted: a save records only what changed and a no-op save nothing; an
 * asset's detail table records under the node; archive and restore are named;
 * ids read as names; bookkeeping and secret pointers are left out; and the
 * history is exactly as visible as the entry — an internal-only entry's
 * history is not a client user's, and nobody can write history directly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../../src/lib/db/client';
import { listHistory } from '../../src/lib/history/queries';
import { connectPools, disconnectPools, IDS, resetDatabase, superuserSql } from './harness';

type Actor = { tenantId: string; actorId: string; actorType: 'user' };
const ADMIN: Actor = { tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' };
const VIEWER: Actor = { tenantId: IDS.tenant1, actorId: IDS.acmeViewer, actorType: 'user' };

const as = <T>(actor: Actor, fn: Parameters<typeof withTenant<T>>[1]) => withTenant<T>(actor, fn);
const historyOf = (entity: 'asset' | 'contact' | 'site', id: string, actor: Actor = ADMIN) =>
  as(actor, (tx) => listHistory(tx, entity, id));

let siteA = '';
let siteB = '';

beforeAll(async () => {
  resetDatabase();
  connectPools();
  const rows = await as(ADMIN, (tx) => tx<{ id: string }[]>`
    INSERT INTO site (tenant_id, organization_id, name) VALUES
      (${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, 'Head office'),
      (${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, 'Warehouse')
    RETURNING id
  `);
  siteA = rows[0]!.id;
  siteB = rows[1]!.id;
}, 180_000);

afterAll(async () => {
  await disconnectPools();
});

describe('what a save records', () => {
  it('records the fields that changed, before and after, and who changed them', async () => {
    await as(ADMIN, (tx) => tx`
      UPDATE asset_node SET name = 'acme-fw-edge', status = 'maintenance', updated_at = now()
      WHERE id = ${IDS.firewall}::uuid`);
    const [latest] = await historyOf('asset', IDS.firewall);
    expect(latest!.kind).toBe('updated');
    expect(latest!.actor).toBe('Northwind Admin');
    expect(latest!.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Name', before: 'acme-fw-01', after: 'acme-fw-edge' }),
      expect.objectContaining({ label: 'Status', before: 'active', after: 'maintenance' }),
    ]));
    // updated_at moved too, and is not news.
    expect(latest!.changes.map((c) => c.field)).not.toContain('updated_at');
  });

  it('records nothing for a save that changed nothing', async () => {
    const before = (await historyOf('asset', IDS.firewall)).length;
    await as(ADMIN, (tx) => tx`UPDATE asset_node SET updated_at = now() WHERE id = ${IDS.firewall}::uuid`);
    expect(await historyOf('asset', IDS.firewall)).toHaveLength(before);
  });

  it('records a configuration’s details under the configuration', async () => {
    await as(ADMIN, (tx) => tx`UPDATE device SET serial_number = 'FGT60F9999' WHERE id = ${IDS.firewall}::uuid`);
    const [latest] = await historyOf('asset', IDS.firewall);
    expect(latest!.changes).toEqual([
      expect.objectContaining({ label: 'Serial number', before: 'FGT60F0001', after: 'FGT60F9999' }),
    ]);
  });

  it('names the location rather than its id, and archive and restore by what they are', async () => {
    await as(ADMIN, (tx) => tx`UPDATE asset_node SET site_id = ${siteA}::uuid WHERE id = ${IDS.firewall}::uuid`);
    await as(ADMIN, (tx) => tx`UPDATE asset_node SET site_id = ${siteB}::uuid WHERE id = ${IDS.firewall}::uuid`);
    const [moved] = await historyOf('asset', IDS.firewall);
    expect(moved!.changes).toEqual([
      expect.objectContaining({ label: 'Location', before: 'Head office', after: 'Warehouse' }),
    ]);

    await as(ADMIN, (tx) => tx`UPDATE asset_node SET archived_at = now() WHERE id = ${IDS.firewall}::uuid`);
    await as(ADMIN, (tx) => tx`UPDATE asset_node SET archived_at = NULL WHERE id = ${IDS.firewall}::uuid`);
    const [restored, archived] = await historyOf('asset', IDS.firewall);
    expect(archived!.kind).toBe('archived');
    expect(restored!.kind).toBe('restored');
  });

  it('records a contact and a location the same way, from their creation on', async () => {
    const [contact] = await as(ADMIN, (tx) => tx<{ id: string }[]>`
      INSERT INTO contact (tenant_id, organization_id, first_name, last_name)
      VALUES (${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, 'Pat', 'Lee') RETURNING id`);
    await as(ADMIN, (tx) => tx`UPDATE contact SET title = 'Office manager' WHERE id = ${contact!.id}::uuid`);
    const history = await historyOf('contact', contact!.id);
    expect(history.map((h) => h.kind)).toEqual(['updated', 'created']);
    expect(history[0]!.changes).toEqual([expect.objectContaining({ label: 'Title', before: null, after: 'Office manager' })]);

    await as(ADMIN, (tx) => tx`UPDATE site SET city = 'Buffalo' WHERE id = ${siteA}::uuid`);
    const [siteChange] = await historyOf('site', siteA);
    expect(siteChange!.changes).toEqual([expect.objectContaining({ label: 'City', after: 'Buffalo' })]);
  });

  it('leaves out what points at a secret', async () => {
    const [cred] = await as(ADMIN, (tx) => tx<{ id: string }[]>`
      INSERT INTO asset_node (tenant_id, organization_id, node_type, name)
      VALUES (${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, 'credential', 'History login') RETURNING id`);
    await as(ADMIN, (tx) => tx`INSERT INTO credential (id, tenant_id, username) VALUES (${cred!.id}::uuid, ${IDS.tenant1}::uuid, 'old')`);
    await as(ADMIN, (tx) => tx`UPDATE credential SET username = 'new' WHERE id = ${cred!.id}::uuid`);
    const [latest] = await historyOf('asset', cred!.id);
    expect(latest!.changes.map((c) => c.field)).toEqual(['username']);
  });
});

describe('who may see it', () => {
  it('is visible to whoever can see the entry, and goes internal with it', async () => {
    await as(ADMIN, (tx) => tx`UPDATE asset_node SET description = 'Primary DC' WHERE id = ${IDS.domainController}::uuid`);
    expect((await historyOf('asset', IDS.domainController, VIEWER)).length).toBeGreaterThan(0);

    await as(ADMIN, (tx) => tx`UPDATE asset_node SET is_internal_only = true WHERE id = ${IDS.domainController}::uuid`);
    try {
      expect(await historyOf('asset', IDS.domainController, VIEWER)).toEqual([]);
      expect((await historyOf('asset', IDS.domainController)).length).toBeGreaterThan(0);
    } finally {
      await as(ADMIN, (tx) => tx`UPDATE asset_node SET is_internal_only = false WHERE id = ${IDS.domainController}::uuid`);
    }
  });

  it('cannot be written or rewritten by the application', async () => {
    await expect(as(ADMIN, (tx) => tx`
      INSERT INTO entity_change (tenant_id, organization_id, entity_type, entity_id, kind)
      VALUES (${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, 'asset', ${IDS.firewall}::uuid, 'updated')`))
      .rejects.toThrow(/permission denied/);
    await expect(as(ADMIN, (tx) => tx`DELETE FROM entity_change`)).rejects.toThrow(/permission denied/);
  });

  it('is not another tenant’s to read', async () => {
    const sql = superuserSql();
    try {
      const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM entity_change WHERE tenant_id = ${IDS.tenant1}::uuid`;
      expect(row!.n).toBeGreaterThan(0);
    } finally {
      await sql.end({ timeout: 5 });
    }
    const seen = await as({ tenantId: IDS.tenant2, actorId: IDS.admin2, actorType: 'user' },
      (tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM entity_change WHERE tenant_id = ${IDS.tenant1}::uuid`);
    expect(seen[0]!.n).toBe(0);
  });
});
