/**
 * Integration harness.
 *
 * These tests run against a real PostgreSQL cluster with the real migrations
 * applied, as the real non-superuser roles. That is the only way to test what
 * actually matters here: RLS policies, SECURITY DEFINER boundaries and grants
 * do not exist in a mock, and every one of them is a place a tenant-isolation
 * bug can hide.
 *
 * Point it at a throwaway database — `resetDatabase()` drops and rebuilds it.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { closeAllPools, registerPool, type DbRole } from '../../src/lib/db/client';
import { BlindIndex } from '../../src/lib/crypto/blind-index';
import { DekCache } from '../../src/lib/crypto/dek-cache';
import { LocalDevKekProvider } from '../../src/lib/crypto/kek';
import { SecretService } from '../../src/lib/secrets/service';
import { TenantKeyService } from '../../src/lib/secrets/keys';
import { LinkEngine } from '../../src/lib/graph/links';

export const PG = {
  // PGHOST first: it is the standard libpq name, it is what scripts/check-drift.ts
  // reads, and CI sets it to a host address rather than a socket directory.
  // PGSOCK remains as a fallback so existing local setups keep working.
  host: process.env.PGHOST ?? process.env.PGSOCK ?? '/run/pgt',
  port: Number(process.env.PGPORT ?? 5433),
  database: process.env.PGDATABASE ?? 'helm',
  superuser: process.env.PGSUPERUSER ?? 'postgres',
};

/** Fixture identifiers, mirroring db/tests/fixtures-integration.sql. */
export const IDS = {
  tenant1: '11111111-1111-1111-1111-111111111111',
  tenant2: '22222222-2222-2222-2222-222222222222',
  orgInternal: '1a000000-0000-0000-0000-000000000001',
  orgAcme: '1a000000-0000-0000-0000-000000000002',
  orgGlobex: '1a000000-0000-0000-0000-000000000003',
  orgContoso: '2a000000-0000-0000-0000-000000000001',
  admin1: '1b000000-0000-0000-0000-000000000001',
  tech1: '1b000000-0000-0000-0000-000000000002',
  acmeAdmin: '1b000000-0000-0000-0000-000000000003',
  acmeViewer: '1b000000-0000-0000-0000-000000000004',
  admin2: '2b000000-0000-0000-0000-000000000001',
  firewall: '1d000000-0000-0000-0000-000000000001',
  network: '1d000000-0000-0000-0000-000000000002',
  domainController: '1d000000-0000-0000-0000-000000000003',
  crmApp: '1d000000-0000-0000-0000-000000000004',
  certificate: '1d000000-0000-0000-0000-000000000005',
  domain: '1d000000-0000-0000-0000-000000000006',
  globexServer: '1d000000-0000-0000-0000-000000000007',
  contosoFirewall: '2d000000-0000-0000-0000-000000000001',
} as const;

function psql(args: string[], database = PG.database): string {
  return execFileSync(
    'psql',
    ['-h', PG.host, '-p', String(PG.port), '-U', PG.superuser, '-v', 'ON_ERROR_STOP=1', '-q',
      ...args, database],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

/** Drop, recreate, migrate, and load fixtures. */
export function resetDatabase(): void {
  psql(['-c', `DROP DATABASE IF EXISTS ${PG.database} WITH (FORCE)`], 'postgres');
  psql(['-c', `CREATE DATABASE ${PG.database}`], 'postgres');

  const files = execFileSync('sh', ['-c', 'ls db/sql/*.sql'], { encoding: 'utf8' })
    .trim()
    .split('\n');
  for (const file of files) psql(['-f', file]);

  psql(['-f', 'db/tests/fixtures-integration.sql']);
}

function connect(user: string) {
  return postgres({
    host: PG.host,
    port: PG.port,
    database: PG.database,
    user,
    max: 4,
    idle_timeout: 5,
    onnotice: () => {},
  });
}

const ROLE_USERS: Record<DbRole, string> = {
  app: 'helm_app',
  auth: 'helm_auth',
  keyAdmin: 'helm_key_admin',
  auditor: 'helm_auditor',
  worker: 'helm_worker',
};

export function connectPools(): void {
  for (const [role, user] of Object.entries(ROLE_USERS) as [DbRole, string][]) {
    registerPool(role, connect(user));
  }
}

export async function disconnectPools(): Promise<void> {
  await closeAllPools();
}

/** A superuser handle, for assertions that deliberately bypass RLS. */
export function superuserSql() {
  return connect(PG.superuser);
}

export interface Harness {
  kek: LocalDevKekProvider;
  dekCache: DekCache;
  blindIndex: BlindIndex;
  secrets: SecretService;
  keys: TenantKeyService;
  links: LinkEngine;
}

export function buildHarness(): Harness {
  const kek = new LocalDevKekProvider(randomBytes(32).toString('base64'));
  const dekCache = new DekCache(kek, { ttlMs: 60_000 });
  const blindIndex = new BlindIndex(randomBytes(32).toString('base64'));

  return {
    kek,
    dekCache,
    blindIndex,
    secrets: new SecretService({ dekCache, blindIndex }),
    keys: new TenantKeyService(kek),
    links: new LinkEngine(),
  };
}

export const actor = (tenantId: string, actorId: string) => ({ tenantId, actorId });
