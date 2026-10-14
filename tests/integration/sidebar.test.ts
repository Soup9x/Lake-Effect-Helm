/**
 * Arranging the organization drawer.
 *
 * WHAT WAS MISSING. The drawer's sixteen categories were split into a primary
 * eight and a "More" disclosure by a hardcoded `secondary` flag in
 * src/lib/nav/org-categories.ts — a reasonable guess at what a technician
 * reaches often, and the same guess for an MSP whose work is networks as for
 * one whose work is licence renewals. There was no table, no page and no way to
 * change it.
 *
 * FOUR THINGS ASSERTED HERE BEYOND THE HAPPY PATH:
 *
 *   1. THE TS AND SQL SLUG LISTS AGREE. helm.sidebar_layout_valid() pins the
 *      legal slugs and ORG_CATEGORIES is the interface's copy. Adding a
 *      category to the registry without a migration produces a layout the CHECK
 *      refuses — a 500 on a save nobody can explain. This is the test that
 *      turns it into a failure here instead.
 *   2. A MISSING ROW AND AN EMPTY ARRAY ARE DIFFERENT ANSWERS. Somebody who
 *      emptied their drawer has expressed a preference; if `[]` fell through to
 *      the default they would watch the control appear to do nothing.
 *   3. THE TENANT DEFAULT IS READ-OPEN AND WRITE-GATED, both halves. A gated
 *      read means a client-side user silently never sees the administrator's
 *      default; an ungated write means anybody sets everybody's drawer.
 *   4. A LAYOUT IS PRIVATE. user_sidebar carries personal RLS, because one
 *      technician's arrangement says something about what they spend their day
 *      on.
 */
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { withTenant } from '../../src/lib/db/client';
import {
  DEFAULT_SIDEBAR, SIDEBAR_MAX, SIDEBAR_SLUGS,
} from '../../src/lib/nav/sidebar-layout';
import {
  actor, connectPools, disconnectPools, IDS, resetDatabase, superuserSql,
} from './harness';
import {
  DELETE as resetMine, GET as getMine, PUT as putMine,
} from '../../src/app/api/workspace/sidebar/route';
import {
  GET as getDefault, PUT as putDefault,
} from '../../src/app/api/tenant/sidebar-default/route';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

let currentUser: SessionUser | null = null;
const admin = actor(IDS.tenant1, IDS.admin1);

const USERS = {
  admin: { id: IDS.admin1, email: 'admin@northwind.test' },
  tech: { id: IDS.tech1, email: 'tech@northwind.test' },
  clientAdmin: { id: IDS.acmeAdmin, email: 'admin@acme.test' },
  viewer: { id: IDS.acmeViewer, email: 'viewer@acme.test' },
} as const;

