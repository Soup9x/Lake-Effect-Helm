/**
 * Checklists, end to end, for the first time.
 *
 * WHAT WAS MISSING, and it was not a column. 0090 modelled procedures, their
 * immutable published versions, runs that snapshot the version they executed
 * against, and per-step execution state — and nothing in the application ever
 * touched `sop_version`, `sop_run` or `sop_run_step`. The only SOP reference in
 * src/ was the export collector reading templates; the category page said in a
 * comment that "SOPs are the one category with no create path"; the integration
 * fixture had no SOP rows at all. A complete model with no way in.
 *
 * FOUR THINGS ASSERTED HERE BEYOND THE HAPPY PATH:
 *
 *   1. A RUN FOLLOWS THE VERSION IT STARTED FROM, FOREVER. This is the whole
 *      point of the snapshot and the one property worth testing hardest:
 *      editing or re-publishing the template after a run begins must not change
 *      a single word of that run.
 *   2. THE HASH IS OVER THE STORED jsonb, NOT OVER A SERIALISED STRING. The
 *      column exists so an export can assert "this run followed exactly this
 *      text", which only works if a reader can recompute it from the row.
 *   3. PUBLISHING REFUSES AN EMPTY LIST WHILE SAVING ONE DOES NOT. A draft
 *      being rewritten passes through empty; a runnable procedure cannot be.
 *   4. A FINISHED RUN IS CLOSED. Editing a step afterwards would rewrite the
 *      evidence the run exists to be.
 */
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { withTenant } from '../../src/lib/db/client';
import { actor, connectPools, disconnectPools, IDS, resetDatabase, superuserSql } from './harness';
import { POST as createSop } from '../../src/app/api/sops/route';
import { PATCH as patchSop } from '../../src/app/api/sops/[sopId]/route';
import { PUT as putSteps } from '../../src/app/api/sops/[sopId]/steps/route';
import { POST as publishVersion } from '../../src/app/api/sops/[sopId]/versions/route';
import { POST as startRun } from '../../src/app/api/sop-runs/route';
import { PATCH as patchRun } from '../../src/app/api/sop-runs/[runId]/route';
import { PATCH as patchStep } from '../../src/app/api/sop-runs/[runId]/steps/[stepId]/route';
import { listRunsForOrganization, readRun, readTemplate } from '../../src/lib/sops/queries';

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

