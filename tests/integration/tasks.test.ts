/**
 * Assignment, due dates and My Tasks (0650).
 *
 * F1 made a checklist runnable; this is what makes it work somebody is GIVEN.
 * The parity item is "tasks assigned to me", and four things about it are worth
 * asserting rather than assuming:
 *
 *   1. A RUN'S ASSIGNEE IS A DEFAULT, STAMPED ONCE. Starting a run writes it
 *      onto every step, so a step's assignment is concrete and My Tasks can
 *      index on it. 0650's header gives the reason the alternative — inheriting
 *      the run's value at read time — was rejected.
 *   2. WORK CANNOT BE HANDED TO SOMEBODY WHO CANNOT SEE IT. The assignee is a
 *      composite key against membership (tenant_id, user_id), so a step
 *      assigned outside the tenant is unrepresentable rather than merely
 *      refused by a route.
 *   3. REASSIGNING IS NOT COMPLETING. The step PATCH drives status, assignment
 *      and the due date through one endpoint, and sending one must not move the
 *      others — in particular completed_at must not be stamped by a handover.
 *   4. A TASK IS WORK SOMEBODY CAN STILL DO. A pending step on an abandoned run
 *      is not a task, and listing it would mean the product disagreeing with
 *      its own decision to give up.
 */
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { withTenant } from '../../src/lib/db/client';
import { actor, connectPools, disconnectPools, IDS, resetDatabase, superuserSql } from './harness';
import { POST as startRun } from '../../src/app/api/sop-runs/route';
import { PATCH as patchRun } from '../../src/app/api/sop-runs/[runId]/route';
import { PATCH as patchStep } from '../../src/app/api/sop-runs/[runId]/steps/[stepId]/route';
import {
  countMyOpenTasks, listAssignableUsers, listMyTasks, readRun,
} from '../../src/lib/sops/queries';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

let currentUser: SessionUser | null = null;
const admin = actor(IDS.tenant1, IDS.admin1);
const tech = actor(IDS.tenant1, IDS.tech1);
const rival = actor(IDS.tenant2, IDS.admin2);

const USERS = {
  admin: { id: IDS.admin1, email: 'admin@northwind.test' },
  tech: { id: IDS.tech1, email: 'tech1@northwind.test' },
} as const;

