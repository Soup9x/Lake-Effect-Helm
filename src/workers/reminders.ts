/**
 * Checklist reminders: raising them, and sending them.
 *
 * TWO JOBS, split exactly as the expiry alerts and the notification fan-out
 * are, and for the reason §4 of docs/architecture/05-workers-and-exports.md
 * gives: EVALUATION decides what should fire and is set-based SQL; DELIVERY
 * talks to the outside world and is therefore the part that fails. A relay that
 * is down must not stop tomorrow's sweep from noticing that a step is now
 * overdue.
 *
 * THE SWEEP IS IDEMPOTENT AND THE DATABASE MAKES IT SO.
 * helm.raise_task_reminders() inserts with ON CONFLICT DO NOTHING against
 * UNIQUE (step_id, kind, lead_day), so running it twice, or running two
 * replicas at once, produces the same rows rather than a second message. The
 * row IS the record that the threshold was crossed — which is 0100's
 * construction for alert_event, chosen there after a nightly job re-alerted
 * until the team filtered the channel.
 *
 * AND ONLY THE SMALLEST CROSSED THRESHOLD IS SENT. Adding a step already due in
 * two days must produce one reminder, not one for the three-day threshold it
 * has also passed. The larger ones are written as 'suppressed' in the same
 * statement, so the unique constraint keeps them from firing later and the
 * table shows the decision rather than an absence.
 *
 * NOTHING IS SENT UNTIL A RELAY IS CONFIGURED. Both the sweep and the backlog
 * join smtp_setting with `enabled`, so a tenant that has not set one up
 * contributes no rows at all — the air-gapped default 0670 established. There is
 * no environment variable to forget.
 */
import { withTenant, db } from '../lib/db/client';
import type { Job, JobContext, JobResult } from './runtime';
import { describeError } from './runtime';
import { EmailBatch, recordRelayResult } from '../lib/email/sender';
import { EmailTransportError } from '../lib/email/transport';
import { reminderBody, reminderSubject, type ReminderMessage } from '../lib/email/render';
import type { TaskReminderKind } from '../lib/notifications/kinds';

interface BacklogRow {
  tenant_id: string;
  tenant_name: string;
  worker_actor_id: string;
  due: string;
}

interface ClaimRow {
  reminder_id: string;
  kind: TaskReminderKind;
  lead_day: number;
  recipient: string;
  recipient_name: string | null;
  run_id: string;
  step_title: string;
  step_position: number;
  run_title: string;
  organization_name: string;
  due_at: Date | null;
  attempts: number;
}

/**
 * Where a step lives, for the link in the message.
 *
 * HELM_PUBLIC_URL and not a guess. A reminder whose link points at `localhost`
 * is a reminder nobody can act on from their phone. setup.sh writes it and
 * docker-compose.yml passes it to the worker (it once did not, and reminders
 * went out with bare paths); tests/unit/env-docs.test.ts asserts every
 * variable the code reads is documented.
 */
function runUrl(runId: string): string {
  const base = (process.env.HELM_PUBLIC_URL ?? '').replace(/\/+$/, '');
  return base ? `${base}/runs/${runId}` : `/runs/${runId}`;
}

export function raiseRemindersJob(): Job {
  return {
    name: 'reminders.raise',
    // Hourly. The thresholds are whole days, so a finer sweep would do the same
    // work repeatedly for no extra resolution — and the unique constraint means
    // a missed hour costs nothing, because the next sweep raises the same row.
    everyMs: 60 * 60 * 1000,
    lockKey: 0x48_45_4c_4d_0c,
    run: raiseReminders,
  };
}

export function deliverRemindersJob(): Job {
  return {
    name: 'reminders.deliver',
    everyMs: 60 * 1000,
    lockKey: 0x48_45_4c_4d_0d,
    run: deliverReminders,
  };
}

async function raiseReminders(ctx: JobContext): Promise<JobResult> {
  // Crosses tenants by design, so it goes through the SECURITY DEFINER sweep
  // rather than a tenant context: there is nothing to do per tenant until the
  // rows exist.
  const [row] = await db('worker')<{ raised: number }[]>`
    SELECT helm.raise_task_reminders(500) AS raised
  `;
  const raised = Number(row?.raised ?? 0);
  // And the team-channel side (0870): steps that fell due, for destinations
  // subscribed to task.overdue. Independent of anybody's own preferences.
  const [channel] = await db('worker')<{ queued: number }[]>`
    SELECT helm.raise_task_channel_events(500) AS queued
  `;
  const queued = Number(channel?.queued ?? 0);

  if (raised > 0 || queued > 0) ctx.log.info('raised', { reminders: raised, channelEvents: queued });
  return { counts: { raised, channelEvents: queued }, idle: raised === 0 && queued === 0 };
}

