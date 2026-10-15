/**
 * The in-app inbox, end to end.
 *
 * WHAT ONLY THIS LEVEL ANSWERS:
 *
 *   1. AN AUDIT ROW REACHES A PERSON'S BELL — through the real fan-out, with
 *      the real subject, for a tenant that has NO webhook destination and NO
 *      mail relay. That last clause is the whole point of 0700 and the thing a
 *      migration guard cannot see: the fan-out's SQL does not join to
 *      webhook_endpoint, but the WORKER only visited tenants that had one, so
 *      every bit of that care was undone one level up. This file is what
 *      found it.
 *
 *   2. THE AUDIENCE IS A SCOPE AND NOT A PERMISSION. client_admin holds
 *      audit:read and must receive nothing. Decision 31, which 0690 had to
 *      learn on task_reminder and which 0700 is the second chance to get wrong.
 *
 *   3. IT IS IDEMPOTENT. A second pass, a rewound cursor and two overlapping
 *      workers all produce the same row rather than a second bell.
 *
 *   4. A REMINDER LIGHTS IT TOO, by a trigger, including the part where a
 *      SUPPRESSED lead does not.
 *
 *   5. NOBODY CAN READ, FORGE OR REWRITE SOMEBODY ELSE'S — the column grant,
 *      asserted behaviourally rather than from the catalogue.
 */
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { withTenant } from '../../src/lib/db/client';
import { resetServices, setKekProvider } from '../../src/lib/services';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import {
  actor, buildHarness, connectPools, disconnectPools, IDS, resetDatabase, superuserSql,
} from './harness';
import { getExportService } from '../../src/lib/exports/service';
import { fanOutNotificationsJob } from '../../src/workers/notifications';
import type { JobContext } from '../../src/workers/runtime';
import {
  DELETE as clearInbox, GET as getInbox, PUT as markInbox,
} from '../../src/app/api/account/inbox/route';
import { PUT as putKinds } from '../../src/app/api/account/notifications/route';
import { POST as startRun } from '../../src/app/api/sop-runs/route';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

const ADMIN = actor(IDS.tenant1, IDS.admin1);
let harness: ReturnType<typeof buildHarness>;
let currentUser: SessionUser | null = null;

const USERS = {
  admin: { id: IDS.admin1, email: 'admin@northwind.test' },
  tech: { id: IDS.tech1, email: 'tech1@northwind.test' },
  // client_admin, which is the role that HOLDS audit:read and is not
  // tenant-wide. acmeViewer is client_read_only and holds no audit:read, so
  // pointing this test at it would have asserted nothing.
  client: { id: IDS.acmeAdmin, email: 'it@acme.test' },
} as const;

const request = (method = 'GET', payload?: unknown) =>
  new NextRequest(new Request('http://helm.test/api/account/inbox', {
    method,
    ...(payload === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
  }));

async function read(response: Response) {
  return { status: response.status, payload: (await response.json()) as Record<string, unknown> };
}

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
  return { log: logger, stopping: () => false, lines } as unknown as JobContext & {
    lines: string[];
  };
}

/** One pass of the REAL job, including its tenant enumeration. */
const fanOut = () => fanOutNotificationsJob().run(context());

/**
 * The worker identity the notification jobs run as.
 *
 * Resolved INSIDE a tenant context, because service_account is RLS-protected
 * and helm.worker_actor() is not a definer function — called bare on the
 * worker pool it matches zero rows and returns NULL. The same note 0420's
 * tests carry, and the same family of defect this file found in the fan-out's
 * own enumeration.
 */
let workerActorId: string | null = null;
async function resolveWorkerActor(): Promise<string> {
  if (workerActorId) return workerActorId;
  const rows = await withTenant(ADMIN, (tx) => tx<{ id: string }[]>`
    SELECT id FROM service_account WHERE is_system AND role_key = 'system_alerts'
  `);
  workerActorId = rows[0]!.id;
  return workerActorId;
}

/** Subscribe somebody to an oversight kind, through the real route. */
async function subscribe(user: SessionUser, kinds: string[]) {
  const previous = currentUser;
  currentUser = user;
  const response = await putKinds(
    new NextRequest(new Request('http://helm.test/api/account/notifications', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kinds }),
    })),
  );
  currentUser = previous;
  return response.status;
}

