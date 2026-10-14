/**
 * The refresh job, end to end, against real servers and a real database.
 *
 * WHAT ONLY THIS LEVEL CAN ANSWER:
 *
 *   1. OFF MEANS NOTHING HAPPENS. Decision 4's promise is that an air-gapped
 *      install works with zero configuration, and the only way to be sure is to
 *      run the job with no setting row and watch it do nothing at all.
 *   2. THE PROBE WRITES BESIDE, NEVER OVER. The recorded expiry must come out
 *      of the job byte-for-byte unchanged while the observed column fills.
 *   3. A FAILURE IS A RECORDED FACT. Status, message, and a next_check_at
 *      pushed out — with last_checked_at deliberately NOT advanced, because it
 *      means "when did we last successfully learn something".
 *   4. THE CLAIM STOPS A SECOND WORKER. Two replicas on the same tick must not
 *      both probe the same domain.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { withTenant, db } from '../../src/lib/db/client';
import { actor, connectPools, disconnectPools, IDS, resetDatabase, superuserSql } from './harness';
import { externalChecksJob } from '../../src/workers/external-checks';
import { FakeRdap, FakeTlsHost, type RdapMode } from '../support/fake-external';
import type { JobContext } from '../../src/workers/runtime';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

const admin = actor(IDS.tenant1, IDS.admin1);

async function su<T>(fn: (sql: ReturnType<typeof superuserSql>) => Promise<T>): Promise<T> {
  const sql = superuserSql();
  try { return await fn(sql); } finally { await sql.end({ timeout: 5 }); }
}

/** A quiet job context; the real one logs JSON per line. */
function context(): JobContext & { lines: string[] } {
  const lines: string[] = [];
  const logger = {
    debug: (m: string) => lines.push(`debug ${m}`),
    info: (m: string) => lines.push(`info ${m}`),
    warn: (m: string) => lines.push(`warn ${m}`),
    error: (m: string) => lines.push(`error ${m}`),
    child: () => logger,
  };
  return { log: logger, stopping: () => false, lines } as unknown as JobContext & { lines: string[] };
}

const run = () => externalChecksJob().run(context());

async function enable(options: {
  domains?: boolean; certificates?: boolean; rdap?: string; hours?: number;
}): Promise<void> {
  await su((sql) => sql`
    INSERT INTO external_check_setting (
      tenant_id, domains_enabled, certificates_enabled, rdap_base_url, interval_hours
    )
    VALUES (
      ${IDS.tenant1}::uuid, ${options.domains ?? false}, ${options.certificates ?? false},
      ${options.rdap ?? 'https://rdap.invalid'}, ${options.hours ?? 24}
    )
    ON CONFLICT (tenant_id) DO UPDATE SET
      domains_enabled = EXCLUDED.domains_enabled,
      certificates_enabled = EXCLUDED.certificates_enabled,
      rdap_base_url = EXCLUDED.rdap_base_url,
      interval_hours = EXCLUDED.interval_hours
  `);
}

const domainRow = () => withTenant(admin, (tx) => tx<{
  expires_at: Date | null; registry_expires_at: Date | null; last_checked_at: Date | null;
  next_check_at: Date | null; status: string | null; error: string | null;
}[]>`
  SELECT expires_at, registry_expires_at, last_checked_at, next_check_at,
         last_check_status::text AS status, last_check_error AS error
  FROM domain WHERE id = ${IDS.domain}::uuid
`).then((rows) => rows[0]!);

const certRow = () => withTenant(admin, (tx) => tx<{
  not_after: Date | null; observed_not_after: Date | null; observed_fingerprint_sha256: string | null;
  last_checked_at: Date | null; next_check_at: Date | null; status: string | null; error: string | null;
}[]>`
  SELECT not_after, observed_not_after, observed_fingerprint_sha256, last_checked_at,
         next_check_at, last_check_status::text AS status, last_check_error AS error
  FROM ssl_certificate WHERE id = ${IDS.certificate}::uuid
`).then((rows) => rows[0]!);

const servers: { stop: () => Promise<void> }[] = [];
async function rdap(options?: { mode?: RdapMode; expiresAt?: string }): Promise<FakeRdap> {
  const s = await FakeRdap.start(options);
  servers.push(s);
  return s;
}

