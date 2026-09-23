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

// ---------------------------------------------------------------------------

describe('reordering the dashboard', () => {
  /**
   * Drag and the arrow buttons both call reorder() and then save the whole
   * list, so what is tested here is the persistence half: that an order
   * arrives, is stored, comes back, and stays personal.
   */
  const layoutOf = async (): Promise<string[]> => {
    const response = await getDashboard(request('/api/workspace/dashboard'));
    return ((await response.json()) as { widgets: string[] }).widgets;
  };

  const save = (widgets: string[]) =>
    putDashboard(request('/api/workspace/dashboard', 'PUT', { widgets }));

  it('stores an order and gives it back in the same order', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    // Deliberately not sorted and not the default: a route that returned the
    // stored set rather than the stored SEQUENCE would pass a test whose
    // expectation happened to be alphabetical.
    const order = ['client_health', 'favorites', 'expirations', 'recently_viewed'];

    expect((await save(order)).status).toBe(200);
    expect(await layoutOf()).toEqual(order);
  });

  it('stores the three new widgets, which the database had to learn first', async () => {
    // The CHECK calls helm.dashboard_layout_valid(). Before 0530 this save
    // came back as an unexplained 500.
    asUser(IDS.admin1, 'admin@northwind.test');
    const order = ['quick_actions', 'sync_status', 'usage_summary', 'favorites'];

    expect((await save(order)).status).toBe(200);
    expect(await layoutOf()).toEqual(order);
  });

  it('round-trips a move rather than only the first save', async () => {
    // What dragging actually produces: an order, then another order.
    asUser(IDS.admin1, 'admin@northwind.test');
    await save(['favorites', 'expirations', 'sync_status']);
    await save(['sync_status', 'favorites', 'expirations']);
    expect(await layoutOf()).toEqual(['sync_status', 'favorites', 'expirations']);
  });

  it('refuses a layout that lists a widget twice', async () => {
    // Which a reorder cannot produce and a hand-written request can. Rendering
    // it twice is not something anybody means.
    asUser(IDS.admin1, 'admin@northwind.test');
    expect((await save(['favorites', 'favorites'])).status).toBe(400);
  });

  it('refuses a key the database does not know', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    expect((await save(['favorites', 'not_a_widget'])).status).toBe(400);
  });

  it('keeps one person\'s order out of another\'s', async () => {
    // The property this whole file exists for. A layout is per-user state, and
    // the failure mode is a colleague quietly inheriting your arrangement.
    asUser(IDS.admin1, 'admin@northwind.test');
    await save(['sync_status', 'usage_summary']);

    asUser(IDS.tech1, 'tech1@northwind.test');
    await save(['favorites', 'quick_actions']);
    expect(await layoutOf()).toEqual(['favorites', 'quick_actions']);

    asUser(IDS.admin1, 'admin@northwind.test');
    expect(await layoutOf()).toEqual(['sync_status', 'usage_summary']);
  });
});

// ---------------------------------------------------------------------------

