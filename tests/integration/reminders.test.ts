/**
 * Checklist reminders, end to end: a real relay, a real socket, a real sweep.
 *
 * WHAT ONLY THIS LEVEL ANSWERS:
 *
 *   1. NOTHING IS SENT UNTIL A RELAY IS CONFIGURED. The air-gapped default,
 *      and the only way to be sure is to run both jobs against a tenant with
 *      no smtp_setting row and watch nothing leave.
 *   2. ONE REMINDER PER THRESHOLD, FOREVER. The unique key is the whole
 *      anti-nuisance mechanism; running the sweep twice must not produce a
 *      second message, and only the SMALLEST crossed threshold may send.
 *   3. THE PERSON'S OWN CHOICE IS HONOURED. A preference row saying no must
 *      stop the mail, and an absent row must not.
 *   4. A COMPLETED STEP STOPS REMINDING. The sweep cannot know in advance that
 *      somebody finished the work between raising and sending.
 *   5. THE RECIPIENT GATE. An address outside the tenant's allowed domains is
 *      refused at send time, because notifications name clients and credential
 *      labels.
 *   6. AND THE MESSAGE SAYS SOMETHING USEFUL. A reminder whose subject is "A
 *      step is due" cannot be acted on from a lock screen, and a link pointing
 *      at the wrong id is worse than no link.
 */
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { withTenant, db } from '../../src/lib/db/client';
import { resetServices, setKekProvider } from '../../src/lib/services';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import {
  actor, buildHarness, connectPools, disconnectPools, IDS, resetDatabase, superuserSql,
} from './harness';
import { FakeSmtp, bodyOf, subjectOf } from '../support/fake-smtp';
import { deliverRemindersJob, raiseRemindersJob } from '../../src/workers/reminders';
import type { JobContext } from '../../src/workers/runtime';
import { POST as startRun } from '../../src/app/api/sop-runs/route';
import { PATCH as patchStep } from '../../src/app/api/sop-runs/[runId]/steps/[stepId]/route';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

const ADMIN = actor(IDS.tenant1, IDS.admin1);

/**
 * How many steps the fixture's published procedure has.
 *
 * Starting a run with an assignee assigns every step, so one due date raises
 * one reminder per step. Named rather than written as 3 at nine call sites, so
 * a fixture that grows a step does not look like a reminder bug.
 */
const STEPS_PER_RUN = 3;
let harness: ReturnType<typeof buildHarness>;
let currentUser: SessionUser | null = null;
// Possibly undefined if beforeAll failed, which afterAll has to tolerate —
// otherwise a setup error is replaced by a TypeError about `stop`, and the
// real failure never reaches the output.
let relay: FakeSmtp | undefined;

const USERS = {
  admin: { id: IDS.admin1, email: 'admin@northwind.test' },
  tech: { id: IDS.tech1, email: 'tech1@northwind.test' },
} as const;

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

const raise = () => raiseRemindersJob().run(context());
const deliver = () => deliverRemindersJob().run(context());

async function su<T>(fn: (sql: ReturnType<typeof superuserSql>) => Promise<T>): Promise<T> {
  const sql = superuserSql();
  try { return await fn(sql); } finally { await sql.end({ timeout: 5 }); }
}

/**
 * Point the tenant at the fake relay.
 *
 * Written with the superuser rather than through the route, because what is
 * being tested here is the jobs; the route has its own tests. The envelope is
 * left empty — the fake relay needs no authentication — which is the
 * "credentials are optional on a trusted network" case.
 */
function theRelay(): FakeSmtp {
  // Asserted once rather than optional-chained at twenty call sites: if the
  // fixture server is not up, every test in this file is meaningless and the
  // message should say that.
  if (!relay) throw new Error('the fake relay is not running; beforeAll failed');
  return relay;
}