beforeAll(async () => {
  resetDatabase();
  connectPools();
  // The probe uses global fetch against a self-signed fixture; production has
  // no option to accept one, and tests/unit/rdap.test.ts explains why this is
  // a test-worker concern rather than a product switch. Restored in afterAll
  // so nothing here rests on vitest's file isolation staying the default.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}, 120_000);

afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.stop();
  await su(async (sql) => {
    await sql`DELETE FROM external_check_setting`;
    await sql`
      UPDATE domain SET registry_expires_at = NULL, last_checked_at = NULL,
        next_check_at = NULL, last_check_status = NULL, last_check_error = NULL
    `;
    await sql`
      UPDATE ssl_certificate SET observed_not_after = NULL, observed_fingerprint_sha256 = NULL,
        last_checked_at = NULL, next_check_at = NULL, last_check_status = NULL,
        last_check_error = NULL
    `;
  });
});
afterAll(async () => {
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  await disconnectPools();
});

// ---------------------------------------------------------------------------

describe('with nothing enabled', () => {
  it('does nothing at all, and says it is idle', async () => {
    // The air-gapped case, which is the default. No setting row exists.
    const result = await run();
    expect(result.idle, 'a tenant that never opted in must produce no work').toBe(true);

    const domain = await domainRow();
    expect(domain.last_checked_at).toBeNull();
    expect(domain.status).toBeNull();
    expect(domain.next_check_at).toBeNull();
  });

  it('does nothing for certificates when only domains are on', async () => {
    const service = await rdap();
    await enable({ domains: true, rdap: service.baseUrl });
    await run();

    expect((await domainRow()).status, 'the domain arm should have run').toBe('ok');
    expect((await certRow()).status, 'the certificate arm was not enabled').toBeNull();
  });
});

describe('a domain the registry knows', () => {
  it('records the registry"s expiry beside the recorded one, never over it', async () => {
    const before = await domainRow();
    expect(before.expires_at, 'the fixture records an expiry by hand').not.toBeNull();

    const service = await rdap({ expiresAt: '2029-09-09T00:00:00Z' });
    await enable({ domains: true, rdap: service.baseUrl, hours: 12 });
    const result = await run();

    const after = await domainRow();
    expect(after.registry_expires_at?.toISOString()).toBe('2029-09-09T00:00:00.000Z');
    expect(after.expires_at?.toISOString(),
      'the hand-recorded expiry must come out unchanged')
      .toBe(before.expires_at?.toISOString());
    expect(after.status).toBe('ok');
    expect(after.error).toBeNull();
    expect(after.last_checked_at, 'a success records when we learned it').not.toBeNull();
    expect(result.counts?.domains).toBe(1);

    // Next check at the tenant's interval, not the claim window.
    const hoursOut = (after.next_check_at!.getTime() - Date.now()) / 3_600_000;
    expect(hoursOut).toBeGreaterThan(11);
    expect(hoursOut).toBeLessThan(13);
  });

  it('asks the configured endpoint, and only that', async () => {
    const service = await rdap();
    await enable({ domains: true, rdap: service.baseUrl });
    await run();
    expect(service.requests, 'it should have asked for the fixture"s domain')
      .toContain('/domain/acme.test');
  });

  it('comes back to it when the interval has passed, and not before', async () => {
    const service = await rdap();
    await enable({ domains: true, rdap: service.baseUrl });
    await run();
    const asked = service.requests.length;

    // Immediately again: next_check_at is in the future, so nothing is due.
    const second = await run();
    expect(service.requests.length, 'it should not re-probe before the interval')
      .toBe(asked);
    expect(second.idle).toBe(true);

    // Wind the clock back by making it due.
    await su((sql) => sql`UPDATE domain SET next_check_at = now() - interval '1 minute'`);
    await run();
    expect(service.requests.length, 'once due, it should probe again')
      .toBeGreaterThan(asked);
  });
});

