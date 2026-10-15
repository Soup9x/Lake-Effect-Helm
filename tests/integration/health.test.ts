/**
 * Documentation health, against real rows and the real trigger.
 *
 * THE TEST THIS FILE EXISTS FOR is "opening a record does not make it look
 * freshly revised". The first version of this feature put `last_viewed_at` on
 * `asset_node`, where `asset_node_touch` (BEFORE UPDATE, helm.touch_updated_at)
 * sets `updated_at := now()` on any write to the row — so recording a view
 * marked the documentation as revised, and a 400-day-old record measured as 0
 * days old. The ring would have counted only the records nobody had looked at
 * as stale, which is the OTHER measure, and it would have got better the more
 * people browsed.
 *
 * Nothing in TypeScript could have caught that, and no unit test: it is a
 * trigger on a table reacting to a write three layers down. So it is asserted
 * here, at the only level where both the trigger and the view are real.
 *
 * THE OTHER THINGS ONLY THIS LEVEL ANSWERS:
 *
 *   1. THE THREE SEGMENTS PARTITION THE TOTAL, on rows contrived so all three
 *      are non-empty — because `0 + 0 + n = n` is an identity that holds for a
 *      broken view too.
 *   2. THE WINDOW IS THE TENANT'S. Moving it has to move the counts, or the
 *      setting is decoration.
 *   3. THE SQL DEFAULT AND THE TS DEFAULT AGREE, and so do the bounds. Three
 *      copies of 180 and two copies of 1..3650 exist by necessity; the test is
 *      what stops them drifting.
 *   4. A SEGMENT'S LIST MATCHES ITS COUNT. The count comes from a FILTER in a
 *      view and the list from a CASE in a query, which is a real duplication —
 *      so the two are checked against each other for every segment.
 *   5. RLS. A client user sees their own organisation's health and nobody
 *      else's; another tenant sees nothing at all.
 */
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { withTenant } from '../../src/lib/db/client';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import {
  actor, connectPools, disconnectPools, IDS, resetDatabase, superuserSql,
} from './harness';
import {
  listHealthSegment, readDocumentationHealth, readHealthSetting,
} from '../../src/lib/health/queries';
import {
  DEFAULT_HEALTH_DAYS, HEALTH_DAYS_MAX, HEALTH_DAYS_MIN, segmentsAccountForAll,
} from '../../src/lib/health/window';
import {
  GET as getWindow, PUT as putWindow,
} from '../../src/app/api/tenant/documentation-health/route';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

const ADMIN = actor(IDS.tenant1, IDS.admin1);
/** The client's own administrator, scoped to ACME alone. */
const CLIENT = actor(IDS.tenant1, IDS.acmeAdmin);
/** Client read-only: holds no asset:write, which is the carve-out's whole point. */
const VIEWER = actor(IDS.tenant1, IDS.acmeViewer);
const OTHER_TENANT = actor(IDS.tenant2, IDS.admin2);

let currentUser: SessionUser | null = null;
const USERS = {
  admin: { id: IDS.admin1, email: 'admin@northwind.test' },
  tech: { id: IDS.tech1, email: 'tech@northwind.test' },
  viewer: { id: IDS.acmeViewer, email: 'viewer@acme.test' },
} as const;