async function requestAnExport(reason = 'contractual handover of all documentation') {
  const previous = currentUser;
  currentUser = USERS.admin;
  await getExportService().request(
    { tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' },
    {
      organizationId: IDS.orgAcme,
      kind: 'client_offboarding',
      format: 'zip',
      reason,
      includeSecrets: true,
    },
  );
  currentUser = previous;
}

/**
 * A real checklist run, assigned to somebody, started through the real route.
 *
 * NOT helm_test.plant_reminder(): that helper lives in db/tests/_assert.sql,
 * which scripts/run-tests.sh loads for the SQL suite only — the integration
 * database has no helm_test schema at all. Which is the better test anyway:
 * this goes through the route that calls helm.raise_assignment_reminder(), so
 * the trigger fires on the write a technician's click actually makes.
 */
async function startAssignedRun(assignTo: string): Promise<string> {
  const previous = currentUser;
  currentUser = USERS.admin;
  const response = await startRun(
    new NextRequest(new Request('http://helm.test/api/sop-runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sopId: IDS.sopOffboard,
        organizationId: IDS.orgAcme,
        assignedTo: assignTo,
      }),
    })),
  );
  const payload = await response.json() as { runId?: string; error?: unknown };
  currentUser = previous;
  expect(payload.runId, JSON.stringify(payload.error ?? payload)).toBeTruthy();
  return payload.runId!;
}

/** Rows straight from the table, with the superuser, for the custody tests. */
const inboxRows = () => su((sql) => sql<{
  user_id: string; kind: string; subject: string; href: string | null; read_at: Date | null;
}[]>`SELECT user_id, kind, subject, href, read_at FROM user_notification ORDER BY subject`);

/**
 * Advance the cursor rather than deleting it, which is the lesson 0420's own
 * tests recorded: the audit log is append-only and is not cleared between
 * tests, so a cursor back at zero makes the next fan-out replay every earlier
 * test's export.
 */
async function reset() {
  await su(async (sql) => {
    await sql`DELETE FROM user_notification`;
    await sql`DELETE FROM user_notification_preference`;
    await sql`DELETE FROM webhook_delivery`;
    await sql`DELETE FROM webhook_endpoint`;
    await sql`DELETE FROM task_reminder`;
    await sql`
      INSERT INTO notification_cursor (tenant_id, last_chain_seq)
      SELECT ${IDS.tenant1}::uuid, coalesce(max(chain_seq), 0)
      FROM audit_log WHERE tenant_id = ${IDS.tenant1}::uuid
      ON CONFLICT (tenant_id) DO UPDATE SET last_chain_seq = EXCLUDED.last_chain_seq
    `;
  });
}

beforeAll(async () => {
  resetDatabase();
  connectPools();
  harness = buildHarness();
  resetServices();
  setKekProvider(harness.kek);
  useSessionResolver(async () => currentUser);
  await harness.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'inbox tests' });
  await reset();
}, 120_000);

afterEach(async () => {
  currentUser = null;
  await reset();
});

afterAll(async () => {
  await disconnectPools();
});

// ---------------------------------------------------------------------------

