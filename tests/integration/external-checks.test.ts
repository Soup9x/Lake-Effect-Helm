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
 *   5. ONLY AN ADMINISTRATOR CAN START THE TRAFFIC, and the endpoint they set
 *      has to be https. Both of those are the route's job, and the route is
 *      the only way a person reaches this feature — every test above seeds the
 *      setting row directly, which proves the job reads it and nothing about
 *      who may write it.
 */
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { withTenant, db } from '../../src/lib/db/client';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { actor, connectPools, disconnectPools, IDS, resetDatabase, superuserSql } from './harness';
import { GET as getSetting, PUT as putSetting } from '../../src/app/api/tenant/external-checks/route';
import { POST as postRegistry } from '../../src/app/api/assets/[nodeId]/registry/route';
import { INTERVAL_MAX_HOURS, INTERVAL_MIN_HOURS } from '../../src/lib/external/settings';
import { externalChecksJob } from '../../src/workers/external-checks';
import { FakeRdap, FakeTlsHost, type RdapMode } from '../support/fake-external';
import type { JobContext } from '../../src/workers/runtime';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

const admin = actor(IDS.tenant1, IDS.admin1);

/** Whoever the route sees. Set per test; see the route block at the bottom. */
let currentUser: SessionUser | null = null;
const USERS = {
  admin: { id: IDS.admin1, email: 'admin@northwind.test' },
  tech: { id: IDS.tech1, email: 'tech@northwind.test' },
  viewer: { id: IDS.acmeViewer, email: 'viewer@acme.test' },
} as const;

const request = (method = 'GET', payload?: unknown) =>
  new NextRequest(
    new Request('http://helm.test/api/tenant/external-checks', {
      method,
      ...(payload === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
    }),
  );

async function read(response: Response): Promise<{
  status: number; payload: Record<string, unknown>; raw: string;
}> {
  const raw = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // A non-JSON body is its own diagnostic; `raw` carries it.
  }
  return { status: response.status, payload, raw };
}

const SETTING = {
  domainsEnabled: true,
  certificatesEnabled: false,
  intervalHours: 24,
  rdapBaseUrl: 'https://rdap.example.test',
};

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
  useSessionResolver(async () => currentUser);
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
        next_check_at = NULL, last_check_status = NULL, last_check_error = NULL,
        registry_details = NULL, registry_dismissed = NULL,
        registrar = NULL, registered_at = NULL, nameservers = NULL,
        transfer_locked = NULL, dnssec_enabled = false, expires_at = current_date + 200
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
     * On 443, because the WORKER takes no port — a certificate's reachable
     * address is its common name, `ssl_certificate` records no port, and
     * threading one through so a test could pass would be widening the product
     * to suit the test. So the fixture's common_name is pointed at 127.0.0.1
     * and the server binds 443.
     *
     * WHICH NEEDS PRIVILEGE, and that cost a CI round: these tests run as root
     * in the container I develop in and as an unprivileged user on a GitHub
     * runner, where the bind is EACCES. CI now lowers
     * net.ipv4.ip_unprivileged_port_start (see the database job in
     * .github/workflows/ci.yml) and FakeTlsHost says so by name if a bind is
     * ever refused again — the first failure was a bare 30-second timeout
     * pointing at this line, which named neither the port nor the cause.
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

// ---------------------------------------------------------------------------

/**
 * The switch itself.
 *
 * Every block above seeds external_check_setting with the superuser, which
 * proves the job reads the row and says nothing about who is allowed to write
 * it — and "who may make a client's domain names leave the building" is the
 * part of this feature worth gating. The route is also the only place the
 * https rule and the interval bounds exist in TypeScript; the database has its
 * own CHECKs, but a 500 naming a constraint is not an answer a form can show.
 */
