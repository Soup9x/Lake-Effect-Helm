/**
 * Expiry warnings, end to end (0730).
 *
 * Before 0730 nothing created an alert_rule, so both alert jobs were idle on
 * every deployment and a destination subscribed to "Expiring soon" never heard
 * anything. This file drives the REAL jobs — tenant discovery included, which
 * is where three of this project's zero-rows-under-RLS defects hid — from a
 * certificate about to lapse to a row on the notification queue.
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { connectPools, disconnectPools, IDS, resetDatabase, superuserSql } from './harness';
import { GET as getSetting, PUT as putSetting } from '../../src/app/api/tenant/expiry-alerts/route';
import { deliverExpiryAlertsJob, evaluateExpiryAlertsJob } from '../../src/workers/alerts';
import { parseLeadDays } from '../../src/lib/alerts/expiry';
import type { JobContext } from '../../src/workers/runtime';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

const CERT = '1d000000-0000-0000-0000-0000000000e1';

let currentUser: SessionUser | null = null;
const ADMIN = { id: IDS.admin1, email: 'admin@northwind.test' };
const TECH = { id: IDS.tech1, email: 'tech1@northwind.test' };

const request = (method = 'GET', payload?: unknown) =>
  new NextRequest(
    new Request('http://helm.test/api/tenant/expiry-alerts', {
      method,
      ...(payload === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
    }),
  );

async function su<T>(fn: (sql: ReturnType<typeof superuserSql>) => Promise<T>): Promise<T> {
  const sql = superuserSql();
  try { return await fn(sql); } finally { await sql.end({ timeout: 5 }); }
}

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

beforeAll(async () => {
  resetDatabase();
  connectPools();
  useSessionResolver(async () => currentUser);
}, 120_000);

afterAll(async () => {
  await disconnectPools();
});

beforeEach(async () => {
  currentUser = null;
  await su(async (sql) => {
    await sql`DELETE FROM webhook_delivery`;
    await sql`DELETE FROM webhook_endpoint`;
    await sql`DELETE FROM alert_event`;
    await sql`DELETE FROM ssl_certificate WHERE id = ${CERT}::uuid`;
    await sql`DELETE FROM asset_node WHERE id = ${CERT}::uuid`;
    await sql`UPDATE alert_rule SET is_active = true, lead_days = '{30,14,7,1}' WHERE is_default`;
    // A certificate five days from lapsing: inside the 30, 14 and 7 day windows.
    await sql`
      INSERT INTO asset_node (id, tenant_id, organization_id, node_type, name)
      VALUES (${CERT}::uuid, ${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid,
              'ssl_certificate', 'portal.acme.test')
    `;
    await sql`
      INSERT INTO ssl_certificate (id, tenant_id, common_name, issuer, not_after)
      VALUES (${CERT}::uuid, ${IDS.tenant1}::uuid, 'portal.acme.test', 'Test CA',
              now() + interval '5 days')
    `;
  });
});

async function subscribeMailbox(): Promise<void> {
  await su((sql) => sql`
    INSERT INTO webhook_endpoint (tenant_id, name, events, transport, email_address)
    VALUES (${IDS.tenant1}::uuid, 'on-call mailbox', ARRAY['expiration.warning'],
            'email', 'oncall@northwind.test')
  `);
}

const queuedWarnings = () => su((sql) => sql<{ event_type: string; payload: Record<string, unknown> }[]>`
  SELECT event_type, payload FROM webhook_delivery WHERE tenant_id = ${IDS.tenant1}::uuid
`);

const alertEvents = () => su((sql) => sql<{ lead_day: number; delivery_status: string; delivery_error: string | null }[]>`
  SELECT a.lead_day, a.delivery_status, a.delivery_error
  FROM alert_event a JOIN alert_rule r ON r.id = a.rule_id
  WHERE r.is_default AND a.tenant_id = ${IDS.tenant1}::uuid
  ORDER BY a.lead_day
`);

describe('the default rule (0730)', () => {
  it('exists for every tenant, including ones created after the migration', async () => {
    const rows = await su((sql) => sql<{ tenant_id: string; lead_days: number[]; is_active: boolean }[]>`
      SELECT t.id AS tenant_id, r.lead_days, r.is_active
      FROM tenant t LEFT JOIN alert_rule r ON r.tenant_id = t.id AND r.is_default
    `);
    // Both fixture tenants are inserted after the migrations run, so this is
    // the trigger's work, not the backfill's.
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      expect(row.lead_days?.map(Number)).toEqual([30, 14, 7, 1]);
      expect(row.is_active).toBe(true);
    }
  });

  it('allows only one default rule per tenant', async () => {
    await expect(su((sql) => sql`
      INSERT INTO alert_rule (tenant_id, name, channel, target, lead_days, is_default)
      VALUES (${IDS.tenant1}::uuid, 'second default', 'webhook', 'x', '{1}', true)
    `)).rejects.toThrow(/alert_rule_one_default/);
  });
});

describe('from an expiring certificate to the notification queue', () => {
  it('queues one warning, for the most urgent threshold, to a subscribed destination', async () => {
    await subscribeMailbox();

    const evaluated = await evaluateExpiryAlertsJob().run(context());
    expect(evaluated.counts).toMatchObject({ fired: 1, suppressed: 2, failed: 0 });

    const delivered = await deliverExpiryAlertsJob().run(context());
    expect(delivered.counts).toMatchObject({ queued: 1, unrouted: 0, tenantsFailed: 0 });

    const queued = await queuedWarnings();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.event_type).toBe('expiration.warning');

    expect((await alertEvents()).map((e) => [e.lead_day, e.delivery_status])).toEqual([
      [7, 'sent'],
      [14, 'suppressed'],
      [30, 'suppressed'],
    ]);

    // And a second pass changes nothing.
    await evaluateExpiryAlertsJob().run(context());
    const again = await deliverExpiryAlertsJob().run(context());
    expect(again.idle).toBe(true);
    expect(await queuedWarnings()).toHaveLength(1);
  });

  it('records a warning with nowhere to go as suppressed, with the reason, rather than retrying it forever', async () => {
    await evaluateExpiryAlertsJob().run(context());
    const ctx = context();
    const delivered = await deliverExpiryAlertsJob().run(ctx);

    expect(delivered.counts).toMatchObject({ queued: 0, unrouted: 1 });
    expect(ctx.lines.some((l) => l.includes('nowhere to go'))).toBe(true);
    const [pending] = (await alertEvents()).filter((e) => e.lead_day === 7);
    expect(pending!.delivery_status).toBe('suppressed');
    expect(pending!.delivery_error).toMatch(/no notification destination subscribes/);
  });

  it('raises nothing when the tenant has switched warnings off', async () => {
    await subscribeMailbox();
    await su((sql) => sql`UPDATE alert_rule SET is_active = false WHERE is_default`);

    const evaluated = await evaluateExpiryAlertsJob().run(context());
    expect(evaluated.idle).toBe(true);
    expect(await alertEvents()).toEqual([]);
  });
});

describe('GET and PUT /api/tenant/expiry-alerts', () => {
  it('reads the default rule', async () => {
    currentUser = TECH;
    const response = await getSetting(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: true, leadDays: [30, 14, 7, 1] });
  });

  it('lets an administrator change the lead times, sorted and de-duplicated, and audits it', async () => {
    currentUser = ADMIN;
    const response = await putSetting(request('PUT', { enabled: true, leadDays: [7, 60, 7, 0] }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: true, leadDays: [60, 7, 0] });

    const [audit] = await su((sql) => sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_log WHERE action = 'alert.rule_updated'
    `);
    expect(audit!.n).toBeGreaterThanOrEqual(1);
  });

  it('refuses somebody without alert:manage', async () => {
    currentUser = TECH;
    const response = await putSetting(request('PUT', { enabled: false, leadDays: [1] }));
    expect(response.status).toBe(403);
  });

  it('refuses a schedule the form would also refuse', async () => {
    currentUser = ADMIN;
    for (const leadDays of [[], [-1], [400], [1.5], [1, 2, 3, 4, 5, 6, 7]]) {
      const response = await putSetting(request('PUT', { enabled: true, leadDays }));
      expect(response.status, JSON.stringify(leadDays)).toBe(400);
    }
  });
});

describe('parseLeadDays', () => {
  it('accepts the form a person types', () => {
    expect(parseLeadDays('30, 14 7,1')).toEqual({ ok: true, leadDays: [30, 14, 7, 1] });
    expect(parseLeadDays('0')).toEqual({ ok: true, leadDays: [0] });
  });

  it('says what is wrong', () => {
    expect(parseLeadDays('')).toMatchObject({ ok: false });
    expect(parseLeadDays('thirty')).toMatchObject({ ok: false });
    expect(parseLeadDays('3000')).toMatchObject({ ok: false });
  });
});