async function configureRelay(options: {
  domains?: string[]; enabled?: boolean;
} = {}): Promise<void> {
  const smtp = theRelay();
  await su((sql) => sql`
    INSERT INTO smtp_setting (
      tenant_id, enabled, host, port, security, tls_verify, tls_pinned_certificate,
      from_address, from_name, allowed_recipient_domains
    )
    VALUES (
      ${IDS.tenant1}::uuid, ${options.enabled ?? true}, ${smtp.host}, ${smtp.port},
      'starttls', true, ${smtp.certificatePem},
      'helm@northwind.test', 'Lake Effect Helm',
      ${options.domains ?? []}
    )
    ON CONFLICT (tenant_id) DO UPDATE SET
      enabled = EXCLUDED.enabled, host = EXCLUDED.host, port = EXCLUDED.port,
      tls_pinned_certificate = EXCLUDED.tls_pinned_certificate,
      allowed_recipient_domains = EXCLUDED.allowed_recipient_domains
  `);
}

const request = (method: string) => (url: string, payload?: unknown) =>
  new NextRequest(new Request(`http://helm.test${url}`, {
    method,
    ...(payload === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
  }));
const withParams = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

/**
 * The fixture's published procedure, started and assigned.
 *
 * DEFAULTS TO SELF-ASSIGNMENT, which is deliberate and is not a dodge.
 * Starting a run for somebody else raises an "assigned to you" reminder per
 * step straight away — that is the product behaviour and it has its own tests
 * below. The due-date tests are about the SWEEP, and mixing six messages of
 * two kinds into every assertion would hide which one broke. Assigning to the
 * person pressing the button exercises a real rule ("nobody needs an email
 * saying they gave themselves a job") and leaves the due path alone.
 */
async function startAssignedRun(options: {
  assignTo?: string; dueInDays?: number;
} = {}): Promise<{ runId: string; steps: { id: string; position: number }[] }> {
  currentUser = USERS.admin;
  const due = options.dueInDays === undefined
    ? undefined
    : new Date(Date.now() + options.dueInDays * 86_400_000).toISOString();

  const response = await startRun(request('POST')('/api/sop-runs', {
    sopId: IDS.sopOffboard,
    organizationId: IDS.orgAcme,
    assignedTo: options.assignTo ?? IDS.admin1,
    ...(due ? { dueAt: due } : {}),
  }));
  const payload = await response.json() as { runId?: string; error?: unknown };
  expect(payload.runId, JSON.stringify(payload.error ?? payload)).toBeTruthy();

  const steps = await withTenant(ADMIN, (tx) => tx<{ id: string; position: number }[]>`
    SELECT id, position FROM sop_run_step WHERE run_id = ${payload.runId!}::uuid
    ORDER BY position
  `);
  return { runId: payload.runId!, steps };
}

beforeAll(async () => {
  resetDatabase();
  connectPools();
  harness = buildHarness();
  setKekProvider(harness.kek);
  useSessionResolver(async () => currentUser);
  await harness.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'reminder tests' });
  relay = await FakeSmtp.start();
  // The link in a reminder has to be absolute or it is unusable from a mail
  // client; the worker reads this.
  process.env.HELM_PUBLIC_URL = 'https://helm.northwind.test';
}, 120_000);

afterEach(async () => {
  if (relay) {
    relay.received.length = 0;
    relay.commands.length = 0;
  }
  await su(async (sql) => {
    await sql`DELETE FROM task_reminder`;
    await sql`DELETE FROM smtp_setting`;
    await sql`DELETE FROM user_notification_preference`;
    await sql`DELETE FROM sop_run_step`;
    await sql`DELETE FROM sop_run`;
  });
});

afterAll(async () => {
  await relay?.stop();
  delete process.env.HELM_PUBLIC_URL;
  resetServices();
  await disconnectPools();
});

// ---------------------------------------------------------------------------