const request = (method = 'GET', payload?: unknown) =>
  new NextRequest(
    new Request('http://helm.test/api/tenant/documentation-health', {
      method,
      ...(payload === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
    }),
  );

async function read(response: Response) {
  const raw = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch { /* a non-JSON body is its own diagnostic */ }
  return { status: response.status, payload, raw };
}

async function su<T>(fn: (sql: ReturnType<typeof superuserSql>) => Promise<T>): Promise<T> {
  const sql = superuserSql();
  try { return await fn(sql); } finally { await sql.end({ timeout: 5 }); }
}

/**
 * A node with timestamps of our choosing.
 *
 * INSERTED, not updated, and that is forced rather than preferred:
 * `asset_node_touch` overwrites `updated_at` on every UPDATE, so there is no
 * way to backdate an existing row through the application's own path. Finding
 * that out is what uncovered the defect this file is mostly about.
 */
async function node(options: {
  name: string;
  createdDaysAgo: number;
  /** Omit for "never revised": updated_at equals created_at. */
  revisedDaysAgo?: number;
  organizationId?: string;
  archived?: boolean;
}): Promise<string> {
  const created = `now() - make_interval(days => ${options.createdDaysAgo})`;
  const updated = options.revisedDaysAgo === undefined
    ? created
    : `now() - make_interval(days => ${options.revisedDaysAgo})`;
  return su(async (sql) => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO asset_node (
        tenant_id, organization_id, node_type, name, created_at, updated_at, archived_at
      )
      VALUES (
        ${IDS.tenant1}::uuid, ${options.organizationId ?? IDS.orgAcme}::uuid,
        'device', ${options.name},
        ${sql.unsafe(created)}, ${sql.unsafe(updated)},
        ${options.archived ? sql.unsafe('now()') : null}
      )
      RETURNING id
    `;
    return row!.id;
  });
}

/** Everything this file inserted, so each test starts from the fixture. */
async function clearAdded(): Promise<void> {
  await su(async (sql) => {
    await sql`DELETE FROM asset_node WHERE name LIKE 'zz %'`;
    await sql`DELETE FROM documentation_health_setting`;
    await sql`DELETE FROM node_view_stat`;
  });
}

const healthOf = (who: typeof ADMIN, organizationId: string = IDS.orgAcme) =>
  withTenant(who, (tx) => readDocumentationHealth(tx, organizationId));

beforeAll(async () => {
  resetDatabase();
  connectPools();
  useSessionResolver(async () => currentUser);
}, 120_000);

afterEach(clearAdded);
afterAll(async () => { await disconnectPools(); });

// ---------------------------------------------------------------------------

describe('a view is not a revision', () => {
  it('does not touch updated_at, so a stale record stays stale', async () => {
    /*
     * THE REGRESSION TEST. Written against the behaviour that shipped broken
     * once: `asset_node_touch` fires on any UPDATE of the row, so putting
     * last_viewed_at on asset_node made every page view a revision.
     */
    const id = await node({ name: 'zz ancient', createdDaysAgo: 400 });

    const before = await healthOf(ADMIN);
    expect(before!.neverRevised, 'a 400-day-old untouched node is never-revised')
      .toBeGreaterThanOrEqual(1);

    // Open it, the way a page does.
    await withTenant(ADMIN, (tx) => tx`SELECT helm.record_view(NULL, ${id}::uuid)`);

    const [row] = await withTenant(ADMIN, (tx) => tx<{ same: boolean; age: number }[]>`
      SELECT updated_at = created_at AS same,
             round(extract(epoch FROM now() - updated_at) / 86400) AS age
      FROM asset_node WHERE id = ${id}::uuid
    `);
    expect(row!.same, 'opening the record rewrote updated_at').toBe(true);
    expect(Number(row!.age), 'the record became young by being read').toBeGreaterThan(390);

    const after = await healthOf(ADMIN);
    expect(after!.neverRevised, 'reading it moved it out of the never-revised segment')
      .toBe(before!.neverRevised);
    expect(after!.current, 'reading it made it count as current').toBe(before!.current);
  });

  it('records the view itself, with a count that increments', async () => {
    const id = await node({ name: 'zz read twice', createdDaysAgo: 10 });

    await withTenant(ADMIN, (tx) => tx`SELECT helm.record_view(NULL, ${id}::uuid)`);
    await withTenant(ADMIN, (tx) => tx`SELECT helm.record_view(NULL, ${id}::uuid)`);

    const [stat] = await withTenant(ADMIN, (tx) => tx<{ view_count: string }[]>`
      SELECT view_count FROM node_view_stat WHERE node_id = ${id}::uuid
    `);
    expect(Number(stat!.view_count)).toBe(2);
  });

  it('can be recorded by a client read-only user, who may not write the table', async () => {
    /*
     * The carve-out, from both ends. A viewer holds no asset:write and has no
     * INSERT privilege on node_view_stat at all — but opening a record they can
     * see has to work, or the measure is only ever about what administrators
     * read.
     */
    const id = await node({ name: 'zz viewer reads', createdDaysAgo: 5 });

    await expect(
      withTenant(VIEWER, (tx) => tx`
        INSERT INTO node_view_stat (node_id, tenant_id)
        VALUES (${id}::uuid, ${IDS.tenant1}::uuid)
      `),
    ).rejects.toThrow();

    await withTenant(VIEWER, (tx) => tx`SELECT helm.record_view(NULL, ${id}::uuid)`);

    const [stat] = await withTenant(ADMIN, (tx) => tx<{ node_id: string }[]>`
      SELECT node_id FROM node_view_stat WHERE node_id = ${id}::uuid
    `);
    expect(stat, 'the definer function should have recorded it').toBeTruthy();
  });

  it('records no actor, so it cannot say who read what', async () => {
    // Decisions 5 and 7 keep read activity unattributable. This is the
    // structural half: there is no column to put a name in.
    const columns = await withTenant(ADMIN, (tx) => tx<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'node_view_stat'
    `);
    const names = columns.map((c) => c.column_name);
    expect(names).toEqual(
      expect.arrayContaining(['node_id', 'tenant_id', 'last_viewed_at', 'view_count']),
    );
    for (const forbidden of ['user_id', 'actor_id', 'viewed_by', 'last_viewed_by']) {
      expect(names, `node_view_stat grew ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('refuses to record a view against another tenant"s node', async () => {
    /*
     * touch_node_view is SECURITY DEFINER, so this asks the only question that
     * matters about it: can the definer rights be aimed somewhere else? The
     * tenant comes from the session and the node id from the caller, so a
     * caller handing over a foreign id must write nothing.
     *
     * CALLED DIRECTLY, not through record_view(), and the first version of this
     * test went through record_view and passed for the wrong reason:
     * user_recent_view's own foreign key rejects a foreign node id first, so
     * the definer function was never reached and its scoping was never tested.
     * That outer check is welcome and is asserted separately below.
     */
    const [theirs] = await withTenant(OTHER_TENANT, (tx) => tx<{ id: string }[]>`
      SELECT id FROM asset_node LIMIT 1
    `);
    expect(theirs, 'tenant 2 should have a node in the fixture').toBeTruthy();

    await withTenant(ADMIN, (tx) => tx`SELECT helm.touch_node_view(${theirs!.id}::uuid)`);

    const rows = await su((sql) => sql<{ node_id: string }[]>`
      SELECT node_id FROM node_view_stat WHERE node_id = ${theirs!.id}::uuid
    `);
    expect(rows, 'a definer function wrote outside its session tenant').toEqual([]);
  });

  it('...and record_view refuses a foreign node id before reaching it', async () => {
    // The outer layer, asserted on purpose rather than relied on silently: the
    // composite foreign key on user_recent_view rejects a node id from another
    // tenant, so the recents list cannot be made to name one either.
    const [theirs] = await withTenant(OTHER_TENANT, (tx) => tx<{ id: string }[]>`
      SELECT id FROM asset_node LIMIT 1
    `);
    await expect(
      withTenant(ADMIN, (tx) => tx`SELECT helm.record_view(NULL, ${theirs!.id}::uuid)`),
    ).rejects.toThrow(/user_recent_view/);
  });
});

describe('the three segments', () => {
  it('partition the total, with all three non-empty', async () => {
    /*
     * Contrived so none of the three is zero: `0 + 0 + n = n` would hold for a
     * view whose predicates overlapped or left a gap, so an identity over a
     * single populated segment proves nothing. The first attempt at this test
     * passed while the backdating silently did nothing, which is how the
     * trigger defect surfaced.
     */
    await node({ name: 'zz fresh', createdDaysAgo: 400, revisedDaysAgo: 2 });
    await node({ name: 'zz lapsed', createdDaysAgo: 400, revisedDaysAgo: 300 });
    await node({ name: 'zz untouched', createdDaysAgo: 400 });

    const health = await healthOf(ADMIN);
    expect(health).toBeTruthy();
    expect(health!.current, 'the fresh one, plus the fixture"s own').toBeGreaterThanOrEqual(1);
    expect(health!.stale).toBeGreaterThanOrEqual(1);
    expect(health!.neverRevised).toBeGreaterThanOrEqual(1);
    expect(segmentsAccountForAll(health!), 'the segments left a gap or overlapped').toBe(true);
  });

  it('excludes archived records, which are not documentation that needs revising', async () => {
    const before = await healthOf(ADMIN);
    await node({ name: 'zz archived ancient', createdDaysAgo: 500, archived: true });
    const after = await healthOf(ADMIN);

    expect(after!.total, 'an archived node reached the denominator').toBe(before!.total);
    expect(after!.neverRevised).toBe(before!.neverRevised);
  });

  it('counts a client with nothing documented as a row of zeroes, not as absent', async () => {
    // Globex has no nodes in the fixture's ACME-heavy world; whichever client
    // is empty, an empty one must still produce a row — a health card that
    // disappears for quiet clients makes an MSP look busier than it is.
    const health = await healthOf(ADMIN, IDS.orgGlobex);
    expect(health, 'an empty client should still have a health row').toBeTruthy();
    expect(segmentsAccountForAll(health!)).toBe(true);
  });

  it('moves when the tenant moves the window', async () => {
    await node({ name: 'zz ninety days', createdDaysAgo: 400, revisedDaysAgo: 90 });

    const atDefault = await healthOf(ADMIN);
    // 90 days ago is inside the shipped 180-day window.
    expect(atDefault!.current).toBeGreaterThanOrEqual(1);
    const currentAtDefault = atDefault!.current;

    await su((sql) => sql`
      INSERT INTO documentation_health_setting (tenant_id, stale_after_days, unviewed_after_days)
      VALUES (${IDS.tenant1}::uuid, 30, 30)
    `);

    const atThirty = await healthOf(ADMIN);
    expect(atThirty!.staleAfterDays, 'the view ignored the tenant"s setting').toBe(30);
    expect(atThirty!.current, 'tightening the window should have moved a record out of current')
      .toBeLessThan(currentAtDefault);
    expect(segmentsAccountForAll(atThirty!)).toBe(true);
  });
});

describe('not opened recently', () => {
  it('counts a node nobody has ever opened', async () => {
    const before = await healthOf(ADMIN);
    await node({ name: 'zz unread', createdDaysAgo: 10, revisedDaysAgo: 1 });
    const after = await healthOf(ADMIN);

    expect(after!.unviewed, 'a node with no view record should count as unviewed')
      .toBe(before!.unviewed + 1);
  });

  it('stops counting it once somebody opens it', async () => {
    const id = await node({ name: 'zz about to be read', createdDaysAgo: 10, revisedDaysAgo: 1 });
    const before = await healthOf(ADMIN);

    await withTenant(ADMIN, (tx) => tx`SELECT helm.record_view(NULL, ${id}::uuid)`);

    const after = await healthOf(ADMIN);
    expect(after!.unviewed).toBe(before!.unviewed - 1);
    expect(after!.lastViewedAt, 'the client"s most recent view should be reported').not.toBeNull();
  });

  it('counts it again once the unviewed window has passed', async () => {
    const id = await node({ name: 'zz read long ago', createdDaysAgo: 10, revisedDaysAgo: 1 });
    await withTenant(ADMIN, (tx) => tx`SELECT helm.record_view(NULL, ${id}::uuid)`);
    // Backdate the view itself. node_view_stat has no touch trigger, which is
    // part of why it is a separate table.
    await su((sql) => sql`
      UPDATE node_view_stat SET last_viewed_at = now() - interval '200 days'
      WHERE node_id = ${id}::uuid
    `);

    const health = await healthOf(ADMIN);
    const listed = await withTenant(ADMIN, (tx) =>
      listHealthSegment(tx, IDS.orgAcme, 'unviewed'));
    expect(listed.map((r) => r.id)).toContain(id);
    expect(health!.unviewed).toBe(listed.length);
  });
});

describe('each segment"s list agrees with its count', () => {
  it('for all four segments at once', async () => {
    /*
     * The counts are FILTER clauses in a view; the lists are a CASE in a
     * separate query. That duplication is deliberate — a per-node view would
     * turn every client page into a scan of the estate — so the two are checked
     * against each other rather than assumed to agree.
     */
    await node({ name: 'zz a fresh', createdDaysAgo: 400, revisedDaysAgo: 2 });
    await node({ name: 'zz b lapsed', createdDaysAgo: 400, revisedDaysAgo: 300 });
    await node({ name: 'zz c untouched', createdDaysAgo: 400 });
    const read = await node({ name: 'zz d read', createdDaysAgo: 400, revisedDaysAgo: 2 });
    await withTenant(ADMIN, (tx) => tx`SELECT helm.record_view(NULL, ${read}::uuid)`);

    /*
     * AN ARCHIVED NODE IN EVERY SEGMENT'S RANGE, and it is here because of a
     * sabotage that survived. Removing `archived_at IS NULL` from
     * listHealthSegment broke no test: the view excludes archived rows, the
     * list did not, and the counts-versus-list comparison below never noticed
     * because the fixture has nothing archived. With these present, a list that
     * forgets the filter returns more rows than the count and this fails.
     */
    await node({ name: 'zz e archived fresh', createdDaysAgo: 400, revisedDaysAgo: 2,
                 archived: true });
    await node({ name: 'zz f archived lapsed', createdDaysAgo: 400, revisedDaysAgo: 300,
                 archived: true });
    await node({ name: 'zz g archived untouched', createdDaysAgo: 400, archived: true });

    const health = await healthOf(ADMIN);
    const counts = {
      current: health!.current,
      stale: health!.stale,
      never_revised: health!.neverRevised,
      unviewed: health!.unviewed,
    } as const;

    for (const segment of ['current', 'stale', 'never_revised', 'unviewed'] as const) {
      const listed = await withTenant(ADMIN, (tx) =>
        listHealthSegment(tx, IDS.orgAcme, segment));
      expect(listed.length, `the ${segment} list and its count disagree`)
        .toBe(counts[segment]);
    }
  });

  it('lists the oldest first, because that is the one to look at', async () => {
    await node({ name: 'zz older', createdDaysAgo: 500 });
    await node({ name: 'zz newer', createdDaysAgo: 300 });

    const listed = await withTenant(ADMIN, (tx) =>
      listHealthSegment(tx, IDS.orgAcme, 'never_revised'));
    const ours = listed.filter((r) => r.name.startsWith('zz '));
    expect(ours.map((r) => r.name)).toEqual(['zz older', 'zz newer']);
  });
});

describe('who can see what', () => {
  it('shows a client user their own organisation and nobody else"s', async () => {
    const mine = await healthOf(CLIENT, IDS.orgAcme);
    expect(mine, 'the client"s own organisation should be visible').toBeTruthy();

    const theirs = await healthOf(CLIENT, IDS.orgGlobex);
    expect(theirs, 'a client user read another client"s health').toBeNull();
  });

  it('shows another tenant nothing at all', async () => {
    const rows = await withTenant(OTHER_TENANT, (tx) => tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM v_documentation_health
      WHERE organization_id = ${IDS.orgAcme}::uuid
    `);
    expect(rows[0]!.n).toBe(0);
  });

  it('counts only the nodes the reader can see', async () => {
    /*
     * The denominator is RLS-scoped, which matters more than it sounds: a
     * client user whose health said "34 records" while they could open 11 would
     * be reading a number about somebody else's documentation.
     */
    const asAdmin = await healthOf(ADMIN, IDS.orgAcme);
    const asClient = await healthOf(CLIENT, IDS.orgAcme);
    expect(asClient!.total).toBeLessThanOrEqual(asAdmin!.total);

    // And internal-only nodes are the reason it can differ. Added as one, so
    // this is not asserting an accidental equality.
    await su((sql) => sql`
      INSERT INTO asset_node (tenant_id, organization_id, node_type, name, is_internal_only)
      VALUES (${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, 'device', 'zz internal', true)
    `);
    const adminAfter = await healthOf(ADMIN, IDS.orgAcme);
    const clientAfter = await healthOf(CLIENT, IDS.orgAcme);
    expect(adminAfter!.total).toBe(asAdmin!.total + 1);
    expect(clientAfter!.total, 'an internal-only node reached a client"s count')
      .toBe(asClient!.total);
  });
});

