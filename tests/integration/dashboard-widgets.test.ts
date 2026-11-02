/**
 * The integration-era dashboard (1230): widget widths, the team default
 * layout, and the queries behind the new widgets.
 *
 * What matters most here is the team default's two rules: an administrator's
 * default reaches a colleague who has never arranged their own (including a
 * client-side one), and only tenant:write may set it.
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import { withTenant } from '../../src/lib/db/client';
import {
  integrationState, listDevicesNeedingAttention, listExpiring, listIntegrationHealth,
} from '../../src/lib/workspace/dashboard-data';
import { DEFAULT_LAYOUT, DEFAULT_WIDE } from '../../src/lib/workspace/widgets';
import {
  buildHarness, connectPools, disconnectPools, IDS, resetDatabase, superuserSql, type Harness,
} from './harness';

import {
  DELETE as deleteDashboard, GET as getDashboard, PUT as putDashboard,
} from '../../src/app/api/workspace/dashboard/route';
import {
  DELETE as deleteTeamDefault, PUT as putTeamDefault,
} from '../../src/app/api/tenant/dashboard-default/route';

let h: Harness;
let currentUser: SessionUser | null = null;
const asUser = (id: string, email: string) => {
  currentUser = { id, email };
};

const request = (url: string, method = 'GET', payload?: unknown) =>
  new NextRequest(
    new Request(`http://helm.test${url}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    }),
  );

interface LayoutBody { widgets: string[]; wide: string[]; source?: string }
const json = async (response: Response) => (await response.json()) as LayoutBody;
const myLayout = async () => json(await getDashboard(request('/api/workspace/dashboard')));

async function su<T>(fn: (sql: ReturnType<typeof superuserSql>) => Promise<T>): Promise<T> {
  const sql = superuserSql();
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const asActor = <T>(userId: string, fn: Parameters<typeof withTenant<T>>[1]) =>
  withTenant({ tenantId: IDS.tenant1, actorId: userId, actorType: 'user' }, fn);

beforeAll(async () => {
  resetDatabase();
  connectPools();
  h = buildHarness();
  resetServices();
  setKekProvider(h.kek);
  useSessionResolver(async () => currentUser);
  await h.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'test provisioning' });
}, 120_000);

afterAll(async () => {
  await disconnectPools();
});

describe('widget widths', () => {
  it('starts from each widget’s own default width', async () => {
    asUser(IDS.tech1, 'tech1@northwind.test');
    const layout = await myLayout();
    expect(layout.source).toBe('built_in');
    expect(layout.widgets).toEqual(DEFAULT_LAYOUT);
    expect(layout.wide).toEqual(DEFAULT_LAYOUT.filter((k) => DEFAULT_WIDE.includes(k)));
  });

  it('stores which widgets span the row, and drops widths of removed widgets', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const saved = await putDashboard(request('/api/workspace/dashboard', 'PUT', {
      widgets: ['integration_health', 'device_attention', 'my_tasks'],
      wide: ['integration_health', 'expirations'],
    }));
    expect(saved.status).toBe(200);
    const layout = await myLayout();
    expect(layout.source).toBe('personal');
    expect(layout.wide).toEqual(['integration_health']);
  });

  it('keeps the widths when an older client saves only the order', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    await putDashboard(request('/api/workspace/dashboard', 'PUT', {
      widgets: ['my_tasks', 'integration_health'],
    }));
    expect((await myLayout()).wide).toEqual(['integration_health']);
  });

  it('accepts every widget at once', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const all = [
      'favorites', 'recently_viewed', 'expirations', 'audit_activity', 'client_health',
      'quick_actions', 'usage_summary', 'sync_status', 'integration_health', 'device_attention',
      'expiring_domains', 'expiring_warranties', 'notifications', 'my_tasks',
    ];
    const saved = await putDashboard(request('/api/workspace/dashboard', 'PUT', { widgets: all }));
    expect(saved.status).toBe(200);
    expect((await myLayout()).widgets).toEqual(all);
  });
});

describe('the team default', () => {
  const teamLayout = { widgets: ['integration_health', 'device_attention'], wide: ['device_attention'] };

  it('cannot be set without tenant:write', async () => {
    asUser(IDS.tech1, 'tech1@northwind.test');
    const response = await putTeamDefault(
      request('/api/tenant/dashboard-default', 'PUT', teamLayout),
    );
    expect(response.status).toBe(403);
    expect(await su((sql) => sql`SELECT 1 FROM tenant_dashboard_default`)).toHaveLength(0);
  });

  it('reaches colleagues who never arranged their own, client-side ones included', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    expect((await putTeamDefault(
      request('/api/tenant/dashboard-default', 'PUT', teamLayout),
    )).status).toBe(200);

    asUser(IDS.tech1, 'tech1@northwind.test');
    expect(await myLayout()).toEqual({ ...teamLayout, source: 'tenant' });

    asUser(IDS.acmeAdmin, 'it@acme.test');
    expect((await myLayout()).source).toBe('tenant');
  });

  it('does not touch anybody’s own arrangement', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    expect((await myLayout()).source).toBe('personal');
  });

  it('is where Reset takes somebody back to', async () => {
    asUser(IDS.tech1, 'tech1@northwind.test');
    await putDashboard(request('/api/workspace/dashboard', 'PUT', { widgets: ['favorites'] }));
    expect((await myLayout()).source).toBe('personal');

    const reset = await json(await deleteDashboard(request('/api/workspace/dashboard', 'DELETE')));
    expect(reset).toEqual({ ...teamLayout, source: 'tenant' });
  });

  it('can be cleared, back to Helm’s own', async () => {
    asUser(IDS.tech1, 'tech1@northwind.test');
    expect((await deleteTeamDefault(request('/api/tenant/dashboard-default', 'DELETE'))).status)
      .toBe(403);

    asUser(IDS.admin1, 'admin@northwind.test');
    expect((await deleteTeamDefault(request('/api/tenant/dashboard-default', 'DELETE'))).status)
      .toBe(200);

    asUser(IDS.tech1, 'tech1@northwind.test');
    const layout = await myLayout();
    expect(layout.source).toBe('built_in');
    expect(layout.widgets).toEqual(DEFAULT_LAYOUT);
  });
});

describe('integration health', () => {
  it('names failing connections first, with the error', async () => {
    await su(async (sql) => {
      await sql`
        INSERT INTO integration_connection
          (id, tenant_id, provider, display_name, base_url, sync_enabled, sync_interval_minutes,
           last_sync_at, last_success_at, consecutive_failures, last_error)
        VALUES
          ('1e000000-0000-0000-0000-0000000000a1', ${IDS.tenant1}, 'ninja_one', 'NinjaOne', 'https://app.ninjarmm.com', true, 60,
           now() - interval '5 minutes', now() - interval '5 minutes', 0, NULL),
          ('1e000000-0000-0000-0000-0000000000a2', ${IDS.tenant1}, 'action1', 'Action1', 'https://app.action1.com', true, 60,
           now() - interval '5 minutes', now() - interval '2 days', 3, 'Action1 said 401')
      `;
    });
    const rows = await asActor(IDS.admin1, (tx) => listIntegrationHealth(tx));
    expect(rows.map((r) => [r.provider, r.state])).toEqual([
      ['action1', 'failing'],
      ['ninja_one', 'healthy'],
    ]);
    expect(rows[0]!.message).toBe('Action1 said 401');
  });

  it('is not shown to a client-side role', async () => {
    const rows = await asActor(IDS.acmeAdmin, (tx) => listIntegrationHealth(tx));
    expect(rows).toEqual([]);
  });

  it('calls a connection stale after three missed intervals', () => {
    const now = Date.now();
    const base = {
      syncEnabled: true, intervalMinutes: 60, consecutiveFailures: 0, lastRunStatus: 'success',
    };
    const at = (hours: number) => new Date(now - hours * 3_600_000);
    expect(integrationState({ ...base, lastSyncAt: at(2), lastSuccessAt: at(2) }, now)).toBe('healthy');
    expect(integrationState({ ...base, lastSyncAt: at(4), lastSuccessAt: at(4) }, now)).toBe('stale');
    expect(integrationState({ ...base, lastSyncAt: null, lastSuccessAt: null }, now)).toBe('waiting');
    expect(integrationState({ ...base, syncEnabled: false, lastSyncAt: null, lastSuccessAt: null }, now))
      .toBe('paused');
  });
});

describe('devices needing attention', () => {
  it('lists only devices whose synced profile flags something, worst first', async () => {
    await su(async (sql) => {
      await sql`
        INSERT INTO external_identity (tenant_id, connection_id, node_id, external_id, external_type, profile)
        VALUES
          (${IDS.tenant1}, '1e000000-0000-0000-0000-0000000000a1', ${IDS.firewall}, 'n1', 'ninja_device',
           ${sql.json({ offline: false, needsReboot: true,
                        pendingPatches: { total: 4, critical: 2 },
                        volumes: [{ name: 'C:', capacityGb: 100, freeGb: 5 }] })}),
          (${IDS.tenant1}, '1e000000-0000-0000-0000-0000000000a1', ${IDS.domainController}, 'n2', 'ninja_device',
           ${sql.json({ offline: false, pendingPatches: { total: 0, critical: 0 },
                        volumes: [{ name: 'C:', capacityGb: 100, freeGb: 60 }] })}),
          (${IDS.tenant1}, '1e000000-0000-0000-0000-0000000000a2', ${IDS.globexServer}, 'a1', 'action1_device',
           ${sql.json({ agentStatus: 'Disconnected', onlineStatus: 'ERROR',
                        missingUpdates: { critical: 1, other: 3 } })})
      `;
    });

    const { rows, total } = await asActor(IDS.admin1, (tx) => listDevicesNeedingAttention(tx));
    expect(total).toBe(2);
    expect(rows.map((r) => r.nodeId).sort()).toEqual([IDS.firewall, IDS.globexServer].sort());

    const firewall = rows.find((r) => r.nodeId === IDS.firewall)!;
    expect(firewall.issues).toEqual(['2 critical patches', 'Disk under 10% free', 'Needs a reboot']);
    expect(firewall.sources).toEqual(['NinjaOne']);

    const globex = rows.find((r) => r.nodeId === IDS.globexServer)!;
    expect(globex.issues).toEqual(
      expect.arrayContaining(['Agent disconnected', 'Not seen in 30+ days', '1 critical update']),
    );
  });

  it('shows a client-side user only their own client’s devices', async () => {
    const { rows } = await asActor(IDS.acmeAdmin, (tx) => listDevicesNeedingAttention(tx));
    expect(rows.every((r) => r.organizationId === IDS.orgAcme)).toBe(true);
  });
});

describe('expiring domains and warranties', () => {
  it('lists only the kind asked for', async () => {
    const domains = await asActor(IDS.admin1, (tx) => listExpiring(tx, 'domain_registration', 3650));
    const warranties = await asActor(IDS.admin1, (tx) => listExpiring(tx, 'device_warranty', 3650));
    expect(domains.rows.length).toBeGreaterThan(0);
    const ids = new Set(warranties.rows.map((r) => r.id));
    for (const row of domains.rows) expect(ids.has(row.id)).toBe(false);
  });
});
