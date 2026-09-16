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
 */
import { withTenant } from '../lib/db/client';
import { db } from '../lib/db/client';
import type { Job, JobContext, JobResult } from './runtime';
import { describeError } from './runtime';
import type { AlertNotifier, AlertMessage } from './notifiers';
import { resolveNotifier } from './notifiers';

interface AlertBacklogRow {
  tenant_id: string;
  tenant_name: string;
  worker_actor_id: string;
  active_rules: string;
}

interface PendingAlertRow {
  alert_id: string;
  rule_id: string;
  rule_name: string;
  channel: string;
  target: string;
  severity: AlertMessage['severity'];
  lead_day: number;
  fired_at: Date;
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

  const notifier = resolveNotifier();
  let sent = 0;
  let failed = 0;

  for (const tenant of backlog) {
    if (ctx.stopping()) break;
    const log = ctx.log.child({ tenant: tenant.tenant_name });

    const pending = await withTenant(
      { tenantId: tenant.tenant_id, actorId: tenant.worker_actor_id, actorType: 'service_account' },
      async (tx) => tx<PendingAlertRow[]>`
        SELECT * FROM helm.pending_alerts(${MAX_PER_TENANT_PER_RUN})
      `,
      { role: 'worker' },
    );

    for (const alert of pending) {
      if (ctx.stopping()) break;

      const outcome = await deliverOne(notifier, tenant, alert, log);
      if (outcome.status === 'sent') sent += 1;
      else failed += 1;

      // Recorded in its own transaction, deliberately. Batching the whole
      // tenant's results into one transaction would mean a crash after sending
      // twenty emails rolls back the record that they were sent — and the next
      // run sends them again.
      await withTenant(
        { tenantId: tenant.tenant_id, actorId: tenant.worker_actor_id, actorType: 'service_account' },
        async (tx) => tx`
          SELECT helm.record_alert_delivery(
            ${alert.alert_id}::uuid, ${outcome.status}, ${outcome.error ?? null}
          )
        `,
        { role: 'worker' },
      );
    }
  }

  return { counts: { sent, failed }, idle: sent === 0 && failed === 0 };
}

async function deliverOne(
  notifier: AlertNotifier,
  tenant: AlertBacklogRow,
  alert: PendingAlertRow,
  log: JobContext['log'],
): Promise<{ status: 'sent' | 'failed'; error?: string }> {
  try {
    await notifier.send({
      tenantId: tenant.tenant_id,
      tenantName: tenant.tenant_name,
      channel: alert.channel,
      target: alert.target,
      ruleName: alert.rule_name,
      severity: alert.severity,
      leadDay: alert.lead_day,
      firedAt: alert.fired_at,
      payload: alert.payload,
    });
    return { status: 'sent' };
  } catch (error) {
    const described = describeError(error);
    log.warn('alert delivery failed', { alert: alert.alert_id, channel: alert.channel, ...described });
    return { status: 'failed', error: String(described.error ?? 'delivery failed') };
  }
}
