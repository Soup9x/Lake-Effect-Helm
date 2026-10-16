/**
 * Recurring checklists: a schedule, and the worker that turns it into runs.
 *
 * WHAT ONLY THIS LEVEL ANSWERS:
 *
 *   1. A RAISED RUN IS A REAL RUN. Three steps from the published snapshot,
 *      the assignee on every one, the deadline from the slot, the audit row,
 *      and the "you have been given this" reminders — exactly what a person
 *      starting it would have produced.
 *   2. THE SLOT MOVES WITH THE RUN. The schedule advances in the same
 *      transaction as the INSERT, so a second tick raises nothing, and a
 *      schedule that was due a month ago raises ONE run, not four.
 *   3. PAUSED MEANS NOTHING HAPPENS, and unpublished means a skip the schedule
 *      can explain, not an empty run.
 *   4. THE GATE. Adding a schedule is sop:execute, the same as starting a run,
 *      and a client viewer is refused by the route's own words.
 */
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { withTenant } from '../../src/lib/db/client';
import { actor, connectPools, disconnectPools, IDS, resetDatabase, superuserSql } from './harness';
import { scheduleChecklistsJob } from '../../src/workers/schedules';
import type { JobContext } from '../../src/workers/runtime';
import { POST as createSop } from '../../src/app/api/sops/route';
import { PUT as putSteps } from '../../src/app/api/sops/[sopId]/steps/route';
import { POST as publishVersion } from '../../src/app/api/sops/[sopId]/versions/route';
import { GET as listRoute, POST as createRoute } from '../../src/app/api/sops/[sopId]/schedules/route';
import {
  DELETE as deleteRoute, PATCH as patchRoute,
} from '../../src/app/api/sops/[sopId]/schedules/[scheduleId]/route';
import { readRun } from '../../src/lib/sops/queries';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

let currentUser: SessionUser | null = null;
const admin = actor(IDS.tenant1, IDS.admin1);

const USERS = {
  admin: { id: IDS.admin1, email: 'admin@northwind.test' },
  tech: { id: IDS.tech1, email: 'tech1@northwind.test' },
  viewer: { id: IDS.acmeViewer, email: 'viewer@acme.test' },
} as const;

const send = (method: string) => (url: string, payload?: unknown) =>
  new NextRequest(new Request(`http://helm.test${url}`, {
    method,
    ...(payload === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
  }));
const get = send('GET');
const post = send('POST');
const put = send('PUT');
const patch = send('PATCH');
const del = send('DELETE');
const withParams = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

async function read(response: Response): Promise<{ status: number; payload: Record<string, unknown>; raw: string }> {
  const raw = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // A non-JSON body is its own diagnostic.
  }
  return { status: response.status, payload, raw };
}

async function ok(response: Response): Promise<Record<string, unknown>> {
  const { status, payload, raw } = await read(response);
  expect(status, raw).toBe(200);
  return payload;
}