describe('when the outside world will not answer', () => {
  it('records a failure without touching last_checked_at', async () => {
    /*
     * The distinction the column exists for. last_checked_at means "when did we
     * last successfully learn something", so a failed probe that advanced it
     * would make a domain nobody has ever looked up read as recently checked.
     */
    await enable({ domains: true, rdap: 'https://127.0.0.1:1' });
    const result = await run();

    const after = await domainRow();
    expect(after.status).toBe('failed');
    expect(after.error, 'the message should say what was tried').toContain('127.0.0.1');
    expect(after.last_checked_at, 'a failure is not a check').toBeNull();
    expect(after.registry_expires_at, 'and it learned nothing').toBeNull();
    expect(result.counts?.failed).toBe(1);

    // And it still waits the full interval rather than retrying every tick.
    expect(after.next_check_at!.getTime()).toBeGreaterThan(Date.now() + 3_600_000);
  });

  it('calls a registry with no expiry event unsupported, not failed', async () => {
    const service = await rdap({ mode: 'no-expiry-event' });
    await enable({ domains: true, rdap: service.baseUrl });
    const result = await run();

    const after = await domainRow();
    expect(after.status, 'a ccTLD that publishes no expiry is not an outage')
      .toBe('unsupported');
    expect(result.counts?.unsupported).toBe(1);
    expect(result.counts?.failed ?? 0).toBe(0);
  });

  it('calls an unknown name not_found, which is also unsupported rather than failed', async () => {
    const service = await rdap({ mode: 'not-found' });
    await enable({ domains: true, rdap: service.baseUrl });
    await run();
    expect((await domainRow()).status).toBe('unsupported');
  });

  it('keeps the recorded expiry through every failure mode', async () => {
    // The promise in decision 4: with egress broken, manual entry keeps
    // working. Asserted across the three outcomes rather than once.
    const before = await domainRow();
    for (const mode of ['not-found', 'server-error', 'not-json'] as RdapMode[]) {
      const service = await rdap({ mode });
      await enable({ domains: true, rdap: service.baseUrl });
      await su((sql) => sql`UPDATE domain SET next_check_at = NULL`);
      await run();
      expect((await domainRow()).expires_at?.toISOString(), `${mode} changed the recorded expiry`)
        .toBe(before.expires_at?.toISOString());
      await servers.pop()!.stop();
    }
  });
});

describe('a certificate', () => {
  it('records what the server actually serves, beside what was recorded', async () => {
    /*
     * On 443, because the probe takes no port — a certificate's reachable
     * address is its common name, and adding a port parameter so a test could
     * pass would be widening the product to suit the test. So the fixture's
     * common_name is pointed at 127.0.0.1 and the server binds 443.
     */
    const host = await FakeTlsHost.start({ commonName: 'serving.test', days: 45, port: 443 });
    servers.push(host);
    await su((sql) => sql`
      UPDATE ssl_certificate SET common_name = '127.0.0.1' WHERE id = ${IDS.certificate}::uuid
    `);

    const before = await certRow();
    await enable({ certificates: true });
    const result = await run();

    const after = await certRow();
    expect(after.status, after.error ?? 'expected a successful probe').toBe('ok');
    expect(after.observed_fingerprint_sha256).toBe(host.sha256);
    expect(after.observed_not_after).not.toBeNull();
    expect(Math.abs(after.observed_not_after!.getTime() - host.notAfter.getTime()))
      .toBeLessThan(60_000);
    expect(after.not_after?.toISOString(), 'the recorded not_after is untouched')
      .toBe(before.not_after?.toISOString());
    expect(result.counts?.certificates).toBe(1);
  });

  it('records a failure for a host it cannot reach, and keeps the recorded dates', async () => {
    // The ordinary case for an internal certificate: the common name does not
    // resolve from this server. Honest failure, manual entry intact.
    await su((sql) => sql`
      UPDATE ssl_certificate SET common_name = 'nothing.invalid'
      WHERE id = ${IDS.certificate}::uuid
    `);
    const before = await certRow();
    await enable({ certificates: true });
    await run();

    const after = await certRow();
    expect(after.status).toBe('failed');
    expect(after.last_checked_at).toBeNull();
    expect(after.not_after?.toISOString()).toBe(before.not_after?.toISOString());
  });
});

describe('two workers on the same tick', () => {
  it('lets exactly one of them probe a given domain', async () => {
    /*
     * The claim. 0430's reasoning applies unchanged: next_check_at pushed
     * forward under FOR UPDATE SKIP LOCKED means a concurrent claimant skips
     * the row rather than blocking, and a worker that dies leaves the claim
     * standing until it lapses.
     */
    const service = await rdap();
    await enable({ domains: true, rdap: service.baseUrl });

    const [first, second] = await Promise.all([run(), run()]);
    const probes = service.requests.filter((path) => path.startsWith('/domain/')).length;

    expect(probes, 'the same domain was probed twice on one tick').toBe(1);
    const worked = (first.counts?.domains ?? 0) + (second.counts?.domains ?? 0);
    expect(worked, 'exactly one run should have done the work').toBe(1);
  });

  it('refuses a second claim until the window lapses', async () => {
    await enable({ domains: true, rdap: 'https://127.0.0.1:1' });
    const [claimed] = await db('worker')<{ ok: boolean }[]>`
      SELECT helm.claim_domain_check(${IDS.domain}::uuid, 300) AS ok
    `;
    expect(claimed!.ok, 'a never-checked row is due, so the first claim takes it').toBe(true);

    const [again] = await db('worker')<{ ok: boolean }[]>`
      SELECT helm.claim_domain_check(${IDS.domain}::uuid, 300) AS ok
    `;
    expect(again!.ok, 'the window is open, so a second claim must be refused').toBe(false);
  });
});
