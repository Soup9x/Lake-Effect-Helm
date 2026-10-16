/**
 * Written documents (0810), in the tree beside the files.
 *
 * WHAT MATTERS BEYOND THE HAPPY PATH:
 *
 *   1. THE FOLDER'S FLAG LANDS ON THE PAGE, by trigger, whatever the request
 *      said — the same inheritance files have.
 *   2. THE BODY IS SEARCHABLE: plain text is derived on the server from the
 *      editor's JSON, never trusted from the client.
 *   3. A PAGE'S ATTACHMENTS go through the same doors as every other file,
 *      and leave with the page.
 *   4. ARCHIVE BEFORE DELETE, and a folder with a page in it is not empty.
 *   5. SCOPE: an internal-only page is not there for a client administrator.
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import { setDocumentStorage } from '../../src/lib/documents/storage';
import { FilesystemExportStorage } from '../../src/lib/exports/storage';
import { withTenant } from '../../src/lib/db/client';
import { actor, buildHarness, connectPools, disconnectPools, IDS, resetDatabase, superuserSql } from './harness';
import { POST as createRoute } from '../../src/app/api/document-pages/route';
import { GET as getRoute, PATCH as patchRoute, DELETE as deleteRoute } from '../../src/app/api/document-pages/[pageId]/route';
import { plainText } from '../../src/lib/documents/pages';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

let currentUser: SessionUser | null = null;
const ADMIN: SessionUser = { id: IDS.admin1, email: 'admin@northwind.test' };
const VIEWER: SessionUser = { id: IDS.acmeViewer, email: 'viewer@acme.test' };
const asAdmin = actor(IDS.tenant1, IDS.admin1);
const asAcmeAdmin = actor(IDS.tenant1, IDS.acmeAdmin);
let harness: ReturnType<typeof buildHarness>;

const req = (method: string, url: string, payload?: unknown) =>
  new NextRequest(new Request(`http://helm.test${url}`, {
    method,
    ...(payload === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
  }));
const params = (pageId: string) => ({ params: Promise.resolve({ pageId }) });

async function ok<T>(response: Response): Promise<T> {
  const raw = await response.text();
  expect(response.status, raw).toBe(200);
  return JSON.parse(raw) as T;
}
async function su<T>(fn: (sql: ReturnType<typeof superuserSql>) => Promise<T>): Promise<T> {
  const sql = superuserSql();
  try { return await fn(sql); } finally { await sql.end({ timeout: 5 }); }
}

const BODY = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Phone system' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'The PBX lives on ' }, { type: 'text', text: 'VLAN 40', marks: [{ type: 'bold' }] }, { type: 'text', text: '.' }] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Reboot from the console, never the power.' }] }] }] },
  ],
};

interface PageOut { id: string; title: string; folderId: string | null; isInternalOnly: boolean; archived: boolean; version: number; bodyText: string }

async function newFolder(name: string, internal = false): Promise<string> {
  return withTenant(asAdmin, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO document_folder (tenant_id, organization_id, name, is_internal_only)
      VALUES (${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, ${name}, ${internal}) RETURNING id
    `;
    return row!.id;
  });
}

async function create(body: Record<string, unknown>): Promise<PageOut> {
  currentUser = ADMIN;
  return (await ok<{ page: PageOut }>(await createRoute(req('POST', '/api/document-pages', {
    organizationId: IDS.orgAcme, title: 'Phone system', body: BODY, ...body,
  })))).page;
}

beforeAll(async () => {
  resetDatabase();
  connectPools();
  harness = buildHarness();
  resetServices();
  setKekProvider(harness.kek);
  useSessionResolver(async () => currentUser);
  await harness.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'document page tests' });
  // The DELETE route reaches for the singleton service; point it at the
  // harness's store so both see one directory (as logos.test.ts does).
  setDocumentStorage(new FilesystemExportStorage(harness.documentRoot));
}, 120_000);
afterAll(async () => { resetServices(); await disconnectPools(); });

describe('plain text', () => {
  it('reads the words out of the editor document, one line per block', () => {
    const text = plainText(BODY as never);
    expect(text).toContain('Phone system\n');
    expect(text).toContain('The PBX lives on VLAN 40.\n');
    expect(text).toContain('Reboot from the console');
  });
});

describe('writing a document', () => {
  it('creates it with its text derived on the server, and finds it by a word in the body', async () => {
    const page = await create({ title: 'PBX runbook' });
    expect(page.version).toBe(1);
    expect(page.bodyText).toContain('VLAN 40');

    const hits = await su((sql) => sql<{ title: string; body: string }[]>`
      SELECT title, body FROM search_document WHERE entity_type = 'document_page' AND entity_id = ${page.id}::uuid
    `);
    expect(hits[0]!.title).toBe('PBX runbook');
    expect(hits[0]!.body).toContain('Reboot from the console');
  });

  it('inherits internal-only from its folder, whatever was asked, and one title per folder', async () => {
    const folder = await newFolder('Internal procedures', true);
    const page = await create({ title: 'Secret sauce', folderId: folder, isInternalOnly: false });
    expect(page.isInternalOnly).toBe(true);

    currentUser = ADMIN;
    const again = await createRoute(req('POST', '/api/document-pages', {
      organizationId: IDS.orgAcme, title: 'secret SAUCE', folderId: folder,
    }));
    expect(again.status).toBe(409);

    // Not there for the client's own administrator.
    const seen = await withTenant(asAcmeAdmin, (tx) => tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM document_page WHERE id = ${page.id}::uuid
    `);
    expect(seen[0]!.n).toBe(0);
  });

  it('is asset:write to create and asset:read to open', async () => {
    const page = await create({ title: 'Readable' });
    currentUser = VIEWER;
    expect((await createRoute(req('POST', '/api/document-pages', { organizationId: IDS.orgAcme, title: 'Nope' }))).status).toBe(403);
    const { page: read } = await ok<{ page: PageOut }>(await getRoute(req('GET', `/api/document-pages/${page.id}`), params(page.id)));
    expect(read.title).toBe('Readable');
  });
});

describe('correcting a document', () => {
  it('saves a new version of the body, moves it between folders and re-derives the text', async () => {
    const page = await create({ title: 'Movable' });
    const folder = await newFolder('Runbooks');
    currentUser = ADMIN;
    const { page: after } = await ok<{ page: PageOut }>(await patchRoute(req('PATCH', `/api/document-pages/${page.id}`, {
      folderId: folder,
      body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Rewritten entirely.' }] }] },
    }), params(page.id)));
    expect(after.version).toBe(2);
    expect(after.folderId).toBe(folder);
    expect(after.bodyText.trim()).toBe('Rewritten entirely.');

    const hits = await su((sql) => sql<{ subtitle: string; body: string }[]>`
      SELECT subtitle, body FROM search_document WHERE entity_type = 'document_page' AND entity_id = ${page.id}::uuid
    `);
    expect(hits[0]!.subtitle).toBe('Runbooks');
    expect(hits[0]!.body).toContain('Rewritten');

    // The folder is not empty while the page is in it.
    await expect(withTenant(asAdmin, (tx) => tx`DELETE FROM document_folder WHERE id = ${folder}::uuid`))
      .rejects.toThrow(/not empty/);
  });

  it('takes attachments, which leave with it, and is deleted only once archived', async () => {
    const page = await create({ title: 'With a picture' });
    const stored = await harness.documents.upload(asAdmin, {
      organizationId: IDS.orgAcme, folderId: null, pageId: page.id,
      filename: 'rack.png', contentType: 'image/png', isInternalOnly: false, bytes: Buffer.from('png'),
    });
    const opened = await harness.documents.download(asAdmin, stored.id);
    expect(opened.bytes.toString()).toBe('png');
    const { attachments } = await ok<{ attachments: { id: string }[] }>(await getRoute(req('GET', `/api/document-pages/${page.id}`), params(page.id)));
    expect(attachments.map((a) => a.id)).toEqual([stored.id]);

    currentUser = ADMIN;
    const live = await deleteRoute(req('DELETE', `/api/document-pages/${page.id}`), params(page.id));
    expect(live.status).toBe(400);

    await ok(await patchRoute(req('PATCH', `/api/document-pages/${page.id}`, { archived: true }), params(page.id)));
    // Archived: out of search.
    const gone = await su((sql) => sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM search_document WHERE entity_type = 'document_page' AND entity_id = ${page.id}::uuid
    `);
    expect(gone[0]!.n).toBe(0);

    await ok(await deleteRoute(req('DELETE', `/api/document-pages/${page.id}`), params(page.id)));
    const rows = await su((sql) => sql<{ pages: number; files: number }[]>`
      SELECT (SELECT count(*) FROM document_page WHERE id = ${page.id}::uuid)::int AS pages,
             (SELECT count(*) FROM attachment WHERE id = ${stored.id}::uuid)::int AS files
    `);
    expect(rows[0]).toEqual({ pages: 0, files: 0 });
  });

  it('refuses an attachment on a page of another client, and one with both a page and a folder', async () => {
    const page = await create({ title: 'Anchored' });
    const folder = await newFolder('Somewhere');
    await expect(harness.documents.upload(asAdmin, {
      organizationId: IDS.orgGlobex, folderId: null, pageId: page.id,
      filename: 'x.pdf', contentType: 'application/pdf', isInternalOnly: false, bytes: Buffer.from('x'),
    })).rejects.toThrow();
    await expect(harness.documents.upload(asAdmin, {
      organizationId: IDS.orgAcme, folderId: folder, pageId: page.id,
      filename: 'x.pdf', contentType: 'application/pdf', isInternalOnly: false, bytes: Buffer.from('x'),
    })).rejects.toThrow();
  });
});