async function su<T>(fn: (sql: ReturnType<typeof superuserSql>) => Promise<T>): Promise<T> {
  const sql = superuserSql();
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function context(): JobContext {
  const logger = {
    debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined,
    child: () => logger,
  };
  return { log: logger, stopping: () => false } as unknown as JobContext;
}

const tick = () => scheduleChecklistsJob().run(context());

interface ScheduleOut {
  id: string; intervalDays: number; nextRunAt: string; enabled: boolean;
  assignedTo: string | null; lastRunId: string | null; lastError: string | null; title: string | null;
}

/** A published procedure of this test's own, so nothing here touches the fixture's. */
async function freshProcedure(name: string): Promise<string> {
  currentUser = USERS.admin;
  const sopId = (await ok(await createSop(post('/api/sops', { organizationId: IDS.orgAcme, name })))).sopId as string;
  await ok(await putSteps(
    put(`/api/sops/${sopId}/steps`, {
      steps: [
        { title: 'Check the backups ran', body: 'Every job green in the console.' },
        { title: 'Test one restore' },
        { title: 'File the evidence', body: 'Screenshot into the ticket.' },
      ],
    }),
    withParams({ sopId }),
  ));
  await ok(await publishVersion(post(`/api/sops/${sopId}/versions`, {}), withParams({ sopId })));
  return sopId;
}

async function schedule(sopId: string, body: Record<string, unknown>): Promise<ScheduleOut> {
  return (await ok(await createRoute(post(`/api/sops/${sopId}/schedules`, body), withParams({ sopId })))).schedule as ScheduleOut;
}

/** The worker only looks at slots already gone; tests move the slot there. */
async function backdate(id: string, iso: string): Promise<void> {
  await su((sql) => sql`UPDATE sop_schedule SET next_run_at = ${iso}::timestamptz WHERE id = ${id}::uuid`);
}

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

beforeAll(async () => {
  resetDatabase();
  connectPools();
  useSessionResolver(async () => currentUser);
  // Assignment reminders are only raised for a tenant with an enabled relay —
  // nothing is sent here; the rows are what the test reads.
  await su((sql) => sql`
    INSERT INTO smtp_setting (tenant_id, enabled, host, port, security, tls_verify, from_address, from_name)
    VALUES (${IDS.tenant1}::uuid, true, 'relay.northwind.test', 587, 'starttls', true, 'helm@northwind.test', 'Helm')
    ON CONFLICT (tenant_id) DO UPDATE SET enabled = true
  `);
}, 120_000);

afterEach(async () => {
  currentUser = null;
  await su(async (sql) => {
    await sql`DELETE FROM sop_schedule`;
    await sql`DELETE FROM task_reminder`;
    await sql`DELETE FROM sop_run`;
  });
});

afterAll(async () => {
  await su((sql) => sql`DELETE FROM smtp_setting WHERE tenant_id = ${IDS.tenant1}::uuid`);
  await disconnectPools();
});

// ---------------------------------------------------------------------------

describe('writing a schedule down', () => {
  it('is sop:execute, so a technician can and a client viewer cannot', async () => {
    const sopId = await freshProcedure('Weekly backup check');

    currentUser = USERS.tech;
    const created = await schedule(sopId, { intervalDays: 7, firstRunAt: inDays(1), assignedTo: IDS.tech1 });
    expect(created.intervalDays).toBe(7);
    expect(created.enabled).toBe(true);
    expect(created.assignedTo).toBe(IDS.tech1);

    currentUser = USERS.viewer;
    const { status, payload } = await read(await createRoute(
      post(`/api/sops/${sopId}/schedules`, { intervalDays: 7, firstRunAt: inDays(1) }),
      withParams({ sopId }),
    ));
    expect(status).toBe(403);
    expect((payload.error as { message?: string }).message).toBe('missing permission: sop:execute');
  });

  it('refuses what cannot work: no published version, an outsider, a bad interval', async () => {
    currentUser = USERS.admin;
    const unpublished = (await read(await createRoute(
      post(`/api/sops/${IDS.sopRestore}/schedules`, { intervalDays: 7, firstRunAt: inDays(1) }),
      withParams({ sopId: IDS.sopRestore }),
    )));
    expect(unpublished.status).toBe(400);
    expect((unpublished.payload.error as { message?: string }).message).toMatch(/publish/);

    const sopId = await freshProcedure('Refusals');
    currentUser = USERS.admin;
    for (const body of [
      { intervalDays: 0, firstRunAt: inDays(1) },
      { intervalDays: 400, firstRunAt: inDays(1) },
      { intervalDays: 7, firstRunAt: 'tomorrow' },
      { intervalDays: 7, firstRunAt: inDays(1), assignedTo: IDS.admin2 },
    ]) {
      const { status, raw } = await read(await createRoute(
        post(`/api/sops/${sopId}/schedules`, body), withParams({ sopId }),
      ));
      expect(status, raw).toBe(400);
    }
  });

  it('lists, pauses, resumes and removes', async () => {
    const sopId = await freshProcedure('Lifecycle');
    currentUser = USERS.admin;
    const s = await schedule(sopId, { intervalDays: 30, firstRunAt: inDays(2), title: 'Monthly' });

    const listed = (await ok(await listRoute(get(`/api/sops/${sopId}/schedules`), withParams({ sopId })))).schedules as ScheduleOut[];
    expect(listed.map((x) => x.id)).toEqual([s.id]);
    expect(listed[0]!.title).toBe('Monthly');

    const paused = (await ok(await patchRoute(
      patch(`/api/sops/${sopId}/schedules/${s.id}`, { enabled: false }), withParams({ sopId, scheduleId: s.id }),
    ))).schedule as ScheduleOut;
    expect(paused.enabled).toBe(false);

    const resumed = (await ok(await patchRoute(
      patch(`/api/sops/${sopId}/schedules/${s.id}`, { enabled: true, intervalDays: 14 }),
      withParams({ sopId, scheduleId: s.id }),
    ))).schedule as ScheduleOut;
    expect(resumed).toMatchObject({ enabled: true, intervalDays: 14 });

    await ok(await deleteRoute(del(`/api/sops/${sopId}/schedules/${s.id}`), withParams({ sopId, scheduleId: s.id })));
    expect((await read(await deleteRoute(
      del(`/api/sops/${sopId}/schedules/${s.id}`), withParams({ sopId, scheduleId: s.id }),
    ))).status).toBe(404);
  });
});

describe('the worker raising runs', () => {
  it('raises a complete run at the slot, and the slot moves on', async () => {
    const sopId = await freshProcedure('Weekly backup check');
    currentUser = USERS.admin;
    const s = await schedule(sopId, {
      intervalDays: 7, firstRunAt: inDays(1), dueAfterDays: 2, assignedTo: IDS.tech1, title: 'Backups',
    });
    const slot = new Date(Date.now() - 3_600_000);
    await backdate(s.id, slot.toISOString());

    const result = await tick();
    expect(result).toMatchObject({ counts: { raised: 1, skipped: 0, failed: 0 } });

    const [row] = await su((sql) => sql<{
      next_run_at: Date; last_run_id: string | null; last_error: string | null; last_raised_at: Date | null;
    }[]>`SELECT next_run_at, last_run_id, last_error, last_raised_at FROM sop_schedule WHERE id = ${s.id}::uuid`);
    expect(row!.last_run_id).not.toBeNull();
    expect(row!.last_error).toBeNull();
    expect(row!.last_raised_at).not.toBeNull();
    // One whole interval on from the slot, not from "now".
    expect(row!.next_run_at.getTime()).toBe(slot.getTime() + 7 * 86_400_000);

    const run = await withTenant(admin, (tx) => readRun(tx, row!.last_run_id!));
    expect(run).not.toBeNull();
    expect(run!.title).toBe(`Backups — ${slot.toISOString().slice(0, 10)}`);
    expect(run!.status).toBe('in_progress');
    expect(run!.steps).toHaveLength(3);
    expect(run!.steps.map((st) => st.title)).toEqual([
      'Check the backups ran', 'Test one restore', 'File the evidence',
    ]);
    for (const step of run!.steps) {
      expect(step.assignedToId).toBe(IDS.tech1);
      expect(new Date(step.dueAt!).getTime()).toBe(slot.getTime() + 2 * 86_400_000);
    }

    const [audit] = await su((sql) => sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_log
      WHERE action = 'sop.run_scheduled' AND entity_id = ${row!.last_run_id}::uuid
    `);
    expect(audit!.n).toBe(1);

    // "You have been given this", one per step, raised by the worker's actor.
    const [reminders] = await su((sql) => sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM task_reminder r
      JOIN sop_run_step st ON st.id = r.step_id
      WHERE st.run_id = ${row!.last_run_id}::uuid AND r.kind = 'assigned'
    `);
    expect(reminders!.n).toBe(3);

    // A second tick finds nothing due.
    expect(await tick()).toMatchObject({ idle: true });
    const [runs] = await su((sql) => sql<{ n: number }[]>`SELECT count(*)::int AS n FROM sop_run WHERE sop_id = ${sopId}::uuid`);
    expect(runs!.n).toBe(1);
  });

  it('catches up a schedule that was due weeks ago with ONE run', async () => {
    const sopId = await freshProcedure('Catch-up');
    currentUser = USERS.admin;
    const s = await schedule(sopId, { intervalDays: 7, firstRunAt: inDays(1) });
    const slot = new Date(Date.now() - 30 * 86_400_000);
    await backdate(s.id, slot.toISOString());

    expect(await tick()).toMatchObject({ counts: { raised: 1 } });
    const [runs] = await su((sql) => sql<{ n: number }[]>`SELECT count(*)::int AS n FROM sop_run WHERE sop_id = ${sopId}::uuid`);
    expect(runs!.n).toBe(1);

    const [row] = await su((sql) => sql<{ next_run_at: Date }[]>`SELECT next_run_at FROM sop_schedule WHERE id = ${s.id}::uuid`);
    // Past now, and on the slot's own grid: 35 days after a slot 30 days ago.
    expect(row!.next_run_at.getTime()).toBeGreaterThan(Date.now());
    expect(row!.next_run_at.getTime()).toBe(slot.getTime() + 35 * 86_400_000);
  });

  it('leaves a paused schedule alone and drops an assignee who has left', async () => {
    const sopId = await freshProcedure('Paused');
    currentUser = USERS.admin;
    const paused = await schedule(sopId, { intervalDays: 7, firstRunAt: inDays(1) });
    await ok(await patchRoute(
      patch(`/api/sops/${sopId}/schedules/${paused.id}`, { enabled: false }), withParams({ sopId, scheduleId: paused.id }),
    ));
    await backdate(paused.id, inDays(-1));

    const gone = await schedule(sopId, { intervalDays: 7, firstRunAt: inDays(1), assignedTo: IDS.tech1 });
    await backdate(gone.id, inDays(-1));
    await su((sql) => sql`
      UPDATE membership SET status = 'suspended'
      WHERE tenant_id = ${IDS.tenant1}::uuid AND user_id = ${IDS.tech1}::uuid
    `);
    try {
      expect(await tick()).toMatchObject({ counts: { raised: 1, skipped: 0 } });
    } finally {
      await su((sql) => sql`
        UPDATE membership SET status = 'active'
        WHERE tenant_id = ${IDS.tenant1}::uuid AND user_id = ${IDS.tech1}::uuid
      `);
    }

    const rows = await su((sql) => sql<{ id: string; last_run_id: string | null }[]>`
      SELECT id, last_run_id FROM sop_schedule WHERE sop_id = ${sopId}::uuid
    `);
    expect(rows.find((r) => r.id === paused.id)!.last_run_id).toBeNull();
    const runId = rows.find((r) => r.id === gone.id)!.last_run_id!;
    const run = await withTenant(admin, (tx) => readRun(tx, runId));
    expect(run!.steps.every((st) => st.assignedToId === null)).toBe(true);
  });

  it('skips, and says why, when the procedure is archived after scheduling', async () => {
    const sopId = await freshProcedure('Archived');
    currentUser = USERS.admin;
    const s = await schedule(sopId, { intervalDays: 7, firstRunAt: inDays(1) });
    await backdate(s.id, inDays(-1));
    await su((sql) => sql`UPDATE asset_node SET archived_at = now() WHERE id = ${sopId}::uuid`);

    expect(await tick()).toMatchObject({ counts: { raised: 0, skipped: 1 } });
    const [row] = await su((sql) => sql<{ last_error: string | null; last_run_id: string | null; next_run_at: Date }[]>`
      SELECT last_error, last_run_id, next_run_at FROM sop_schedule WHERE id = ${s.id}::uuid
    `);
    expect(row!.last_run_id).toBeNull();
    expect(row!.last_error).toMatch(/published|archived/);
    // The slot still moved on, so the skip is not repeated every five minutes.
    expect(row!.next_run_at.getTime()).toBeGreaterThan(Date.now());
    const [runs] = await su((sql) => sql<{ n: number }[]>`SELECT count(*)::int AS n FROM sop_run WHERE sop_id = ${sopId}::uuid`);
    expect(runs!.n).toBe(0);
  });
});