describe('with no relay configured', () => {
  it('raises nothing and sends nothing', async () => {
    // The air-gapped default: a tenant that has not set up mail contributes no
    // rows at all, so there is nothing for the delivery job to find either.
    await startAssignedRun({ dueInDays: 1 });

    const raised = await raise();
    expect(raised.counts?.raised).toBe(0);
    expect(raised.idle).toBe(true);

    const sent = await deliver();
    expect(sent.idle).toBe(true);
    expect(theRelay().received, 'something was sent with no relay configured').toHaveLength(0);
  });

  it('raises nothing when the relay exists but is switched off', async () => {
    await configureRelay({ enabled: false });
    await startAssignedRun({ dueInDays: 1 });

    expect((await raise()).counts?.raised).toBe(0);
    expect(theRelay().received).toHaveLength(0);
  });
});

describe('a step that is due', () => {
  it('raises one reminder and sends it', async () => {
    await configureRelay();
    await startAssignedRun({ dueInDays: 1 });

    /*
     * THREE, not one: the fixture's procedure has three steps and starting a
     * run assigns every one of them, so a single due date crosses one
     * threshold per step. Asserted as STEPS rather than as a magic number, so
     * the test says why — the first version expected 1 and was simply wrong
     * about the fixture.
     */
    const raised = await raise();
    expect(raised.counts?.raised, 'one reminder per assigned step').toBe(STEPS_PER_RUN);

    const sent = await deliver();
    expect(sent.counts?.sent).toBe(STEPS_PER_RUN);
    expect(theRelay().received).toHaveLength(STEPS_PER_RUN);

    const mail = theRelay().received.find((m) => subjectOf(m).includes('Disable the account'))!;
    expect(mail, 'no reminder named the first step').toBeTruthy();
    expect(mail.to).toEqual(['admin@northwind.test']);
    expect(mail.from).toBe('helm@northwind.test');
    expect(mail.encrypted, 'a reminder was sent over an unencrypted connection').toBe(true);
  });

  it('says something somebody can act on from a lock screen', async () => {
    await configureRelay();
    const { runId } = await startAssignedRun({ dueInDays: 1 });
    await raise();
    await deliver();

    const mail = theRelay().received[0]!;
    const subject = subjectOf(mail);
    // The step, the client, and when — not "a step is due".
    expect(subject).toContain('Due tomorrow');
    expect(subject).toContain('Disable the account');
    expect(subject).toContain('Acme');

    const body = bodyOf(mail);
    expect(body).toContain('Disable the account');
    // THE LINK POINTS AT THE RUN. The first version of the worker passed the
    // reminder's own id, which would have 404'd in every reminder ever sent.
    expect(body, 'the link does not point at the run').toContain(
      `https://helm.northwind.test/runs/${runId}`,
    );
    // And it tells the reader how to make it stop, in the message they are
    // reading rather than only in the first one.
    expect(body).toContain('Account → Notifications');
  });

  it('does not send a second time, however often the sweep runs', async () => {
    /*
     * THE UNIQUE KEY DOING ITS JOB. 0100 learned this the hard way: a nightly
     * job that re-alerts until the team filters the channel is worse than no
     * alert.
     */
    await configureRelay();
    await startAssignedRun({ dueInDays: 1 });

    await raise();
    await deliver();
    expect(theRelay().received).toHaveLength(STEPS_PER_RUN);

    await raise();
    await raise();
    await deliver();
    expect(theRelay().received, 'the sweep re-sent reminders it had already sent')
      .toHaveLength(STEPS_PER_RUN);
  });

  it('sends only the smallest crossed threshold, and records the rest as suppressed', async () => {
    /*
     * A step due in half a day has crossed the 3-day and 1-day thresholds at
     * once. One message per step — not two — and the larger one is written as
     * 'suppressed' so the unique constraint stops it firing later and the table
     * shows the decision.
     *
     * THE LADDER IS `due_at <= now() + lead days`, so lead 0 means due NOW or
     * overdue rather than "some time today" — a step due this afternoon has not
     * crossed it. The first version of this test assumed 0 fired for anything
     * due today and expected three rows; the overdue case below is where 0
     * actually appears.
     */
    await configureRelay();
    await startAssignedRun({ dueInDays: 0.5 });

    const raised = await raise();
    expect(
      raised.counts?.raised,
      'three thresholds crossed per step should send one per step',
    ).toBe(STEPS_PER_RUN);

    // One step's rows, so the pattern is legible rather than nine rows deep.
    const rows = await su((sql) => sql<{ lead_day: number; status: string }[]>`
      SELECT lead_day, status FROM task_reminder
      WHERE step_id = (SELECT id FROM sop_run_step ORDER BY position LIMIT 1)
      ORDER BY lead_day
    `);
    expect(rows.map((r) => `${r.lead_day}:${r.status}`))
      .toEqual(['1:pending', '3:suppressed']);

    await deliver();
    expect(theRelay().received).toHaveLength(STEPS_PER_RUN);
    /*
     * "Due tomorrow", because the wording comes from the THRESHOLD that fired
     * rather than from the clock — the 1-day reminder is the one that was sent.
     * A step due this afternoon genuinely is inside tomorrow's window, and
     * saying "due today" from a lead-1 row would make the subject disagree with
     * the row that produced it.
     */
    expect(subjectOf(theRelay().received[0]!)).toContain('Due tomorrow');
  });

  it('raises nothing for a step that is not due for a fortnight', async () => {
    await configureRelay();
    await startAssignedRun({ dueInDays: 14 });
    expect((await raise()).counts?.raised).toBe(0);
  });

  it('calls an overdue step overdue, not due today', async () => {
    await configureRelay();
    const { steps } = await startAssignedRun({ dueInDays: 1 });
    // Backdated directly: sop_run_step has no touch trigger on due_at, and the
    // alternative is waiting a day.
    await su((sql) => sql`
      UPDATE sop_run_step SET due_at = now() - interval '2 days'
      WHERE id = ${steps[0]!.id}::uuid
    `);

    await raise();
    await deliver();

    const overdue = theRelay().received.find((m) => subjectOf(m).includes('Overdue'));
    expect(overdue, 'an overdue step should say so').toBeTruthy();
  });
});

