/**
 * Expiry alerts.
 *
 * Two jobs, deliberately split.
 *
 *   EVALUATION decides what should fire. It is set-based SQL
 *   (helm.evaluate_alert_rules) and is idempotent: the unique constraint on
 *   (rule, expiration, lead_day) means re-running it cannot re-alert, so a
 *   crash halfway through is recovered by running it again.
 *
 *   DELIVERY takes what fired and sends it. Separate because delivery is the
 *   part that talks to the outside world and therefore the part that fails:
 *   an SMTP server that is down must not prevent tomorrow's evaluation from
 *   noticing that a certificate now expires in seven days.
 *
 * The alert worker's service account holds no route to ciphertext — enforced by
 * a migration guard in 0910, not by this comment. Alert payloads are built in
 * SQL from the expiration projection, which never contains secret material.
 *
 * DELIVERY IS THE SHARED NOTIFICATION QUEUE, and only that. Each alert is
 * queued as `expiration.warning` for every destination subscribed to it, which
 * gives an expiry warning the same Discord/Teams/email formatting, retry and
 * enveloped destination as every other event. The original alert_rule.target
 * notifier (workers/notifiers.ts) was removed: its "email" channel only wrote a
 * log line yet recorded the alert as sent, and no rule ever used it.
 *
 * Every tenant has a default rule since 0730 — before that nothing created one,
 * so both jobs here were idle on every deployment.
 */
import { withTenant, type HelmTx } from '../lib/db/client';
import { db } from '../lib/db/client';
import type { Job, JobContext, JobResult } from './runtime';
import { describeError } from './runtime';

interface AlertBacklogRow {
  tenant_id: string;
  tenant_name: string;
  worker_actor_id: string;
  active_rules: string;
}

interface PendingAlertRow {
  alert_id: string;
  rule_id: string;
  lead_day: number;
  payload: Record<string, unknown>;
}

const MAX_PER_TENANT_PER_RUN = 200;

export function evaluateExpiryAlertsJob(): Job {
  return {
    name: 'alerts.evaluate',
    // Expiry thresholds have day granularity, so evaluating more than a few
    // times a day buys nothing. Hourly keeps a newly-imported certificate from
    // waiting a day for its first alert.
    everyMs: 60 * 60 * 1000,
    lockKey: 0x48_45_4c_4d_01,
    run: evaluateExpiryAlerts,
  };
}

export function deliverExpiryAlertsJob(): Job {
  return {
    name: 'alerts.deliver',
    everyMs: 5 * 60 * 1000,
    lockKey: 0x48_45_4c_4d_02,
    run: deliverExpiryAlerts,
  };
}

async function evaluateExpiryAlerts(ctx: JobContext): Promise<JobResult> {
  const backlog = await db('worker')<AlertBacklogRow[]>`SELECT * FROM helm.alert_backlog()`;
  if (backlog.length === 0) return { idle: true };

  let fired = 0;
  let suppressed = 0;
  let failed = 0;

  for (const tenant of backlog) {
    if (ctx.stopping()) break;
    const log = ctx.log.child({ tenant: tenant.tenant_name });

    try {
      const [row] = await withTenant(
        { tenantId: tenant.tenant_id, actorId: tenant.worker_actor_id, actorType: 'service_account' },
        async (tx) => tx<{ fired: string; suppressed: string }[]>`
          SELECT * FROM helm.evaluate_alert_rules()
        `,
        { role: 'worker' },
      );

      fired += Number(row?.fired ?? 0);
      suppressed += Number(row?.suppressed ?? 0);

      if (Number(row?.fired ?? 0) > 0) {
        log.info('alerts fired', { fired: Number(row?.fired), suppressed: Number(row?.suppressed) });
      }
    } catch (error) {
      // One tenant's failure must not abandon the rest. A tenant whose data is
      // in a state the evaluator cannot handle should not silence alerts for
      // every other client of the MSP.
      failed += 1;
      log.error('evaluation failed', describeError(error));
    }
  }

  return { counts: { tenants: backlog.length, fired, suppressed, failed }, idle: fired === 0 && suppressed === 0 };
}

