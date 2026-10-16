/**
 * What a backup run actually does (0820), as functions the service loop and
 * the tests both call.
 *
 *   dump      pg_dump -Fc of the whole database, as the superuser
 *   volumes   tar.gz of each mounted volume directory that exists
 *   seal      every file encrypted with the backup passphrase (crypto.ts)
 *   manifest  a small plaintext JSON naming each file, its size, its sha256
 *             before sealing, the KDF parameters and the schema version
 *   ship      to a folder under the mounted root, or to an object store
 *   prune     older sets beyond the retention rule (retention.ts)
 *   verify    restore the newest dump into a scratch database and compare
 *
 * Nothing here knows about the schedule or the request table; that is the
 * loop in scripts/backup.ts, which calls these and records the outcome.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { KDF, decryptFile, encryptFile } from './crypto';
import { setName, setStamp, setsToPrune, type BackupSet } from './retention';
import { s3Delete, s3List, s3Put, type S3Target } from './s3';

export interface Destination {
  kind: 'local' | 's3';
  /** Local: the directory sets are written under (root + subdir). */
  localDir?: string;
  s3?: S3Target;
}

export interface RunOptions {
  /** PG* variables or a DATABASE_URL for pg_dump/pg_restore/psql. */
  databaseUrl: string;
  passphrase: string;
  destination: Destination;
  /** Mounted volume directories to archive, by name; missing ones are skipped. */
  volumes: Record<string, string>;
  keepDays: number;
  keepCount: number;
  now?: Date;
  log?: (line: string) => void;
}

export interface Manifest {
  format: 'helm-backup/1';
  createdAt: string;
  set: string;
  schemaVersion: string | null;
  kdf: typeof KDF & { algorithm: 'scrypt'; cipher: 'aes-256-gcm' };
  files: { name: string; role: 'database' | 'volume'; volume?: string; plainBytes: number; sealedBytes: number; sha256: string }[];
}

export interface RunOutcome {
  set: string;
  location: string;
  bytes: number;
  manifest: Manifest;
  pruned: string[];
}

function run(cmd: string, args: string[], env: Record<string, string>, options: { stdoutTo?: string; input?: string } = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let sink: WriteStream | null = null;
    if (options.stdoutTo) {
      sink = createWriteStream(options.stdoutTo, { mode: 0o600 });
      child.stdout.pipe(sink);
    } else {
      child.stdout.on('data', (c) => out.push(c));
    }
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      const finish = () => {
        if (code === 0) resolvePromise(Buffer.concat(out).toString('utf8'));
        else reject(new Error(`${cmd} exited ${code}: ${Buffer.concat(err).toString('utf8').trim().slice(-2000)}`));
      };
      if (sink) sink.end(finish); else finish();
    });
    if (options.input !== undefined) child.stdin.end(options.input); else child.stdin.end();
  });
}

const sha256File = (path: string) => new Promise<string>((res, rej) => {
  const h = createHash('sha256');
  createReadStream(path).on('data', (c) => h.update(c)).on('end', () => res(h.digest('hex'))).on('error', rej);
});

/** The newest migration applied, so a restore knows which code to run it with. */
async function schemaVersion(databaseUrl: string): Promise<string | null> {
  try {
    const out = await run('psql', [databaseUrl, '-At', '-c',
      "SELECT filename FROM helm_migration ORDER BY applied_at DESC LIMIT 1"], {});
    return out.trim() || null;
  } catch {
    return null;
  }
}