describe('what the person chose', () => {
  it('sends nothing when they turned task_due off', async () => {
    await configureRelay();
    await su((sql) => sql`
      INSERT INTO user_notification_preference (tenant_id, user_id, kinds)
      VALUES (${IDS.tenant1}::uuid, ${IDS.admin1}::uuid, '["task_assigned"]'::jsonb)
    `);
    await startAssignedRun({ dueInDays: 1 });

    expect((await raise()).counts?.raised, 'a preference saying no was ignored').toBe(0);
    await deliver();
    expect(theRelay().received).toHaveLength(0);
  });

  it('sends nothing when they turned everything off', async () => {
    await configureRelay();
    await su((sql) => sql`
      INSERT INTO user_notification_preference (tenant_id, user_id, kinds)
      VALUES (${IDS.tenant1}::uuid, ${IDS.admin1}::uuid, '[]'::jsonb)
    `);
    await startAssignedRun({ dueInDays: 1 });
    expect((await raise()).counts?.raised).toBe(0);
  });

  it('sends when they have never touched the setting', async () => {
    // An absent row is the shipped default, which is both kinds on. If `[]`
    // and "no row" were the same answer this would be silent, and the feature
    // would appear broken to everybody who was not told to switch it on.
    await configureRelay();
    await startAssignedRun({ dueInDays: 1 });
    expect((await raise()).counts?.raised).toBe(STEPS_PER_RUN);
  });
});

