/**
 * Profile and preferences: group E.
 *
 * FOUR THINGS ASSERTED HERE BEYOND THE HAPPY PATH, each a failure that would
 * otherwise be quiet:
 *
 *   1. THE ROUTE'S `WHERE id` IS LOAD-BEARING. app_user_rls_update is
 *      `id = helm.current_actor_id() OR helm.has_permission('user:write')`,
 *      because an administrator edits colleagues from the People page. So the
 *      policy alone would let a super_admin's "save my preferences" rewrite
 *      every row in the tenant. Only the route's predicate stops that, and it
 *      is the kind of line somebody deletes as redundant.
 *   2. AND SO IS THE POLICY. The route is confined twice; a test that only
 *      covered the predicate would not notice the second lock going missing.
 *   3. THE HALVES WIN OVER A TYPED NAME, structurally, because 0630's trigger
 *      fires on the same statement. The unit test's composedName() is pinned
 *      against what the database actually does, here, so the form cannot come
 *      to disagree with the trigger about what a save will produce.
 *   4. AN UNKNOWN TIME ZONE IS REFUSED AT WRITE TIME. The alternative is a
 *      stored string that raises on `AT TIME ZONE` later — a 500 on every page
 *      that renders a date, for one person, until somebody reads a log.
 */
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { withTenant } from '../../src/lib/db/client';
import { composedName } from '../../src/lib/ui/preferences';
import { actor, connectPools, disconnectPools, IDS, resetDatabase, superuserSql } from './harness';
import { PATCH as patchAccount } from '../../src/app/api/account/route';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

let currentUser: SessionUser | null = null;
const admin = actor(IDS.tenant1, IDS.admin1);

const USERS = {
  admin: { id: IDS.admin1, email: 'admin@northwind.test' },
  tech: { id: IDS.tech1, email: 'tech@northwind.test' },
  viewer: { id: IDS.acmeViewer, email: 'viewer@acme.test' },
} as const;

const patch = (payload: unknown) =>
  patchAccount(new NextRequest(new Request('http://helm.test/api/account', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })));

async function read(response: Response): Promise<{
  status: number; payload: Record<string, unknown>; raw: string;
}> {
  const raw = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // A non-JSON body is its own diagnostic.
  }
  return { status: response.status, payload, raw };
}

const account = async (response: Response): Promise<Record<string, unknown>> => {
  const { status, payload, raw } = await read(response);
  expect(status, raw).toBe(200);
  return payload.account as Record<string, unknown>;
};

interface Row {
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  timezone: string | null;
  theme: string;
}