describe('an audit row reaches a bell', () => {
  it('with no webhook destination and no mail relay anywhere', async () => {
    /*
     * THE TEST THAT FOUND THE BUG. The fan-out's in-app INSERT is deliberately
     * not joined to webhook_endpoint — but the job's tenant enumeration was
     * `EXISTS (... webhook_endpoint ... is_active)`, so for this tenant the
     * function was never called at all and the bell stayed empty. A guard in
     * the migration cannot see a predicate in TypeScript.
     */
    expect(await su((sql) => sql`SELECT 1 FROM webhook_endpoint`)).toEqual([]);
    expect(await su((sql) => sql`SELECT 1 FROM smtp_setting`)).toEqual([]);

    expect(await subscribe(USERS.admin, ['export_activity'])).toBe(200);
    await requestAnExport();

    const result = await fanOut();
    expect(result.counts).toMatchObject({ queued: 0, notified: 1 });
    // ...and it is not reported idle, because filling a bell is doing something.
    expect(result.idle).toBe(false);

    const rows = await inboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(IDS.admin1);
    expect(rows[0]!.kind).toBe('export_activity');
    // The same words the channels get, from helm.notification_subject().
    expect(rows[0]!.subject).toContain('Acme');
    expect(rows[0]!.subject).toContain('CREDENTIAL-BEARING');
    // A relative path to the client it is about, not an absolute URL.
    expect(rows[0]!.href).toBe(`/organizations/${IDS.orgAcme}`);
    expect(rows[0]!.read_at).toBeNull();
  });

  it('and the route hands it to the person it belongs to', async () => {
    await subscribe(USERS.admin, ['export_activity']);
    await requestAnExport();
    await fanOut();

    currentUser = USERS.admin;
    const { status, payload } = await read(await getInbox(request()));
    expect(status).toBe(200);
    expect(payload.unread).toBe(1);
    const list = payload.notifications as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'export_activity', read: false });

    // The technician subscribed to nothing, so their bell is empty — and that
    // is the audience test, not a filter in the route.
    currentUser = USERS.tech;
    const theirs = await read(await getInbox(request()));
    expect(theirs.payload.unread).toBe(0);
    expect(theirs.payload.notifications).toEqual([]);
  });

  it('sends nothing to anybody who has not opted in', async () => {
    // Nobody subscribed at all: the oversight kinds are off by default, so the
    // quiet start is the shipped state rather than a fault.
    await requestAnExport();
    const result = await fanOut();
    // The job does not even visit the tenant, because nothing could want a row.
    expect(result.idle).toBe(true);
    expect(await inboxRows()).toEqual([]);
  });
});

describe('the audience is a scope, not a permission', () => {
  it('refuses a client administrator who holds audit:read', async () => {
    // The premise, asserted rather than assumed: this is only a test if the
    // role really does hold the permission and really is not tenant-wide.
    const [seat] = await su((sql) => sql<{ audit_read: boolean; wide: boolean }[]>`
      SELECT
        EXISTS (SELECT 1 FROM role_permission rp
                 WHERE rp.role_key = mb.role_key AND rp.permission_key = 'audit:read')
          AS audit_read,
        mb.org_scope_all AS wide
      FROM membership mb
      WHERE mb.tenant_id = ${IDS.tenant1}::uuid AND mb.user_id = ${IDS.acmeAdmin}::uuid
    `);
    expect(seat!.audit_read, 'the premise of decision 31 no longer holds').toBe(true);
    expect(seat!.wide).toBe(false);

    // They can even ask for the kind — the preference is theirs to set.
    expect(await subscribe(USERS.client, ['export_activity'])).toBe(200);
    await requestAnExport();
    await fanOut();

    expect(
      await inboxRows(),
      'a client administrator received an oversight notification about another client',
    ).toEqual([]);

    currentUser = USERS.client;
    expect((await read(await getInbox(request()))).payload.notifications).toEqual([]);
  });

  it('and a suspended member, and an expired one', async () => {
    /*
     * THE SUBSCRIBER IS THE TECHNICIAN, NOT THE ADMINISTRATOR, because the
     * administrator is the one requesting the export — and the first version of
     * this test suspended the requester, so the export service itself refused
     * with "no active membership" and the test failed for a reason that had
     * nothing to do with notifications. tier1 is tenant-wide and holds
     * audit:read, so it is a real member of the audience.
     */
    await subscribe(USERS.tech, ['export_activity']);
    /*
     * RESTORED IN A `finally`, which the first version of this test did not do
     * — and a single failed assertion then left the administrator's membership
     * suspended for every test after it, so eight unrelated tests failed with
     * "no active membership". A fixture a test breaks must be repaired whether
     * or not the test passes.
     */
    try {
      await su((sql) => sql`
        UPDATE membership SET status = 'suspended'
        WHERE tenant_id = ${IDS.tenant1}::uuid AND user_id = ${IDS.tech1}::uuid
      `);
      await requestAnExport();
      await fanOut();
      expect(await inboxRows(), 'a suspended member received a notification').toEqual([]);

      await su((sql) => sql`
        UPDATE membership SET status = 'active', expires_at = now() - interval '1 day'
        WHERE tenant_id = ${IDS.tenant1}::uuid AND user_id = ${IDS.tech1}::uuid
      `);
      await requestAnExport('a second reason long enough to pass');
      await fanOut();
      expect(await inboxRows(), 'an expired member received a notification').toEqual([]);
    } finally {
      await su((sql) => sql`
        UPDATE membership SET status = 'active', expires_at = NULL
        WHERE tenant_id = ${IDS.tenant1}::uuid AND user_id = ${IDS.tech1}::uuid
      `);
    }
  });
});

