/**
 * The backup service (0820): a loop that watches the schedule and the
 * "run now" requests, performs each run through lib/backups/runner, and
 * records the outcome where Settings can see it.
 *
 *   node_modules/.bin/tsx scripts/backup.ts            the service
 *   node_modules/.bin/tsx scripts/backup.ts once       one backup, then exit
 *   node_modules/.bin/tsx scripts/backup.ts verify     one rehearsal, then exit
 *   node_modules/.bin/tsx scripts/backup.ts decrypt <set-dir> <out-dir>
 *
 * It connects as the migrator (the superuser), the same credential that runs
 * pg_dump, and reads backup_setting and backup_run directly; the web
 * application never sees those tables except through SECURITY DEFINER
 * functions. Settings changes are picked up on the next tick.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import { nextRun } from '../src/lib/backups/cron';
import { openSet, performBackup, performVerify, type Destination } from '../src/lib/backups/runner';

const TICK_MS = 30_000;
const VOLUMES: Record<string, string> = {
  'helm-documents': process.env.HELM_DOCUMENT_DIR ?? '/var/lib/helm/documents',
  'helm-passphrases': process.env.HELM_PASSPHRASE_DIR ?? '/var/lib/helm/passphrases',
  'helm-anchors': process.env.HELM_ANCHOR_DIR ?? '/var/lib/helm/anchors',
  'caddy-data': process.env.HELM_CADDY_DATA_DIR ?? '/var/lib/helm/caddy',
};

const log = (line: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), service: 'backup', msg: line, ...extra }));

function adminUrl(): string {
  const url = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL_MIGRATOR is not set');
  return url;
}

async function passphrase(): Promise<string> {
  if (process.env.HELM_BACKUP_PASSPHRASE) return process.env.HELM_BACKUP_PASSPHRASE;
  const file = process.env.HELM_BACKUP_PASSPHRASE_FILE;
  if (!file) throw new Error('no backup passphrase: set HELM_BACKUP_PASSPHRASE_FILE (deploy/secrets/backup.pass)');
  const text = (await readFile(file, 'utf8')).trim();
  if (text.length < 16) throw new Error('the backup passphrase is shorter than 16 characters');
  return text;
}

interface Setting {
  enabled: boolean; schedule: string; destination_kind: 'local' | 's3'; local_subdir: string;
  s3_bucket: string | null; s3_prefix: string; s3_endpoint: string | null; s3_region: string;
  keep_days: number; keep_count: number; include_volumes: boolean; verify_weekday: number | null;
}

function destinationOf(s: Setting): Destination {
  if (s.destination_kind === 's3') {
    const accessKeyId = process.env.HELM_BACKUP_S3_ACCESS_KEY_ID;
    const secretAccessKey = process.env.HELM_BACKUP_S3_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) throw new Error('the object store is chosen but HELM_BACKUP_S3_* keys are not set');
    if (!s.s3_bucket) throw new Error('no bucket is set');
    return { kind: 's3', s3: { bucket: s.s3_bucket, prefix: s.s3_prefix, region: s.s3_region, endpoint: s.s3_endpoint, accessKeyId, secretAccessKey } };
  }
  const root = process.env.HELM_BACKUP_ROOT ?? '/var/lib/helm/backups';
  return { kind: 'local', localDir: s.local_subdir ? join(root, s.local_subdir) : root };
}

async function main(): Promise<void> {
  const [mode, a, b] = process.argv.slice(2);
  if (mode === 'decrypt') {
    if (!a || !b) throw new Error('usage: backup.ts decrypt <set-dir> <out-dir>');
    const manifest = await openSet(a, b, await passphrase());
    log('opened', { set: manifest.set, files: manifest.files.map((f) => f.name) });
    return;
  }

  const sql = postgres(adminUrl(), { max: 2, onnotice: () => {} });
  const readSetting = async (): Promise<Setting> => (await sql<Setting[]>`SELECT * FROM backup_setting WHERE id = 1`)[0]!;

  async function execute(kind: 'backup' | 'verify', trigger: 'schedule' | 'manual', runId: string | null): Promise<void> {
    const s = await readSetting();
    const id = runId ?? (await sql<{ id: string }[]>`
      INSERT INTO backup_run (kind, trigger, status, started_at) VALUES (${kind}, ${trigger}, 'running', now()) RETURNING id
    `)[0]!.id;
    if (runId) await sql`UPDATE backup_run SET status = 'running', started_at = now() WHERE id = ${runId}::uuid`;
    const lines: string[] = [];
    const say = (line: string) => { lines.push(line); log(line, { run: id }); };
    try {
      const destination = destinationOf(s);
      if (kind === 'backup') {
        const out = await performBackup({
          databaseUrl: adminUrl(), passphrase: await passphrase(), destination,
          volumes: s.include_volumes ? VOLUMES : {}, keepDays: s.keep_days, keepCount: s.keep_count, log: say,
        });
        await sql`
          UPDATE backup_run SET status = 'succeeded', finished_at = now(), destination = ${s.destination_kind},
            location = ${out.location}, bytes = ${out.bytes},
            detail = ${sql.json({ set: out.set, files: out.manifest.files, pruned: out.pruned, schemaVersion: out.manifest.schemaVersion, log: lines })}
          WHERE id = ${id}::uuid
        `;
      } else {
        const out = await performVerify({ databaseUrl: adminUrl(), adminUrl: adminUrl(), passphrase: await passphrase(), destination, volumes: {}, log: say });
        await sql`
          UPDATE backup_run SET status = ${out.ok ? 'succeeded' : 'failed'}, finished_at = now(), destination = ${s.destination_kind},
            location = ${out.set}, detail = ${sql.json({ counts: out.counts, log: lines })},
            error = ${out.ok ? null : 'restored row counts do not match the live database'}
          WHERE id = ${id}::uuid
        `;
      }
      log(`${kind} finished`, { run: id });
    } catch (error) {
      const message = (error as Error).message.slice(0, 4000);
      log(`${kind} failed`, { run: id, error: message });
      await sql`
        UPDATE backup_run SET status = 'failed', finished_at = now(), error = ${message}, detail = ${sql.json({ log: lines })}
        WHERE id = ${id}::uuid
      `;
    }
  }

  if (mode === 'once') { await execute('backup', 'manual', null); await sql.end(); return; }
  if (mode === 'verify') { await execute('verify', 'manual', null); await sql.end(); return; }

  log('backup service started');
  // A run that was mid-flight when the container last stopped is failed, not
  // left spinning forever in the Settings table.
  await sql`UPDATE backup_run SET status = 'failed', finished_at = now(), error = 'the backup service restarted during this run' WHERE status = 'running'`;

  let lastScheduled: Date | null = (await sql<{ t: Date | null }[]>`
    SELECT max(started_at) AS t FROM backup_run WHERE kind = 'backup' AND trigger = 'schedule'
  `)[0]?.t ?? null;
  let lastVerifyDay: string | null = (await sql<{ d: string | null }[]>`
    SELECT to_char(max(started_at), 'YYYY-MM-DD') AS d FROM backup_run WHERE kind = 'verify' AND trigger = 'schedule'
  `)[0]?.d ?? null;
  const bootedAt = new Date();

  for (;;) {
    try {
      // 1. Requests from Settings, oldest first.
      const [requested] = await sql<{ id: string; kind: 'backup' | 'verify' }[]>`
        SELECT id, kind FROM backup_run WHERE status = 'requested' ORDER BY requested_at LIMIT 1
      `;
      if (requested) {
        await execute(requested.kind, 'manual', requested.id);
        continue;
      }
      // 2. The schedule.
      const s = await readSetting();
      if (s.enabled) {
        const now = new Date();
        const due = nextRun(s.schedule, lastScheduled ?? bootedAt);
        if (due.getTime() <= now.getTime()) {
          lastScheduled = now;
          await execute('backup', 'schedule', null);
          continue;
        }
        const today = now.toISOString().slice(0, 10);
        if (s.verify_weekday !== null && now.getUTCDay() === s.verify_weekday && lastVerifyDay !== today
            && s.destination_kind === 'local' && now.getUTCHours() >= 4) {
          lastVerifyDay = today;
          await execute('verify', 'schedule', null);
          continue;
        }
      }
    } catch (error) {
      log('tick failed', { error: (error as Error).message });
    }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
