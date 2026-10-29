/**
 * The bulk bar's Delete, and the bar on Documents and Locations.
 *
 * Delete is the one bulk action that cannot be taken back, so the cases that
 * matter are the refusals: a selection with an entry that is not a password,
 * somebody without secret:delete, a vault id that is somebody else's. Each
 * must change nothing. Documents and Locations get Tag, Archive, Export and
 * Make copies too; those ride the same service as entries and contacts.
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import {
  actor, buildHarness, connectPools, disconnectPools, IDS, resetDatabase, superuserSql,
  type Harness,
} from './harness';
import { POST as bulkDelete } from '../../src/app/api/bulk/delete/route';
import { POST as bulkTags } from '../../src/app/api/bulk/tags/route';
import { POST as bulkArchive } from '../../src/app/api/bulk/archive/route';
import { POST as bulkExport } from '../../src/app/api/bulk/export/route';
import { POST as bulkCopy } from '../../src/app/api/bulk/copy/route';
import { collectExport } from '../../src/lib/exports/collect';
import { withTenant } from '../../src/lib/db/client';
import { setDocumentStorage } from '../../src/lib/documents/storage';
import { FilesystemExportStorage } from '../../src/lib/exports/storage';

let h: Harness;
let currentUser: SessionUser | null = null;
const asAdmin = () => { currentUser = { id: IDS.admin1, email: 'admin@northwind.test' }; };
const asTech = () => { currentUser = { id: IDS.tech1, email: 'tech@northwind.test' }; };

const post = (path: string, payload: unknown) =>
  new NextRequest(new Request(`http://helm.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }));

const json = async (r: Response) => (await r.json()) as Record<string, any>;

async function su<T>(fn: (sql: ReturnType<typeof superuserSql>) => Promise<T>): Promise<T> {
  const sql = superuserSql();
  try { return await fn(sql); } finally { await sql.end({ timeout: 5 }); }
}

async function credential(name: string): Promise<string> {
  const created = await h.secrets.create(
    actor(IDS.tenant1, IDS.admin1),
    { organizationId: IDS.orgAcme, kind: 'password', label: name },
    'a-stored-value',
  );
  return su(async (sql) => {
    const [node] = await sql<{ id: string }[]>`
      INSERT INTO asset_node (tenant_id, organization_id, node_type, name)
      VALUES (${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, 'credential', ${name}) RETURNING id
    `;
    await sql`
      INSERT INTO credential (id, tenant_id, credential_type, username, secret_id)
      VALUES (${node!.id}::uuid, ${IDS.tenant1}::uuid, 'local_admin', 'svc', ${created.secretId}::uuid)
    `;
    return node!.id;
  });
}

async function site(org: string, name: string, primary = false, tenant: string = IDS.tenant1): Promise<string> {
  return su(async (sql) => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO site (tenant_id, organization_id, name, code, is_primary, city)
      VALUES (${tenant}::uuid, ${org}::uuid, ${name}, ${name.slice(0, 8).toUpperCase()}, ${primary}, 'Buffalo')
      RETURNING id
    `;
    return row!.id;
  });
}

async function page(title: string): Promise<string> {
  return su(async (sql) => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO document_page (tenant_id, organization_id, title, body_text)
      VALUES (${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, ${title}, 'How the backups run.')
      RETURNING id
    `;
    return row!.id;
  });
}

async function file(name: string): Promise<string> {
  return su(async (sql) => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO attachment (tenant_id, organization_id, is_document, filename,
                              content_type, byte_size, storage_key, content_sha256, uploaded_by)
      VALUES (${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, true, ${name}, 'application/pdf', 64,
              ${'bulk/' + Math.random().toString(36).slice(2)}, decode(repeat('ab', 32), 'hex'),
              ${IDS.admin1}::uuid)
      RETURNING id
    `;
    return row!.id;
  });
}

beforeAll(async () => {
  resetDatabase();
  connectPools();
  h = buildHarness();
  resetServices();
  setKekProvider(h.kek);
  useSessionResolver(async () => currentUser);
  await h.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'bulk delete tests' });
  // The route reaches for the singleton document service, which deletes a
  // file's stored bytes too: point it at the harness's directory.
  setDocumentStorage(new FilesystemExportStorage(h.documentRoot));
  await su((sql) => sql`UPDATE membership SET role_key = 'tier1' WHERE user_id = ${IDS.tech1}::uuid`);
}, 120_000);

beforeEach(async () => {
  asAdmin();
  await su((sql) => sql`DELETE FROM export_job`);
});

afterAll(async () => {
  resetServices();
  setDocumentStorage(null);
  await disconnectPools();
});

describe('deleting passwords', () => {
  it('deletes a selection of live passwords, archiving them first, with their stored values', async () => {
    const ids = [await credential('bulk one'), await credential('bulk two')];
    const response = await bulkDelete(post('/api/bulk/delete', { target: 'node', ids }));
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await json(response)).affected).toBe(2);
    const left = await su((sql) => sql`SELECT id FROM asset_node WHERE id = ANY(${ids}::uuid[])`);
    expect(left).toHaveLength(0);
  });

  it('refuses a selection with an entry that is not a password, and changes nothing', async () => {
    const id = await credential('kept');
    const response = await bulkDelete(post('/api/bulk/delete', { target: 'node', ids: [id, IDS.firewall] }));
    expect(response.status).toBe(400);
    expect((await json(response)).error.message).toMatch(/only passwords can be deleted/i);
    const [row] = await su((sql) => sql<{ archived_at: Date | null }[]>`
      SELECT archived_at FROM asset_node WHERE id = ${id}::uuid`);
    expect(row!.archived_at).toBeNull();
  });

  it('refuses somebody without secret:delete', async () => {
    const id = await credential('tier1 cannot');
    asTech();
    const response = await bulkDelete(post('/api/bulk/delete', { target: 'node', ids: [id] }));
    expect(response.status).toBe(403);
    expect(await su((sql) => sql`SELECT id FROM asset_node WHERE id = ${id}::uuid`)).toHaveLength(1);
  });
});

describe('deleting from my own vault', () => {
  it('deletes my entries, and refuses one that is somebody else’s without touching mine', async () => {
    const [mine1, mine2, theirs] = await su(async (sql) => {
      const rows = await sql<{ id: string }[]>`
        INSERT INTO personal_credential (tenant_id, owner_user_id, name)
        VALUES (${IDS.tenant1}::uuid, ${IDS.admin1}::uuid, 'mine 1'),
               (${IDS.tenant1}::uuid, ${IDS.admin1}::uuid, 'mine 2'),
               (${IDS.tenant1}::uuid, ${IDS.tech1}::uuid, 'theirs')
        RETURNING id`;
      return rows.map((r) => r.id);
    });

    const refused = await bulkDelete(post('/api/bulk/delete', { target: 'vault', ids: [mine1, theirs] }));
    expect(refused.status).toBe(403);
    expect(await su((sql) => sql`SELECT id FROM personal_credential WHERE id = ANY(${[mine1!, theirs!]}::uuid[])`))
      .toHaveLength(2);

    const response = await bulkDelete(post('/api/bulk/delete', { target: 'vault', ids: [mine1, mine2] }));
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await json(response)).affected).toBe(2);
    const left = await su((sql) => sql<{ id: string }[]>`SELECT id FROM personal_credential`);
    expect(left.map((r) => r.id)).toEqual([theirs]);
  });
});

describe('locations', () => {
  it('tags, archives (clearing primary) and restores a selection', async () => {
    const ids = [await site(IDS.orgAcme, 'Tag HQ', true), await site(IDS.orgAcme, 'Tag Annex')];
    expect((await bulkTags(post('/api/bulk/tags', { target: 'site', ids, tags: ['Warehouse'] }))).status).toBe(200);
    expect((await bulkArchive(post('/api/bulk/archive', { target: 'site', ids, archived: true }))).status).toBe(200);
    const rows = await su((sql) => sql<{ tags: string[]; is_primary: boolean; archived_at: Date | null }[]>`
      SELECT tags, is_primary, archived_at FROM site WHERE id = ANY(${ids}::uuid[])`);
    expect(rows.every((r) => r.tags.join() === 'warehouse' && !r.is_primary && r.archived_at)).toBe(true);
    expect((await bulkArchive(post('/api/bulk/archive', { target: 'site', ids, archived: false }))).status).toBe(200);
  });

  it('copies a selection without its code or primary flag', async () => {
    const id = await site(IDS.orgAcme, 'Copy HQ', false);
    const response = await bulkCopy(post('/api/bulk/copy', { target: 'site', ids: [id] }));
    expect(response.status, await response.clone().text()).toBe(200);
    const { copies } = await json(response);
    const [row] = await su((sql) => sql<{ name: string; code: string | null; city: string }[]>`
      SELECT name, code, city FROM site WHERE id = ${copies[0].id}::uuid`);
    expect(row).toEqual({ name: 'Copy HQ (copy)', code: null, city: 'Buffalo' });
  });

  it('exports a locations-only bundle', async () => {
    const id = await site(IDS.orgAcme, 'Export HQ');
    const response = await bulkExport(post('/api/bulk/export', {
      target: 'site', ids: [id], reason: 'Locations for the new field tech',
    }));
    expect(response.status, await response.clone().text()).toBe(200);
    const collected = await withTenant(actor(IDS.tenant1, IDS.admin1), (tx) =>
      collectExport(tx, IDS.orgAcme, { siteIds: [id] }));
    expect(collected.sites.map((s) => s.id)).toEqual([id]);
    expect(collected.assets).toEqual([]);
    expect(collected.contacts).toEqual([]);
  });

  it('deletes a selection, live ones included', async () => {
    const ids = [await site(IDS.orgAcme, 'Gone A'), await site(IDS.orgAcme, 'Gone B')];
    const response = await bulkDelete(post('/api/bulk/delete', { target: 'site', ids }));
    expect(response.status, await response.clone().text()).toBe(200);
    const rows = await su((sql) => sql<{ deleted_at: Date | null }[]>`
      SELECT deleted_at FROM site WHERE id = ANY(${ids}::uuid[])`);
    expect(rows.every((r) => r.deleted_at)).toBe(true);
  });

  it('refuses a selection reaching a location in another tenant', async () => {
    const id = await site(IDS.orgContoso, 'Other tenant', false, IDS.tenant2);
    const ours = await site(IDS.orgAcme, 'Ours');
    const response = await bulkDelete(post('/api/bulk/delete', { target: 'site', ids: [ours, id] }));
    expect(response.status).toBe(403);
    const [row] = await su((sql) => sql<{ deleted_at: Date | null }[]>`SELECT deleted_at FROM site WHERE id = ${ours}::uuid`);
    expect(row!.deleted_at).toBeNull();
  });
});

describe('documents', () => {
  it('tags and archives files and written documents in one selection', async () => {
    const ids = [await file('tagged.pdf'), await page('Tagged runbook')];
    const tagged = await bulkTags(post('/api/bulk/tags', { target: 'document', ids, tags: ['Backups'] }));
    expect(tagged.status, await tagged.clone().text()).toBe(200);
    expect((await json(tagged)).affected).toBe(2);
    const archived = await bulkArchive(post('/api/bulk/archive', { target: 'document', ids, archived: true }));
    expect(archived.status).toBe(200);
    const rows = await su((sql) => sql<{ tags: string[]; archived: boolean }[]>`
      SELECT tags, archived_at IS NOT NULL AS archived FROM attachment WHERE id = ${ids[0]!}::uuid
      UNION ALL
      SELECT tags, archived_at IS NOT NULL FROM document_page WHERE id = ${ids[1]!}::uuid`);
    expect(rows).toEqual([{ tags: ['backups'], archived: true }, { tags: ['backups'], archived: true }]);
  });

  it('copies written documents, twice without a title clash', async () => {
    const id = await page('Copied runbook');
    await bulkCopy(post('/api/bulk/copy', { target: 'document', ids: [id] }));
    const second = await bulkCopy(post('/api/bulk/copy', { target: 'document', ids: [id] }));
    expect(second.status, await second.clone().text()).toBe(200);
    expect((await json(second)).copies[0].name).toBe('Copied runbook (copy 2)');
  });

  it('refuses to copy an uploaded file', async () => {
    const response = await bulkCopy(post('/api/bulk/copy', { target: 'document', ids: [await file('nocopy.pdf')] }));
    expect(response.status).toBe(404);
  });

  it('exports a documents-only inventory with files and written documents', async () => {
    const ids = [await file('inventory.pdf'), await page('Inventory runbook')];
    const response = await bulkExport(post('/api/bulk/export', {
      target: 'document', ids, reason: 'Document handover for the client',
    }));
    expect(response.status, await response.clone().text()).toBe(200);
    const collected = await withTenant(actor(IDS.tenant1, IDS.admin1), (tx) =>
      collectExport(tx, IDS.orgAcme, { documentIds: ids }));
    expect(collected.documents.map((d) => d.filename).sort()).toEqual(['Inventory runbook', 'inventory.pdf']);
    expect(collected.assets).toEqual([]);
  });

  it('deletes files and written documents, live ones included', async () => {
    const ids = [await file('deleted.pdf'), await page('Deleted runbook')];
    const response = await bulkDelete(post('/api/bulk/delete', { target: 'document', ids }));
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await json(response)).affected).toBe(2);
    const left = await su((sql) => sql`
      SELECT id FROM attachment WHERE id = ${ids[0]!}::uuid AND deleted_at IS NULL
      UNION ALL SELECT id FROM document_page WHERE id = ${ids[1]!}::uuid AND deleted_at IS NULL`);
    expect(left).toHaveLength(0);
  });

  it('refuses somebody without asset:delete, before archiving anything', async () => {
    const id = await page('Tier1 keeps');
    asTech();
    const response = await bulkDelete(post('/api/bulk/delete', { target: 'document', ids: [id] }));
    expect(response.status).toBe(403);
    const [row] = await su((sql) => sql<{ archived_at: Date | null }[]>`
      SELECT archived_at FROM document_page WHERE id = ${id}::uuid`);
    expect(row!.archived_at).toBeNull();
  });
});
