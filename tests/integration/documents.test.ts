/**
 * Client documents, end to end, against a real cluster and real roles.
 *
 * Documents are attachments in a folder tree, so most of the security is
 * inherited rather than new — and inherited security is exactly the kind that
 * gets assumed. These tests exercise it through the paths a person actually
 * reaches: the upload, the download, the list the client page renders, the
 * search index, and the export bundle. That last one is here because the
 * internal-only flag has been found leaking through a collector before: 0390's
 * audit turned up fifteen query paths and the rule held in one.
 *
 * The bytes go to a real directory, so "encrypted at rest" is checked by
 * reading the file off disk rather than by trusting the column.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../../src/lib/db/client';
import { resetServices, setKekProvider } from '../../src/lib/services';
import { collectExport } from '../../src/lib/exports/collect';
import { DocumentError } from '../../src/lib/documents/service';
import {
  IDS, actor, buildHarness, connectPools, disconnectPools, resetDatabase,
} from './harness';

const ADMIN = actor(IDS.tenant1, IDS.admin1);
/** Tier 1: holds asset:write, so it may archive. Not asset:delete. */
const TECH = actor(IDS.tenant1, IDS.tech1);
/** The client's own administrator, scoped to ACME alone. */
const CLIENT = actor(IDS.tenant1, IDS.acmeAdmin);
const OTHER_TENANT = actor(IDS.tenant2, IDS.admin2);

/** One harness for the file: a second would mint a second KEK. See exports.test.ts. */
let harness: ReturnType<typeof buildHarness>;

const bytesOf = (text: string) => Buffer.from(text, 'utf8');