async function deliverExpiryAlerts(ctx: JobContext): Promise<JobResult> {
  const backlog = await db('worker')<AlertBacklogRow[]>`SELECT * FROM helm.alert_backlog()`;
  if (backlog.length === 0) return { idle: true };

  let queued = 0;
  let unrouted = 0;
  let tenantsFailed = 0;

  for (const tenant of backlog) {
    if (ctx.stopping()) break;
    const log = ctx.log.child({ tenant: tenant.tenant_name });
    const actor = {
      tenantId: tenant.tenant_id,
      actorId: tenant.worker_actor_id,
      actorType: 'service_account' as const,
    };

    let tenantUnrouted = 0;

    try {
      const pending = await withTenant(
        actor,
        async (tx) => tx<PendingAlertRow[]>`
          SELECT * FROM helm.pending_alerts(${MAX_PER_TENANT_PER_RUN})
        `,
        { role: 'worker' },
      );

      for (const alert of pending) {
        if (ctx.stopping()) break;

        /*
         * Queued rather than sent here: delivery, retry and backoff are the
         * notification worker's job, and two things POSTing to chat platforms
         * is how one of them ends up with the retry bug.
         *
         * Queue and record in ONE transaction. Recorded as sent without the
         * queue row, the warning would be lost; queued without the record, the
         * next run would queue it again — the queue's (endpoint, event_uid)
         * conflict guard would absorb that, but only for destinations that
         * still exist.
         */
        const delivered = await withTenant(
          actor,
          async (tx) => {
            const [row] = await tx<{ enqueue_notification: number }[]>`
              SELECT helm.enqueue_notification(
                'expiration.warning',
                ${alert.alert_id}::uuid,
                ${(alert.payload.organization_id as string | undefined) ?? null}::uuid,
                ${tx.json(toJson(alert.payload))}::jsonb)
            `;
            const count = Number(row?.enqueue_notification ?? 0);
            // No destination subscribes to expiry warnings. Recorded as
            // suppressed, with the reason, rather than left pending: a pending
            // alert would be re-examined every five minutes forever, and an
            // expiry warning that turns up weeks late is worse than none — the
            // next, more urgent threshold fires on its own.
            await tx`
              SELECT helm.record_alert_delivery(
                ${alert.alert_id}::uuid,
                ${count > 0 ? 'sent' : 'suppressed'},
                ${count > 0 ? null : 'no notification destination subscribes to expiration.warning'})
            `;
            return count;
          },
          { role: 'worker' },
        );

        if (delivered > 0) {
          queued += 1;
        } else {
          unrouted += 1;
          tenantUnrouted += 1;
        }
      }

      if (tenantUnrouted > 0) {
        log.info('expiry warnings had nowhere to go', {
          unrouted: tenantUnrouted,
          hint: 'subscribe a destination to "Expiring soon" under Settings',
        });
      }
    } catch (error) {
      // One tenant's failure must not abandon the rest — the same promise the
      // evaluation half above already keeps.
      tenantsFailed += 1;
      log.error('alert delivery failed for this tenant; continuing', describeError(error));
    }
  }

  return {
    counts: { queued, unrouted, tenantsFailed },
    idle: queued === 0 && unrouted === 0 && tenantsFailed === 0,
  };
}

/**
 * postgres.js types its json() helper against a recursive JSONValue, which a
 * Record<string, unknown> does not structurally satisfy. The alert payload is
 * plain data by construction — built by helm.evaluate_alert_rules() out of the
 * expiration projection — so this is a typing accommodation, not a claim about
 * unchecked content. Same helper, same reasoning, as in lib/exports/service.ts.
 */
function toJson(value: unknown): Parameters<HelmTx['json']>[0] {
  return JSON.parse(JSON.stringify(value)) as Parameters<HelmTx['json']>[0];
}
