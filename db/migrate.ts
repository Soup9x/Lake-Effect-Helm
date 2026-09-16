/**
 * Migration runner for db/sql/*.sql.
 *
 * Deliberately small and deliberately not drizzle-kit. Helm's schema depends on
 * things drizzle-kit does not model — RLS policies, SECURITY DEFINER routines,
 * declarative partitioning, generated columns, column-level grants — and losing
 * one of those silently is a tenant-isolation breach rather than a migration
 * inconvenience. So the SQL is hand-authored and this applies it in order.
 *
 * Properties that matter:
 *
 *  * Each file runs inside ONE transaction. A half-applied migration that adds
 *    a table but not its RLS policy would leave a window where that table is
 *    readable across tenants.
 *  * A session advisory lock serialises concurrent runners, so two deploying
 *    pods do not race.
 *  * Applied files are recorded with a sha256 of their contents. Editing a file
 *    that has already run is refused: the database no longer matches what the
 *    file says, and pretending otherwise is how environments diverge.
 *
 * Usage:
 *   pnpm db:migrate            apply pending migrations
 *   pnpm db:migrate:status     show what would run
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), 'sql');

/** Arbitrary but fixed: two runners must pick the same number to exclude each other. */
const ADVISORY_LOCK_KEY = 0x48454c4d; // "HELM"