export async function performBackup(o: RunOptions): Promise<RunOutcome> {
  const log = o.log ?? (() => {});
  const now = o.now ?? new Date();
  const name = setName(now);
  const work = await mkdtemp(join(tmpdir(), 'helm-backup-'));
  try {
    const manifest: Manifest = {
      format: 'helm-backup/1', createdAt: now.toISOString(), set: name,
      schemaVersion: await schemaVersion(o.databaseUrl),
      kdf: { ...KDF, algorithm: 'scrypt', cipher: 'aes-256-gcm' }, files: [],
    };

    // 1. The database.
    log('dumping the database');
    const dump = join(work, 'helm.dump');
    await run('pg_dump', [o.databaseUrl, '-Fc', '--no-owner', '--no-acl', '-f', dump], {});
    await seal(dump, 'helm.dump', 'database', undefined, o.passphrase, manifest, work);

    // 2. The volumes that are mounted.
    for (const [volume, dir] of Object.entries(o.volumes)) {
      try {
        if (!(await stat(dir)).isDirectory()) continue;
      } catch {
        log(`volume ${volume} is not mounted; skipped`);
        continue;
      }
      log(`archiving ${volume}`);
      const tarPath = join(work, `${volume}.tar.gz`);
      await run('tar', ['-czf', tarPath, '-C', dir, '.'], {});
      await seal(tarPath, `${volume}.tar.gz`, 'volume', volume, o.passphrase, manifest, work);
    }

    await writeFile(join(work, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    const bytes = manifest.files.reduce((n, f) => n + f.sealedBytes, 0);

    // 3. Ship, then prune.
    let location: string;
    let pruned: string[] = [];
    if (o.destination.kind === 'local') {
      const dir = o.destination.localDir!;
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const target = join(dir, name);
      // Written beside, renamed into place: a half-copied set never looks whole.
      const staging = `${target}.partial`;
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { mode: 0o700 });
      for (const entry of await readdir(work)) await rename(join(work, entry), join(staging, entry));
      await rename(staging, target);
      location = target;
      pruned = await pruneLocal(dir, o.keepDays, o.keepCount, now, log);
    } else {
      const t = o.destination.s3!;
      for (const entry of await readdir(work)) {
        log(`uploading ${entry}`);
        await s3Put(t, `${name}/${entry}`, join(work, entry));
      }
      location = `s3://${t.bucket}/${t.prefix ? `${t.prefix}/` : ''}${name}`;
      pruned = await pruneS3(t, o.keepDays, o.keepCount, now, log);
    }
    return { set: name, location, bytes, manifest, pruned };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function seal(
  plain: string, name: string, role: 'database' | 'volume', volume: string | undefined,
  passphrase: string, manifest: Manifest, work: string,
): Promise<void> {
  const plainBytes = (await stat(plain)).size;
  const digest = await sha256File(plain);
  const sealed = join(work, `${name}.enc`);
  const sealedBytes = await encryptFile(plain, sealed, passphrase);
  await rm(plain, { force: true });
  manifest.files.push({ name: `${name}.enc`, role, ...(volume ? { volume } : {}), plainBytes, sealedBytes, sha256: digest });
}

async function pruneLocal(dir: string, keepDays: number, keepCount: number, now: Date, log: (l: string) => void): Promise<string[]> {
  const sets: BackupSet[] = [];
  for (const entry of await readdir(dir)) {
    const at = setStamp(entry);
    if (at) sets.push({ name: entry, createdAt: at });
  }
  const gone: string[] = [];
  for (const set of setsToPrune(sets, keepDays, keepCount, now)) {
    const path = resolve(dir, set.name);
    if (!path.startsWith(resolve(dir) + sep)) continue;
    log(`pruning ${set.name}`);
    await rm(path, { recursive: true, force: true });
    gone.push(set.name);
  }
  return gone;
}

async function pruneS3(t: S3Target, keepDays: number, keepCount: number, now: Date, log: (l: string) => void): Promise<string[]> {
  const objects = await s3List(t);
  const byName = new Map<string, string[]>();
  const base = t.prefix ? `${t.prefix}/` : '';
  for (const obj of objects) {
    const rest = obj.key.startsWith(base) ? obj.key.slice(base.length) : obj.key;
    const name = rest.split('/')[0]!;
    if (!setStamp(name)) continue;
    byName.set(name, [...(byName.get(name) ?? []), obj.key]);
  }
  const sets: BackupSet[] = [...byName.keys()].map((name) => ({ name, createdAt: setStamp(name)! }));
  const gone: string[] = [];
  for (const set of setsToPrune(sets, keepDays, keepCount, now)) {
    log(`pruning ${set.name}`);
    for (const key of byName.get(set.name) ?? []) await s3Delete(t, key);
    gone.push(set.name);
  }
  return gone;
}

/** Open a sealed set into `outDir`; the manifest's hashes are checked. */
export async function openSet(setDir: string, outDir: string, passphrase: string): Promise<Manifest> {
  const manifest = JSON.parse(await readFile(join(setDir, 'manifest.json'), 'utf8')) as Manifest;
  if (manifest.format !== 'helm-backup/1') throw new Error(`unknown backup format ${String(manifest.format)}`);
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  for (const file of manifest.files) {
    const target = join(outDir, file.name.replace(/\.enc$/, ''));
    await decryptFile(join(setDir, file.name), target, passphrase);
    const digest = await sha256File(target);
    if (digest !== file.sha256) throw new Error(`${file.name} did not decrypt to the bytes the manifest names`);
  }
  return manifest;
}

export interface VerifyOutcome {
  set: string;
  counts: Record<string, { live: number; restored: number }>;
  ok: boolean;
}

const COUNTED = ['tenant', 'organization', 'asset_node', 'credential', 'secret_version', 'contact', 'attachment', 'audit_log'];

/**
 * Restore the newest local set into a scratch database beside the live one
 * and compare a handful of row counts. Only for a local destination: pulling
 * a set back from an object store to rehearse is the operator's job and a
 * network bill, and the guide says how.
 */
export async function performVerify(o: Omit<RunOptions, 'keepDays' | 'keepCount'> & { adminUrl: string }): Promise<VerifyOutcome> {
  const log = o.log ?? (() => {});
  if (o.destination.kind !== 'local') throw new Error('a restore rehearsal needs a local destination');
  const dir = o.destination.localDir!;
  const names = (await readdir(dir)).filter((n) => setStamp(n)).sort().reverse();
  const newest = names[0];
  if (!newest) throw new Error('no backup set to verify');

  const work = await mkdtemp(join(tmpdir(), 'helm-verify-'));
  const scratch = `helm_verify_${Date.now()}`;
  try {
    log(`opening ${newest}`);
    await openSet(join(dir, newest), work, o.passphrase);
    log(`restoring into ${scratch}`);
    await run('psql', [o.adminUrl, '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE "${scratch}"`], {});
    const scratchUrl = o.adminUrl.replace(/\/[^/?]+(\?|$)/, `/${scratch}$1`);
    // The roles exist on this cluster, so ownership and grants restore; the
    // extensions and schema are in the dump.
    await run('pg_restore', ['--no-owner', '--no-acl', '--exit-on-error', '-d', scratchUrl, join(work, 'helm.dump')], {});
    const counts: VerifyOutcome['counts'] = {};
    let ok = true;
    for (const table of COUNTED) {
      const q = `SELECT count(*) FROM ${table}`;
      const live = Number((await run('psql', [o.databaseUrl, '-At', '-c', q], {})).trim());
      const restored = Number((await run('psql', [scratchUrl, '-At', '-c', q], {})).trim());
      counts[table] = { live, restored };
      // Live can only have grown since the dump; a restored count above live
      // or far below it is the signal.
      if (restored > live || restored < live * 0.9 - 5) ok = false;
    }
    return { set: newest, counts, ok };
  } finally {
    await run('psql', [o.adminUrl, '-c', `DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`], {}).catch(() => {});
    await rm(work, { recursive: true, force: true });
  }
}