const send = (method: string) => (url: string, payload?: unknown) =>
  new NextRequest(new Request(`http://helm.test${url}`, {
    method,
    ...(payload === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
  }));
const post = send('POST');
const put = send('PUT');
const patch = send('PATCH');
const withParams = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

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

async function ok(response: Response): Promise<Record<string, unknown>> {
  const { status, payload, raw } = await read(response);
  expect(status, raw).toBe(200);
  return payload;
}

/**
 * Back to the fixture's state, as far as the schema permits.
 *
 * A PUBLISHED VERSION CANNOT BE DELETED, BY ANYBODY. sop_version carries
 * helm.deny_mutation() on BEFORE UPDATE OR DELETE, and a cascade fires row
 * triggers — so deleting the asset_node of a published procedure fails with
 * "DELETE on sop_version is not permitted", even as the superuser. That is the
 * append-only guarantee working, and it is also why this helper cannot simply
 * truncate: tests that publish must each use their OWN procedure, so nothing
 * needs un-publishing. freshProcedure() below exists for that.
 *
 * Unpublished procedures a test created ARE removable, since there is no
 * version row to refuse the cascade. Runs are removable outright.
 */
async function resetChecklists(): Promise<void> {
  const sql = superuserSql();
  try {
    await sql`DELETE FROM sop_run`;
    await sql`
      DELETE FROM asset_node
      WHERE node_type = 'sop'
        AND id NOT IN (${IDS.sopOffboard}::uuid, ${IDS.sopRestore}::uuid)
        AND NOT EXISTS (SELECT 1 FROM sop_version v WHERE v.sop_id = asset_node.id)
    `;
    // The fixture procedure's step list, restored. Its published v1 is left
    // alone — it cannot be removed, and tests that publish do not touch it.
    await sql`DELETE FROM sop_step WHERE sop_id = ${IDS.sopOffboard}::uuid`;
    await sql`
      INSERT INTO sop_step (tenant_id, sop_id, position, title, body) VALUES
        (${IDS.tenant1}::uuid, ${IDS.sopOffboard}::uuid, 1, 'Disable the account',
         'In the directory, not just the mailbox.'),
        (${IDS.tenant1}::uuid, ${IDS.sopOffboard}::uuid, 2, 'Forward the mailbox', NULL),
        (${IDS.tenant1}::uuid, ${IDS.sopOffboard}::uuid, 3, 'Collect the laptop',
         'Log the asset tag against the ticket.')
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * A procedure of this test's own, with three steps, published as v1.
 *
 * Used by every test that publishes or re-publishes, because the fixture's
 * procedure cannot be returned to version 1 once a test has moved it on — see
 * resetChecklists. Each caller gets a fresh id, so version numbers are
 * predictable and no test can be perturbed by another's publishing.
 */
async function freshProcedure(name: string): Promise<string> {
  const sopId = (await ok(await createSop(post('/api/sops', {
    organizationId: IDS.orgAcme, name,
  })))).sopId as string;
  await ok(await putSteps(
    put(`/api/sops/${sopId}/steps`, {
      steps: [
        { title: 'Disable the account', body: 'In the directory, not just the mailbox.' },
        { title: 'Forward the mailbox' },
        { title: 'Collect the laptop', body: 'Log the asset tag against the ticket.' },
      ],
    }),
    withParams({ sopId }),
  ));
  await ok(await publishVersion(post(`/api/sops/${sopId}/versions`, {}), withParams({ sopId })));
  return sopId;
}

/**
 * A 403 that the ROUTE refused, naming the permission it wanted.
 *
 * Asserting the status alone proves nothing about the gate. Every actor who
 * lacks sop:write or sop:execute is ALSO below the role rank the matching RLS
 * policy requires — tier1 is rank 40 against `sop`'s 60, client_read_only is
 * rank 10 against `sop_run`'s 40 — so deleting a route's `permissions` option
 * leaves the request refused by the database, with the same 403. Both layers
 * saying no is the design; a test that cannot tell which one spoke is not a
 * test of the gate, and deleting `{ permissions: ['sop:execute'] }` from the
 * run route passed the whole suite.
 *
 * The messages differ, so the message is what distinguishes them. This asserts
 * the gate's own words rather than the policy refusal's, so it keeps passing
 * when the raw-message leak from that branch is fixed.
 */
async function refusedByGate(response: Response, permission: string): Promise<void> {
  const { status, payload } = await read(response);
  const error = (payload.error ?? {}) as { code?: string; message?: string };
  expect(status).toBe(403);
  expect(error.code).toBe('forbidden');
  expect(
    error.message,
    `this was refused, but not by the route's ${permission} gate — `
    + 'the policy caught it first, so the gate is untested',
  ).toBe(`missing permission: ${permission}`);
}

const asAdmin = () => { currentUser = USERS.admin; };

beforeAll(async () => {
  resetDatabase();
  connectPools();
  useSessionResolver(async () => currentUser);
}, 120_000);

afterEach(async () => { currentUser = null; await resetChecklists(); });
afterAll(async () => { await disconnectPools(); });

// ---------------------------------------------------------------------------

describe('writing a procedure down', () => {
  it('creates the node and its procedure row together', async () => {
    asAdmin();
    const sopId = (await ok(await createSop(post('/api/sops', {
      organizationId: IDS.orgAcme,
      name: 'Rebuild a workstation',
      category: 'Lifecycle',
      summary: 'From bare metal.',
      reviewIntervalDays: 365,
    })))).sopId as string;

    const rows = await withTenant(admin, (tx) => tx<{
      name: string; node_type: string; category: string | null; current_version: number;
      review_interval_days: number | null;
    }[]>`
      SELECT n.name, n.node_type::text, s.category, s.current_version, s.review_interval_days
      FROM sop s JOIN asset_node n ON n.id = s.id WHERE s.id = ${sopId}::uuid
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: 'Rebuild a workstation',
      node_type: 'sop',
      category: 'Lifecycle',
      current_version: 0,
      review_interval_days: 365,
    });
  });

  it('refuses a client in another tenant', async () => {
    asAdmin();
    expect((await read(await createSop(post('/api/sops', {
      organizationId: IDS.orgContoso, name: 'Not yours',
    })))).status).toBe(400);
  });

  it('is refused to an actor without sop:write', async () => {
    // tier1 holds sop:read and sop:execute and not sop:write — technicians run
    // procedures, senior staff write them.
    currentUser = USERS.tech;
    await refusedByGate(await createSop(post('/api/sops', {
      organizationId: IDS.orgAcme, name: 'Nope',
    })), 'sop:write');
  });

  it('records a review without letting it be backdated', async () => {
    asAdmin();
    await ok(await patchSop(
      patch(`/api/sops/${IDS.sopOffboard}`, { reviewedNow: true }),
      withParams({ sopId: IDS.sopOffboard }),
    ));
    const [row] = await withTenant(admin, (tx) => tx<{ reviewed: boolean }[]>`
      SELECT last_reviewed_at > now() - interval '1 minute' AS reviewed
      FROM sop WHERE id = ${IDS.sopOffboard}::uuid
    `);
    expect(row!.reviewed).toBe(true);
  });

  it('has no way to say a review happened last March', async () => {
    /*
     * "A review you can backdate is a review you can fabricate" is the route's
     * stated reason for `reviewedNow: z.literal(true)`, and the test above
     * cannot see it: it sends `true` and gets now(), which is also what a
     * route that accepted a date would do. Widening the field to take one
     * passed the entire suite.
     *
     * So this sends a date. The only acceptable answer is a 400 — and
     * last_reviewed_at must not move, because a refusal that still wrote
     * something would be worse than accepting it honestly.
     */
    asAdmin();
    const before = await withTenant(admin, (tx) => tx<{ at: Date | null }[]>`
      SELECT last_reviewed_at AS at FROM sop WHERE id = ${IDS.sopRestore}::uuid
    `);

    for (const payload of [
      { reviewedNow: '2020-03-01T00:00:00Z' },
      { reviewedNow: false },
      { lastReviewedAt: '2020-03-01T00:00:00Z' },
    ]) {
      const { status } = await read(await patchSop(
        patch(`/api/sops/${IDS.sopRestore}`, payload),
        withParams({ sopId: IDS.sopRestore }),
      ));
      expect(status, `${JSON.stringify(payload)} should not be a way to set a review date`)
        .toBe(400);
    }

    const after = await withTenant(admin, (tx) => tx<{ at: Date | null }[]>`
      SELECT last_reviewed_at AS at FROM sop WHERE id = ${IDS.sopRestore}::uuid
    `);
    expect(after[0]!.at, 'a refused review still moved the date')
      .toEqual(before[0]!.at);
  });
});

describe('the step list', () => {
  it('replaces the whole list, renumbering from one', async () => {
    asAdmin();
    await ok(await putSteps(
      put(`/api/sops/${IDS.sopOffboard}/steps`, {
        steps: [{ title: 'Second thing' }, { title: 'First thing', body: 'detail' }],
      }),
      withParams({ sopId: IDS.sopOffboard }),
    ));

    const steps = await withTenant(admin, (tx) => tx<{
      position: number; title: string; body: string | null;
    }[]>`
      SELECT position, title, body FROM sop_step
      WHERE sop_id = ${IDS.sopOffboard}::uuid ORDER BY position
    `);
    expect(steps.map((s) => [s.position, s.title]))
      .toEqual([[1, 'Second thing'], [2, 'First thing']]);
    expect(steps[1]!.body).toBe('detail');
  });

  it('survives a reorder, which an in-place UPDATE would not', async () => {
    /*
     * sop_step_position_uk UNIQUE (sop_id, position) is not DEFERRABLE, so
     * shifting positions with an UPDATE can collide halfway through depending
     * on the order rows are visited. Reversing a three-step list is the
     * smallest case that would trip it.
     */
    asAdmin();
    const reversed = [{ title: 'Collect the laptop' }, { title: 'Forward the mailbox' },
      { title: 'Disable the account' }];
    await ok(await putSteps(
      put(`/api/sops/${IDS.sopOffboard}/steps`, { steps: reversed }),
      withParams({ sopId: IDS.sopOffboard }),
    ));
    const steps = await withTenant(admin, (tx) => tx<{ title: string }[]>`
      SELECT title FROM sop_step WHERE sop_id = ${IDS.sopOffboard}::uuid ORDER BY position
    `);
    expect(steps.map((s) => s.title)).toEqual(reversed.map((s) => s.title));
  });

  it('accepts an empty list as a draft', async () => {
    asAdmin();
    await ok(await putSteps(
      put(`/api/sops/${IDS.sopOffboard}/steps`, { steps: [] }),
      withParams({ sopId: IDS.sopOffboard }),
    ));
    const steps = await withTenant(admin, (tx) => tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM sop_step WHERE sop_id = ${IDS.sopOffboard}::uuid
    `);
    expect(steps[0]!.n).toBe(0);
  });

  it('does not delete anything when the procedure is not writable', async () => {
    /*
     * The ordering that matters: the route proves the procedure is readable
     * BEFORE deleting. Without that check a PUT against another tenant's
     * procedure would delete nothing, insert nothing and answer 200 — a no-op
     * that reads as success.
     */
    asAdmin();
    const refused = await read(await putSteps(
      put(`/api/sops/${IDS.contosoFirewall}/steps`, { steps: [{ title: 'x' }] }),
      withParams({ sopId: IDS.contosoFirewall }),
    ));
    expect(refused.status).toBe(404);
  });

  it('refuses a blank step title', async () => {
    asAdmin();
    const refused = await read(await putSteps(
      put(`/api/sops/${IDS.sopOffboard}/steps`, { steps: [{ title: '  ' }] }),
      withParams({ sopId: IDS.sopOffboard }),
    ));
    expect(refused.status).toBe(400);
  });
});

describe('publishing a version', () => {
  it('freezes the steps and advances current_version', async () => {
    asAdmin();
    const sopId = await freshProcedure('Freeze me');
    const published = await ok(await publishVersion(
      post(`/api/sops/${sopId}/versions`, { changeNote: 'Tightened wording' }),
      withParams({ sopId }),
    ));
    expect(published.version).toBe(2);
    expect(published.steps).toBe(3);

    const [row] = await withTenant(admin, (tx) => tx<{ current_version: number; n: number }[]>`
      SELECT s.current_version, (SELECT count(*)::int FROM sop_version WHERE sop_id = s.id) AS n
      FROM sop s WHERE s.id = ${sopId}::uuid
    `);
    expect(row!.current_version).toBe(2);
    expect(row!.n).toBe(2);
  });

  it('hashes the STORED jsonb, so a reader can recompute it', async () => {
    /*
     * snapshot_sha256 is "sha256 over the canonical snapshot", and the column
     * exists so an export can assert "this run followed exactly this text".
     * That only works if the hash is over what the row holds — jsonb, whose
     * key order Postgres normalises — rather than over whatever string the
     * writing process happened to serialise.
     */
    asAdmin();
    const sopId = await freshProcedure('Hash me');

    const [row] = await withTenant(admin, (tx) => tx<{ matches: boolean; len: number }[]>`
      SELECT snapshot_sha256 = digest(snapshot::text, 'sha256') AS matches,
             octet_length(snapshot_sha256) AS len
      FROM sop_version WHERE sop_id = ${sopId}::uuid AND version = 1
    `);
    expect(row!.matches, 'the stored hash does not match the stored snapshot').toBe(true);
    expect(row!.len).toBe(32);
  });

  it('refuses to publish a procedure with no steps', async () => {
    asAdmin();
    // A brand-new procedure: never published, no steps. The honest shape of
    // "this is not runnable yet", rather than a published one emptied out.
    const sopId = (await ok(await createSop(post('/api/sops', {
      organizationId: IDS.orgAcme, name: 'Empty draft',
    })))).sopId as string;
    const refused = await read(await publishVersion(
      post(`/api/sops/${sopId}/versions`, {}),
      withParams({ sopId }),
    ));
    expect(refused.status).toBe(400);
    expect(refused.raw).toContain('step');
  });

  it('cannot be revised once published', async () => {
    // sop_version_append_only, by trigger. Correcting a version means
    // publishing the next one.
    await expect(
      withTenant(admin, (tx) => tx`
        UPDATE sop_version SET change_note = 'rewritten'
        WHERE sop_id = ${IDS.sopOffboard}::uuid AND version = 1
      `),
    ).rejects.toThrow();
  });

  it('is refused to an actor without sop:write', async () => {
    currentUser = USERS.tech;
    await refusedByGate(await publishVersion(
      post(`/api/sops/${IDS.sopOffboard}/versions`, {}),
      withParams({ sopId: IDS.sopOffboard }),
    ), 'sop:write');
  });
});

describe('the warning that the steps on screen are not the steps a run gets', () => {
  it('is quiet right after publishing and speaks after an edit', async () => {
    /*
     * `unpublishedChanges` is what the template card turns into "a run started
     * now follows the published version", and the integration test above makes
     * that sentence true. This asserts the card is actually told.
     *
     * Compared by value rather than read from a dirty flag — there is no such
     * column — so it has to be exercised in both directions: a procedure whose
     * list matches its snapshot must not nag, and one edited since must.
     */
    asAdmin();
    const sopId = await freshProcedure('Edited since publishing');

    const justPublished = await withTenant(admin, (tx) => readTemplate(tx, sopId));
    expect(justPublished.current?.version).toBe(1);
    expect(justPublished.unpublishedChanges,
      'nothing was edited after publishing, so there is nothing to warn about').toBe(false);

    // A change that keeps the step COUNT, so a length comparison alone cannot
    // see it. Only reading the titles back finds this one.
    await ok(await putSteps(
      put(`/api/sops/${sopId}/steps`, {
        steps: [
          { title: 'Disable the account', body: 'In the directory, not just the mailbox.' },
          { title: 'Forward the mailbox to the manager' },
          { title: 'Collect the laptop', body: 'Log the asset tag against the ticket.' },
        ],
      }),
      withParams({ sopId }),
    ));

    const edited = await withTenant(admin, (tx) => readTemplate(tx, sopId));
    expect(edited.unpublishedChanges,
      'the live list differs from the published snapshot and nothing says so').toBe(true);
    expect(edited.current?.steps,
      'the published version"s step count should come from its snapshot').toBe(3);

    // And publishing again settles it, which is the way out of the warning.
    await ok(await publishVersion(post(`/api/sops/${sopId}/versions`, {}), withParams({ sopId })));
    const republished = await withTenant(admin, (tx) => readTemplate(tx, sopId));
    expect(republished.current?.version).toBe(2);
    expect(republished.unpublishedChanges,
      'publishing the live list should clear the warning').toBe(false);
  });
});

describe('starting a run', () => {
  it('copies the published steps onto the run', async () => {
    asAdmin();
    const started = await ok(await startRun(post('/api/sop-runs', {
      sopId: IDS.sopOffboard, organizationId: IDS.orgAcme, ticketRef: 'TKT-1',
    })));
    expect(started.steps).toBe(3);
    expect(started.version).toBe(1);

    const steps = await withTenant(admin, (tx) => tx<{
      position: number; title: string; status: string;
    }[]>`
      SELECT position, title, status::text FROM sop_run_step
      WHERE run_id = ${started.runId as string}::uuid ORDER BY position
    `);
    expect(steps.map((s) => s.title))
      .toEqual(['Disable the account', 'Forward the mailbox', 'Collect the laptop']);
    expect(steps.every((s) => s.status === 'pending')).toBe(true);
  });

  it('refuses a procedure that was never published', async () => {
    // The fixture's second procedure has steps and current_version 0. There is
    // no frozen text to run against, which is the right refusal.
    asAdmin();
    const refused = await read(await startRun(post('/api/sop-runs', {
      sopId: IDS.sopRestore, organizationId: IDS.orgAcme,
    })));
    expect(refused.status).toBe(404);
  });

  it('is refused to an actor without sop:execute', async () => {
    currentUser = USERS.viewer;
    await refusedByGate(await startRun(post('/api/sop-runs', {
      sopId: IDS.sopOffboard, organizationId: IDS.orgAcme,
    })), 'sop:execute');
  });

  it('defaults the title to the procedure"s name', async () => {
    asAdmin();
    const started = await ok(await startRun(post('/api/sop-runs', {
      sopId: IDS.sopOffboard, organizationId: IDS.orgAcme,
    })));
    const [row] = await withTenant(admin, (tx) => tx<{ title: string }[]>`
      SELECT title FROM sop_run WHERE id = ${started.runId as string}::uuid
    `);
    expect(row!.title).toBe('Offboard a user');
  });
});

describe('a run follows the version it started from", forever', () => {
  it('is untouched by later edits and later publishes', async () => {
    /*
     * THE TEST THIS WHOLE GROUP EXISTS FOR. 0090: "a run snapshots the SOP
     * version it executed against. Pointing a run at a living, editable
     * document would let today's edit rewrite yesterday's evidence."
     *
     * So: start a run, then rewrite the template completely and publish it
     * twice. The run's steps must not move by a single word, and it must still
     * report the version it began with.
     */
    asAdmin();
    const sopId = await freshProcedure('Pin me');
    const started = await ok(await startRun(post('/api/sop-runs', {
      sopId, organizationId: IDS.orgAcme,
    })));
    const runId = started.runId as string;

    await ok(await putSteps(
      put(`/api/sops/${sopId}/steps`, { steps: [{ title: 'Something else entirely' }] }),
      withParams({ sopId }),
    ));
    await ok(await publishVersion(post(`/api/sops/${sopId}/versions`, {}), withParams({ sopId })));
    await ok(await putSteps(
      put(`/api/sops/${sopId}/steps`, { steps: [{ title: 'And again' }] }),
      withParams({ sopId }),
    ));
    await ok(await publishVersion(post(`/api/sops/${sopId}/versions`, {}), withParams({ sopId })));

    const steps = await withTenant(admin, (tx) => tx<{ title: string }[]>`
      SELECT title FROM sop_run_step WHERE run_id = ${runId}::uuid ORDER BY position
    `);
    expect(steps.map((s) => s.title),
      'the run was rewritten by a later edit to the template')
      .toEqual(['Disable the account', 'Forward the mailbox', 'Collect the laptop']);

    const [run] = await withTenant(admin, (tx) => tx<{ version: number }[]>`
      SELECT v.version FROM sop_run r JOIN sop_version v ON v.id = r.sop_version_id
      WHERE r.id = ${runId}::uuid
    `);
    expect(run!.version, 'the run moved onto a later version').toBe(1);
  });

  it('follows the PUBLISHED version, not an unpublished edit', async () => {
    /*
     * The companion to the test above, and the one that actually pins the step
     * copy to the snapshot.
     *
     * The test above edits the template AFTER the run starts, so it passes
     * even if the run copied its steps from the live sop_step rows — at the
     * moment of the copy those rows still agreed with the published snapshot.
     * Reading sop_step instead of version.snapshot survived that test
     * untouched, which is why this one exists.
     *
     * Here the edit lands BETWEEN publish and run. The draft and the published
     * snapshot now disagree, so only a run that reads the snapshot can be
     * right. This is also the claim the template card makes to the person
     * pressing the button — "a run started now follows the published version" —
     * so a regression here turns that sentence into a lie.
     */
    asAdmin();
    const sopId = await freshProcedure('Draft and published disagree');

    await ok(await putSteps(
      put(`/api/sops/${sopId}/steps`, {
        steps: [{ title: 'An unpublished idea' }, { title: 'A second unpublished idea' }],
      }),
      withParams({ sopId }),
    ));

    const started = await ok(await startRun(post('/api/sop-runs', {
      sopId, organizationId: IDS.orgAcme,
    })));
    expect(started.version, 'the run did not start from the published version').toBe(1);
    expect(started.steps, 'the run took the draft"s step count, not the published one').toBe(3);

    const steps = await withTenant(admin, (tx) => tx<{ title: string }[]>`
      SELECT title FROM sop_run_step WHERE run_id = ${started.runId as string}::uuid
      ORDER BY position
    `);
    expect(steps.map((s) => s.title),
      'the run copied the live draft rather than the published snapshot')
      .toEqual(['Disable the account', 'Forward the mailbox', 'Collect the laptop']);
  });

  it('starts a NEW run from the newest version', async () => {
    // The companion: pinning an existing run must not freeze the procedure.
    asAdmin();
    const sopId = await freshProcedure('Advance me');
    await ok(await publishVersion(post(`/api/sops/${sopId}/versions`, {}), withParams({ sopId })));
    const started = await ok(await startRun(post('/api/sop-runs', {
      sopId, organizationId: IDS.orgAcme,
    })));
    expect(started.version).toBe(2);
  });
});

describe('working down a run', () => {
  async function freshRun(): Promise<string> {
    asAdmin();
    return (await ok(await startRun(post('/api/sop-runs', {
      sopId: IDS.sopOffboard, organizationId: IDS.orgAcme,
    })))).runId as string;
  }

  async function stepsOf(runId: string) {
    return withTenant(admin, (tx) => tx<{
      id: string; position: number; status: string; note: string | null;
      completed_at: Date | null; completed_by: string | null;
    }[]>`
      SELECT id, position, status::text, note, completed_at, completed_by
      FROM sop_run_step WHERE run_id = ${runId}::uuid ORDER BY position
    `);
  }

  it('checks a step off and records who and when', async () => {
    const runId = await freshRun();
    const [first] = await stepsOf(runId);

    await ok(await patchStep(
      patch(`/api/sop-runs/${runId}/steps/${first!.id}`, { status: 'done' }),
      withParams({ runId, stepId: first!.id }),
    ));

    const [after] = await stepsOf(runId);
    expect(after!.status).toBe('done');
    // sop_run_step_terminal_has_actor requires completed_at for every terminal
    // status, so this is a constraint as much as a nicety.
    expect(after!.completed_at).not.toBeNull();
    expect(after!.completed_by).toBe(IDS.admin1);
  });

  it('undoes a check, clearing the timestamp with it', async () => {
    const runId = await freshRun();
    const [first] = await stepsOf(runId);
    await ok(await patchStep(
      patch(`/api/sop-runs/${runId}/steps/${first!.id}`, { status: 'done' }),
      withParams({ runId, stepId: first!.id }),
    ));
    await ok(await patchStep(
      patch(`/api/sop-runs/${runId}/steps/${first!.id}`, { status: 'pending', note: null }),
      withParams({ runId, stepId: first!.id }),
    ));

    const [after] = await stepsOf(runId);
    expect(after!.status).toBe('pending');
    expect(after!.completed_at, 'unticking left a timestamp saying it was finished').toBeNull();
    expect(after!.completed_by).toBeNull();
  });

  it('refuses to skip a required step without a reason', async () => {
    const runId = await freshRun();
    const [first] = await stepsOf(runId);
    const refused = await read(await patchStep(
      patch(`/api/sop-runs/${runId}/steps/${first!.id}`, { status: 'skipped' }),
      withParams({ runId, stepId: first!.id }),
    ));
    expect(refused.status).toBe(400);
    expect((await stepsOf(runId))[0]!.status).toBe('pending');
  });

  it('skips with a reason, and keeps it', async () => {
    const runId = await freshRun();
    const [first] = await stepsOf(runId);
    await ok(await patchStep(
      patch(`/api/sop-runs/${runId}/steps/${first!.id}`, {
        status: 'skipped', note: 'Account was already disabled.',
      }),
      withParams({ runId, stepId: first!.id }),
    ));
    const [after] = await stepsOf(runId);
    expect(after!.status).toBe('skipped');
    expect(after!.note).toBe('Account was already disabled.');
  });

  it('refuses a status the UI has no control for', async () => {
    // The enum has seven values; this route drives three. The other four get
    // no control until something is built that means them.
    const runId = await freshRun();
    const [first] = await stepsOf(runId);
    for (const status of ['blocked', 'failed', 'not_applicable', 'in_progress']) {
      expect((await read(await patchStep(
        patch(`/api/sop-runs/${runId}/steps/${first!.id}`, { status }),
        withParams({ runId, stepId: first!.id }),
      ))).status, `${status} should not be drivable`).toBe(400);
    }
  });

  it('refuses a step id from another run', async () => {
    const runId = await freshRun();
    const otherId = await freshRun();
    const [otherStep] = await stepsOf(otherId);
    expect((await read(await patchStep(
      patch(`/api/sop-runs/${runId}/steps/${otherStep!.id}`, { status: 'done' }),
      withParams({ runId, stepId: otherStep!.id }),
    ))).status).toBe(404);
  });

  it('will not complete while a required step is pending', async () => {
    const runId = await freshRun();
    const refused = await read(await patchRun(
      patch(`/api/sop-runs/${runId}`, { status: 'completed' }),
      withParams({ runId }),
    ));
    expect(refused.status).toBe(400);
    expect(refused.raw).toContain('required');
  });

  it('completes once every required step is settled', async () => {
    const runId = await freshRun();
    for (const step of await stepsOf(runId)) {
      await ok(await patchStep(
        patch(`/api/sop-runs/${runId}/steps/${step.id}`, { status: 'done' }),
        withParams({ runId, stepId: step.id }),
      ));
    }
    const done = await ok(await patchRun(
      patch(`/api/sop-runs/${runId}`, { status: 'completed' }),
      withParams({ runId }),
    ));
    expect(done.status).toBe('completed');

    const [row] = await withTenant(admin, (tx) => tx<{ completed_by: string | null }[]>`
      SELECT completed_by FROM sop_run WHERE id = ${runId}::uuid
    `);
    expect(row!.completed_by).toBe(IDS.admin1);
  });

  it('closes a finished run to further step edits', async () => {
    const runId = await freshRun();
    const steps = await stepsOf(runId);
    for (const step of steps) {
      await ok(await patchStep(
        patch(`/api/sop-runs/${runId}/steps/${step.id}`, { status: 'done' }),
        withParams({ runId, stepId: step.id }),
      ));
    }
    await ok(await patchRun(
      patch(`/api/sop-runs/${runId}`, { status: 'completed' }),
      withParams({ runId }),
    ));

    // Editing a step after the fact would rewrite the evidence the run is.
    const refused = await read(await patchStep(
      patch(`/api/sop-runs/${runId}/steps/${steps[0]!.id}`, { status: 'pending' }),
      withParams({ runId, stepId: steps[0]!.id }),
    ));
    expect(refused.status).toBe(409);
    expect((await stepsOf(runId))[0]!.status).toBe('done');
  });

  it('refuses to complete a run twice', async () => {
    const runId = await freshRun();
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
    expect((await read(await patchRun(
      patch(`/api/sop-runs/${runId}`, { status: 'completed' }),
      withParams({ runId }),
    ))).status).toBe(409);
  });

  it('abandons only with a reason, and keeps it', async () => {
    const runId = await freshRun();
    expect((await read(await patchRun(
      patch(`/api/sop-runs/${runId}`, { status: 'abandoned' }),
      withParams({ runId }),
    ))).status, 'abandoning without a reason tells nobody anything').toBe(400);

    await ok(await patchRun(
      patch(`/api/sop-runs/${runId}`, { status: 'abandoned', reason: 'Server was already gone.' }),
      withParams({ runId }),
    ));
    const [row] = await withTenant(admin, (tx) => tx<{
      status: string; abandoned_reason: string | null;
    }[]>`
      SELECT status::text, abandoned_reason FROM sop_run WHERE id = ${runId}::uuid
    `);
    expect(row!.status).toBe('abandoned');
    expect(row!.abandoned_reason).toBe('Server was already gone.');
  });
});

describe('what the pages read', () => {
  /*
   * The queries behind the client page and the run page, asserted directly.
   *
   * The route tests above read sop_run_step with their own ORDER BY, which
   * proves the rows are right and says nothing about the functions the pages
   * actually call. Dropping `ORDER BY s.position` from readRun and inverting
   * the open-first ordering in listRunsForOrganization both passed every test
   * in this suite and in pages.test.ts — the first because three freshly
   * inserted rows come back in insert order anyway, the second because the
   * fixture had one run and a list of one is sorted.
   */
  it('puts open runs above finished ones, with the progress the view computes', async () => {
    asAdmin();
    const finished = (await ok(await startRun(post('/api/sop-runs', {
      sopId: IDS.sopOffboard, organizationId: IDS.orgAcme, title: 'Finished first',
    })))).runId as string;

    const finishedSteps = await withTenant(admin, (tx) => tx<{ id: string }[]>`
      SELECT id FROM sop_run_step WHERE run_id = ${finished}::uuid ORDER BY position
    `);
    for (const step of finishedSteps) {
      await ok(await patchStep(
        patch(`/api/sop-runs/${finished}/steps/${step.id}`, { status: 'done' }),
        withParams({ runId: finished, stepId: step.id }),
      ));
    }
    await ok(await patchRun(
      patch(`/api/sop-runs/${finished}`, { status: 'completed' }),
      withParams({ runId: finished }),
    ));

    // Started SECOND and still open, so recency alone would put it below.
    const open = (await ok(await startRun(post('/api/sop-runs', {
      sopId: IDS.sopOffboard, organizationId: IDS.orgAcme, title: 'Open second',
    })))).runId as string;
    const openSteps = await withTenant(admin, (tx) => tx<{ id: string }[]>`
      SELECT id FROM sop_run_step WHERE run_id = ${open}::uuid ORDER BY position
    `);
    await ok(await patchStep(
      patch(`/api/sop-runs/${open}/steps/${openSteps[0]!.id}`, { status: 'done' }),
      withParams({ runId: open, stepId: openSteps[0]!.id }),
    ));

    const runs = await withTenant(admin, (tx) => listRunsForOrganization(tx, IDS.orgAcme));

    expect(runs.map((r) => r.id), 'a finished run was listed above an open one')
      .toEqual([open, finished]);

    const [first, second] = runs;
    expect(first!.status).toBe('in_progress');
    expect(first!.sopName, 'the run list should name the procedure, not just the run')
      .toBe('Offboard a user');
    expect({ total: first!.totalSteps, done: first!.doneSteps, left: first!.remainingRequired })
      .toEqual({ total: 3, done: 1, left: 2 });
    expect({ total: second!.totalSteps, done: second!.doneSteps, left: second!.remainingRequired })
      .toEqual({ total: 3, done: 3, left: 0 });
  });

  it('reads a run"s steps in the order they are meant to be done', async () => {
    /*
     * The step order has to come from the function the run page calls, and the
     * physical order has to DISAGREE with the position order or the assertion
     * proves nothing. Getting that disagreement took measuring rather than
     * guessing:
     *
     *   checking a step off does NOT disturb it. The query plans as a bitmap
     *   index scan over sop_run_step_run_idx (run_id, position), and the update
     *   is HOT, so the row keeps its line pointer and the scan still visits it
     *   in its original slot — ctid moved from (0,1) to (0,4) and the row still
     *   came back first. Dropping the ORDER BY passed the whole suite.
     *
     *   inserting out of order DOES. Line pointer order is insert order, so a
     *   run whose steps were written 3, 1, 2 reads back 3, 1, 2.
     *
     * Hence superuser inserts here, out of order on purpose. POST /api/sop-runs
     * writes them in snapshot order, so this is not a state it can produce
     * today — but readRun's contract is that it sorts what it finds, and F2
     * adds assignment to these rows, which is another writer.
     */
    asAdmin();
    const sql = superuserSql();
    let runId = '';
    try {
      const [version] = await sql<{ id: string }[]>`
        SELECT id FROM sop_version WHERE sop_id = ${IDS.sopOffboard}::uuid AND version = 1
      `;
      const [run] = await sql<{ id: string }[]>`
        INSERT INTO sop_run (
          tenant_id, organization_id, sop_id, sop_version_id, title, status,
          started_at, started_by
        )
        VALUES (
          ${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, ${IDS.sopOffboard}::uuid,
          ${version!.id}::uuid, 'Written out of order', 'in_progress', now(),
          ${IDS.admin1}::uuid
        )
        RETURNING id
      `;
      runId = run!.id;
      await sql`
        INSERT INTO sop_run_step (tenant_id, run_id, position, title, kind, status) VALUES
          (${IDS.tenant1}::uuid, ${runId}::uuid, 3, 'Collect the laptop', 'manual', 'pending'),
          (${IDS.tenant1}::uuid, ${runId}::uuid, 1, 'Disable the account', 'manual', 'pending'),
          (${IDS.tenant1}::uuid, ${runId}::uuid, 2, 'Forward the mailbox', 'manual', 'pending')
      `;
    } finally {
      await sql.end({ timeout: 5 });
    }

    /*
     * THE PREMISE, ESTABLISHED BY FORCING A HEAP SCAN. The rows were written
     * 3, 1, 2, so the heap holds them in that order — but the filter is on
     * run_id, which is the leading column of sop_run_step_run_idx (run_id,
     * position), so Postgres is free to answer from the index instead and hand
     * back position order for nothing. Which plan it picks has already changed
     * once during this work: it was a bitmap heap scan (physical order) when
     * this test was written in F1, and 0650's two extra columns were enough to
     * flip it to a plain index scan (index order) — at which point the test
     * stopped being able to see an ORDER BY at all, and said so, because of the
     * guard below.
     *
     * So the disagreement between physical order and position order is
     * demonstrated here with the index paths switched off, and the conclusion
     * is then tested against readRun planned normally. That is the right split:
     * the premise is a fact about the heap, and the ORDER BY exists precisely
     * for the plans where the index does not supply the order for free.
     */
    const unordered = await withTenant(admin, async (tx) => {
      await tx`SET LOCAL enable_indexscan = off`;
      await tx`SET LOCAL enable_bitmapscan = off`;
      return tx<{ position: number }[]>`
        SELECT position FROM sop_run_step WHERE run_id = ${runId}::uuid
      `;
    });
    expect(
      unordered.map((row) => row.position),
      'the rows come back sorted without being asked, so this test cannot see an ORDER BY — '
      + 'find another way to disturb the physical order',
    ).toEqual([3, 1, 2]);

    /*
     * AND THE CONCLUSION, UNDER THE PLAN WHERE THE CLAUSE MATTERS.
     *
     * Read normally, readRun is planned as an index scan over
     * sop_run_step_run_idx and gets position order for free — so dropping
     * `ORDER BY s.position` from it passes, which was measured, not assumed.
     * The clause is still right: a plan is not a guarantee, it already changed
     * once in this work, and a seq scan is what a large table or new statistics
     * produce. So readRun is exercised here with the index paths switched off,
     * which is the only way for a test to see the difference the clause makes.
     */
    const run = await withTenant(admin, async (tx) => {
      await tx`SET LOCAL enable_indexscan = off`;
      await tx`SET LOCAL enable_bitmapscan = off`;
      return readRun(tx, runId);
    });
    expect(run, 'the run page could not read the run').toBeTruthy();
    expect(run!.steps.map((step) => step.position),
      'the run page lists steps in whatever order the table hands them over')
      .toEqual([1, 2, 3]);

    // And identically under the planner's own choice, so the assertion is not
    // only about a plan nobody runs in production.
    const normal = await withTenant(admin, (tx) => readRun(tx, runId));
    expect(normal!.steps.map((step) => step.position)).toEqual([1, 2, 3]);
    expect(run!.steps.map((step) => step.title)).toEqual([
      'Disable the account', 'Forward the mailbox', 'Collect the laptop',
    ]);
    expect(run!.version, 'the run page should name the version it followed').toBe(1);
    expect(run!.sopName).toBe('Offboard a user');
    expect(run!.startedBy, 'the run page should name who started it').toBe('Northwind Admin');
  });
});

describe('across tenants and scopes', () => {
  it('does not let another tenant see or touch a run', async () => {
    asAdmin();
    const runId = (await ok(await startRun(post('/api/sop-runs', {
      sopId: IDS.sopOffboard, organizationId: IDS.orgAcme,
    })))).runId as string;

    currentUser = { id: IDS.admin2, email: 'admin@rival.test' };
    expect((await read(await patchRun(
      patch(`/api/sop-runs/${runId}`, { status: 'completed' }),
      withParams({ runId }),
    ))).status).toBe(404);
  });

  it('refuses a client administrator at the database, despite sop:execute', async () => {
    /*
     * A PRE-EXISTING MISMATCH, pinned here rather than changed. The seed gives
     * client_admin sop:execute, so the route's gate lets them through — but
     * sop_run's RLS requires role rank 40 (apply_tenant_rls(..., 40)) and
     * client_admin is rank 30, so the insert matches no policy. Failing closed
     * is the safe direction; reconciling the two is a permission decision
     * beyond this group and is written up in docs/itg-parity.md.
     */
    currentUser = USERS.clientAdmin;
    const refused = await read(await startRun(post('/api/sop-runs', {
      sopId: IDS.sopOffboard, organizationId: IDS.orgAcme,
    })));
    expect(refused.status, refused.raw).not.toBe(200);
  });
});
