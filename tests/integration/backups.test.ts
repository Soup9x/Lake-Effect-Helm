/**
 * Built-in backups (0820): the settings, the request queue, and a real run.
 *
 *   1. THE TABLES ARE CLOSED. The application reaches them only through the
 *      functions, and every function insists on tenant:write.
 *   2. ONE REQUEST AT A TIME. A second "run now" while one is queued is
 *      refused, not duplicated.
 *   3. A RUN IS REAL. Against the test cluster's own pg_dump: a set is
 *      written, sealed, the manifest names what is in it, it opens again
 *      with the passphrase and not without, and retention prunes the old
 *      ones but never the newest.
 */
import { mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { withTenant } from '../../src/lib/db/client';
import { connectPools, disconnectPools, IDS, resetDatabase, superuserSql } from './harness';
import { GET as getSettings, PUT as putSettings } from '../../src/app/api/tenant/backups/route';
import { POST as runRoute } from '../../src/app/api/tenant/backups/run/route';
import { openSet, performBackup } from '../../src/lib/backups/runner';
import { setName } from '../../src/lib/backups/retention';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

let currentUser: SessionUser | null = null;
const ADMIN: SessionUser = { id: IDS.admin1, email: 'admin@northwind.test' };
const TECH: SessionUser = { id: IDS.tech1, email: 'tech1@northwind.test' };

const req = (method: string, url: string, payload?: unknown) =>
  new NextRequest(new Request(`http://helm.test${url}`, {
    method,
    ...(payload === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
  }));
async function read(response: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  const raw = await response.text();
  return { status: response.status, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} };
}

beforeAll(async () => {
  resetDatabase();
  connectPools();
  useSessionResolver(async () => currentUser);
}, 120_000);
afterAll(async () => { await disconnectPools(); });

describe('the settings', () => {
  it('are tenant:write to read and to change, and refused to the app role directly', async () => {
    currentUser = TECH;
    expect((await getSettings(req('GET', '/api/tenant/backups'))).status).toBe(403);

    currentUser = ADMIN;
    const { status, body } = await read(await getSettings(req('GET', '/api/tenant/backups')));
    expect(status).toBe(200);
    expect((body.settings as { enabled: boolean; schedule: string }).enabled).toBe(false);
    expect((body.settings as { schedule: string }).schedule).toBe('0 2 * * *');

    // The table itself is closed to the request role, whatever the session.
    await expect(withTenant({ tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' }, (tx) =>
      tx`SELECT count(*) FROM backup_setting`)).rejects.toThrow(/permission denied/);
  });

  it('saves a schedule, a destination and a retention, and refuses nonsense', async () => {
    currentUser = ADMIN;
    const ok = await read(await putSettings(req('PUT', '/api/tenant/backups', {
      enabled: true, schedule: '30 3 * * 0', localSubdir: 'nightly', keepDays: 14, keepCount: 4, verifyWeekday: null,
    })));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.settings).toMatchObject({ enabled: true, schedule: '30 3 * * 0', localSubdir: 'nightly', keepDays: 14, keepCount: 4, verifyWeekday: null });

    for (const bad of [
      { schedule: '0 2 * *' },
      { localSubdir: '../etc' },
      { keepDays: 0 },
      { destinationKind: 's3' }, // no keys in this environment
    ]) {
      const { status } = await read(await putSettings(req('PUT', '/api/tenant/backups', bad)));
      expect(status, JSON.stringify(bad)).toBe(400);
    }

    const sql = superuserSql();
    try {
      const [audit] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_log WHERE action = 'backup.settings_changed'`;
      expect(audit!.n).toBeGreaterThan(0);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('queues one run at a time', async () => {
    currentUser = ADMIN;
    const first = await read(await runRoute(req('POST', '/api/tenant/backups/run', { kind: 'backup' })));
    expect(first.status).toBe(200);
    expect(first.body.run).toMatchObject({ kind: 'backup', trigger: 'manual', status: 'requested' });
    const second = await read(await runRoute(req('POST', '/api/tenant/backups/run', { kind: 'verify' })));
    expect(second.status).toBe(409);

    currentUser = TECH;
    expect((await runRoute(req('POST', '/api/tenant/backups/run', {}))).status).toBe(403);
  });
});

describe('a run against the test cluster', () => {
  const url = () => {
    const host = process.env.PGHOST ?? 'localhost';
    const port = process.env.PGPORT ?? '5432';
    const user = process.env.PGSUPERUSER ?? 'postgres';
    return `postgresql://${user}@${host.startsWith('/') ? `localhost/helm?host=${encodeURIComponent(host)}&port=${port}` : `${host}:${port}/helm`}`;
  };

  it('writes a sealed set that opens with the passphrase and prunes the old ones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'helm-backup-root-'));
    const volume = await mkdtemp(join(tmpdir(), 'helm-vol-'));
    await writeFile(join(volume, 'a.txt'), 'hello');
    const dest = join(root, 'nightly');
    await mkdir(dest, { recursive: true });
    // Two old sets that retention should remove, and one it must keep.
    for (const daysAgo of [40, 35, 2]) {
      const at = new Date(Date.now() - daysAgo * 86_400_000);
      const d = join(dest, setName(at));
      await mkdir(d);
      await writeFile(join(d, 'manifest.json'), '{}');
      await utimes(d, at, at);
    }

    // The harness applies db/sql/*.sql directly and never writes the ledger
    // db/migrate.ts keeps; give the manifest one row to name.
    const su = superuserSql();
    await su.unsafe(`
      CREATE TABLE IF NOT EXISTS helm_migration (
        filename text PRIMARY KEY, sha256 text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now(), duration_ms integer NOT NULL
      );
      INSERT INTO helm_migration (filename, sha256, duration_ms)
      VALUES ('0820_backups.sql', 'test', 1) ON CONFLICT DO NOTHING;
    `);
    await su.end();

    const out = await performBackup({
      databaseUrl: url(), passphrase: 'a passphrase long enough to pass',
      destination: { kind: 'local', localDir: dest },
      volumes: { 'helm-documents': volume, 'helm-missing': join(volume, 'nope') },
      keepDays: 30, keepCount: 2,
    });
    expect(out.manifest.files.map((f) => [f.name, f.role])).toEqual([
      ['helm.dump.enc', 'database'], ['helm-documents.tar.gz.enc', 'volume'],
    ]);
    expect(out.manifest.schemaVersion).toBe('0820_backups.sql');
    expect(out.bytes).toBeGreaterThan(10_000);
    expect(out.pruned).toHaveLength(2);
    const remaining = (await readdir(dest)).sort();
    expect(remaining).toHaveLength(2);
    expect(remaining).toContain(out.set);

    const opened = await mkdtemp(join(tmpdir(), 'helm-opened-'));
    const manifest = await openSet(out.location, opened, 'a passphrase long enough to pass');
    expect(manifest.set).toBe(out.set);
    const dump = await readFile(join(opened, 'helm.dump'));
    // A custom-format dump starts with "PGDMP".
    expect(dump.subarray(0, 5).toString()).toBe('PGDMP');
    await expect(openSet(out.location, await mkdtemp(join(tmpdir(), 'helm-wrong-')), 'wrong')).rejects.toThrow();
  }, 120_000);
});