async function deliverReminders(ctx: JobContext): Promise<JobResult> {
  const backlog = await db('worker')<BacklogRow[]>`SELECT * FROM helm.email_backlog(25)`;
  if (backlog.length === 0) return { idle: true };

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const tenant of backlog) {
    if (ctx.stopping()) break;

    const actor = {
      tenantId: tenant.tenant_id,
      actorId: tenant.worker_actor_id,
      actorType: 'service_account' as const,
    };
    const log = ctx.log.child({ tenant: tenant.tenant_name });

    // One connection for this tenant's whole batch, closed in the finally. See
    // EmailBatch for why neither per-message nor per-process is right.
    let batch: EmailBatch | null = null;
    // Per tenant, not the run's total: tenant A's bad address must not make
    // tenant B's relay read as broken on its settings page.
    let tenantFailures = 0;
    let tenantSent = 0;
    try {
      batch = await EmailBatch.open(actor);
      if (!batch) {
        // The relay was turned off between the backlog query and here.
        skipped += 1;
        continue;
      }

      const due = await withTenant(
        actor,
        (tx) => tx<ClaimRow[]>`SELECT * FROM helm.claim_task_reminders(50)`,
        { role: 'worker' },
      );

      for (const reminder of due) {
        if (ctx.stopping()) break;

        const message: ReminderMessage = {
          kind: reminder.kind,
          leadDay: Number(reminder.lead_day),
          recipientName: reminder.recipient_name,
          stepTitle: reminder.step_title,
          stepPosition: Number(reminder.step_position),
          runTitle: reminder.run_title,
          organizationName: reminder.organization_name,
          dueAt: reminder.due_at,
          runUrl: runUrl(reminder.run_id),
        };

        try {
          await batch.send({
            to: reminder.recipient,
            subject: reminderSubject(message),
            text: reminderBody(message),
          });
          await record(actor, reminder.reminder_id, true);
          sent += 1;
          tenantSent += 1;
        } catch (error) {
          const described = error instanceof EmailTransportError
            ? error
            : new EmailTransportError(String(error), 'rejected');
          // Recorded against the row, not thrown: one bad address must not
          // abandon the rest of the batch, and the backoff lives in
          // helm.record_task_reminder() so two workers cannot disagree about
          // when to try again.
          await record(actor, reminder.reminder_id, false, described.message);
          failed += 1;
          tenantFailures += 1;
          log.warn('a reminder could not be sent', {
            reason: described.reason, message: described.message,
          });
        }
      }

      // The relay's own health, for the settings page. Recorded once per tenant
      // per run rather than per message: "the last send failed" is about the
      // relay, and twenty successes followed by one refused address should not
      // read as a broken relay. So: healthy if anything got through, or if
      // nothing failed. (This used to be `tenantFailures === 0`, which was
      // exactly the one-refused-address case the sentence above rules out.)
      await recordRelayResult(tenant.tenant_id, tenantSent > 0 || tenantFailures === 0);
    } catch (error) {
      failed += 1;
      tenantFailures += 1;
      const described = describeError(error);
      log.error('the mail relay could not be used at all', described);
      await recordRelayResult(
        tenant.tenant_id, false, String(described.error ?? 'relay unavailable'),
      ).catch(() => {
        // The send already failed; failing to record that must not take the
        // whole run down with it.
      });
    } finally {
      batch?.close();
    }
  }

  return { counts: { tenants: backlog.length, sent, failed, skipped }, idle: sent + failed === 0 };
}

async function record(
  actor: { tenantId: string; actorId: string; actorType: 'service_account' },
  reminderId: string,
  ok: boolean,
  error?: string,
): Promise<void> {
  await withTenant(
    actor,
    (tx) => tx`
      SELECT helm.record_task_reminder(${reminderId}::uuid, ${ok}, ${error ?? null})
    `,
    { role: 'worker' },
  );
}