describe('turning it on', () => {
  const asAdmin = () => { currentUser = USERS.admin; };
  const asTech = () => { currentUser = USERS.tech; };
  const asClientViewer = () => { currentUser = USERS.viewer; };

  async function refusedByGate(response: Response): Promise<void> {
    const { status, payload } = await read(response);
    const error = (payload.error ?? {}) as { code?: string; message?: string };
    expect(status).toBe(403);
    expect(error.code).toBe('forbidden');
    // The policy would also refuse this write, with a different message. If the
    // policy got there first the route's gate would be untested, and removing
    // it would break nothing visible.
    expect(
      error.message,
      "this was refused, but not by the route's tenant:write gate",
    ).toBe('missing permission: tenant:write');
  }

  const stored = () => su((sql) => sql<{
    domains_enabled: boolean; rdap_base_url: string; interval_hours: number;
  }[]>`SELECT domains_enabled, rdap_base_url, interval_hours FROM external_check_setting`);

  it('is off, and says so, before anybody has been near it', async () => {
    asAdmin();
    const { status, payload } = await read(await getSetting(request()));
    expect(status).toBe(200);
    expect(payload.domainsEnabled).toBe(false);
    expect(payload.certificatesEnabled).toBe(false);
    // The distinction the domain page depends on: nobody has configured this,
    // as opposed to somebody having configured it to off.
    expect(payload.configured, 'an absent row is not the same as a row saying off')
      .toBe(false);
  });

  it('can be read by anybody, including a client user', async () => {
    // Not a convenience: "last checked: never" is unreadable without it. A
    // client viewer who cannot tell "switched off" from "the registry will not
    // answer" goes looking for a fault that does not exist.
    asAdmin();
    await read(await putSetting(request('PUT', SETTING)));

    for (const who of [asTech, asClientViewer]) {
      who();
      const { status, payload } = await read(await getSetting(request()));
      expect(status).toBe(200);
      expect(payload.domainsEnabled).toBe(true);
      expect(payload.configured).toBe(true);
    }
  });

  it('cannot be turned on by a technician', async () => {
    asTech();
    await refusedByGate(await putSetting(request('PUT', SETTING)));
    expect(await stored(), 'nothing should have been written').toEqual([]);
  });

  it('cannot be turned on by a client administrator either', async () => {
    currentUser = { id: IDS.acmeAdmin, email: 'admin@acme.test' };
    await refusedByGate(await putSetting(request('PUT', SETTING)));
    expect(await stored()).toEqual([]);
  });

  it('refuses an http endpoint instead of quietly upgrading it', async () => {
    asAdmin();
    const { status, payload } = await read(
      await putSetting(request('PUT', { ...SETTING, rdapBaseUrl: 'http://rdap.example.test' })),
    );
    expect(status).toBe(400);
    const issues = ((payload.error as { details?: { issues?: { path: string }[] } })
      ?.details?.issues ?? []);
    expect(issues.map((i) => i.path)).toContain('rdapBaseUrl');

    // The important half: refused, not coerced. An http URL silently rewritten
    // to https sends the request somewhere the person did not ask for, and the
    // first they would know is a failure against a host they never typed.
    expect(await stored(), 'a rejected payload must not have written a row').toEqual([]);
  });

  it('refuses an interval outside the bounds, at both ends', async () => {
    asAdmin();
    for (const intervalHours of [0, -1, 8761]) {
      const { status } = await read(await putSetting(request('PUT', { ...SETTING, intervalHours })));
      expect(status, `${intervalHours} hours should not be accepted`).toBe(400);
    }
    expect(await stored()).toEqual([]);

    // And the ends themselves are allowed, so the bounds are bounds rather
    // than an off-by-one that happens to reject the bad cases too.
    for (const intervalHours of [1, 8760]) {
      const { status, raw } = await read(
        await putSetting(request('PUT', { ...SETTING, intervalHours })),
      );
      expect(status, raw).toBe(200);
    }
  });

  it('agrees with the CHECK constraint about where the bounds are', async () => {
    /*
     * The route's zod schema and the form's own guard both read
     * INTERVAL_MIN_HOURS / INTERVAL_MAX_HOURS, so those two cannot drift from
     * each other. The database's CHECK is a literal in 0670, and it CAN drift —
     * in the direction that matters most, where the route accepts a value and
     * the insert then fails with a constraint name nobody can act on.
     *
     * Asserted by asking the database rather than by parsing the constraint, so
     * it keeps working if the CHECK is ever rewritten.
     */
    for (const hours of [INTERVAL_MIN_HOURS, INTERVAL_MAX_HOURS]) {
      await su((sql) => sql`DELETE FROM external_check_setting`);
      const accepted = await su(async (sql) => {
        try {
          await sql`
            INSERT INTO external_check_setting (tenant_id, interval_hours)
            VALUES (${IDS.tenant1}::uuid, ${hours})
          `;
          return true;
        } catch {
          return false;
        }
      });
      expect(accepted, `the route accepts ${hours} hours, so the CHECK must too`).toBe(true);
    }

    // And the other direction: a value the route refuses must not be one the
    // database would have taken, or the bounds are narrower in TypeScript than
    // in the schema and the schema's are decoration.
    for (const hours of [INTERVAL_MIN_HOURS - 1, INTERVAL_MAX_HOURS + 1]) {
      await su((sql) => sql`DELETE FROM external_check_setting`);
      const accepted = await su(async (sql) => {
        try {
          await sql`
            INSERT INTO external_check_setting (tenant_id, interval_hours)
            VALUES (${IDS.tenant1}::uuid, ${hours})
          `;
          return true;
        } catch {
          return false;
        }
      });
      expect(accepted, `${hours} hours is refused by the route; the CHECK should refuse it too`)
        .toBe(false);
    }
  });

  it('skips a tenant whose sync account is disabled, instead of falling over', async () => {
    /*
     * The IS NOT NULL in external_check_backlog, which looks like defensive
     * noise until you ask what happens without it.
     *
     * helm.worker_actor() returns NULL for a service account somebody has
     * disabled — an ordinary administrative act, not a corrupt install. The
     * backlog would then hand the job a row with no actor, withTenant would be
     * asked to assume an identity that does not exist, and the throw would come
     * out of the loop and abandon EVERY OTHER TENANT's checks for that tick.
     * One tenant's disabled account must not be an outage for the rest.
     */
    const service = await rdap({ expiresAt: '2032-02-02T00:00:00Z' });
    asAdmin();
    await read(await putSetting(request('PUT', {
      ...SETTING, domainsEnabled: true, rdapBaseUrl: service.baseUrl,
    })));

    await su((sql) => sql`
      UPDATE service_account SET disabled_at = now()
      WHERE tenant_id = ${IDS.tenant1}::uuid AND role_key = 'system_sync' AND is_system
    `);
    try {
      const result = await run();
      expect(result.idle, 'with no actor to write as, there is nothing this job can do').toBe(true);
      expect(service.requests, 'and it must not probe what it cannot record').toEqual([]);
      expect((await domainRow()).registry_expires_at).toBeNull();
    } finally {
      await su((sql) => sql`
        UPDATE service_account SET disabled_at = NULL
        WHERE tenant_id = ${IDS.tenant1}::uuid AND role_key = 'system_sync' AND is_system
      `);
    }
  });

  it('is what makes the job start working, end to end', async () => {
    /*
     * The one test that joins the two halves. Everything else in this file
     * reaches past the route to insert the row, so a route that wrote to the
     * wrong column — or wrote nothing and returned 200 — would pass all of it.
     */
    const service = await rdap({ expiresAt: '2031-01-01T00:00:00Z' });

    asAdmin();
    expect((await run()).idle, 'nothing is enabled yet').toBe(true);

    const { status, raw } = await read(await putSetting(request('PUT', {
      ...SETTING, domainsEnabled: true, rdapBaseUrl: service.baseUrl,
    })));
    expect(status, raw).toBe(200);

    const result = await run();
    expect(result.counts?.domains, 'the job should now have a domain to check').toBe(1);
    expect((await domainRow()).registry_expires_at?.toISOString())
      .toBe('2031-01-01T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------

describe('what the registry says beyond the expiry (1140)', () => {
  const asAdmin = () => { currentUser = USERS.admin; };
  const asClientViewer = () => { currentUser = USERS.viewer; };
  const verdict = (payload: unknown) => postRegistry(
    new NextRequest(new Request(`http://helm.test/api/assets/${IDS.domain}/registry`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    })),
    { params: Promise.resolve({ nodeId: IDS.domain }) },
  );
  const recorded = () => su((sql) => sql<{
    registrar: string | null; nameservers: string[] | null; transfer_locked: boolean | null;
    dnssec_enabled: boolean; registered_at: string | null; expires_at: string | null;
    registry_details: Record<string, unknown> | null; registry_dismissed: Record<string, unknown> | null;
  }[]>`
    SELECT registrar, nameservers, transfer_locked, dnssec_enabled,
           registered_at::text, expires_at::text, registry_details, registry_dismissed
    FROM domain WHERE id = ${IDS.domain}::uuid
  `).then((rows) => rows[0]!);

  it('keeps the whole answer as a suggestion, and changes nothing recorded', async () => {
    const service = await rdap({ expiresAt: '2029-09-09T00:00:00Z' });
    await enable({ domains: true, rdap: service.baseUrl });
    await run();

    const after = await recorded();
    expect(after.registry_details).toMatchObject({
      registrar: 'Example Registrar, LLC',
      registered_at: '2020-01-01',
      expires_at: '2029-09-09',
      nameservers: ['ns1.example-dns.test', 'ns2.example-dns.test'],
      transfer_locked: true,
      dnssec_enabled: true,
    });
    expect(after.registrar, 'nothing is applied until a person says so').toBeNull();
    expect(after.nameservers).toBeNull();
    expect(after.dnssec_enabled).toBe(false);
  });

  it('keeps the details when the registry publishes no expiry', async () => {
    const service = await rdap({ mode: 'no-expiry-event' });
    await enable({ domains: true, rdap: service.baseUrl });
    await run();
    expect((await domainRow()).status).toBe('unsupported');
    expect((await recorded()).registry_details).toMatchObject({ registered_at: '2020-01-01' });
  });

  it('applies the stored values a person chose, as their change', async () => {
    const service = await rdap({ expiresAt: '2029-09-09T00:00:00Z' });
    await enable({ domains: true, rdap: service.baseUrl });
    await run();

    asAdmin();
    const { status, payload } = await read(await verdict({ apply: ['registrar', 'nameservers', 'expires_at'] }));
    expect(status).toBe(200);
    expect(payload.applied).toEqual(['registrar', 'nameservers', 'expires_at']);

    const after = await recorded();
    expect(after.registrar).toBe('Example Registrar, LLC');
    expect(after.nameservers).toEqual(['ns1.example-dns.test', 'ns2.example-dns.test']);
    expect(after.expires_at, 'and the alerts follow, since they read the recorded date').toBe('2029-09-09');
    expect(after.transfer_locked, 'a field nobody named is untouched').toBeNull();

    const [change] = await su((sql) => sql<{ changes: Record<string, unknown>; actor_id: string | null }[]>`
      SELECT changes, actor_id FROM entity_change
      WHERE entity_id = ${IDS.domain}::uuid ORDER BY id DESC LIMIT 1
    `);
    expect(Object.keys(change!.changes)).toEqual(expect.arrayContaining(['registrar', 'nameservers', 'expires_at']));
    expect(change!.actor_id, 'recorded as the person who verified it').toBe(IDS.admin1);
    expect(Object.keys(change!.changes), 'the suggestion itself is not history')
      .not.toContain('registry_details');
  });

  it('remembers "keep mine" for that value, and forgets it once applied', async () => {
    const service = await rdap();
    await enable({ domains: true, rdap: service.baseUrl });
    await run();

    asAdmin();
    const kept = await read(await verdict({ keep: ['registrar'] }));
    expect(kept.status, kept.raw).toBe(200);
    expect((await recorded()).registry_dismissed).toEqual({ registrar: 'Example Registrar, LLC' });
    expect((await recorded()).registrar).toBeNull();

    expect((await read(await verdict({ apply: ['registrar'] }))).status).toBe(200);
    expect((await recorded()).registry_dismissed).toBeNull();
  });

  it('refuses a field the registry did not fill, or one it never mentioned', async () => {
    asAdmin();
    expect((await read(await verdict({ apply: ['domain_name'] }))).status).toBe(400);
    // No check has run, so the registry has said nothing at all.
    expect((await read(await verdict({ apply: ['registrar'] }))).status).toBe(409);
  });

  it('is not for a client viewer', async () => {
    const service = await rdap();
    await enable({ domains: true, rdap: service.baseUrl });
    await run();
    asClientViewer();
    expect((await read(await verdict({ apply: ['registrar'] }))).status).toBe(403);
    expect((await recorded()).registrar).toBeNull();
  });
});