describe('a step that stops needing a reminder', () => {
  it('is not reminded about once it is complete', async () => {
    /*
     * The claim function filters on the step's CURRENT status, because the
     * sweep cannot know that somebody finished the work between raising the
     * reminder and the delivery job running a minute later.
     */
    await configureRelay();
    const { runId, steps } = await startAssignedRun({ dueInDays: 1 });
    await raise();

    currentUser = USERS.admin;
    const done = await patchStep(
      request('PATCH')(`/api/sop-runs/${runId}/steps/${steps[0]!.id}`, { status: 'done' }),
      withParams({ runId, stepId: steps[0]!.id }),
    );
    expect(done.status, await done.text()).toBe(200);

    await deliver();
    const sentAboutStepOne = theRelay().received.some((m) =>
      subjectOf(m).includes('Disable the account'));
    expect(sentAboutStepOne, 'a completed step was still reminded about').toBe(false);
  });

  it('is not reminded about when the assignee has left the tenant', async () => {
    // The reminder's foreign key says a recipient is a member; work assigned to
    // somebody who left is a reassignment somebody has to do, not a message to
    // send into a void.
    await configureRelay();
    await startAssignedRun({ dueInDays: 1 });
    await su((sql) => sql`
      UPDATE membership SET status = 'suspended'
      WHERE tenant_id = ${IDS.tenant1}::uuid AND user_id = ${IDS.admin1}::uuid
    `);
    try {
      expect((await raise()).counts?.raised).toBe(0);
    } finally {
      await su((sql) => sql`
        UPDATE membership SET status = 'active'
        WHERE tenant_id = ${IDS.tenant1}::uuid AND user_id = ${IDS.admin1}::uuid
      `);
    }
  });
});

describe('the recipient gate', () => {
  it('refuses an address outside the allowed domains, and records why', async () => {
    /*
     * Notifications name clients, assets and credential labels. The gate is
     * checked at SEND time as well as at configuration time, because a tenant
     * can narrow its domains after the fact and the moment that matters is the
     * moment something is about to leave.
     */
    await configureRelay({ domains: ['example.invalid'] });
    await startAssignedRun({ dueInDays: 1 });
    await raise();

    const result = await deliver();
    expect(result.counts?.failed).toBe(STEPS_PER_RUN);
    expect(theRelay().received, 'a message went to a disallowed address').toHaveLength(0);

    const [row] = await su((sql) => sql<{ status: string; error: string | null }[]>`
      -- NOT a bare LIMIT 1: every due step also has a 'suppressed' row for
      -- the larger threshold, and an unfiltered pick returns one of those
      -- about half the time. The first version of this test did, and read as
      -- a status bug.
      SELECT status, error FROM task_reminder WHERE status <> 'suppressed' LIMIT 1
    `);
    // Recorded rather than dropped quietly, so somebody can see why nothing
    // arrived — and it names the setting rather than the address.
    expect(row!.status).toBe('pending');
    expect(row!.error).toContain('outside the domains');
  });

  it('allows the sending domain when no domains are listed', async () => {
    await configureRelay({ domains: [] });
    await startAssignedRun({ dueInDays: 1 });
    await raise();
    await deliver();
    expect(theRelay().received, 'the default should allow the tenant"s own domain')
      .toHaveLength(STEPS_PER_RUN);
  });
});