async function newFolder(
  who: typeof ADMIN,
  name: string,
  options: { parentId?: string | null; internal?: boolean } = {},
): Promise<string> {
  return withTenant(who, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO document_folder (tenant_id, organization_id, parent_id, name, is_internal_only)
      VALUES (${who.tenantId}::uuid, ${IDS.orgAcme}::uuid, ${options.parentId ?? null},
              ${name}, ${options.internal ?? false})
      RETURNING id
    `;
    return row!.id;
  });
}

function upload(
  who: typeof ADMIN,
  filename: string,
  body: string,
  options: { folderId?: string | null; internal?: boolean; organizationId?: string } = {},
) {
  return harness.documents.upload(who, {
    organizationId: options.organizationId ?? IDS.orgAcme,
    folderId: options.folderId ?? null,
    filename,
    contentType: 'application/pdf',
    isInternalOnly: options.internal ?? false,
    bytes: bytesOf(body),
  });
}

beforeAll(async () => {
  resetDatabase();
  connectPools();

  harness = buildHarness();
  setKekProvider(harness.kek);
  await harness.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'document tests' });
  await harness.keys.provision(IDS.tenant2, IDS.admin2, { reason: 'document tests' });
});

afterAll(async () => {
  resetServices();
  await disconnectPools();
});

describe('uploading', () => {
  it('stores the file and says what it stored', async () => {
    const stored = await upload(ADMIN, 'msa-2026.pdf', 'the master services agreement');

    expect(stored.filename).toBe('msa-2026.pdf');
    expect(stored.byteSize).toBe('the master services agreement'.length);
    expect(stored.isInternalOnly).toBe(false);
  });

  it('writes CIPHERTEXT to disk, not the file', async () => {
    const plaintext = 'wifi PSK is hunter2, do not tell the client';
    const stored = await upload(ADMIN, 'install-notes.pdf', plaintext);

    const [row] = await withTenant(ADMIN, (tx) => tx<{ storage_key: string }[]>`
      SELECT storage_key FROM attachment WHERE id = ${stored.id}::uuid
    `);
    const onDisk = await readFile(join(harness.documentRoot, row!.storage_key));

    // The assertion that matters: somebody with the volume and without the
    // database and the KEK has bytes, not documents.
    expect(onDisk.includes('hunter2')).toBe(false);
    expect(onDisk.toString('utf8')).not.toContain('PSK');
    // ciphertext || 16-byte GCM tag.
    expect(onDisk.length).toBe(plaintext.length + 16);
  });

  it('writes it 0600, because ciphertext still lands in every backup', async () => {
    const stored = await upload(ADMIN, 'modes.pdf', 'x');
    const [row] = await withTenant(ADMIN, (tx) => tx<{ storage_key: string }[]>`
      SELECT storage_key FROM attachment WHERE id = ${stored.id}::uuid
    `);

    const stats = await stat(join(harness.documentRoot, row!.storage_key));
    // eslint-disable-next-line no-bitwise
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('records the upload in the audit log', async () => {
    const stored = await upload(ADMIN, 'audited.pdf', 'x');

    const rows = await withTenant(ADMIN, (tx) => tx<{ action: string }[]>`
      SELECT action FROM audit_log
      WHERE entity_id = ${stored.id}::uuid AND action = 'document.uploaded'
    `);
    expect(rows).toHaveLength(1);
  });

  it('refuses a second document with the same name in the same folder', async () => {
    const folder = await newFolder(ADMIN, 'Duplicates');
    await upload(ADMIN, 'same.pdf', 'first', { folderId: folder });

    // No versioning: the second upload is refused rather than silently
    // replacing bytes the first caller may still need.
    await expect(upload(ADMIN, 'same.pdf', 'second', { folderId: folder })).rejects.toMatchObject({
      code: 'name_taken',
    });
  });

  it('...and leaves no orphan file behind when it does', async () => {
    const folder = await newFolder(ADMIN, 'Orphans');
    await upload(ADMIN, 'only.pdf', 'first', { folderId: folder });

    // Files only. remove() unlinks the file and leaves the two sharding
    // directories, which is correct and would otherwise read as an orphan.
    const countFiles = async () =>
      (await readdir(harness.documentRoot, { recursive: true, withFileTypes: true })).filter((e) =>
        e.isFile(),
      ).length;

    const before = await countFiles();
    await expect(upload(ADMIN, 'only.pdf', 'second', { folderId: folder })).rejects.toThrow();
    const after = await countFiles();

    // The bytes are written before the row and removed again when the row is
    // refused. A row pointing at nothing is a support call; a file pointing at
    // nothing is disk.
    expect(after).toBe(before);
  });

  it('allows the same name in a DIFFERENT folder', async () => {
    const a = await newFolder(ADMIN, 'Branch A');
    const b = await newFolder(ADMIN, 'Branch B');

    await expect(upload(ADMIN, 'shared-name.pdf', 'x', { folderId: a })).resolves.toBeTruthy();
    await expect(upload(ADMIN, 'shared-name.pdf', 'y', { folderId: b })).resolves.toBeTruthy();
  });

  it('refuses a folder belonging to another client', async () => {
    const acmeFolder = await newFolder(ADMIN, 'ACME only');

    await expect(
      upload(ADMIN, 'misfiled.pdf', 'x', {
        folderId: acmeFolder,
        organizationId: IDS.orgGlobex,
      }),
    ).rejects.toMatchObject({ code: 'no_such_folder' });
  });
});

describe('downloading', () => {
  it('round-trips the exact bytes', async () => {
    const plaintext = 'diagram bytes, or close enough';
    const stored = await upload(ADMIN, 'round-trip.pdf', plaintext);

    const opened = await harness.documents.download(ADMIN, stored.id);
    expect(opened.bytes.toString('utf8')).toBe(plaintext);
    expect(opened.filename).toBe('round-trip.pdf');
  });

  it('records the download, with an audit id the caller can quote', async () => {
    const stored = await upload(ADMIN, 'traced.pdf', 'x');
    const opened = await harness.documents.download(ADMIN, stored.id);

    const rows = await withTenant(ADMIN, (tx) => tx<{ event_uid: string }[]>`
      SELECT event_uid FROM audit_log
      WHERE entity_id = ${stored.id}::uuid AND action = 'document.downloaded'
    `);
    expect(rows.map((r) => r.event_uid)).toContain(opened.auditEventUid);
  });

  it('refuses a document in another tenant', async () => {
    const stored = await upload(ADMIN, 'ours.pdf', 'x');

    await expect(harness.documents.download(OTHER_TENANT, stored.id)).rejects.toBeInstanceOf(
      DocumentError,
    );
  });
});

describe('the internal-only flag, through every path that reaches a document', () => {
  let internalFolder: string;
  let internalDoc: string;
  let sharedDoc: string;

  beforeAll(async () => {
    internalFolder = await newFolder(ADMIN, 'Margins', { internal: true });
    // Asked for false. The folder decides.
    internalDoc = (await upload(ADMIN, 'margin-analysis.pdf', 'they are 60 days late', {
      folderId: internalFolder,
      internal: false,
    })).id;
    sharedDoc = (await upload(ADMIN, 'client-runbook.pdf', 'how to restart the VPN')).id;
  });

  it('is forced on by the folder, whatever the upload asked for', async () => {
    const [row] = await withTenant(ADMIN, (tx) => tx<{ is_internal_only: boolean }[]>`
      SELECT is_internal_only FROM attachment WHERE id = ${internalDoc}::uuid
    `);
    expect(row!.is_internal_only).toBe(true);
  });

  it('hides it from the client on the list the client page renders', async () => {
    const rows = await withTenant(CLIENT, (tx) => tx<{ filename: string }[]>`
      SELECT filename FROM attachment
      WHERE organization_id = ${IDS.orgAcme}::uuid AND is_document AND deleted_at IS NULL
    `);
    const names = rows.map((r) => r.filename);

    expect(names).toContain('client-runbook.pdf');
    expect(names).not.toContain('margin-analysis.pdf');
  });

  it('hides the folder too', async () => {
    const rows = await withTenant(CLIENT, (tx) => tx<{ name: string }[]>`
      SELECT name FROM document_folder WHERE organization_id = ${IDS.orgAcme}::uuid
    `);
    expect(rows.map((r) => r.name)).not.toContain('Margins');
  });

  it('hides it from search', async () => {
    const hits = await withTenant(CLIENT, (tx) => tx<{ title: string }[]>`
      SELECT title FROM helm.search('margin-analysis', NULL, NULL, 20, 0)
    `);
    expect(hits).toHaveLength(0);

    // ...and the query works at all, so the assertion above is not vacuous.
    const visible = await withTenant(CLIENT, (tx) => tx<{ title: string }[]>`
      SELECT title FROM helm.search('client-runbook', NULL, NULL, 20, 0)
    `);
    expect(visible.map((h) => h.title)).toContain('client-runbook.pdf');
  });

  it('refuses the download', async () => {
    await expect(harness.documents.download(CLIENT, internalDoc)).rejects.toBeInstanceOf(
      DocumentError,
    );
    await expect(harness.documents.download(CLIENT, sharedDoc)).resolves.toBeTruthy();
  });

  it('...and records the refusal, because it is returned rather than raised', async () => {
    await expect(harness.documents.download(CLIENT, internalDoc)).rejects.toThrow();

    const rows = await withTenant(ADMIN, (tx) => tx<{ outcome: string }[]>`
      SELECT outcome FROM audit_log
      WHERE entity_id = ${internalDoc}::uuid AND action = 'document.download_denied'
    `);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.outcome).toBe('denied');
  });

  // -------------------------------------------------------------------------
  // The export bundle. A co-managed client administrator holds export:create,
  // and the collector runs under the REQUESTING actor rather than the worker —
  // which is the fix 0390 made and the reason documents get it for free.
  // -------------------------------------------------------------------------
  it('keeps it out of an export the client requested', async () => {
    const bundle = await withTenant(CLIENT, (tx) => collectExport(tx, IDS.orgAcme, {}));
    const names = bundle.documents.map((d) => d.filename);

    expect(names).toContain('client-runbook.pdf');
    expect(names).not.toContain('margin-analysis.pdf');
    expect(bundle.documents.every((d) => !d.is_internal_only)).toBe(true);
  });

  it('...while the MSP still gets everything, so the bundle is not simply empty', async () => {
    const bundle = await withTenant(ADMIN, (tx) => collectExport(tx, IDS.orgAcme, {}));
    const names = bundle.documents.map((d) => d.filename);

    expect(names).toContain('client-runbook.pdf');
    expect(names).toContain('margin-analysis.pdf');
  });

  it('carries the folder path into the bundle, so a handover can be checked off', async () => {
    const bundle = await withTenant(ADMIN, (tx) => collectExport(tx, IDS.orgAcme, {}));
    const margin = bundle.documents.find((d) => d.filename === 'margin-analysis.pdf');

    expect(margin?.path).toBe('Margins');
    expect(margin?.content_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('archiving, and the rail in front of deletion', () => {
  it('takes the document out of search and leaves the row whole', async () => {
    const stored = await upload(ADMIN, 'retiring.pdf', 'x');

    await withTenant(ADMIN, (tx) => tx`
      UPDATE attachment SET archived_at = now() WHERE id = ${stored.id}::uuid
    `);

    const [indexed] = await withTenant(ADMIN, (tx) => tx<{ count: string }[]>`
      SELECT count(*)::text FROM search_document WHERE entity_id = ${stored.id}::uuid
    `);
    expect(indexed!.count).toBe('0');

    // Still readable, still downloadable: archived is not deleted.
    await expect(harness.documents.download(ADMIN, stored.id)).resolves.toBeTruthy();
  });

  it('refuses to delete a live document', async () => {
    const stored = await upload(ADMIN, 'still-live.pdf', 'x');

    await expect(harness.documents.remove(ADMIN, stored.id)).rejects.toMatchObject({
      code: 'not_archived',
    });
  });

  it('refuses a rank that can archive but not destroy', async () => {
    const stored = await upload(ADMIN, 'tier1-cannot.pdf', 'x');
    // tier1 holds asset:write, so it archives...
    await withTenant(TECH, (tx) => tx`
      UPDATE attachment SET archived_at = now() WHERE id = ${stored.id}::uuid
    `);

    await expect(harness.documents.remove(TECH, stored.id)).rejects.toMatchObject({
      code: 'forbidden',
    });
    // ...and the refusal is on the record, not swallowed by its own exception.
    const denials = await withTenant(ADMIN, (tx) => tx<{ id: string }[]>`
      SELECT id FROM audit_log
      WHERE entity_id = ${stored.id}::uuid AND action = 'document.delete_denied'
    `);
    expect(denials.length).toBeGreaterThan(0);
  });

  it('deletes the row AND the bytes once archived', async () => {
    const stored = await upload(ADMIN, 'doomed.pdf', 'goodbye');
    const [row] = await withTenant(ADMIN, (tx) => tx<{ storage_key: string }[]>`
      SELECT storage_key FROM attachment WHERE id = ${stored.id}::uuid
    `);
    const path = join(harness.documentRoot, row!.storage_key);
    await expect(stat(path)).resolves.toBeTruthy();

    await withTenant(ADMIN, (tx) => tx`
      UPDATE attachment SET archived_at = now() WHERE id = ${stored.id}::uuid
    `);
    await harness.documents.remove(ADMIN, stored.id);

    await expect(stat(path)).rejects.toThrow();
    const [after] = await withTenant(ADMIN, (tx) => tx<{ count: string }[]>`
      SELECT count(*)::text FROM attachment WHERE id = ${stored.id}::uuid
    `);
    expect(after!.count).toBe('0');
  });

  it('...and the audit trail outlives the row it describes', async () => {
    const stored = await upload(ADMIN, 'remembered.pdf', 'x');
    await withTenant(ADMIN, (tx) => tx`
      UPDATE attachment SET archived_at = now() WHERE id = ${stored.id}::uuid
    `);
    await harness.documents.remove(ADMIN, stored.id);

    const rows = await withTenant(ADMIN, (tx) => tx<{ metadata: { filename: string } }[]>`
      SELECT metadata FROM audit_log
      WHERE entity_id = ${stored.id}::uuid AND action = 'document.deleted'
    `);
    expect(rows[0]?.metadata.filename).toBe('remembered.pdf');
  });
});

describe('the folder tree', () => {
  it('refuses to delete a folder that still has anything in it', async () => {
    const folder = await newFolder(ADMIN, 'Occupied');
    const stored = await upload(ADMIN, 'inside.pdf', 'x', { folderId: folder });

    await expect(
      withTenant(ADMIN, (tx) => tx`DELETE FROM document_folder WHERE id = ${folder}::uuid`),
    ).rejects.toThrow(/not empty/);

    // An ARCHIVED document still holds it open, which is the case a UI that
    // only counts live files would get wrong.
    await withTenant(ADMIN, (tx) => tx`
      UPDATE attachment SET archived_at = now() WHERE id = ${stored.id}::uuid
    `);
    await expect(
      withTenant(ADMIN, (tx) => tx`DELETE FROM document_folder WHERE id = ${folder}::uuid`),
    ).rejects.toThrow(/not empty/);

    await harness.documents.remove(ADMIN, stored.id);
    await expect(
      withTenant(ADMIN, (tx) => tx`DELETE FROM document_folder WHERE id = ${folder}::uuid`),
    ).resolves.toBeTruthy();
  });

  it('re-indexes everything beneath a folder that is renamed', async () => {
    const parent = await newFolder(ADMIN, 'Before');
    const child = await newFolder(ADMIN, 'Deep', { parentId: parent });
    const stored = await upload(ADMIN, 'nested.pdf', 'x', { folderId: child });

    const subtitle = async () =>
      (
        await withTenant(ADMIN, (tx) => tx<{ subtitle: string }[]>`
          SELECT subtitle FROM search_document WHERE entity_id = ${stored.id}::uuid
        `)
      )[0]?.subtitle;

    expect(await subtitle()).toBe('Before / Deep');

    await withTenant(ADMIN, (tx) => tx`
      UPDATE document_folder SET name = 'After' WHERE id = ${parent}::uuid
    `);
    expect(await subtitle()).toBe('After / Deep');
  });

  it('cascades internal-only downwards when a folder is reclassified', async () => {
    const parent = await newFolder(ADMIN, 'Open');
    const child = await newFolder(ADMIN, 'Inner', { parentId: parent });
    const stored = await upload(ADMIN, 'was-visible.pdf', 'x', { folderId: child });

    await withTenant(ADMIN, (tx) => tx`
      UPDATE document_folder SET is_internal_only = true WHERE id = ${parent}::uuid
    `);

    const [folder] = await withTenant(ADMIN, (tx) => tx<{ is_internal_only: boolean }[]>`
      SELECT is_internal_only FROM document_folder WHERE id = ${child}::uuid
    `);
    const [document] = await withTenant(ADMIN, (tx) => tx<{ is_internal_only: boolean }[]>`
      SELECT is_internal_only FROM attachment WHERE id = ${stored.id}::uuid
    `);

    expect(folder!.is_internal_only).toBe(true);
    expect(document!.is_internal_only).toBe(true);
  });
});
