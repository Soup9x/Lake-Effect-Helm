/**
 * The per-user workspace: favourites, recently viewed, dashboard layout, notes.
 *
 * The property worth testing here is not "does the star save". It is that ALL
 * of this is PERSONAL — scoped by a policy naming both the tenant and the
 * acting user, unlike almost every other table in this schema, which is scoped
 * by tenant alone. A technician's recently-viewed list is a record of which
 * clients they have been looking at, and the failure mode is not a crash: it is
 * a colleague quietly seeing it.
 *
 * §26 of db/tests/security.sql asserts the same thing at the policy level. This
 * asserts it through the API, because the policy being right does not help if a
 * route reaches the table with a user id from the request.
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import { withTenant } from '../../src/lib/db/client';
import { listRecent, recordView } from '../../src/lib/workspace/queries';
import { DEFAULT_LAYOUT, WIDGET_KEYS } from '../../src/lib/workspace/widgets';
import {
  buildHarness,
  connectPools,
  disconnectPools,
  IDS,
  resetDatabase,
  superuserSql,
  type Harness,
} from './harness';

import { GET as getFavorites, PUT as putFavorite } from '../../src/app/api/workspace/favorites/route';
import { GET as getRecent } from '../../src/app/api/workspace/recent/route';
import { GET as getDashboard, PUT as putDashboard } from '../../src/app/api/workspace/dashboard/route';
import { PATCH as patchOrganization } from '../../src/app/api/organizations/[organizationId]/route';
import { POST as postSite } from '../../src/app/api/sites/route';
import { POST as postAsset } from '../../src/app/api/assets/route';

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

const body = async (response: Response) => (await response.json()) as Record<string, unknown>;

/** The transaction a page gets, for the query helpers that take one. */
async function asActor<T>(userId: string, fn: Parameters<typeof withTenant<T>>[1]): Promise<T> {
  return withTenant({ tenantId: IDS.tenant1, actorId: userId, actorType: 'user' }, fn);
}

