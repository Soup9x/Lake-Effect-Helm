/**
 * The migration runner refuses a role that row-level security applies to.
 *
 * This guards a failure with no symptom. Helm's tables are FORCE ROW LEVEL
 * SECURITY, which subjects the table owner to its own policies, and every
 * SECURITY DEFINER function runs as whoever owns it — the role that ran the
 * migrations. Migrate as a role RLS applies to and those functions match zero
 * rows: helm.reveal_secret() returns NULL rather than the credential, nothing
 * raises, nothing logs, and the deployment looks healthy right up until
 * somebody tries to read a password.
 *
 * `.env.example` and the README used to recommend exactly that role. These
 * tests exist so nobody can reintroduce it quietly.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { PG } from './harness';

const run = promisify(execFile);

/** A throwaway database, so this never touches the one the other suites use. */
const PROBE_DB = 'helm_migrate_guard_probe';

function connect(user: string, database: string) {
  return postgres({
    host: PG.host,
    port: PG.port,
    database,
    user,
    max: 1,
    idle_timeout: 5,
    onnotice: () => {},
  });
}

/** Run db/migrate.ts as `user`, returning its exit code and combined output. */
async function migrateAs(user: string, args: string[] = []): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await run(
      'node_modules/.bin/tsx',
      ['db/migrate.ts', ...args],
      {
        env: {
          ...process.env,
          // postgres.js does not honour a socket path inside a URL, so the
          // runner's PG* fallback is what the socket-based dev cluster uses.
          PGHOST: PG.host,
          PGPORT: String(PG.port),
          PGDATABASE: PROBE_DB,
          PGUSER: user,
          DATABASE_URL_MIGRATOR: '',
          DATABASE_URL: '',
        },
        timeout: 120_000,
      },
    );
    return { code: 0, output: stdout + stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, output: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

let admin: ReturnType<typeof connect>;

beforeAll(async () => {
  admin = connect(PG.superuser, 'postgres');

  // Self-contained: the runtime roles are normally created by 0000_bootstrap,
  // but this suite must not depend on another one having run first — on a
  // fresh cluster that ordering is not guaranteed. NOBYPASSRLS is the whole
  // point of the fixture.
  await admin.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helm_migrator') THEN
        CREATE ROLE helm_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
      END IF;
    END
    $$;
  `);

  await admin.unsafe(`DROP DATABASE IF EXISTS ${PROBE_DB} WITH (FORCE)`);
  // Owned by helm_migrator so that role can actually create objects in it —
  // the point is to test the guard, not to fail on a missing privilege.
  await admin.unsafe(`CREATE DATABASE ${PROBE_DB} OWNER helm_migrator`);
});

afterAll(async () => {
  await admin.unsafe(`DROP DATABASE IF EXISTS ${PROBE_DB} WITH (FORCE)`);
  await admin.end({ timeout: 5 });
});

describe('the migration runner', () => {
  it('refuses to run as a role that row-level security applies to', async () => {
    const { code, output } = await migrateAs('helm_migrator', ['--status']);

    expect(code).not.toBe(0);
    expect(output).toContain('helm_migrator');
    expect(output).toMatch(/row-level\s+security applies to/);
    // The message has to explain the consequence, or the operator "fixes" it
    // by granting something rather than by changing who migrates.
    expect(output).toMatch(/reveal_secret/);
    expect(output).toMatch(/BYPASSRLS|superuser/);
  });

  it('writes nothing when it refuses', async () => {
    // A guard that fails after creating its bookkeeping table would leave the
    // database owned by the wrong role anyway.
    const probe = connect(PG.superuser, PROBE_DB);
    try {
      const [row] = await probe<{ exists: boolean }[]>`
        SELECT to_regclass('public.helm_migration') IS NOT NULL AS exists
      `;
      expect(row!.exists).toBe(false);
    } finally {
      await probe.end({ timeout: 5 });
    }
  });

  it('proceeds as a role row-level security does not apply to', async () => {
    const { code, output } = await migrateAs(PG.superuser, ['--status']);

    expect(code).toBe(0);
    expect(output).toMatch(/pending migration/);
  });

  it('is checking the real behaviour, not a catalog attribute', async () => {
    // The property the guard tests is "can this role read a FORCE-RLS table",
    // which is what actually decides whether SECURITY DEFINER works. This
    // reproduces it directly, so a future refactor to a `rolsuper` lookup that
    // disagrees with reality would be caught here.
    for (const [user, expected] of [['helm_migrator', 0], [PG.superuser, 1]] as const) {
      const session = connect(user, PROBE_DB);
      try {
        await session.unsafe(`
          CREATE TEMP TABLE guard_probe (id integer);
          INSERT INTO guard_probe VALUES (1);
          ALTER TABLE guard_probe ENABLE ROW LEVEL SECURITY;
          ALTER TABLE guard_probe FORCE ROW LEVEL SECURITY;
        `);
        const [row] = await session<{ n: number }[]>`SELECT count(*)::int AS n FROM guard_probe`;
        expect(row!.n).toBe(expected);
      } finally {
        await session.end({ timeout: 5 });
      }
    }
  });
});

/**
 * The real runner, over the real migrations, on a fresh database.
 *
 * This exists because of a failure the rest of the suite CANNOT SEE.
 *
 * scripts/rebuild-test-db.sh applies each file with `psql -f`, where every
 * statement commits on its own. db/migrate.ts wraps each FILE in one
 * transaction, deliberately — a half-applied migration is worse than none. The
 * two are not equivalent, and PostgreSQL has at least one rule that separates
 * them:
 *
 *     BEGIN;
 *     ALTER TYPE auth_method ADD VALUE 'oidc';
 *     SELECT 'oidc'::auth_method;
 *     ERROR: unsafe use of new value "oidc" of enum type auth_method
 *
 * Under psql that works, because the ALTER has already committed. Under the
 * real runner it fails. So a migration written and tested entirely through the
 * test path can be broken in production and green everywhere else — appearing
 * during an upgrade, after the operator has taken the service down.
 *
 * (0405_auth_method_oidc.sql is a one-statement file for exactly this reason.)
 *
 * The assertion is simply that every file applies. It is slow and it is worth
 * it: the class of bug it catches has no other detector here.
 */
describe('every migration applies under the real runner', () => {
  const RUNNER_DB = 'helm_migrate_runner_probe';

  beforeAll(async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${RUNNER_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${RUNNER_DB}`);
  }, 60_000);

  afterAll(async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${RUNNER_DB} WITH (FORCE)`);
  });

  it('applies db/sql cleanly, one transaction per file', async () => {
    const { stdout, stderr } = await run('node_modules/.bin/tsx', ['db/migrate.ts'], {
      env: {
        ...process.env,
        PGHOST: PG.host,
        PGPORT: String(PG.port),
        PGDATABASE: RUNNER_DB,
        PGUSER: PG.superuser,
        DATABASE_URL_MIGRATOR: '',
        DATABASE_URL: '',
      },
      timeout: 180_000,
    });

    const output = stdout + stderr;
    expect(output).not.toMatch(/unsafe use of new value/);
    expect(output).toMatch(/0400_single_approver_exports/);
    expect(output).toMatch(/0410_oidc_provider/);
  }, 180_000);

  it('leaves a schema the application can actually use', async () => {
    // A file can apply and still leave the database wrong, so this checks the
    // two things 0405 and 0410 exist to produce.
    const probe = connect(PG.superuser, RUNNER_DB);
    try {
      const [method] = await probe<{ present: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'auth_method' AND e.enumlabel = 'oidc'
        ) AS present
      `;
      expect(method!.present).toBe(true);

      const [table] = await probe<{ present: boolean }[]>`
        SELECT to_regclass('public.oidc_provider') IS NOT NULL AS present
      `;
      expect(table!.present).toBe(true);
    } finally {
      await probe.end({ timeout: 5 });
    }
  }, 60_000);

  it('is idempotent — a second run applies nothing and succeeds', async () => {
    const { stdout, stderr } = await run('node_modules/.bin/tsx', ['db/migrate.ts', '--status'], {
      env: {
        ...process.env,
        PGHOST: PG.host,
        PGPORT: String(PG.port),
        PGDATABASE: RUNNER_DB,
        PGUSER: PG.superuser,
        DATABASE_URL_MIGRATOR: '',
        DATABASE_URL: '',
      },
      timeout: 60_000,
    });
    // Every file recorded, nothing left to do. The count moves as migrations
    // are added, so the assertion is on the state and not on the number.
    expect(stdout + stderr).toMatch(/up to date \(\d+ migrations applied\)/);
  }, 60_000);
});