describe('the window setting', () => {
  it('agrees with the database about the default', async () => {
    // Three copies of 180 exist: helm.default_health_days(), the column
    // defaults that call it, and DEFAULT_HEALTH_DAYS for a form that needs the
    // number before asking. This is what stops them drifting.
    const [row] = await withTenant(ADMIN, (tx) => tx<{ days: number }[]>`
      SELECT helm.default_health_days() AS days
    `);
    expect(Number(row!.days)).toBe(DEFAULT_HEALTH_DAYS);
  });

  it('agrees with the database about the bounds, at both ends', async () => {
    for (const days of [HEALTH_DAYS_MIN, HEALTH_DAYS_MAX]) {
      await su((sql) => sql`DELETE FROM documentation_health_setting`);
      const accepted = await su(async (sql) => {
        try {
          await sql`
            INSERT INTO documentation_health_setting (tenant_id, stale_after_days)
            VALUES (${IDS.tenant1}::uuid, ${days})
          `;
          return true;
        } catch { return false; }
      });
      expect(accepted, `the route accepts ${days} days, so the CHECK must too`).toBe(true);
    }

    for (const days of [HEALTH_DAYS_MIN - 1, HEALTH_DAYS_MAX + 1]) {
      await su((sql) => sql`DELETE FROM documentation_health_setting`);
      const accepted = await su(async (sql) => {
        try {
          await sql`
            INSERT INTO documentation_health_setting (tenant_id, stale_after_days)
            VALUES (${IDS.tenant1}::uuid, ${days})
          `;
          return true;
        } catch { return false; }
      });
      expect(accepted, `${days} days is refused by the route; the CHECK should refuse it too`)
        .toBe(false);
    }
  });

  it('reports the shipped defaults, and says nobody has set them', async () => {
    const setting = await withTenant(ADMIN, (tx) => readHealthSetting(tx));
    expect(setting.staleAfterDays).toBe(DEFAULT_HEALTH_DAYS);
    expect(setting.configured, 'an absent row is not a configured one').toBe(false);
  });

  it('can be read by anybody, because a count needs its units', async () => {
    for (const who of [USERS.admin, USERS.tech, USERS.viewer]) {
      currentUser = who;
      const { status, payload } = await read(await getWindow(request()));
      expect(status, `${who.email} could not read the window`).toBe(200);
      expect(payload.staleAfterDays).toBe(DEFAULT_HEALTH_DAYS);
    }
  });

  it('cannot be changed by a technician', async () => {
    currentUser = USERS.tech;
    const { status, payload } = await read(
      await putWindow(request('PUT', { staleAfterDays: 30, unviewedAfterDays: 30 })),
    );
    expect(status).toBe(403);
    const error = (payload.error ?? {}) as { message?: string };
    expect(
      error.message,
      "refused, but not by the route's tenant:write gate — the policy caught it first",
    ).toBe('missing permission: tenant:write');

    const rows = await su((sql) => sql`SELECT 1 FROM documentation_health_setting`);
    expect(rows, 'nothing should have been written').toEqual([]);
  });

  it('can be changed by an administrator, and the ring follows', async () => {
    await node({ name: 'zz ninety', createdDaysAgo: 400, revisedDaysAgo: 90 });
    const before = await healthOf(ADMIN);

    currentUser = USERS.admin;
    const { status, raw } = await read(
      await putWindow(request('PUT', { staleAfterDays: 30, unviewedAfterDays: 45 })),
    );
    expect(status, raw).toBe(200);

    const after = await healthOf(ADMIN);
    expect(after!.staleAfterDays).toBe(30);
    expect(after!.unviewedAfterDays).toBe(45);
    expect(after!.current, 'the ring did not follow the window').toBeLessThan(before!.current);
  });

  it('refuses a window outside the bounds', async () => {
    currentUser = USERS.admin;
    for (const payload of [
      { staleAfterDays: 0, unviewedAfterDays: 30 },
      { staleAfterDays: 30, unviewedAfterDays: HEALTH_DAYS_MAX + 1 },
      { staleAfterDays: 1.5, unviewedAfterDays: 30 },
      { staleAfterDays: 30 },
    ]) {
      const { status } = await read(await putWindow(request('PUT', payload)));
      expect(status, `${JSON.stringify(payload)} should not be accepted`).toBe(400);
    }
    const rows = await su((sql) => sql`SELECT 1 FROM documentation_health_setting`);
    expect(rows).toEqual([]);
  });

  it('is one row per tenant however many times it is saved', async () => {
    currentUser = USERS.admin;
    await read(await putWindow(request('PUT', { staleAfterDays: 30, unviewedAfterDays: 30 })));
    await read(await putWindow(request('PUT', { staleAfterDays: 60, unviewedAfterDays: 60 })));

    const rows = await su((sql) => sql<{ stale_after_days: number }[]>`
      SELECT stale_after_days FROM documentation_health_setting
    `);
    expect(rows.length).toBe(1);
    expect(Number(rows[0]!.stale_after_days)).toBe(60);
  });

  it('does not let one tenant"s window change another"s ring', async () => {
    await su((sql) => sql`
      INSERT INTO documentation_health_setting (tenant_id, stale_after_days, unviewed_after_days)
      VALUES (${IDS.tenant1}::uuid, 7, 7)
    `);
    const theirs = await withTenant(OTHER_TENANT, (tx) =>
      readDocumentationHealth(tx, IDS.orgContoso));
    expect(theirs, 'tenant 2 should see its own client').toBeTruthy();
    expect(theirs!.staleAfterDays, 'tenant 1"s window reached tenant 2"s ring')
      .toBe(DEFAULT_HEALTH_DAYS);
  });
});

describe('the no-score rule', () => {
  it('returns no percentage or score column, because decision 20 says counts', async () => {
    // Guard 7 in 0680 asserts this against the catalogue at migration time;
    // this asserts it against what the query layer hands the page, which is
    // where a helpful addition would be made.
    const health = await healthOf(ADMIN);
    const keys = Object.keys(health!);
    for (const key of keys) {
      expect(key.toLowerCase(), `${key} looks like a score`).not.toMatch(/score|percent|ratio/);
    }
  });
});