const send = (method: string) => (url: string, payload?: unknown) =>
  new NextRequest(new Request(`http://helm.test${url}`, {
    method,
    ...(payload === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
  }));
const post = send('POST');
const patch = send('PATCH');
const withParams = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

async function read(response: Response): Promise<{
  status: number; payload: Record<string, unknown>; raw: string;
}> {
  const raw = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch { /* a non-JSON body is its own diagnostic */ }
  return { status: response.status, payload, raw };
}

async function ok(response: Response): Promise<Record<string, unknown>> {
  const { status, payload, raw } = await read(response);
  expect(status, raw).toBe(200);
  return payload;
}

const asAdmin = () => { currentUser = USERS.admin; };

/** The fixture's published procedure, started with whatever defaults. */
async function run(payload: Record<string, unknown> = {}): Promise<string> {
  return (await ok(await startRun(post('/api/sop-runs', {
    sopId: IDS.sopOffboard, organizationId: IDS.orgAcme, ...payload,
  })))).runId as string;
}

async function stepsOf(runId: string) {
  return withTenant(admin, (tx) => tx<{
    id: string; position: number; status: string; assigned_to: string | null;
    due_at: Date | null; completed_at: Date | null;
  }[]>`
    SELECT id, position, status::text, assigned_to, due_at, completed_at
    FROM sop_run_step WHERE run_id = ${runId}::uuid ORDER BY position
  `);
}

const soon = () => new Date(Date.now() + 86_400_000).toISOString();
const past = () => new Date(Date.now() - 86_400_000).toISOString();

beforeAll(async () => {
  resetDatabase();
  connectPools();
  useSessionResolver(async () => currentUser);
}, 120_000);

afterEach(async () => {
  currentUser = null;
  const sql = superuserSql();
  try { await sql`DELETE FROM sop_run`; } finally { await sql.end({ timeout: 5 }); }
});
afterAll(async () => { await disconnectPools(); });

// ---------------------------------------------------------------------------

describe('starting a run with an assignee', () => {
  it('stamps the default onto every step', async () => {
    asAdmin();
    const due = soon();
    const runId = await run({ assignedTo: IDS.tech1, dueAt: due });

    const steps = await stepsOf(runId);
    expect(steps).toHaveLength(3);
    for (const step of steps) {
      expect(step.assigned_to, `step ${step.position} was not assigned`).toBe(IDS.tech1);
      expect(step.due_at?.toISOString()).toBe(due);
    }

    // And on the run itself, which is what the client page and the run header
    // show. Both, not either: the run records what it was started as.
    const [row] = await withTenant(admin, (tx) => tx<{
      assigned_to: string | null; due_at: Date | null;
    }[]>`SELECT assigned_to, due_at FROM sop_run WHERE id = ${runId}::uuid`);
    expect(row!.assigned_to).toBe(IDS.tech1);
    expect(row!.due_at?.toISOString()).toBe(due);
  });

  it('leaves every step unassigned when nobody was named', async () => {
    asAdmin();
    const steps = await stepsOf(await run());
    expect(steps.every((s) => s.assigned_to === null && s.due_at === null)).toBe(true);
  });

  it('refuses somebody who is not a member of this tenant', async () => {
    // The rival tenant's administrator. A real uuid, a real user, and no
    // membership here — so assigning to them would create work that nobody in
    // either tenant could ever see.
    asAdmin();
    const { status, payload } = await read(await startRun(post('/api/sop-runs', {
      sopId: IDS.sopOffboard, organizationId: IDS.orgAcme, assignedTo: IDS.admin2,
    })));
    expect(status).toBe(400);
    expect((payload.error as { message?: string }).message).toMatch(/not an active member/i);
  });

  it('refuses a revoked member, which the foreign key alone would allow', async () => {
    /*
     * The two locks differ on purpose. sop_run_step_assignee_fk accepts any
     * membership row, revoked or not — a revoked colleague can still HOLD a
     * task, because the work exists and somebody has to take it over. Handing
     * them a NEW one is what the route refuses, and only the route can, because
     * a foreign key cannot ask about `status`.
     */
    const sql = superuserSql();
    try {
      await sql`
        UPDATE membership SET status = 'revoked'
        WHERE tenant_id = ${IDS.tenant1}::uuid AND user_id = ${IDS.tech1}::uuid
      `;
      asAdmin();
      const { status } = await read(await startRun(post('/api/sop-runs', {
        sopId: IDS.sopOffboard, organizationId: IDS.orgAcme, assignedTo: IDS.tech1,
      })));
      expect(status).toBe(400);
    } finally {
      await sql`
        UPDATE membership SET status = 'active'
        WHERE tenant_id = ${IDS.tenant1}::uuid AND user_id = ${IDS.tech1}::uuid
      `;
      await sql.end({ timeout: 5 });
    }
  });

  it('cannot be assigned outside the tenant even by the database', async () => {
    // The constraint, not the route. A composite key against membership makes
    // the row unrepresentable, so no future writer can reintroduce this.
    asAdmin();
    const runId = await run();
    const [first] = await stepsOf(runId);
    const sql = superuserSql();
    try {
      await expect(sql`
        UPDATE sop_run_step SET assigned_to = ${IDS.admin2}::uuid
        WHERE id = ${first!.id}::uuid
      `).rejects.toThrow(/sop_run_step_assignee_fk|foreign key/i);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

describe('handing one step on', () => {
  it('moves that step and no other', async () => {
    asAdmin();
    const runId = await run({ assignedTo: IDS.admin1, dueAt: soon() });
    const [first] = await stepsOf(runId);

    await ok(await patchStep(
      patch(`/api/sop-runs/${runId}/steps/${first!.id}`, { assignedTo: IDS.tech1 }),
      withParams({ runId, stepId: first!.id }),
    ));

    const after = await stepsOf(runId);
    expect(after[0]!.assigned_to).toBe(IDS.tech1);
    expect(after[1]!.assigned_to, 'reassigning one step moved another').toBe(IDS.admin1);
    expect(after[2]!.assigned_to).toBe(IDS.admin1);
  });

  it('does not mark it done', async () => {
    /*
     * The step PATCH drives three things through one endpoint. Before 0650 it
     * always wrote completed_at from `status`, because status was mandatory;
     * now a body without one must leave the timestamp exactly as it was, or a
     * handover would silently record the step as finished.
     */
    asAdmin();
    const runId = await run();
    const [first] = await stepsOf(runId);

    await ok(await patchStep(
      patch(`/api/sop-runs/${runId}/steps/${first!.id}`, {
        assignedTo: IDS.tech1, dueAt: soon(),
      }),
      withParams({ runId, stepId: first!.id }),
    ));

    const [after] = await stepsOf(runId);
    expect(after!.status, 'a handover changed the status').toBe('pending');
    expect(after!.completed_at, 'a handover stamped the step as finished').toBeNull();
  });

  it('does not un-assign it when only the status moves', async () => {
    // The other direction of the same bug: checking a step off must keep whose
    // it was, because that is who did it.
    asAdmin();
    const runId = await run({ assignedTo: IDS.tech1, dueAt: soon() });
    const [first] = await stepsOf(runId);

    await ok(await patchStep(
      patch(`/api/sop-runs/${runId}/steps/${first!.id}`, { status: 'done' }),
      withParams({ runId, stepId: first!.id }),
    ));

    const [after] = await stepsOf(runId);
    expect(after!.status).toBe('done');
    expect(after!.assigned_to, 'completing a step dropped its assignee').toBe(IDS.tech1);
    expect(after!.due_at, 'completing a step dropped its due date').not.toBeNull();
    expect(after!.completed_at).not.toBeNull();
  });

  it('clears an assignee and a due date when sent null', async () => {
    asAdmin();
    const runId = await run({ assignedTo: IDS.tech1, dueAt: soon() });
    const [first] = await stepsOf(runId);

    await ok(await patchStep(
      patch(`/api/sop-runs/${runId}/steps/${first!.id}`, { assignedTo: null, dueAt: null }),
      withParams({ runId, stepId: first!.id }),
    ));

    const [after] = await stepsOf(runId);
    expect(after!.assigned_to).toBeNull();
    expect(after!.due_at).toBeNull();
  });

  it('refuses a body with nothing in it', async () => {
    // A PATCH that would change nothing is a mistake, and a 200 would hide it.
    asAdmin();
    const runId = await run();
    const [first] = await stepsOf(runId);
    const { status } = await read(await patchStep(
      patch(`/api/sop-runs/${runId}/steps/${first!.id}`, {}),
      withParams({ runId, stepId: first!.id }),
    ));
    expect(status).toBe(400);
  });

  it('refuses a non-member here too', async () => {
    asAdmin();
    const runId = await run();
    const [first] = await stepsOf(runId);
    const { status, payload } = await read(await patchStep(
      patch(`/api/sop-runs/${runId}/steps/${first!.id}`, { assignedTo: IDS.admin2 }),
      withParams({ runId, stepId: first!.id }),
    ));
    expect(status).toBe(400);
    expect((payload.error as { message?: string }).message).toMatch(/not an active member/i);
  });

  it('refuses to reassign a step on a finished run', async () => {
    // A finished run is closed to every edit, not just to ticking boxes.
    asAdmin();
    const runId = await run();
    for (const step of await stepsOf(runId)) {
      await ok(await patchStep(
        patch(`/api/sop-runs/${runId}/steps/${step.id}`, { status: 'done' }),
        withParams({ runId, stepId: step.id }),
      ));
    }
    await ok(await patchRun(
      patch(`/api/sop-runs/${runId}`, { status: 'completed' }),
      withParams({ runId }),
    ));

    const [first] = await stepsOf(runId);
    const { status } = await read(await patchStep(
      patch(`/api/sop-runs/${runId}/steps/${first!.id}`, { assignedTo: IDS.tech1 }),
      withParams({ runId, stepId: first!.id }),
    ));
    expect(status).toBe(409);
  });
});

describe('My Tasks', () => {
  it('defaults to incomplete and mine', async () => {
    asAdmin();
    const mine = await run({ assignedTo: IDS.admin1, dueAt: soon() });
    const theirs = await run({ assignedTo: IDS.tech1, dueAt: soon() });

    // One of mine is done, so it should drop out of the default list.
    const [firstMine] = await stepsOf(mine);
    await ok(await patchStep(
      patch(`/api/sop-runs/${mine}/steps/${firstMine!.id}`, { status: 'done' }),
      withParams({ runId: mine, stepId: firstMine!.id }),
    ));

    const tasks = await withTenant(admin, (tx) => listMyTasks(tx));
    expect(tasks.every((t) => t.runId === mine),
      'somebody else"s steps are in my default list').toBe(true);
    expect(tasks.every((t) => t.status === 'pending'),
      'a finished step is still in the to-do list').toBe(true);
    expect(tasks).toHaveLength(2);

    // And the other person's list is their own, from the same function.
    const theirTasks = await withTenant(tech, (tx) => listMyTasks(tx));
    expect(theirTasks.every((t) => t.runId === theirs)).toBe(true);
    expect(theirTasks).toHaveLength(3);
  });

  it('counts what it lists', async () => {
    /*
     * The dashboard number and the page's list are two queries, and a count
     * that disagrees with the list it links to is worse than no count. One
     * overdue step, one due later, and one belonging to somebody else.
     */
    asAdmin();
    const mine = await run({ assignedTo: IDS.admin1, dueAt: past() });
    await run({ assignedTo: IDS.tech1, dueAt: past() });

    const counts = await withTenant(admin, (tx) => countMyOpenTasks(tx));
    const tasks = await withTenant(admin, (tx) => listMyTasks(tx));
    expect(counts.open).toBe(tasks.length);
    expect(counts.overdue).toBe(tasks.filter((t) => t.overdue).length);
    expect(counts.open).toBe(3);
    expect(counts.overdue).toBe(3);

    const [first] = await stepsOf(mine);
    await ok(await patchStep(
      patch(`/api/sop-runs/${mine}/steps/${first!.id}`, { status: 'done' }),
      withParams({ runId: mine, stepId: first!.id }),
    ));
    expect((await withTenant(admin, (tx) => countMyOpenTasks(tx))).open).toBe(2);
  });

  it('does not count a pending step on an abandoned run', async () => {
    /*
     * The run was given up on. Its steps are still `pending` — abandoning does
     * not touch them, by design, because the record of how far it got is the
     * point — so a query that asked only about step status would keep offering
     * them forever.
     */
    asAdmin();
    const runId = await run({ assignedTo: IDS.admin1, dueAt: soon() });
    expect((await withTenant(admin, (tx) => countMyOpenTasks(tx))).open).toBe(3);

    await ok(await patchRun(
      patch(`/api/sop-runs/${runId}`, { status: 'abandoned', reason: 'the server was already gone' }),
      withParams({ runId }),
    ));

    const steps = await stepsOf(runId);
    expect(steps.every((s) => s.status === 'pending'),
      'abandoning rewrote the steps, which it should not').toBe(true);
    expect((await withTenant(admin, (tx) => countMyOpenTasks(tx))).open,
      'an abandoned run"s steps are still being offered as work').toBe(0);
    expect(await withTenant(admin, (tx) => listMyTasks(tx))).toHaveLength(0);
  });

  it('orders the latest work first and undated work last', async () => {
    asAdmin();
    const late = await run({ assignedTo: IDS.admin1, dueAt: past() });
    const later = await run({ assignedTo: IDS.admin1, dueAt: soon() });
    const undated = await run({ assignedTo: IDS.admin1 });

    const tasks = await withTenant(admin, (tx) => listMyTasks(tx));
    const order = tasks.map((t) => t.runId);
    expect(order.indexOf(late)).toBeLessThan(order.indexOf(later));
    expect(order.indexOf(later)).toBeLessThan(order.indexOf(undated));
    expect(tasks[0]!.overdue, 'the overdue step should lead and be marked overdue').toBe(true);
    expect(tasks.at(-1)!.dueAt).toBeNull();
  });

  it('narrows to overdue, and widens to anyone', async () => {
    asAdmin();
    await run({ assignedTo: IDS.admin1, dueAt: past() });
    await run({ assignedTo: IDS.admin1, dueAt: soon() });
    await run({ assignedTo: IDS.tech1, dueAt: past() });

    const overdue = await withTenant(admin, (tx) => listMyTasks(tx, { state: 'overdue' }));
    expect(overdue).toHaveLength(3);
    expect(overdue.every((t) => t.overdue)).toBe(true);

    const anyone = await withTenant(admin, (tx) => listMyTasks(tx, { who: 'anyone' }));
    expect(anyone.length, 'the anyone filter should see every assigned step').toBe(9);
    expect(new Set(anyone.map((t) => t.assignedTo)).size).toBe(2);
  });

  it('includes a finished step under "everything" and names its run', async () => {
    asAdmin();
    // Due in the PAST, so the step below is both finished and late — which is
    // the only state in which "everything" can show whether a completed step
    // is still being called overdue.
    const runId = await run({ assignedTo: IDS.admin1, dueAt: past() });
    const [first] = await stepsOf(runId);
    await ok(await patchStep(
      patch(`/api/sop-runs/${runId}/steps/${first!.id}`, { status: 'done' }),
      withParams({ runId, stepId: first!.id }),
    ));

    const all = await withTenant(admin, (tx) => listMyTasks(tx, { state: 'all' }));
    expect(all).toHaveLength(3);
    const done = all.find((t) => t.status === 'done');
    expect(done, 'a completed step is missing from "everything"').toBeTruthy();
    expect(done!.organizationName).toBe('Acme Manufacturing');
    expect(done!.sopName).toBe('Offboard a user');
    expect(done!.runTitle).toBe('Offboard a user');

    /*
     * AND IT IS NOT OVERDUE, however late it was done.
     *
     * Found by sabotage: dropping `AND s.status = 'pending'` from the overdue
     * expression broke nothing, because the default filter only ever returns
     * pending steps and the redundancy is invisible there. Under "everything"
     * it is not redundant at all — it is the difference between a finished
     * list and a list painted red.
     */
    expect(done!.overdue, 'a completed step is still being reported as overdue').toBe(false);
    expect(all.filter((t) => t.overdue).length,
      'only the two steps still owed are overdue').toBe(2);
  });

  it('shows another tenant nothing', async () => {
    asAdmin();
    await run({ assignedTo: IDS.admin1, dueAt: soon() });

    expect(await withTenant(rival, (tx) => listMyTasks(tx, { who: 'anyone' }))).toHaveLength(0);
    expect((await withTenant(rival, (tx) => countMyOpenTasks(tx))).open).toBe(0);
  });
});

describe('who can be handed a task', () => {
  it('lists the tenant"s active members and nobody else', async () => {
    const people = await withTenant(admin, (tx) => listAssignableUsers(tx));
    const ids = people.map((p) => p.id);

    expect(ids, 'the tenant"s own members should be assignable').toContain(IDS.admin1);
    expect(ids).toContain(IDS.tech1);
    expect(ids, 'another tenant"s administrator is not assignable').not.toContain(IDS.admin2);
    expect(people.every((p) => p.name !== '')).toBe(true);
  });

  it('drops somebody whose membership was revoked', async () => {
    /*
     * NOT A TEST OF THIS QUERY'S OWN FILTER, and saying so matters. Deleting
     * `m.status = 'active'` from listAssignableUsers changes nothing here,
     * because app_user_rls_select is
     *
     *   id = helm.current_actor_id() OR EXISTS (… m.status = 'active' …)
     *
     * so a revoked colleague is already invisible in app_user. The predicate in
     * the query is a second lock on a door RLS has already shut. This asserts
     * the behaviour, which is what somebody opening the picker cares about; the
     * test below is the one that can see the query's own contribution.
     */
    const sql = superuserSql();
    try {
      await sql`
        UPDATE membership SET status = 'revoked'
        WHERE tenant_id = ${IDS.tenant1}::uuid AND user_id = ${IDS.tech1}::uuid
      `;
      const ids = (await withTenant(admin, (tx) => listAssignableUsers(tx))).map((p) => p.id);
      expect(ids).not.toContain(IDS.tech1);
      expect(ids).toContain(IDS.admin1);
    } finally {
      await sql`
        UPDATE membership SET status = 'active'
        WHERE tenant_id = ${IDS.tenant1}::uuid AND user_id = ${IDS.tech1}::uuid
      `;
      await sql.end({ timeout: 5 });
    }
  });

  it('drops somebody whose membership has EXPIRED, which RLS does not', async () => {
    /*
     * The gap between the two layers, and the only part of this query's filter
     * that is independently observable. app_user_rls_select asks about
     * `status` and says nothing about `expires_at` — so a membership that is
     * still marked active but ran out yesterday passes RLS, and only the
     * query's own predicate removes it.
     *
     * Found by sabotage: deleting `m.status = 'active'` broke no test, because
     * RLS covers it. Deleting the expires_at clause breaks this one.
     */
    const sql = superuserSql();
    try {
      await sql`
        UPDATE membership SET expires_at = now() - interval '1 day'
        WHERE tenant_id = ${IDS.tenant1}::uuid AND user_id = ${IDS.tech1}::uuid
      `;
      const ids = (await withTenant(admin, (tx) => listAssignableUsers(tx))).map((p) => p.id);
      expect(ids, 'an expired membership is still being offered a new task')
        .not.toContain(IDS.tech1);
      expect(ids).toContain(IDS.admin1);
    } finally {
      await sql`
        UPDATE membership SET expires_at = NULL
        WHERE tenant_id = ${IDS.tenant1}::uuid AND user_id = ${IDS.tech1}::uuid
      `;
      await sql.end({ timeout: 5 });
    }
  });
});

describe('the run page', () => {
  it('carries the assignment through to what it renders', async () => {
    asAdmin();
    const due = soon();
    const runId = await run({ assignedTo: IDS.tech1, dueAt: due });

    const view = await withTenant(admin, (tx) => readRun(tx, runId));
    expect(view!.assignedTo, 'the run header should name its assignee').toBe('Tier One Tech');
    expect(view!.dueAt).toBe(due);
    expect(view!.steps[0]!.assignedTo).toBe('Tier One Tech');
    expect(view!.steps[0]!.assignedToId,
      'the picker needs the id, not just the name').toBe(IDS.tech1);
    expect(view!.steps[0]!.overdue, 'a step due tomorrow is not overdue').toBe(false);
  });

  it('marks an overdue step overdue, and stops once it is done', async () => {
    asAdmin();
    const runId = await run({ assignedTo: IDS.admin1, dueAt: past() });
    const before = await withTenant(admin, (tx) => readRun(tx, runId));
    expect(before!.steps.every((s) => s.overdue)).toBe(true);

    const [first] = await stepsOf(runId);
    await ok(await patchStep(
      patch(`/api/sop-runs/${runId}/steps/${first!.id}`, { status: 'done' }),
      withParams({ runId, stepId: first!.id }),
    ));

    // A finished step is not overdue, however late it was: overdue means
    // "still owed", and the step is not owed any more.
    const after = await withTenant(admin, (tx) => readRun(tx, runId));
    expect(after!.steps[0]!.overdue,
      'a completed step is still being reported as overdue').toBe(false);
    expect(after!.steps[1]!.overdue).toBe(true);
  });
});