async function countWhere(table: string, predicate: string): Promise<number> {
  const sql = superuserSql();
  try {
    const [row] = await sql.unsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM ${table} WHERE ${predicate}`,
    );
    return row!.n;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

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

// ---------------------------------------------------------------------------

describe('the widget catalogue', () => {
  it('agrees with the keys the database will accept', async () => {
    // Two copies of one list — helm.dashboard_layout_valid() and WIDGET_KEYS.
    // Adding a widget to the interface without a migration produces a layout
    // the CHECK refuses, which is a 500 on a save nobody can explain. This is
    // the test that turns that into a failure here instead.
    const sql = superuserSql();
    try {
      for (const key of WIDGET_KEYS) {
        // sql.json(), the way setLayout() sends it. JSON.stringify() here
        // would arrive as a jsonb string rather than an array and this test
        // would fail for a reason that has nothing to do with the key.
        const [row] = await sql<{ ok: boolean }[]>`
          SELECT helm.dashboard_layout_valid(${sql.json([key])}::jsonb) AS ok
        `;
        expect(row!.ok, `the database refuses the widget key "${key}"`).toBe(true);
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('has a default layout made only of real widgets', () => {
    for (const key of DEFAULT_LAYOUT) expect(WIDGET_KEYS).toContain(key);
  });
});

describe('pinning a client', () => {
  it('appears on your own list afterwards', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await putFavorite(
      request('/api/workspace/favorites', 'PUT', { organizationId: IDS.orgAcme, pinned: true }),
    );
    expect(response.status).toBe(200);

    const favorites = (await body(await getFavorites(request('/api/workspace/favorites'))))
      .favorites as { organizationId: string }[];
    expect(favorites.map((f) => f.organizationId)).toContain(IDS.orgAcme);
  });

  it('is NOT on a colleague\'s list', async () => {
    // The whole point. Same tenant, same connection pool, different person.
    asUser(IDS.tech1, 'tech1@northwind.test');
    const favorites = (await body(await getFavorites(request('/api/workspace/favorites'))))
      .favorites as unknown[];
    expect(favorites).toHaveLength(0);
  });

  it('unpins without touching anybody else\'s', async () => {
    asUser(IDS.tech1, 'tech1@northwind.test');
    await putFavorite(
      request('/api/workspace/favorites', 'PUT', { organizationId: IDS.orgAcme, pinned: true }),
    );
    await putFavorite(
      request('/api/workspace/favorites', 'PUT', { organizationId: IDS.orgAcme, pinned: false }),
    );

    expect(await countWhere('user_favorite', `user_id = '${IDS.tech1}'`)).toBe(0);
    // The admin's pin from the first test is still there.
    expect(await countWhere('user_favorite', `user_id = '${IDS.admin1}'`)).toBe(1);
  });

  it('refuses a client in another tenant', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await putFavorite(
      request('/api/workspace/favorites', 'PUT', { organizationId: IDS.orgContoso, pinned: true }),
    );

    // 400, not 500 and not 404: naming a client that is not yours must not
    // distinguish "another tenant's" from "no such".
    expect(response.status).toBe(400);
    expect(await countWhere('user_favorite', `organization_id = '${IDS.orgContoso}'`)).toBe(0);
  });

  it('carries the client\'s health AND its tallies, so the widget needs no second query', async () => {
    // The tallies are not decoration. The widget renders "2 critical, 1
    // expiring soon: <names>", and a zero where a real count belongs produced
    // "At risk . : *.acme.test" — an empty count list and the colon that was
    // meant to follow it.
    // The condition is CREATED here rather than assumed of the fixtures. An
    // assertion that a count is above zero, against data that happens to have
    // nothing expiring, passes or fails for reasons that have nothing to do
    // with the code under test.
    const sql = superuserSql();
    try {
      await sql`
        UPDATE ssl_certificate SET not_after = now() - interval '2 days'
        WHERE id = ${IDS.certificate}::uuid
      `;
    } finally {
      await sql.end({ timeout: 5 });
    }

    asUser(IDS.admin1, 'admin@northwind.test');
    const favorites = (await body(await getFavorites(request('/api/workspace/favorites'))))
      .favorites as {
        organizationId: string; health: string;
        expiredCount: number; criticalCount: number; warningCount: number;
      }[];
    const acme = favorites.find((f) => f.organizationId === IDS.orgAcme);

    expect(acme!.health).toBe('red');
    expect(
      acme!.expiredCount + acme!.criticalCount + acme!.warningCount,
    ).toBeGreaterThan(0);
  });
});

describe('recently viewed', () => {
  it('records what you opened, newest first', async () => {
    // Two transactions, because two page loads are two transactions — and the
    // ordering has to hold within one as well, which is why record_view()
    // stamps clock_timestamp() rather than now().
    await asActor(IDS.tech1, (tx) => recordView(tx, { organizationId: IDS.orgAcme }));
    await asActor(IDS.tech1, (tx) => recordView(tx, { organizationId: IDS.orgGlobex }));

    asUser(IDS.tech1, 'tech1@northwind.test');
    const recent = (await body(await getRecent(request('/api/workspace/recent')))).recent as {
      id: string;
    }[];
    expect(recent[0]!.id).toBe(IDS.orgGlobex);
    expect(recent[1]!.id).toBe(IDS.orgAcme);
  });

  it('moves a repeat visit up rather than listing it twice', async () => {
    await asActor(IDS.tech1, (tx) => recordView(tx, { organizationId: IDS.orgAcme }));

    const recent = await asActor(IDS.tech1, (tx) => listRecent(tx, 10));
    expect(recent.filter((r) => r.id === IDS.orgAcme)).toHaveLength(1);
    expect(recent[0]!.id).toBe(IDS.orgAcme);
  });

  it('records assets as well as clients, with the client they belong to', async () => {
    await asActor(IDS.tech1, (tx) => recordView(tx, { nodeId: IDS.firewall }));

    const recent = await asActor(IDS.tech1, (tx) => listRecent(tx, 10));
    const asset = recent.find((r) => r.id === IDS.firewall);
    expect(asset?.kind).toBe('asset');
    expect(asset?.href).toBe(`/assets/${IDS.firewall}`);
    expect(asset?.context).toBeTruthy();
  });

  it('orders correctly even within one transaction', async () => {
    // now() is the transaction's start time, so a pair recorded in one
    // transaction would tie and order arbitrarily. record_view() stamps
    // clock_timestamp() precisely so this holds.
    await asActor(IDS.tech1, async (tx) => {
      await recordView(tx, { organizationId: IDS.orgAcme });
      await recordView(tx, { organizationId: IDS.orgGlobex });
    });

    const recent = await asActor(IDS.tech1, (tx) => listRecent(tx, 10));
    expect(recent[0]!.id).toBe(IDS.orgGlobex);
    expect(recent[1]!.id).toBe(IDS.orgAcme);
  });

  it('is invisible to a colleague', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const recent = (await body(await getRecent(request('/api/workspace/recent'))))
      .recent as unknown[];
    expect(recent).toHaveLength(0);
  });

  it('forgets a client that is deleted rather than listing a dangling row', async () => {
    // A foreign key with ON DELETE CASCADE, not a join that silently drops
    // rows: the difference shows up as a list that quietly shortens versus a
    // table that grows forever.
    const sql = superuserSql();
    try {
      await sql`
        INSERT INTO organization (id, tenant_id, slug, name)
        VALUES ('1a000000-0000-0000-0000-0000000000ee'::uuid, ${IDS.tenant1}::uuid, 'doomed', 'Doomed Ltd')
      `;
      await asActor(IDS.tech1, (tx) =>
        recordView(tx, { organizationId: '1a000000-0000-0000-0000-0000000000ee' }),
      );
      expect(
        await countWhere('user_recent_view', `organization_id = '1a000000-0000-0000-0000-0000000000ee'`),
      ).toBe(1);

      await sql`DELETE FROM organization WHERE id = '1a000000-0000-0000-0000-0000000000ee'::uuid`;
      expect(
        await countWhere('user_recent_view', `organization_id = '1a000000-0000-0000-0000-0000000000ee'`),
      ).toBe(0);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

describe('the dashboard layout', () => {
  it('gives a first-time user the default rather than an empty page', async () => {
    asUser(IDS.acmeAdmin, 'it@acme.test');
    const widgets = (await body(await getDashboard(request('/api/workspace/dashboard'))))
      .widgets as string[];
    expect(widgets).toEqual(DEFAULT_LAYOUT);
    // ...and has not written a row for somebody who has never customised it.
    expect(await countWhere('user_dashboard', `user_id = '${IDS.acmeAdmin}'`)).toBe(0);
  });

  it('saves an arrangement and reads it back in order', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const saved = await putDashboard(
      request('/api/workspace/dashboard', 'PUT', {
        widgets: ['expirations', 'favorites'],
      }),
    );
    expect(saved.status).toBe(200);

    const widgets = (await body(await getDashboard(request('/api/workspace/dashboard'))))
      .widgets as string[];
    expect(widgets).toEqual(['expirations', 'favorites']);
  });

  it('keeps an empty layout, because removing everything is a choice', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    await putDashboard(request('/api/workspace/dashboard', 'PUT', { widgets: [] }));

    const widgets = (await body(await getDashboard(request('/api/workspace/dashboard'))))
      .widgets as string[];
    expect(widgets).toEqual([]);

    // Restore, so later tests see a normal dashboard.
    await putDashboard(request('/api/workspace/dashboard', 'PUT', { widgets: [...DEFAULT_LAYOUT] }));
  });

  it('refuses a widget that does not exist', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await putDashboard(
      request('/api/workspace/dashboard', 'PUT', { widgets: ['favorites', 'not_a_widget'] }),
    );
    expect(response.status).toBe(400);
  });

  it('refuses the same widget twice', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await putDashboard(
      request('/api/workspace/dashboard', 'PUT', { widgets: ['favorites', 'favorites'] }),
    );
    expect(response.status).toBe(400);
  });

  it('is not a colleague\'s layout', async () => {
    asUser(IDS.tech1, 'tech1@northwind.test');
    await putDashboard(request('/api/workspace/dashboard', 'PUT', { widgets: ['audit_activity'] }));

    asUser(IDS.admin1, 'admin@northwind.test');
    const widgets = (await body(await getDashboard(request('/api/workspace/dashboard'))))
      .widgets as string[];
    expect(widgets).not.toEqual(['audit_activity']);
  });
});

describe('client health', () => {
  it('is green for a client with nothing tracked, not absent', async () => {
    // A health view that omits the quiet clients makes an MSP look busier than
    // it is, and hides the clients nobody is tracking anything for.
    const sql = superuserSql();
    try {
      const rows = await sql<{ organization_id: string; health: string }[]>`
        SELECT organization_id, health FROM v_client_health WHERE tenant_id = ${IDS.tenant1}::uuid
      `;
      const orgs = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM organization
        WHERE tenant_id = ${IDS.tenant1}::uuid AND deleted_at IS NULL
      `;
      expect(rows).toHaveLength(orgs[0]!.n);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('turns red when something has expired, and says why', async () => {
    const sql = superuserSql();
    try {
      // Backdate the fixture certificate rather than inventing a new severity:
      // helm.expiration_severity() decides, and this proves the view is asking it.
      await sql`
        UPDATE ssl_certificate SET not_after = now() - interval '3 days'
        WHERE id = ${IDS.certificate}::uuid
      `;
      const [row] = await sql<{ health: string; reasons: string[] | null }[]>`
        SELECT health, reasons FROM v_client_health WHERE organization_id = ${IDS.orgAcme}::uuid
      `;
      expect(row!.health).toBe('red');
      expect(row!.reasons?.length).toBeGreaterThan(0);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

describe('notes', () => {
  it('saves on a client and reads back', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await patchOrganization(
      request(`/api/organizations/${IDS.orgAcme}`, 'PATCH', {
        notes: 'Uses a nonstandard VPN. Ring Dave before touching the firewall.',
      }),
      { params: Promise.resolve({ organizationId: IDS.orgAcme }) },
    );
    expect(response.status).toBe(200);

    expect(
      await countWhere('organization', `id = '${IDS.orgAcme}' AND notes LIKE 'Uses a nonstandard%'`),
    ).toBe(1);
  });

  it('clears on an explicit null, and is left alone when absent', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    // An unrelated field: the note must survive a PATCH that does not mention it.
    await patchOrganization(
      request(`/api/organizations/${IDS.orgAcme}`, 'PATCH', { industry: 'Manufacturing' }),
      { params: Promise.resolve({ organizationId: IDS.orgAcme }) },
    );
    expect(await countWhere('organization', `id = '${IDS.orgAcme}' AND notes IS NOT NULL`)).toBe(1);

    await patchOrganization(
      request(`/api/organizations/${IDS.orgAcme}`, 'PATCH', { notes: null }),
      { params: Promise.resolve({ organizationId: IDS.orgAcme }) },
    );
    expect(await countWhere('organization', `id = '${IDS.orgAcme}' AND notes IS NULL`)).toBe(1);
  });

  it('saves on a site when it is created', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await postSite(
      request('/api/sites', 'POST', {
        organizationId: IDS.orgAcme,
        name: 'Noted site',
        notes: 'Key is in the lockbox by the loading dock.',
      }),
    );
    expect(response.status).toBe(200);
    expect(await countWhere('site', `name = 'Noted site' AND notes LIKE 'Key is in%'`)).toBe(1);
  });

  it('saves on an asset when it is created', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await postAsset(
      request('/api/assets', 'POST', {
        organizationId: IDS.orgAcme,
        nodeType: 'device',
        deviceType: 'server',
        name: 'Noted server',
        notes: 'Reboots take eleven minutes. Do not assume it is dead.',
      }),
    );
    expect(response.status).toBe(200);
    expect(
      await countWhere('asset_node', `name = 'Noted server' AND notes LIKE 'Reboots take%'`),
    ).toBe(1);
  });

  it('refuses a note longer than the column allows', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await patchOrganization(
      request(`/api/organizations/${IDS.orgAcme}`, 'PATCH', { notes: 'x'.repeat(4001) }),
      { params: Promise.resolve({ organizationId: IDS.orgAcme }) },
    );
    expect(response.status).toBe(400);
  });

  it('lives in exactly ONE place for a credential', async () => {
    // 0370 removed credential.notes. A credential is an asset_node, so its
    // notes are the node's — and if that column came back, the interface would
    // edit one field while the offboarding export read the other, with nothing
    // anywhere reporting a problem.
    const sql = superuserSql();
    try {
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_attribute
        WHERE attrelid = 'public.credential'::regclass AND attname = 'notes'
          AND attnum > 0 AND NOT attisdropped
      `;
      expect(row!.n).toBe(0);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