describe('when the relay misbehaves', () => {
  it('records the failure against the reminder and backs off', async () => {
    const broken = await FakeSmtp.start({ mode: 'reject-data' });
    try {
      await su((sql) => sql`
        INSERT INTO smtp_setting (
          tenant_id, enabled, host, port, security, tls_verify,
          tls_pinned_certificate, from_address, allowed_recipient_domains
        )
        VALUES (
          ${IDS.tenant1}::uuid, true, ${broken.host}, ${broken.port}, 'starttls',
          true, ${broken.certificatePem}, 'helm@northwind.test', '{}'
        )
      `);
      await startAssignedRun({ dueInDays: 1 });
      await raise();

      const result = await deliver();
      expect(result.counts?.failed).toBe(STEPS_PER_RUN);

      const [row] = await su((sql) => sql<{
        status: string; attempts: number; error: string | null; next_attempt_at: Date;
      }[]>`SELECT status, attempts, error, next_attempt_at FROM task_reminder
            WHERE status <> 'suppressed' LIMIT 1`);
      expect(row!.status, 'one failure is not dead yet').toBe('pending');
      expect(Number(row!.attempts)).toBe(1);
      expect(row!.error).toBeTruthy();
      // Backoff computed in the database, so two workers cannot disagree.
      expect(row!.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
    } finally {
      await broken.stop();
    }
  });

  it('gives up after enough attempts, and says dead rather than failed', async () => {
    await configureRelay({ domains: ['example.invalid'] });
    await startAssignedRun({ dueInDays: 1 });
    await raise();

    // Six attempts is the cap. Driven by resetting the backoff rather than by
    // waiting, because the point is the attempt count and not the clock.
    for (let i = 0; i < 6; i += 1) {
      await su((sql) => sql`
        UPDATE task_reminder SET next_attempt_at = now() WHERE status = 'pending'
      `);
      await deliver();
    }

    const [row] = await su((sql) => sql<{ status: string; attempts: number }[]>`
      SELECT status, attempts FROM task_reminder WHERE status <> 'suppressed' LIMIT 1
    `);
    // 'dead' and 'failed' are different things to look at: failed means it will
    // try again, dead means a person has to.
    expect(row!.status).toBe('dead');
    expect(Number(row!.attempts)).toBe(6);
  });

  it('does not let one tenant"s broken relay stop another"s mail', async () => {
    // Both tenants configured, one pointed at a relay that refuses. The loop
    // catches per tenant, so the working one still receives.
    const broken = await FakeSmtp.start({ mode: 'reject-data' });
    try {
      await configureRelay();
      await su((sql) => sql`
        INSERT INTO smtp_setting (
          tenant_id, enabled, host, port, security, tls_verify,
          tls_pinned_certificate, from_address, allowed_recipient_domains
        )
        VALUES (
          ${IDS.tenant2}::uuid, true, ${broken.host}, ${broken.port}, 'starttls',
          true, ${broken.certificatePem}, 'helm@contoso.test', '{}'
        )
      `);
      await startAssignedRun({ dueInDays: 1 });
      await raise();

      const result = await deliver();
      expect(result.counts?.sent, 'the working tenant should still have been sent to')
        .toBe(STEPS_PER_RUN);
      expect(theRelay().received).toHaveLength(STEPS_PER_RUN);
    } finally {
      await broken.stop();
      await su((sql) => sql`DELETE FROM smtp_setting WHERE tenant_id = ${IDS.tenant2}::uuid`);
    }
  });

  it('records the relay"s own health per tenant, not per run', async () => {
    await configureRelay();
    await startAssignedRun({ dueInDays: 1 });
    await raise();
    await deliver();

    const [row] = await su((sql) => sql<{
      last_send_ok: boolean; consecutive_failures: number;
    }[]>`SELECT last_send_ok, consecutive_failures FROM smtp_setting`);
    expect(row!.last_send_ok).toBe(true);
    expect(Number(row!.consecutive_failures)).toBe(0);
  });
});

describe('the worker"s own boundaries', () => {
  it('reads the relay password through the worker role and nothing else', async () => {
    // helm_app has no column privilege on the envelope at all; this is the
    // behavioural half of 0690's guard 2.
    await configureRelay();
    await expect(
      withTenant(ADMIN, (tx) => tx`SELECT secret_ciphertext FROM smtp_setting`),
    ).rejects.toThrow(/permission denied/);

    const rows = await db('worker')`SELECT host FROM helm.smtp_transport(${IDS.tenant1}::uuid)`;
    expect(rows).toHaveLength(1);
  });

  it('cannot be asked for another tenant"s reminders", even by the worker', async () => {
    await configureRelay();
    await startAssignedRun({ dueInDays: 1 });
    await raise();

    // claim_task_reminders scopes to the session tenant, so a worker inside
    // tenant 2 sees none of tenant 1's.
    const theirs = await withTenant(
      actor(IDS.tenant2, IDS.admin2),
      (tx) => tx`SELECT * FROM helm.claim_task_reminders(50)`,
      { role: 'worker' },
    );
    expect(theirs).toHaveLength(0);
  });
});

describe('being given a step', () => {
  it('sends one message per step when somebody else assigns it', async () => {
    /*
     * BEING GIVEN WORK IS AN ACT, so this is raised by the route at the moment
     * of assignment rather than swept for — an hourly sweep cannot tell a step
     * assigned yesterday from one assigned a moment ago, and a step with no due
     * date would otherwise never produce anything.
     *
     * Per step rather than per run: the thing somebody acts on is a step, and
     * the due reminders are per step anyway.
     */
    await configureRelay();
    await startAssignedRun({ assignTo: IDS.tech1 });

    const rows = await su((sql) => sql<{ kind: string; status: string; lead_day: number }[]>`
      SELECT kind, status, lead_day FROM task_reminder
    `);
    expect(rows).toHaveLength(STEPS_PER_RUN);
    expect(rows.every((r) => r.kind === 'assigned' && Number(r.lead_day) === -1)).toBe(true);

    await deliver();
    expect(theRelay().received).toHaveLength(STEPS_PER_RUN);
    const mail = theRelay().received[0]!;
    expect(mail.to).toEqual(['tech1@northwind.test']);
    expect(subjectOf(mail)).toContain('Assigned to you');
  });

  it('sends nothing when somebody assigns a step to themselves', async () => {
    // The common case, and three emails to the person who just pressed the
    // button would be the fastest way to have this feature switched off.
    await configureRelay();
    await startAssignedRun({ assignTo: IDS.admin1 });

    expect(await su((sql) => sql`SELECT 1 FROM task_reminder`)).toEqual([]);
    await deliver();
    expect(theRelay().received).toHaveLength(0);
  });

  it('sends nothing when the person turned that kind off', async () => {
    await configureRelay();
    await su((sql) => sql`
      INSERT INTO user_notification_preference (tenant_id, user_id, kinds)
      VALUES (${IDS.tenant1}::uuid, ${IDS.tech1}::uuid, '["task_due"]'::jsonb)
    `);
    await startAssignedRun({ assignTo: IDS.tech1 });
    expect(await su((sql) => sql`SELECT 1 FROM task_reminder`)).toEqual([]);
  });

  it('sends nothing when mail is not configured', async () => {
    // The route calls the same function whether or not a relay exists, so the
    // no-op has to be inside it rather than at the call site.
    await startAssignedRun({ assignTo: IDS.tech1 });
    expect(await su((sql) => sql`SELECT 1 FROM task_reminder`)).toEqual([]);
  });

  it('does not send a second message when the step is reassigned back', async () => {
    // The unique key is (step, kind, lead_day) with lead -1 for an assignment,
    // so a step passed back and forth produces one message per person at most
    // once — not one per change of mind.
    await configureRelay();
    const { runId, steps } = await startAssignedRun({ assignTo: IDS.tech1 });
    await deliver();
    expect(theRelay().received).toHaveLength(STEPS_PER_RUN);

    currentUser = USERS.admin;
    for (const assignee of [IDS.admin1, IDS.tech1]) {
      const response = await patchStep(
        request('PATCH')(`/api/sop-runs/${runId}/steps/${steps[0]!.id}`, {
          assignedTo: assignee,
        }),
        withParams({ runId, stepId: steps[0]!.id }),
      );
      expect(response.status, await response.text()).toBe(200);
    }

    await deliver();
    expect(
      theRelay().received,
      'reassigning a step produced another message about it',
    ).toHaveLength(STEPS_PER_RUN);
  });
});