interface Applied {
  filename: string;
  sha256: string;
  applied_at: Date;
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Connection target. A URL wins; otherwise fall back to the standard PG*
 * variables, which postgres.js reads natively. The fallback matters for unix
 * sockets (postgres.js does not honour a socket path in a URL query string) and
 * for managed platforms that inject PGHOST/PGUSER rather than a URL.
 */
function connectionTarget(): string | undefined {
  const url = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
  if (url) return url;
  if (process.env.PGHOST || process.env.PGDATABASE) return undefined;
  throw new Error(
    'No connection configured. Set DATABASE_URL_MIGRATOR (or the standard PG* ' +
    'variables). Migrations must run as a role that is not subject to row-level ' +
    'security — see assertNotSubjectToForcedRls() below for why — and never as ' +
    'the application role.',
  );
}

/**
 * Refuse to migrate as a role that row-level security applies to.
 *
 * This is the guard for a failure with no error message. Every sensitive table
 * in Helm is FORCE ROW LEVEL SECURITY, which subjects the table OWNER to its
 * policies too, and the schema's SECURITY DEFINER functions run as whoever
 * owns them — which is whoever ran the migrations.
 *
 * So if migrations run as a role that RLS applies to, every one of those
 * functions matches zero rows. helm.reveal_secret() returns NULL instead of the
 * credential. Nothing raises, nothing logs, and the deployment looks fine until
 * somebody tries to read a password. Verified: a non-superuser owner of a
 * FORCE-RLS table cannot see its own rows.
 *
 * The check is empirical rather than a `rolsuper` lookup, because the property
 * that matters is "can this role read a FORCE-RLS table", and that can also
 * come from BYPASSRLS or from an inherited role. A temporary table is enough to
 * ask the question directly, and it disappears with the session.
 */
async function assertNotSubjectToForcedRls(sql: postgres.Sql<Record<string, never>>): Promise<void> {
  let visible: boolean;

  try {
    await sql.unsafe(`
      CREATE TEMP TABLE helm_rls_probe (id integer) ON COMMIT DROP;
      INSERT INTO helm_rls_probe VALUES (1);
      ALTER TABLE helm_rls_probe ENABLE ROW LEVEL SECURITY;
      ALTER TABLE helm_rls_probe FORCE ROW LEVEL SECURITY;
    `);
    const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM helm_rls_probe`;
    visible = (row?.n ?? 0) === 1;
    await sql.unsafe('DROP TABLE IF EXISTS helm_rls_probe');
  } catch {
    // The probe needs TEMP on this database. If it is unavailable the guard
    // must not become its own failure mode, so fall back to asking the catalog
    // and only refuse on a clear answer.
    const [role] = await sql<{ exempt: boolean }[]>`
      SELECT rolsuper OR rolbypassrls AS exempt FROM pg_roles WHERE rolname = current_user
    `;
    if (role?.exempt !== false) return;
    visible = false;
  }

  if (visible) return;

  const [who] = await sql<{ current_user: string }[]>`SELECT current_user`;
  throw new Error(
    `migrations are running as "${who?.current_user ?? 'unknown'}", which row-level ` +
    'security applies to.\n\n' +
    "Helm's tables are FORCE ROW LEVEL SECURITY, and its SECURITY DEFINER " +
    'functions run as whoever owns them — the role that ran the migrations. A ' +
    'role that RLS applies to owns functions that match zero rows, so ' +
    'helm.reveal_secret() would return NULL instead of the credential, with no ' +
    'error anywhere. The deployment would look healthy and decrypt nothing.\n\n' +
    'Run migrations as a superuser (what docker-compose.yml does), or as a role ' +
    'with BYPASSRLS. No RUNTIME role may hold either — that separation is ' +
    'asserted in db/sql/0220_grants.sql and is unaffected by this.',
  );
}

async function main(): Promise<void> {
  const statusOnly = process.argv.includes('--status');

  const target = connectionTarget();
  const options = {
    max: 1,
    // Migrations create indexes and rewrite tables; the request-path timeout
    // would abort them partway.
    idle_timeout: 0,
    connect_timeout: 30,
    onnotice: (notice) => {
      const severity = notice.severity ?? 'NOTICE';
      // The migrations RAISE NOTICE liberally from their assertion blocks;
      // surface warnings always, plain notices only when asked.
      if (severity !== 'NOTICE' || process.env.HELM_MIGRATE_VERBOSE) {
        console.log(`  [${severity.toLowerCase()}] ${notice.message}`);
      }
    },
  } satisfies postgres.Options<Record<string, never>>;

  const sql = target ? postgres(target, options) : postgres(options);

  try {
    // Before any DDL: a schema created by the wrong role is worse than no
    // schema, because it works until the first secret read.
    await assertNotSubjectToForcedRls(sql);

    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS helm_migration (
        filename    text PRIMARY KEY,
        sha256      text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now(),
        duration_ms integer NOT NULL
      )
    `);

    const files = (await readdir(SQL_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const applied = await sql<Applied[]>`SELECT filename, sha256, applied_at FROM helm_migration`;
    const appliedByName = new Map(applied.map((a) => [a.filename, a]));

    const pending: { filename: string; body: string; hash: string }[] = [];

    for (const filename of files) {
      const body = await readFile(join(SQL_DIR, filename), 'utf8');
      const hash = sha256(body);
      const previous = appliedByName.get(filename);

      if (!previous) {
        pending.push({ filename, body, hash });
        continue;
      }
      if (previous.sha256 !== hash) {
        throw new Error(
          `${filename} has changed since it was applied on ` +
          `${previous.applied_at.toISOString()}.\n` +
          'Applied migrations are immutable. Write a new migration that alters ' +
          'what this one created — editing it in place leaves every environment ' +
          'that already ran it silently different from the file.',
        );
      }
    }

    if (pending.length === 0) {
      console.log(`✓ up to date (${applied.length} migrations applied)`);
      return;
    }

    if (statusOnly) {
      console.log(`${pending.length} pending migration(s):`);
      for (const p of pending) console.log(`  - ${p.filename}`);
      return;
    }

    // Serialise concurrent deploys. Session-scoped, released on disconnect.
    const [lock] = await sql<{ pg_try_advisory_lock: boolean }[]>`
      SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY})
    `;
    if (!lock?.pg_try_advisory_lock) {
      throw new Error('another migration run holds the advisory lock; try again shortly');
    }

    try {
      for (const { filename, body, hash } of pending) {
        process.stdout.write(`  → ${filename} ... `);
        const started = Date.now();
        // One transaction per file: a migration is applied completely or not
        // at all. Postgres DDL is transactional, so this actually holds.
        await sql.begin(async (tx) => {
          await tx.unsafe(body);
          const duration = Date.now() - started;
          await tx`
            INSERT INTO helm_migration (filename, sha256, duration_ms)
            VALUES (${filename}, ${hash}, ${duration})
          `;
        });
        console.log(`ok (${Date.now() - started}ms)`);
      }
      console.log(`✓ applied ${pending.length} migration(s)`);
    } finally {
      await sql`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  console.error(`\n✗ migration failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
