/**
 * Profile pictures (1040), end to end, with the bytes on a real disk.
 *
 *   1. The person sets their own; what lands on disk is ciphertext.
 *   2. Everybody in the tenant sees it; nobody outside does (404, the same as
 *      no picture).
 *   3. Nobody sets one for anybody else, and a service account sets none.
 *   4. An SVG is refused, including one that claims to be a PNG.
 *   5. Replacing it removes the old file; removing the membership removes it.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { withTenant } from '../../src/lib/db/client';
import { resetServices, setKekProvider } from '../../src/lib/services';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { buildHarness, connectPools, disconnectPools, IDS, resetDatabase, superuserSql } from './harness';
import { DELETE as removeMine, POST as setMine } from '../../src/app/api/account/avatar/route';
import { GET as getAvatar } from '../../src/app/api/users/[userId]/avatar/route';
import { AvatarService, avatarUrls } from '../../src/lib/avatars/service';
import { setDocumentStorage } from '../../src/lib/documents/storage';
import { FilesystemExportStorage } from '../../src/lib/exports/storage';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

const ADMIN: SessionUser = { id: IDS.admin1, email: 'admin@northwind.test' };
const TECH: SessionUser = { id: IDS.tech1, email: 'tech1@northwind.test' };
const OTHER_TENANT: SessionUser = { id: IDS.admin2, email: 'admin@contoso.test' };

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
const PNG2 = Buffer.concat([PNG, Buffer.from('trailing bytes, still a PNG by signature')]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

let harness: ReturnType<typeof buildHarness>;
let currentUser: SessionUser | null = null;

async function su<T>(fn: (sql: ReturnType<typeof superuserSql>) => Promise<T>): Promise<T> {
  const sql = superuserSql();
  try { return await fn(sql); } finally { await sql.end({ timeout: 5 }); }
}

const upload = (bytes: Buffer, type = 'image/png') => {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(bytes)], 'me.png', { type }));
  return setMine(new NextRequest(new Request('http://helm.test/api/account/avatar', { method: 'POST', body: form })),
    { params: Promise.resolve({}) });
};
const fetchAvatar = (userId: string) =>
  getAvatar(new NextRequest(new Request(`http://helm.test/api/users/${userId}/avatar`)),
    { params: Promise.resolve({ userId }) });

const row = (userId: string) => su((sql) => sql<{ storage_key: string; content_type: string }[]>`
  SELECT storage_key, content_type FROM member_avatar WHERE user_id = ${userId}::uuid
`);

beforeAll(async () => {
  resetDatabase();
  connectPools();
  harness = buildHarness();
  setKekProvider(harness.kek);
  useSessionResolver(async () => currentUser);
  await harness.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'avatar tests' });
  setDocumentStorage(new FilesystemExportStorage(harness.documentRoot));
}, 120_000);

afterEach(async () => {
  await su((sql) => sql`DELETE FROM member_avatar`);
});

afterAll(async () => {
  resetServices();
  setDocumentStorage(null);
  await disconnectPools();
});

describe('setting your own', () => {
  it('stores it encrypted, and serves it back as the image it is', async () => {
    currentUser = ADMIN;
    const response = await upload(PNG, 'image/jpeg');
    expect(response.status).toBe(200);
    const { avatar } = (await response.json()) as { avatar: { url: string } };
    expect(avatar.url).toMatch(new RegExp(`^/api/users/${IDS.admin1}/avatar\\?v=[0-9a-f]{16}$`));

    const [stored] = await row(IDS.admin1);
    // The sniffed type, not the browser's claim.
    expect(stored!.content_type).toBe('image/png');
    const onDisk = await readFile(join(harness.documentRoot, stored!.storage_key));
    expect(onDisk.subarray(0, 8).equals(PNG.subarray(0, 8))).toBe(false);

    const served = await fetchAvatar(IDS.admin1);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await served.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('refuses an SVG, including one that claims to be a PNG', async () => {
    currentUser = ADMIN;
    expect((await upload(SVG, 'image/svg+xml')).status).toBe(400);
    expect((await upload(SVG, 'image/png')).status).toBe(400);
    expect(await row(IDS.admin1)).toHaveLength(0);
  });

  it('replaces the old file rather than leaving it behind, and removes it on request', async () => {
    currentUser = ADMIN;
    await upload(PNG);
    const [first] = await row(IDS.admin1);
    await upload(PNG2);
    const [second] = await row(IDS.admin1);
    expect(second!.storage_key).not.toBe(first!.storage_key);
    const files = async () => (await readdir(harness.documentRoot, { recursive: true })).map(String);
    expect((await files()).some((f) => f.endsWith(first!.storage_key.split('/').pop()!))).toBe(false);

    const removed = await removeMine(new NextRequest(new Request('http://helm.test/api/account/avatar', { method: 'DELETE' })),
      { params: Promise.resolve({}) });
    expect(((await removed.json()) as { removed: boolean }).removed).toBe(true);
    expect(await row(IDS.admin1)).toHaveLength(0);
    expect((await fetchAvatar(IDS.admin1)).status).toBe(404);
  });
});

describe('who sees it, and who sets it', () => {
  it('is seen by a colleague in the tenant and by nobody outside it', async () => {
    currentUser = ADMIN;
    await upload(PNG);

    currentUser = TECH;
    expect((await fetchAvatar(IDS.admin1)).status).toBe(200);
    expect((await withTenant({ tenantId: IDS.tenant1, actorId: IDS.tech1 }, (tx) => avatarUrls(tx))).has(IDS.admin1))
      .toBe(true);

    currentUser = OTHER_TENANT;
    expect((await fetchAvatar(IDS.admin1)).status).toBe(404);
  });

  it('cannot be set for somebody else: the policy writes only your own row', async () => {
    currentUser = ADMIN;
    await upload(PNG);
    // Straight at the table, as the tech, aiming at the admin's row.
    await expect(withTenant({ tenantId: IDS.tenant1, actorId: IDS.tech1 }, (tx) => tx`
      UPDATE member_avatar SET content_type = 'image/gif' WHERE user_id = ${IDS.admin1}::uuid RETURNING 1
    `)).resolves.toHaveLength(0);
    await expect(withTenant({ tenantId: IDS.tenant1, actorId: IDS.tech1 }, (tx) => tx`
      DELETE FROM member_avatar WHERE user_id = ${IDS.admin1}::uuid RETURNING 1
    `)).resolves.toHaveLength(0);
    expect((await row(IDS.admin1))[0]!.content_type).toBe('image/png');
  });

  it('is never set by a service account', async () => {
    const [worker] = await su((sql) => sql<{ id: string }[]>`
      SELECT helm.worker_actor(${IDS.tenant1}::uuid, 'system_alerts') AS id`);
    const service = new AvatarService({ storage: new FilesystemExportStorage(harness.documentRoot) });
    await expect(service.put({ tenantId: IDS.tenant1, actorId: worker!.id, actorType: 'service_account' },
      { contentType: 'image/png', bytes: PNG })).rejects.toThrow(/only a person signed in as themselves/);
    expect(await su((sql) => sql`SELECT 1 FROM member_avatar`)).toHaveLength(0);
  });

  it('goes with the membership', async () => {
    currentUser = TECH;
    expect((await upload(PNG)).status).toBe(200);
    await su((sql) => sql`DELETE FROM membership WHERE tenant_id = ${IDS.tenant1}::uuid AND user_id = ${IDS.tech1}::uuid`);
    expect(await row(IDS.tech1)).toHaveLength(0);
  });
});