describe('what the new widgets are given', () => {
  /**
   * The three new widgets take rows and render them, like every other widget
   * here — the page fetches only what the layout asks for. So what is worth
   * asserting is the QUERIES: that each returns live data of the shape its
   * widget expects, under the caller's own RLS.
   *
   * The statements below are the ones in src/app/(app)/dashboard/page.tsx. A
   * server component cannot be imported and called, and duplicating the SQL to
   * assert a different SQL would test nothing — so these run the same text
   * against the same fixtures.
   */
  const asActor = { tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' as const };

  it('usage summary: totals that match what is really there', async () => {
    const [totals, actual] = await withTenant(asActor, async (tx) => {
      const [row] = await tx<Record<string, string>[]>`
        SELECT
          (SELECT count(*) FROM organization WHERE deleted_at IS NULL) AS organizations,
          (SELECT count(*) FROM v_secret_metadata) AS secrets,
          (SELECT count(*) FROM asset_node WHERE archived_at IS NULL) AS assets,
          (SELECT count(*) FROM site WHERE deleted_at IS NULL) AS sites,
          (SELECT count(*) FROM contact) AS contacts,
          (SELECT count(*) FROM attachment WHERE deleted_at IS NULL) AS attachments
      `;
      const [check] = await tx<{ orgs: string; assets: string }[]>`
        SELECT (SELECT count(*) FROM organization WHERE deleted_at IS NULL) AS orgs,
               (SELECT count(*) FROM asset_node WHERE archived_at IS NULL) AS assets
      `;
      return [row!, check!];
    });

    expect(Number(totals.organizations)).toBe(Number(actual.orgs));
    expect(Number(totals.assets)).toBe(Number(actual.assets));
    // Not a tenant with nothing in it, or every assertion above is 0 === 0.
    expect(Number(totals.organizations)).toBeGreaterThan(0);
    expect(Number(totals.assets)).toBeGreaterThan(0);
  });

  it('usage summary: an archived asset stops counting', async () => {
    const before = await withTenant(asActor, async (tx) => {
      const [r] = await tx<{ n: string }[]>`
        SELECT count(*) AS n FROM asset_node WHERE archived_at IS NULL
      `;
      return Number(r!.n);
    });

    const sql = superuserSql();
    try {
      await sql`UPDATE asset_node SET archived_at = now() WHERE id = ${IDS.firewall}::uuid`;
      const after = await withTenant(asActor, async (tx) => {
        const [r] = await tx<{ n: string }[]>`
          SELECT count(*) AS n FROM asset_node WHERE archived_at IS NULL
        `;
        return Number(r!.n);
      });
      expect(after).toBe(before - 1);
    } finally {
      await sql`UPDATE asset_node SET archived_at = NULL WHERE id = ${IDS.firewall}::uuid`;
      await sql.end({ timeout: 5 });
    }
  });

  it('quick actions: clients with their sites, archived ones left out', async () => {
    const sql = superuserSql();
    let siteId = '';
    try {
      const [site] = await sql<{ id: string }[]>`
        INSERT INTO site (tenant_id, organization_id, name)
        VALUES (${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, 'ZZ Widget Site')
        RETURNING id
      `;
      siteId = site!.id;
      await sql`UPDATE organization SET archived_at = now() WHERE id = ${IDS.orgGlobex}::uuid`;

      const clients = await withTenant(asActor, (tx) => tx<
        { id: string; name: string; sites: { id: string; name: string }[] }[]
      >`
        SELECT o.id, o.name,
               coalesce(
                 jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name)
                           ORDER BY s.name) FILTER (WHERE s.id IS NOT NULL),
                 '[]'::jsonb) AS sites
        FROM organization o
        LEFT JOIN site s ON s.organization_id = o.id AND s.deleted_at IS NULL
        WHERE o.deleted_at IS NULL AND o.archived_at IS NULL
        GROUP BY o.id, o.name
        ORDER BY o.is_msp_internal, o.name
      `);

      const acme = clients.find((c) => c.id === IDS.orgAcme);
      expect(acme).toBeDefined();
      // The shape NewAssetForm expects, not a bare id list.
      expect(acme!.sites.map((s) => s.name)).toContain('ZZ Widget Site');
      // Starting new work on an archived client is not something somebody means
      // to do, so it is not offered.
      expect(clients.map((c) => c.id)).not.toContain(IDS.orgGlobex);
      // A client with no sites arrives as [] rather than [null].
      const empty = clients.find((c) => c.sites.length === 0);
      if (empty) expect(Array.isArray(empty.sites)).toBe(true);
    } finally {
      await sql`UPDATE organization SET archived_at = NULL WHERE id = ${IDS.orgGlobex}::uuid`;
      if (siteId) await sql`DELETE FROM site WHERE id = ${siteId}::uuid`;
      await sql.end({ timeout: 5 });
    }
  });

  it('sync status: every column the widget reads, for a real mapping', async () => {
    const sql = superuserSql();
    try {
      const [secret] = await sql<{ id: string }[]>`
        INSERT INTO secret (tenant_id, organization_id, kind, label)
        VALUES (${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, 'api_key', 'ZZ widget controller key')
        RETURNING id
      `;
      await sql`
        INSERT INTO unifi_site_mapping
          (tenant_id, organization_id, name, controller_url, unifi_site_id,
           api_key_secret_id, is_active, poll_interval_seconds,
           last_poll_at, last_poll_ok, consecutive_failures)
        VALUES (${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, 'ZZ Widget Controller',
                'https://unifi.zz.test', 'default', ${secret!.id}::uuid, true, 900,
                now() - interval '10 minutes', true, 0)
      `;

      const rows = await withTenant(asActor, (tx) => tx<Record<string, unknown>[]>`
        SELECT id, name, organization_name, is_active, last_poll_at, last_poll_ok,
               last_poll_error, poll_interval_seconds, consecutive_failures
        FROM helm.unifi_mappings()
        ORDER BY organization_name, name
      `);

      const mapping = rows.find((r) => r.name === 'ZZ Widget Controller');
      expect(mapping).toBeDefined();
      // Every field syncState() reads, present and of the right type — the
      // widget cannot classify a mapping it is handed undefined for.
      expect(mapping!.is_active).toBe(true);
      expect(mapping!.last_poll_ok).toBe(true);
      expect(mapping!.last_poll_at).toBeInstanceOf(Date);
      expect(typeof mapping!.poll_interval_seconds).toBe('number');
      expect(mapping!.organization_name).toBe('Acme Manufacturing');
      // And no API key: helm.unifi_mappings() has no column that could carry
      // one, which is why the widget can be handed its rows directly.
      expect(Object.keys(mapping!)).not.toContain('api_key_secret_id');
    } finally {
      await sql`DELETE FROM unifi_site_mapping WHERE name = 'ZZ Widget Controller'`;
      await sql`DELETE FROM secret WHERE label = 'ZZ widget controller key'`;
      await sql.end({ timeout: 5 });
    }
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

  /**
   * The page calls this BEFORE the six queries that render it, inside the same
   * transaction. A failed statement aborts a Postgres transaction, so a
   * swallowed failure here used to poison every query after it — one
   * unwritable history row became a 500 on every client and asset page, and
   * the catch hid the cause.
   *
   * A deleted organisation is the realistic trigger: the page reads the row,
   * it goes away, and the write violates user_recent_view's foreign key.
   */
  it('a failed view record leaves the caller’s transaction usable', async () => {
    const vanished = '0a000000-0000-0000-0000-0000000000ff';

    const stillWorks = await asActor(IDS.tech1, async (tx) => {
      await recordView(tx, { organizationId: vanished });

      // What the page does next. Before the savepoint this raised 25P02,
      // "current transaction is aborted, commands ignored until end of
      // transaction block".
      const [row] = await tx<{ name: string }[]>`
        SELECT name FROM organization WHERE id = ${IDS.orgAcme}::uuid
      `;
      return row?.name ?? null;
    });

    expect(stillWorks).toBeTruthy();
  });

  it('records nothing when the view record fails', async () => {
    const vanished = '0a000000-0000-0000-0000-0000000000fe';

    await asActor(IDS.tech1, (tx) => recordView(tx, { organizationId: vanished }));

    const recent = await asActor(IDS.tech1, (tx) => listRecent(tx, 50));
    expect(recent.map((r) => r.id)).not.toContain(vanished);
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