const request = (url: string, method = 'GET', payload?: unknown) =>
  new NextRequest(
    new Request(`http://helm.test${url}`, {
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

const slugsOf = async (response: Response): Promise<string[]> => {
  const { status, payload, raw } = await read(response);
  expect(status, raw).toBe(200);
  return payload.categories as string[];
};

const save = (categories: string[]) =>
  putMine(request('/api/workspace/sidebar', 'PUT', { categories }));
const saveDefault = (categories: string[]) =>
  putDefault(request('/api/tenant/sidebar-default', 'PUT', { categories }));

/** Wipe both tables between tests, as the superuser so no policy is in the way. */
async function clearLayouts(): Promise<void> {
  const sql = superuserSql();
  try {
    await sql`DELETE FROM user_sidebar`;
    await sql`DELETE FROM tenant_sidebar_default`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

beforeAll(async () => {
  resetDatabase();
  connectPools();
  useSessionResolver(async () => currentUser);
}, 120_000);

afterEach(async () => {
  currentUser = null;
  await clearLayouts();
});
afterAll(async () => { await disconnectPools(); });

// ---------------------------------------------------------------------------

describe('the category catalogue', () => {
  it('agrees with the slugs the database will accept', async () => {
    // Two copies of one list — helm.sidebar_layout_valid() and ORG_CATEGORIES.
    const sql = superuserSql();
    try {
      for (const slug of SIDEBAR_SLUGS) {
        // sql.json(), the way setSidebarLayout() sends it. JSON.stringify()
        // would arrive as a jsonb STRING rather than an array and this test
        // would fail for a reason that has nothing to do with the slug.
        const [row] = await sql<{ ok: boolean }[]>`
          SELECT helm.sidebar_layout_valid(${sql.json([slug])}::jsonb) AS ok
        `;
        expect(row!.ok, `the database refuses the category slug "${slug}"`).toBe(true);
      }

      // ...and the converse, so a validator that accepts everything fails here
      // rather than passing the loop above and storing anything.
      const [unknown] = await sql<{ ok: boolean }[]>`
        SELECT helm.sidebar_layout_valid('["not_a_category"]'::jsonb) AS ok
      `;
      expect(unknown!.ok).toBe(false);

      // And the whole registry at once, because the ceiling is the other way
      // this can silently stop working as categories are added.
      const [all] = await sql<{ ok: boolean }[]>`
        SELECT helm.sidebar_layout_valid(${sql.json([...SIDEBAR_SLUGS])}::jsonb) AS ok
      `;
      expect(all!.ok, 'the database refuses a layout naming every category').toBe(true);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  /**
   * THE CEILING IS NOT INDEPENDENTLY OBSERVABLE, and saying so is the honest
   * version of a test that looked like it checked one.
   *
   * With sixteen distinct slugs and the duplicate rule, the longest VALID array
   * is sixteen — so nothing otherwise-legal can reach a cap of twenty. The
   * first version of this test built twenty-one fake slugs and watched the
   * validator refuse them, which it does because they are unknown, not because
   * of the length: raising the cap to a hundred left that test passing. The
   * migration's own guard has the same blind spot for the same reason (its
   * over-long array also contains duplicates).
   *
   * So what is asserted here is the property that MATTERS and can be seen: the
   * cap is not below the registry, i.e. somebody who wants every category can
   * store that. The cap itself is defence in depth against a future registry
   * that outgrows it — and the thing that notices THAT is the unit assertion
   * that SIDEBAR_SLUGS fits under SIDEBAR_MAX, which fails loudly on the
   * seventeenth category rather than when somebody's save stops working.
   */
  it('does not cap below the registry, so every category at once is storable', async () => {
    expect(SIDEBAR_SLUGS.length).toBeLessThanOrEqual(SIDEBAR_MAX);
    const sql = superuserSql();
    try {
      const [full] = await sql<{ ok: boolean }[]>`
        SELECT helm.sidebar_layout_valid(${sql.json([...SIDEBAR_SLUGS])}::jsonb) AS ok
      `;
      expect(full!.ok).toBe(true);

      // An over-long array IS refused, whichever rule fires first. Worth
      // pinning as a floor; not worth pretending it isolates the cap.
      const overflowing = Array.from({ length: SIDEBAR_MAX + 1 }, (_, i) => `c${i}`);
      const [over] = await sql<{ ok: boolean }[]>`
        SELECT helm.sidebar_layout_valid(${sql.json(overflowing)}::jsonb) AS ok
      `;
      expect(over!.ok).toBe(false);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

describe('my own layout', () => {
  it('starts as the shipped default', async () => {
    currentUser = USERS.admin;
    expect(await slugsOf(await getMine(request('/api/workspace/sidebar'))))
      .toEqual([...DEFAULT_SIDEBAR]);
  });

  it('saves an arrangement and reads it back in that order', async () => {
    currentUser = USERS.admin;
    const chosen = ['sops', 'passwords', 'documents'];
    expect(await slugsOf(await save(chosen))).toEqual(chosen);
    expect(await slugsOf(await getMine(request('/api/workspace/sidebar')))).toEqual(chosen);
  });

  it('keeps an empty layout empty rather than handing back the default', async () => {
    // The distinction the whole resolution chain turns on.
    currentUser = USERS.admin;
    await slugsOf(await save([]));
    expect(await slugsOf(await getMine(request('/api/workspace/sidebar')))).toEqual([]);
  });

  it('refuses a slug the registry does not know, and says where', async () => {
    currentUser = USERS.admin;
    const { status, payload, raw } = await read(await save(['passwords', 'invented']));
    expect(status).toBe(400);
    // The POSITION, not the offending value: Zod's enum message names the path
    // and the legal set, which is what makes a rejection actionable when the
    // sender is a control holding a list. Asserted as it actually behaves —
    // the first version of this test expected the value echoed back, and the
    // route's own comment claimed the same thing. Both were wrong.
    const issues = (payload.error as { details?: { issues?: { path: string }[] } })
      .details?.issues ?? [];
    expect(issues.map((i) => i.path), raw).toContain('categories.1');
    expect(raw).toContain('passwords');
  });

  it('refuses the same category twice', async () => {
    currentUser = USERS.admin;
    expect((await read(await save(['passwords', 'passwords']))).status).toBe(400);
  });

  it('refuses a layout longer than the ceiling', async () => {
    currentUser = USERS.admin;
    const tooMany = [...SIDEBAR_SLUGS, ...SIDEBAR_SLUGS].slice(0, SIDEBAR_MAX + 1);
    expect((await read(await save(tooMany))).status).toBe(400);
  });

  it('is nobody else"s business', async () => {
    // Personal RLS. One technician's arrangement says something about what they
    // spend their day on.
    currentUser = USERS.admin;
    await slugsOf(await save(['sops']));

    currentUser = USERS.tech;
    expect(await slugsOf(await getMine(request('/api/workspace/sidebar'))))
      .toEqual([...DEFAULT_SIDEBAR]);

    // ...and the admin's row is still there, i.e. the second actor did not
    // overwrite it by writing to a row the policy let through.
    await slugsOf(await putMine(request('/api/workspace/sidebar', 'PUT', {
      categories: ['contacts'],
    })));
    currentUser = USERS.admin;
    expect(await slugsOf(await getMine(request('/api/workspace/sidebar')))).toEqual(['sops']);
  });

  it('can be reset, so the first save is not permanent', async () => {
    currentUser = USERS.admin;
    await slugsOf(await saveDefault(['locations', 'networks']));
    await slugsOf(await save(['sops']));

    const reset = await read(await resetMine(request('/api/workspace/sidebar', 'DELETE')));
    expect(reset.status, reset.raw).toBe(200);
    // The tenant default, not the shipped one: resetting means "follow whatever
    // the administrator sets", which is a different state from a copy.
    expect(reset.payload.categories).toEqual(['locations', 'networks']);

    const after = await withTenant(admin, (tx) =>
      tx<{ n: number }[]>`SELECT count(*)::int AS n FROM user_sidebar`);
    expect(after[0]!.n, 'reset should remove the row, not store a copy').toBe(0);
  });

  it('is available to a client-side role, which has its own drawer too', async () => {
    currentUser = USERS.viewer;
    expect(await slugsOf(await save(['passwords', 'documents'])))
      .toEqual(['passwords', 'documents']);
  });
});

describe('the tenant default', () => {
  it('is what a user with no row of their own gets', async () => {
    currentUser = USERS.admin;
    await slugsOf(await saveDefault(['networks', 'locations', 'contacts']));

    currentUser = USERS.tech;
    expect(await slugsOf(await getMine(request('/api/workspace/sidebar'))))
      .toEqual(['networks', 'locations', 'contacts']);
  });

  it('does not disturb somebody who has already arranged theirs', async () => {
    currentUser = USERS.tech;
    await slugsOf(await save(['sops']));

    currentUser = USERS.admin;
    await slugsOf(await saveDefault(['networks']));

    currentUser = USERS.tech;
    expect(await slugsOf(await getMine(request('/api/workspace/sidebar')))).toEqual(['sops']);
  });

  it('reaches a client-side role, whose drawer renders from it', async () => {
    /*
     * The reason tenant_sidebar_default does NOT use the tenant-wide read
     * predicate. apply_tenant_rls(..., false) would gate SELECT on
     * is_tenant_wide(), so a client administrator would silently get the
     * shipped default and an administrator would have set a default that
     * quietly did not apply to half their users.
     */
    currentUser = USERS.admin;
    await slugsOf(await saveDefault(['documents', 'contacts']));

    currentUser = USERS.clientAdmin;
    expect(await slugsOf(await getMine(request('/api/workspace/sidebar'))))
      .toEqual(['documents', 'contacts']);
    currentUser = USERS.viewer;
    expect(await slugsOf(await getDefault(request('/api/tenant/sidebar-default'))))
      .toEqual(['documents', 'contacts']);
  });

  it('is refused to a tenant-wide actor without tenant:write, by the ROUTE', async () => {
    /*
     * tier1 is tenant-wide and holds plenty; tenant:write is super_admin only
     * (the seed excludes tier3 from it explicitly), so this proves the gate is
     * the permission and not merely "can see the whole tenant".
     *
     * AND IT ASSERTS THE MESSAGE, WHICH IS NOT FUSSINESS. The status alone
     * cannot tell the route's gate from the database's: deleting
     * `permissions: ['tenant:write']` from the route still answers 403,
     * because the RLS policy refuses the INSERT and a policy violation is
     * SQLSTATE 42501, which errorResponse() maps to forbidden. That is
     * defence in depth working — and it is also how this test passed with the
     * route's gate removed, until it looked at the body.
     *
     * The bodies differ, and the difference matters to somebody who may be a
     * co-managed customer:
     *
     *   with the gate     "missing permission: tenant:write"
     *   without it        "new row violates row-level security policy for
     *                      table \"tenant_sidebar_default\""
     *
     * The second is a raw Postgres message naming an internal table, reaching
     * a client through the general insufficient_privilege branch in
     * src/lib/api/handler.ts — which strips a leading "helm: " and passes the
     * rest through, on the assumption that such a message came from one of
     * Helm's own RAISE EXCEPTIONs. A policy violation is not one of those.
     * errors.ts opens by saying none of a Postgres message's contents should
     * reach such a client, so the route's gate is what keeps that true here.
     */
    currentUser = USERS.tech;
    const refused = await read(await saveDefault(['sops']));
    expect(refused.status).toBe(403);
    const message = (refused.payload.error as { message?: string }).message ?? '';
    expect(message, refused.raw).toContain('tenant:write');
    expect(message, 'a Postgres message naming an internal table reached the client')
      .not.toContain('tenant_sidebar_default');
    expect(message.toLowerCase()).not.toContain('row-level security');

    currentUser = USERS.admin;
    expect(await slugsOf(await getDefault(request('/api/tenant/sidebar-default'))))
      .toEqual([...DEFAULT_SIDEBAR]);
  });

  it('is refused to a client administrator', async () => {
    currentUser = USERS.clientAdmin;
    expect((await read(await saveDefault(['sops']))).status).toBe(403);
  });

  it('is refused by the database too, not only by the route', async () => {
    /*
     * The route's permission check and the RLS policy are two expressions of
     * one rule. Going round the route proves the second one exists: without
     * it, a future caller, a script or a psql prompt could set everybody's
     * drawer.
     */
    await expect(
      withTenant(actor(IDS.tenant1, IDS.tech1), (tx) => tx`
        INSERT INTO tenant_sidebar_default (tenant_id, categories)
        VALUES (helm.current_tenant_id(), ${tx.json(['sops'])}::jsonb)
      `),
    ).rejects.toThrow();
  });

  it('does not leak across tenants', async () => {
    currentUser = USERS.admin;
    await slugsOf(await saveDefault(['sops']));

    currentUser = { id: IDS.admin2, email: 'admin@rival.test' };
    expect(await slugsOf(await getDefault(request('/api/tenant/sidebar-default'))))
      .toEqual([...DEFAULT_SIDEBAR]);
  });
});

describe('the drawer itself', () => {
  const renderDrawer = async (): Promise<unknown> =>
    (await import('../../src/app/(app)/organizations/[organizationId]/layout')).default({
      children: null,
      params: Promise.resolve({ organizationId: IDS.orgAcme }),
    });

  /** The props a named component was handed, found anywhere in the tree. */
  function propsOf(node: unknown, name: string): Record<string, unknown> | null {
    const seen = new WeakSet<object>();
    const walk = (value: unknown): Record<string, unknown> | null => {
      if (value === null || typeof value !== 'object') return null;
      if (seen.has(value)) return null;
      seen.add(value);
      const element = value as { type?: unknown; props?: Record<string, unknown> };
      if (typeof element.type === 'function' && element.type.name === name && element.props) {
        return element.props;
      }
      for (const child of Array.isArray(value) ? value : Object.values(value)) {
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    return walk(node);
  }

  it('is handed the saved layout, not the registry default', async () => {
    currentUser = USERS.admin;
    await slugsOf(await save(['sops', 'passwords']));

    const drawer = propsOf(await renderDrawer(), 'Sidebar');
    expect(drawer, 'the drawer should be on the page').toBeTruthy();
    expect(drawer!.layout).toEqual(['sops', 'passwords']);
    // ...and told that this person has one, so the reset control is offered.
    expect(drawer!.customised).toBe(true);
  });

  it('is told when somebody has NOT customised, so reset is not offered', async () => {
    // `customised` is a different question from the layout: a layout that
    // happens to equal the default is not the same as not having one.
    currentUser = USERS.admin;
    await slugsOf(await save([...DEFAULT_SIDEBAR]));
    expect(propsOf(await renderDrawer(), 'Sidebar')!.customised).toBe(true);

    await resetMine(request('/api/workspace/sidebar', 'DELETE'));
    const after = propsOf(await renderDrawer(), 'Sidebar')!;
    expect(after.customised).toBe(false);
    expect(after.layout).toEqual([...DEFAULT_SIDEBAR]);
  });

  it('hands the client boundary nothing React would refuse', async () => {
    // The same check pages.test.ts runs on every page. The trap here is the
    // `trigger` prop: a RENDERED element handed to a Client Component, which is
    // fine, where a component reference would not be.
    currentUser = USERS.admin;
    const { clientComponentNames, describeViolations, findBoundaryViolations } =
      await import('../support/rsc-boundary');
    const violations = findBoundaryViolations(await renderDrawer(), clientComponentNames());
    expect(
      violations.length,
      violations.length === 0 ? '' : describeViolations(violations),
    ).toBe(0);
  });
});

/**
 * The settings card, and the control it does not offer.
 *
 * A BUTTON THAT ALWAYS REFUSES IS ITS OWN KIND OF WRONG. The settings page
 * already computes a tenant:write grant for the rename form and now reads it
 * for this card too — which is why the field is called can_write_tenant rather
 * than can_rename. Three layers decide whether the default can be changed (this
 * render, the route's permission list, and the RLS policy); this is the one
 * that decides what somebody is invited to try.
 */
describe('the settings card', () => {
  const renderSettings = async (): Promise<unknown> =>
    (await import('../../src/app/(app)/settings/page')).default();

  /** Every element of a named component in the tree, with its props. */
  function allProps(node: unknown, name: string): Record<string, unknown>[] {
    const found: Record<string, unknown>[] = [];
    const seen = new WeakSet<object>();
    const walk = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return;
      if (seen.has(value)) return;
      seen.add(value);
      const element = value as { type?: unknown; props?: Record<string, unknown> };
      if (typeof element.type === 'function' && element.type.name === name && element.props) {
        found.push(element.props);
      }
      for (const child of Array.isArray(value) ? value : Object.values(value)) walk(child);
    };
    walk(node);
    return found;
  }

  it('offers the default to somebody holding tenant:write', async () => {
    currentUser = USERS.admin;
    await slugsOf(await saveDefault(['networks', 'sops']));

    const controls = allProps(await renderSettings(), 'SidebarCustomise');
    const tenantScoped = controls.filter((p) => p.scope === 'tenant');
    expect(tenantScoped, 'the default sidebar control should be on the page').toHaveLength(1);
    expect(tenantScoped[0]!.layout).toEqual(['networks', 'sops']);
  });

  it('does not offer it to a tenant-wide actor without that permission', async () => {
    // tier1 can open Settings and sees most of it. The route and the policy
    // would both refuse this write, so offering the control would be an
    // invitation to a dead end.
    currentUser = USERS.tech;
    const controls = allProps(await renderSettings(), 'SidebarCustomise');
    expect(controls.filter((p) => p.scope === 'tenant')).toHaveLength(0);
  });
});
