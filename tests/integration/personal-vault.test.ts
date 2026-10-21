/**
 * The personal password vault (1030), through the real routes.
 *
 *   OWNER ONLY    somebody else — a super_admin included — cannot list, read,
 *                 change or delete an entry: each is a 404, the same as an entry
 *                 that does not exist. A non-person actor sees nothing at all.
 *   ENCRYPTED     the password and the seed are never at rest in the clear, and
 *                 each change is a new envelope version.
 *   AUDITED       a read writes personal_vault.revealed with the id and purpose
 *                 and nothing that names the entry.
 *   CODES         a one-time code is generated server-side and verifies.
 *   ROTATION      a data key cannot be retired while an entry is sealed under
 *                 it; re-encrypting the vault moves it, and it still opens.
 *   LEAVING       removing the person from the tenant removes their vault.
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import { withTenant } from '../../src/lib/db/client';
import { base32Decode, base32Encode, verifyTotp } from '../../src/lib/crypto/totp';
import {
  IDS, buildHarness, connectPools, disconnectPools, resetDatabase, superuserSql, type Harness,
} from './harness';
import { GET as listVault, POST as createEntry } from '../../src/app/api/personal/vault/route';
import { DELETE as deleteEntry, PATCH as patchEntry } from '../../src/app/api/personal/vault/[entryId]/route';
import { POST as reveal } from '../../src/app/api/personal/vault/[entryId]/reveal/route';
import { POST as code } from '../../src/app/api/personal/vault/[entryId]/code/route';
import { POST as importEntry } from '../../src/app/api/personal/vault/import/route';
import { listVault as listVaultLib, reEncryptPersonalVault } from '../../src/lib/personal/vault';

let h: Harness;
let currentUser: SessionUser | null = null;
const TECH: SessionUser = { id: IDS.tech1, email: 'tech1@northwind.test' };
const ADMIN: SessionUser = { id: IDS.admin1, email: 'admin@northwind.test' };

const RFC_SEED_BYTES = Buffer.from('12345678901234567890', 'ascii');
const RFC_SEED = base32Encode(RFC_SEED_BYTES);
const PASSWORD = 'my-own-bank-password-9f3c';

const req = (method: string, payload?: unknown) =>
  new NextRequest(new Request('https://helm.test/api/personal/vault', {
    method,
    headers: { 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  }));
const entry = (entryId: string) => ({ params: Promise.resolve({ entryId }) });
const json = async <T = Record<string, unknown>>(r: Response) => (await r.json()) as T;

async function su<T>(fn: (sql: ReturnType<typeof superuserSql>) => Promise<T>): Promise<T> {
  const sql = superuserSql();
  try { return await fn(sql); } finally { await sql.end({ timeout: 5 }); }
}

interface Entry { id: string; name: string; hasPassword: boolean; hasTotp: boolean }
let entryId = '';

beforeAll(async () => {
  resetDatabase();
  connectPools();
  h = buildHarness();
  resetServices();
  setKekProvider(h.kek);
  useSessionResolver(async () => currentUser);
  await h.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'personal vault tests' });
}, 180_000);
afterAll(async () => { await disconnectPools(); });

describe('the owner', () => {
  it('stores an entry with a password and a one-time code, and lists it without either', async () => {
    currentUser = TECH;
    const created = await createEntry(req('POST', {
      name: 'My bank', username: 'tech1', url: 'https://bank.example', notes: 'personal', password: PASSWORD, totp: RFC_SEED,
    }));
    expect(created.status, await created.clone().text()).toBe(200);
    entryId = (await json<{ entry: Entry }>(created)).entry.id;

    const listed = await json<{ entries: Entry[] }>(await listVault(req('GET')));
    expect(listed.entries).toEqual([expect.objectContaining({ id: entryId, name: 'My bank', hasPassword: true, hasTotp: true })]);
    expect(JSON.stringify(listed)).not.toContain(PASSWORD);
    expect(JSON.stringify(listed)).not.toContain(RFC_SEED);
  });

  it('is never at rest in the clear', async () => {
    const [row] = await su((sql) => sql<{ secret_ciphertext: Buffer; secret_version: number }[]>`
      SELECT secret_ciphertext, secret_version FROM personal_credential WHERE id = ${entryId}::uuid`);
    expect(row!.secret_version).toBe(1);
    const raw = row!.secret_ciphertext.toString('latin1');
    expect(raw).not.toContain(PASSWORD);
    expect(raw).not.toContain(RFC_SEED);
  });

  it('reads the password back, audited by id and purpose and nothing that names it', async () => {
    currentUser = TECH;
    const response = await reveal(req('POST', { purpose: 'copy' }), entry(entryId));
    expect(response.status).toBe(200);
    const { value, auditEventUid } = await json<{ value: string; auditEventUid: string }>(response);
    expect(value).toBe(PASSWORD);

    const [row] = await su((sql) => sql<{ action: string; entity_id: string; metadata: Record<string, unknown>; reason: string | null }[]>`
      SELECT action, entity_id::text, metadata, reason FROM audit_log WHERE event_uid = ${auditEventUid}::uuid`);
    expect(row).toMatchObject({ action: 'personal_vault.revealed', entity_id: entryId });
    expect(row!.metadata).toMatchObject({ purpose: 'copy' });
    expect(JSON.stringify(row)).not.toContain('My bank');
  });

  it('gets a one-time code that verifies, without the seed leaving', async () => {
    currentUser = TECH;
    const response = await code(req('POST', {}), entry(entryId));
    expect(response.status).toBe(200);
    const body = await json<{ code: string; secondsRemaining: number }>(response);
    expect(body.code).toMatch(/^\d{6}$/);
    expect(verifyTotp(base32Decode(RFC_SEED), body.code).valid).toBe(true);
    expect(JSON.stringify(body)).not.toContain(RFC_SEED);
  });

  it('changes the password as a new version, and can drop the code and then the password', async () => {
    currentUser = TECH;
    const changed = await patchEntry(req('PATCH', { password: 'a-new-one', totp: null }), entry(entryId));
    expect(changed.status, await changed.clone().text()).toBe(200);
    expect((await json<{ entry: Entry }>(changed)).entry).toMatchObject({ hasPassword: true, hasTotp: false });
    const [row] = await su((sql) => sql<{ secret_version: number }[]>`
      SELECT secret_version FROM personal_credential WHERE id = ${entryId}::uuid`);
    expect(row!.secret_version).toBe(2);
    expect((await json<{ value: string }>(await reveal(req('POST', {}), entry(entryId)))).value).toBe('a-new-one');

    const cleared = await patchEntry(req('PATCH', { password: null }), entry(entryId));
    expect((await json<{ entry: Entry }>(cleared)).entry).toMatchObject({ hasPassword: false, hasTotp: false });
    const [empty] = await su((sql) => sql<{ secret_ciphertext: Buffer | null }[]>`
      SELECT secret_ciphertext FROM personal_credential WHERE id = ${entryId}::uuid`);
    expect(empty!.secret_ciphertext).toBeNull();

    await patchEntry(req('PATCH', { password: PASSWORD }), entry(entryId));
  });
});

describe('everybody else', () => {
  it('cannot list, read, change or delete it — a super_admin included', async () => {
    currentUser = ADMIN;
    expect((await json<{ entries: Entry[] }>(await listVault(req('GET')))).entries).toEqual([]);
    expect((await reveal(req('POST', {}), entry(entryId))).status).toBe(404);
    expect((await code(req('POST', {}), entry(entryId))).status).toBe(404);
    expect((await patchEntry(req('PATCH', { name: 'mine now' }), entry(entryId))).status).toBe(404);
    expect((await deleteEntry(req('DELETE'), entry(entryId))).status).toBe(404);

    currentUser = TECH;
    expect((await json<{ entries: Entry[] }>(await listVault(req('GET')))).entries).toHaveLength(1);
  });

  it('cannot reach it as a service account either — the worker included, whose role inherits helm_app', async () => {
    const [worker] = await su((sql) => sql<{ id: string }[]>`
      SELECT helm.worker_actor(${IDS.tenant1}::uuid, 'system_alerts') AS id`);
    const rows = await withTenant(
      { tenantId: IDS.tenant1, actorId: worker!.id, actorType: 'service_account' },
      (tx) => listVaultLib(tx),
      { role: 'worker' },
    );
    expect(rows).toEqual([]);
  });
});

describe('a data key rotation', () => {
  it('cannot retire a key an entry is sealed under, and re-encrypting the vault moves it', async () => {
    const [{ data_key_id: oldKey }] = await su((sql) => sql<{ data_key_id: string }[]>`
      SELECT data_key_id FROM personal_credential WHERE id = ${entryId}::uuid`) as unknown as [{ data_key_id: string }];
    await h.keys.beginRotation(IDS.tenant1, IDS.admin1, 'annual key rotation');

    await expect(h.keys.retire(IDS.tenant1, IDS.admin1, oldKey)).rejects.toThrow(/live secrets still use key .* \(and 1 personal vault entries\)/);

    const moved = await reEncryptPersonalVault({ tenantId: IDS.tenant1, actorId: IDS.admin1 });
    expect(moved.reEncrypted).toBe(1);
    const [row] = await su((sql) => sql<{ data_key_id: string }[]>`
      SELECT data_key_id FROM personal_credential WHERE id = ${entryId}::uuid`);
    expect(row!.data_key_id).not.toBe(oldKey);

    currentUser = TECH;
    expect((await json<{ value: string }>(await reveal(req('POST', {}), entry(entryId)))).value).toBe(PASSWORD);
  });
});

describe('leaving the tenant', () => {
  it('takes the vault with the membership', async () => {
    await su((sql) => sql`DELETE FROM membership WHERE tenant_id = ${IDS.tenant1}::uuid AND user_id = ${IDS.tech1}::uuid`);
    const [left] = await su((sql) => sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM personal_credential WHERE owner_user_id = ${IDS.tech1}::uuid`);
    expect(left!.n).toBe(0);
  });
});

describe('importing an export', () => {
  const importReq = (entries: unknown[]) =>
    new NextRequest(new Request('https://helm.test/api/personal/vault/import', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entries }),
    }));

  it('stores every entry encrypted, skips one already here, and keeps an entry whose code cannot be read', async () => {
    currentUser = ADMIN;
    const entries = [
      { name: 'Imported bank', username: 'me', url: 'https://bank.example', password: 'imported-pw-1', totp: RFC_SEED },
      { name: 'Steam', username: 'gamer', url: null, password: 'imported-pw-2', totp: 'steam://NOTAVALIDSEED' },
    ];
    const first = await importEntry(importReq(entries));
    expect(first.status, await first.clone().text()).toBe(200);
    expect(await json(first)).toEqual({ imported: 2, duplicates: 0, codesDropped: 1 });

    const listed = (await json<{ entries: Entry[] }>(await listVault(req('GET')))).entries;
    expect(listed.find((e) => e.name === 'Imported bank')).toMatchObject({ hasPassword: true, hasTotp: true });
    expect(listed.find((e) => e.name === 'Steam')).toMatchObject({ hasPassword: true, hasTotp: false });
    const raw = await su((sql) => sql<{ c: Buffer }[]>`
      SELECT secret_ciphertext AS c FROM personal_credential WHERE owner_user_id = ${IDS.admin1}::uuid`);
    expect(raw.every((r) => !r.c.toString('latin1').includes('imported-pw'))).toBe(true);

    // The same file again adds nothing.
    expect(await json(await importEntry(importReq(entries)))).toEqual({ imported: 0, duplicates: 2, codesDropped: 0 });

    const [audit] = await su((sql) => sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM audit_log WHERE action = 'personal_vault.imported' ORDER BY occurred_at LIMIT 1`);
    expect(audit!.metadata).toMatchObject({ imported: 2, duplicates: 0, codesDropped: 1 });
    expect(JSON.stringify(audit!.metadata)).not.toContain('Imported bank');
  });

  it('refuses the whole import when one entry has no name', async () => {
    currentUser = ADMIN;
    const before = (await json<{ entries: Entry[] }>(await listVault(req('GET')))).entries.length;
    const refused = await importEntry(importReq([{ name: 'ok', password: 'x' }, { name: '', password: 'y' }]));
    expect(refused.status).toBe(400);
    expect((await json<{ entries: Entry[] }>(await listVault(req('GET')))).entries).toHaveLength(before);
  });
});