/** Read a row as the superuser, so no policy decides what the test can see. */
async function rowOf(userId: string): Promise<Row> {
  const sql = superuserSql();
  try {
    const [row] = await sql<Row[]>`
      SELECT name, first_name, last_name, timezone, theme FROM app_user WHERE id = ${userId}
    `;
    if (!row) throw new Error(`no app_user ${userId}`);
    return row;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Put the fixture's users back, so each test starts from a known row. */
async function resetUsers(): Promise<void> {
  const sql = superuserSql();
  try {
    await sql`
      UPDATE app_user
      SET first_name = NULL, last_name = NULL, timezone = NULL, theme = 'system',
          name = CASE id
                   WHEN ${IDS.admin1}::uuid THEN 'Northwind Admin'
                   WHEN ${IDS.tech1}::uuid THEN 'Northwind Tech'
                   ELSE name
                 END
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

beforeAll(async () => {
  resetDatabase();
  connectPools();
  useSessionResolver(async () => currentUser);
}, 120_000);

afterEach(async () => { currentUser = null; await resetUsers(); });
afterAll(async () => { await disconnectPools(); });

describe('saving my own preferences', () => {
  it('stores a theme and a time zone', async () => {
    currentUser = USERS.admin;
    const saved = await account(await patch({ theme: 'dark', timezone: 'America/New_York' }));
    expect(saved.theme).toBe('dark');
    expect(saved.timezone).toBe('America/New_York');

    const row = await rowOf(IDS.admin1);
    expect(row.theme).toBe('dark');
    expect(row.timezone).toBe('America/New_York');
  });

  it('clears a time zone with an explicit null, rather than ignoring it', async () => {
    // The COALESCE trap: `COALESCE(${null}, timezone)` keeps the old value, so
    // "no preference" would silently do nothing.
    currentUser = USERS.admin;
    await account(await patch({ timezone: 'Europe/London' }));
    expect((await rowOf(IDS.admin1)).timezone).toBe('Europe/London');

    await account(await patch({ timezone: null }));
    expect((await rowOf(IDS.admin1)).timezone).toBeNull();
  });

  it('leaves a field alone when it is not sent', async () => {
    currentUser = USERS.admin;
    await account(await patch({ timezone: 'Europe/London', theme: 'light' }));
    await account(await patch({ theme: 'dark' }));

    const row = await rowOf(IDS.admin1);
    expect(row.theme).toBe('dark');
    expect(row.timezone, 'an unsent field should survive').toBe('Europe/London');
  });

  it('refuses a time zone the server does not know', async () => {
    currentUser = USERS.admin;
    const refused = await read(await patch({ timezone: 'Mars/Olympus_Mons' }));
    expect(refused.status).toBe(400);
    // The message names the offending zone, which is the only thing a person
    // can act on — and it comes from the trigger, not from a guess here.
    expect(refused.raw).toContain('Mars/Olympus_Mons');
    expect((await rowOf(IDS.admin1)).timezone).toBeNull();
  });

  it('refuses an unknown theme', async () => {
    currentUser = USERS.admin;
    expect((await read(await patch({ theme: 'puce' }))).status).toBe(400);
    expect((await rowOf(IDS.admin1)).theme).toBe('system');
  });

  it('refuses a body with nothing in it', async () => {
    currentUser = USERS.admin;
    expect((await read(await patch({}))).status).toBe(400);
  });

  it('is available to a client-side role, whose account is theirs too', async () => {
    currentUser = USERS.viewer;
    expect((await account(await patch({ theme: 'light' }))).theme).toBe('light');
  });
});

describe('the display name and its halves', () => {
  /**
   * The table the unit test runs through composedName(), run here through the
   * real UPDATE and the real trigger. If the two ever disagree, the form shows
   * a person one name and stores another.
   */
  const CASES: { first: string | null; last: string | null; existing: string }[] = [
    { first: 'Ada', last: 'Lovelace', existing: 'Northwind Admin' },
    { first: 'Ada', last: null, existing: 'Northwind Admin' },
    { first: null, last: 'Lovelace', existing: 'Northwind Admin' },
    { first: null, last: null, existing: 'Northwind Admin' },
    { first: '  Ada  ', last: '  Lovelace  ', existing: 'Northwind Admin' },
  ];

  it('agrees with composedName() on every shape', async () => {
    for (const { first, last, existing } of CASES) {
      await resetUsers();
      currentUser = USERS.admin;
      await account(await patch({ firstName: first, lastName: last }));

      const row = await rowOf(IDS.admin1);
      expect(row.name, `halves ${JSON.stringify([first, last])}`)
        .toBe(composedName(first, last, existing));
    }
  });

  it('lets the halves win over a name sent in the same save', async () => {
    // Structural, not a convention about call order: the trigger fires on this
    // statement because the halves are in its SET list.
    currentUser = USERS.admin;
    await account(await patch({
      firstName: 'Ada', lastName: 'Lovelace', name: 'Something Else',
    }));
    expect((await rowOf(IDS.admin1)).name).toBe('Ada Lovelace');
  });

  it('still sets a display name directly when there are no halves', async () => {
    currentUser = USERS.admin;
    await account(await patch({ name: 'SMITH, J (Contractor)' }));
    expect((await rowOf(IDS.admin1)).name).toBe('SMITH, J (Contractor)');
  });

  it('leaves the display name alone when the halves are cleared', async () => {
    currentUser = USERS.admin;
    await account(await patch({ firstName: 'Ada', lastName: 'Lovelace' }));
    await account(await patch({ firstName: null, lastName: null }));

    const row = await rowOf(IDS.admin1);
    expect(row.first_name).toBeNull();
    expect(row.last_name).toBeNull();
    expect(row.name, 'clearing the halves should not blank the name').toBe('Ada Lovelace');
  });

  it('normalises an emptied box to NULL rather than the blank string', async () => {
    // app_user_name_parts_not_blank refuses '', and the form sends '' for a
    // field somebody cleared. A 500 would be a poor way to learn that.
    currentUser = USERS.admin;
    const saved = await account(await patch({ firstName: '', lastName: '  ' }));
    expect(saved.firstName).toBeNull();
    expect(saved.lastName).toBeNull();
  });

  it('refuses a half longer than the column', async () => {
    currentUser = USERS.admin;
    expect((await read(await patch({ firstName: 'a'.repeat(61) }))).status).toBe(400);
  });
});

describe('one account, not the tenant', () => {
  it('does not touch a colleague, even for an actor holding user:write', async () => {
    /*
     * THE TEST THIS FILE EXISTS FOR. super_admin holds user:write, so
     * app_user_rls_update admits its UPDATE against any row in the tenant. The
     * route's `WHERE id = actorId` is the only thing scoping it, and deleting
     * that line looks like removing a redundant predicate.
     */
    currentUser = USERS.admin;
    await account(await patch({ theme: 'dark', firstName: 'Ada' }));

    const colleague = await rowOf(IDS.tech1);
    expect(colleague.theme, 'a colleague"s theme was rewritten').toBe('system');
    expect(colleague.first_name).toBeNull();
    expect(colleague.name).toBe('Northwind Tech');
  });

  it('is confined by the policy as well, not only by the route', async () => {
    /*
     * The second lock. tier1 holds no user:write, so app_user_rls_update
     * admits only its own row — going round the route proves the database
     * would refuse a cross-user write even if the predicate were wrong.
     */
    const updated = await withTenant(actor(IDS.tenant1, IDS.tech1), (tx) => tx<{ id: string }[]>`
      UPDATE app_user SET theme = 'dark' WHERE id = ${IDS.admin1}::uuid RETURNING id
    `);
    expect(updated, 'RLS let tier1 write another user"s row').toHaveLength(0);
    expect((await rowOf(IDS.admin1)).theme).toBe('system');
  });

  it('reads MY row, not whichever colleague the policy also admits', async () => {
    /*
     * app_user_rls_select is "my own row, OR somebody who shares my tenant",
     * because the People page lists colleagues. So readMyPreferences() without
     * its explicit WHERE would return several rows and take whichever came
     * first — the shell would then apply a colleague's theme, and the account
     * page would offer to edit their name.
     */
    const sql = superuserSql();
    try {
      await sql`UPDATE app_user SET theme = 'dark',  first_name = 'Admin'
                 WHERE id = ${IDS.admin1}::uuid`;
      await sql`UPDATE app_user SET theme = 'light', first_name = 'Tech'
                 WHERE id = ${IDS.tech1}::uuid`;
    } finally {
      await sql.end({ timeout: 5 });
    }

    const { readMyPreferences } = await import('../../src/lib/ui/account-queries');
    const as = (actorId: string, email: string) => readMyPreferences({
      actorId, actorType: 'user', email, name: email,
      tenantId: IDS.tenant1, tenantName: 'Northwind',
      roleKey: 'super_admin', memberships: [],
    });

    /*
     * BOTH DIRECTIONS, and that is what makes this test mean something. The
     * first version set one colleague's row and read as the other, which
     * passed when the WHERE was replaced by `ORDER BY email` — 'admin@' sorts
     * before 'tech@', so the right row came back by luck. Asserting that each
     * actor sees their OWN distinct values cannot be satisfied by any
     * ordering, only by actually selecting one row.
     */
    const mine = await as(IDS.admin1, USERS.admin.email);
    expect(mine.theme, 'a colleague"s row was read as mine').toBe('dark');
    expect(mine.firstName).toBe('Admin');

    const theirs = await as(IDS.tech1, USERS.tech.email);
    expect(theirs.theme, 'the same row came back for a different actor').toBe('light');
    expect(theirs.firstName).toBe('Tech');
  });

  it('does not reach another tenant"s user at all', async () => {
    const updated = await withTenant(admin, (tx) => tx<{ id: string }[]>`
      UPDATE app_user SET theme = 'dark' WHERE id = ${IDS.admin2}::uuid RETURNING id
    `);
    expect(updated).toHaveLength(0);
  });
});