describe('it is idempotent', () => {
  it('a second pass adds nothing', async () => {
    await subscribe(USERS.admin, ['export_activity']);
    await requestAnExport();
    expect((await fanOut()).counts).toMatchObject({ notified: 1 });
    expect((await fanOut()).counts).toMatchObject({ notified: 0 });
    expect(await inboxRows()).toHaveLength(1);
  });

  it('and so does a rewound cursor, which is the case the key exists for', async () => {
    await subscribe(USERS.admin, ['export_activity']);
    await requestAnExport();
    await fanOut();
    const [first] = await su((sql) => sql<{ dedupe_key: string }[]>`
      SELECT dedupe_key FROM user_notification
    `);
    expect(first).toBeTruthy();

    /*
     * A crash between the insert and the cursor update looks exactly like
     * this. Asserted PER EVENT rather than on the total, which the first
     * version got wrong: rewinding the cursor five rows legitimately picks up
     * four OTHER audit rows this test file has written, so the total grows and
     * that is correct. What must not happen is a second row for the same
     * event — which is what the (user, kind, dedupe_key) key is for.
     */
    await su((sql) => sql`
      UPDATE notification_cursor SET last_chain_seq = last_chain_seq - 5
      WHERE tenant_id = ${IDS.tenant1}::uuid
    `);
    await fanOut();

    const again = await su((sql) => sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM user_notification
      WHERE dedupe_key = ${first!.dedupe_key}
    `);
    expect(
      again[0]!.n,
      'a rewound cursor produced a second bell for one event',
    ).toBe(1);
  });
});

describe('a reminder lights the bell', () => {
  it('by a trigger on the write the route makes', async () => {
    const runId = await startAssignedRun(IDS.tech1);

    const rows = await inboxRows();
    // The fixture's procedure has several steps and assigning the run assigns
    // every one, so this is per step rather than per run — the same shape
    // 0690's reminder tests had to name.
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.user_id).toBe(IDS.tech1);
      expect(row.kind).toBe('task_assigned');
      expect(row.subject).toContain('You were assigned');
      expect(row.href).toBe(`/runs/${runId}`);
    }

    // And the assignee's own bell shows them.
    currentUser = USERS.tech;
    const { payload } = await read(await getInbox(request()));
    expect(payload.unread).toBe(rows.length);
  });

  it('but a suppressed lead does not, which is 0690"s one-message rule', async () => {
    // 0690 raises the earliest crossed lead as pending and the rest as
    // suppressed, so a step entered the day before its deadline produces one
    // message. Lighting the bell for a suppressed row would undo exactly that.
    await startAssignedRun(IDS.tech1);
    const assigned = (await inboxRows()).length;
    expect(assigned).toBeGreaterThan(0);

    const step = await su((sql) => sql<{ id: string; tenant_id: string }[]>`
      SELECT step_id AS id, tenant_id FROM task_reminder LIMIT 1
    `);
    await su((sql) => sql`
      INSERT INTO task_reminder (tenant_id, step_id, user_id, kind, lead_day,
                                 status, next_attempt_at)
      VALUES (${step[0]!.tenant_id}::uuid, ${step[0]!.id}::uuid,
              ${IDS.tech1}::uuid, 'due', 3, 'suppressed', now())
    `);
    expect(
      (await inboxRows()).length,
      'a suppressed reminder lit the bell, which undoes the one-message rule',
    ).toBe(assigned);

    /*
     * ...and TWO pending `due` leads on ONE step are two bells, because the
     * lead day is part of the dedupe key.
     *
     * THE FIRST VERSION OF THIS ASSERTION WAS WORTHLESS. It inserted a single
     * `due` row and checked the count went up by one — which passes with the
     * lead day removed from the key entirely, because the row it compared
     * against was a `task_assigned` row and the KIND already distinguished
     * them. Removing `|| NEW.lead_day` from the key broke nothing and no test
     * noticed. Two rows of the SAME kind, differing only in lead, is the only
     * shape that tests what the key is for.
     */
    await su((sql) => sql`
      INSERT INTO task_reminder (tenant_id, step_id, user_id, kind, lead_day,
                                 status, next_attempt_at)
      VALUES
        (${step[0]!.tenant_id}::uuid, ${step[0]!.id}::uuid,
         ${IDS.tech1}::uuid, 'due', 1, 'pending', now()),
        (${step[0]!.tenant_id}::uuid, ${step[0]!.id}::uuid,
         ${IDS.tech1}::uuid, 'due', 0, 'pending', now())
    `);
    const after = await inboxRows();
    expect(
      after.length,
      'two due thresholds on one step produced fewer than two notifications, so '
      + 'the lead day is not in the dedupe key',
    ).toBe(assigned + 2);
    expect(after.some((r) => r.subject.startsWith('Due tomorrow:'))).toBe(true);
    expect(after.some((r) => r.subject.startsWith('Due today:'))).toBe(true);
  });

  it('and honours the preference, in the same set the email uses', async () => {
    await subscribe(USERS.tech, []);
    await startAssignedRun(IDS.tech1);
    expect(
      await inboxRows(),
      'somebody who turned task_assigned off still got a bell for it',
    ).toEqual([]);
  });
});

describe('custody of a bell', () => {
  it('cannot be read by an administrator, by any path', async () => {
    await subscribe(USERS.tech, ['export_activity']);
    await requestAnExport();
    await fanOut();
    expect(await inboxRows()).toHaveLength(1);

    // Not merely unreturned by the function — invisible to the policy.
    const rows = await withTenant(ADMIN, (tx) => tx`SELECT 1 FROM user_notification`);
    expect(rows, 'an administrator could read somebody else"s bell').toEqual([]);

    currentUser = USERS.admin;
    expect((await read(await getInbox(request()))).payload.notifications).toEqual([]);
  });

  it('cannot be forged or reworded from the request path', async () => {
    const forged = withTenant(ADMIN, (tx) => tx`
      INSERT INTO user_notification (tenant_id, user_id, kind, dedupe_key, subject, occurred_at)
      VALUES (${IDS.tenant1}::uuid, ${IDS.admin1}::uuid, 'operations', 'forged',
              'Helm says this is fine', now())
    `);
    await expect(forged, 'helm_app could forge a notification').rejects.toThrow();

    await subscribe(USERS.admin, ['export_activity']);
    await requestAnExport();
    await fanOut();

    // The column grant: read_at is writable, the subject is not. A notification
    // about an export is Helm speaking, and rewriting it would be putting words
    // in its mouth.
    const reworded = withTenant(ADMIN, (tx) => tx`
      UPDATE user_notification SET subject = 'nothing happened'
    `);
    await expect(reworded, 'helm_app could reword a notification').rejects.toThrow();
  });

  it('marks read exactly what was asked for, and keeps the first read time', async () => {
    await subscribe(USERS.admin, ['export_activity', 'credential_access']);
    await requestAnExport();
    await requestAnExport('a second export with its own long enough reason');
    await fanOut();

    currentUser = USERS.admin;
    const before = await read(await getInbox(request()));
    expect(before.payload.unread).toBe(2);

    const ids = (before.payload.notifications as { id: string }[]).map((n) => n.id);
    const one = await read(await markInbox(request('PUT', { ids: [ids[0]!] })));
    expect(one.payload).toMatchObject({ marked: 1, unread: 1 });

    const first = await su((sql) => sql<{ read_at: Date }[]>`
      SELECT read_at FROM user_notification WHERE id = ${ids[0]!}::uuid
    `).then((rows) => rows[0]!.read_at);

    // Re-marking changes nothing, and does not move the time it was first read.
    const again = await read(await markInbox(request('PUT', { ids: [ids[0]!] })));
    expect(again.payload).toMatchObject({ marked: 0, unread: 1 });
    const stillFirst = await su((sql) => sql<{ read_at: Date }[]>`
      SELECT read_at FROM user_notification WHERE id = ${ids[0]!}::uuid
    `).then((rows) => rows[0]!.read_at);
    expect(stillFirst.getTime()).toBe(first.getTime());

    // No ids means all of them, which is the "mark all read" button. An EMPTY
    // array means none — a different answer, and why the field is optional.
    expect((await read(await markInbox(request('PUT', { ids: [] })))).payload)
      .toMatchObject({ marked: 0, unread: 1 });
    expect((await read(await markInbox(request('PUT', {})))).payload)
      .toMatchObject({ marked: 1, unread: 0 });
  });

  it('clears the read ones and leaves the unread, which is what it is for', async () => {
    await subscribe(USERS.admin, ['export_activity']);
    await requestAnExport();
    await requestAnExport('a second export with its own long enough reason');
    await fanOut();

    currentUser = USERS.admin;
    const ids = ((await read(await getInbox(request()))).payload
      .notifications as { id: string }[]).map((n) => n.id);
    await markInbox(request('PUT', { ids: [ids[0]!] }));

    const cleared = await read(await clearInbox(request('DELETE')));
    expect(cleared.payload).toMatchObject({ cleared: 1, unread: 1 });
    // Deleting something unseen would delete the thing the table exists for.
    expect(await inboxRows()).toHaveLength(1);
  });
});

describe('the pre-filter and the retention sweep', () => {
  it('has_inapp_audience is what lets a bell-only tenant be visited', async () => {
    // The rule the worker's enumeration depends on, asserted directly so a
    // change to either side is visible here rather than as a silent empty bell.
    const quiet = await su((sql) => sql<{ ok: boolean }[]>`
      SELECT helm.has_inapp_audience(${IDS.tenant1}::uuid) AS ok
    `);
    expect(quiet[0]!.ok, 'nobody has opted in yet').toBe(false);

    // The DEFAULT kinds do not make an audience: they are per-person reminders
    // the trigger writes, not something the fan-out has to be run for.
    await subscribe(USERS.admin, ['task_assigned', 'task_due']);
    expect((await su((sql) => sql<{ ok: boolean }[]>`
      SELECT helm.has_inapp_audience(${IDS.tenant1}::uuid) AS ok
    `))[0]!.ok).toBe(false);

    await subscribe(USERS.admin, ['task_due', 'operations']);
    expect((await su((sql) => sql<{ ok: boolean }[]>`
      SELECT helm.has_inapp_audience(${IDS.tenant1}::uuid) AS ok
    `))[0]!.ok, 'an oversight subscription should make the tenant due').toBe(true);
  });

  it('prunes read rows sooner than unread ones', async () => {
    const workerActor = {
      tenantId: IDS.tenant1,
      actorId: await resolveWorkerActor(),
      actorType: 'service_account' as const,
    };
    await subscribe(USERS.admin, ['export_activity']);
    await requestAnExport();
    await fanOut();

    // Backdated past the read window but well inside the unread one.
    await su((sql) => sql`
      UPDATE user_notification SET created_at = now() - interval '60 days'
    `);
    // As the WORKER, because that is who prunes: the function is granted to
    // helm_worker alone, and calling it from the request path would be a way
    // for one person to delete another's notifications wholesale.
    const [kept] = await withTenant(workerActor, (tx) => tx<{ n: number }[]>`
      SELECT helm.prune_notifications() AS n
    `, { role: 'worker' });
    expect(kept!.n, 'an UNREAD notification was pruned at 60 days').toBe(0);
    expect(await inboxRows()).toHaveLength(1);

    await su((sql) => sql`UPDATE user_notification SET read_at = now()`);
    const [swept] = await withTenant(workerActor, (tx) => tx<{ n: number }[]>`
      SELECT helm.prune_notifications() AS n
    `, { role: 'worker' });
    expect(swept!.n).toBe(1);
    expect(await inboxRows()).toEqual([]);
  });
});
