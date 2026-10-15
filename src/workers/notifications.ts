/**
 * Outbound notifications.
 *
 * Two jobs, split the same way the expiry alerts are, and for the same reason.
 *
 *   FAN-OUT decides what should be sent. It reads forward from each tenant's
 *   cursor through the audit log and queues a delivery per subscribed
 *   destination. Idempotent: the unique constraint on (endpoint, event_uid)
 *   means a crash between the insert and the cursor update is recovered by
 *   running it again, not by sending twice.
 *
 *   DELIVERY takes what was queued and posts it. Separate because delivery is
 *   the part that talks to the outside world and therefore the part that fails:
 *   a Discord outage must not stop tomorrow's fan-out from noticing that
 *   somebody exported a client's credentials.
 *
 * WHY THIS MATTERS MORE THAN IT DID. 0400 removed two-person approval from
 * credential exports on the stated understanding that detection replaces
 * prevention. This is the detection. A fan-out that quietly stops is not a
 * degraded feature, it is the control being gone, so both jobs count what they
 * did and a tenant that fails does not abandon the rest.
 *
 * The URL is opened here and nowhere else — held for one fetch, written
 * nowhere. helm_app cannot read it at all (0420 asserts that per column).
 */
import { withTenant, db } from '../lib/db/client';
import type { Job, JobContext, JobResult } from './runtime';
import { describeError } from './runtime';
import { formatPayload, type NotificationEvent, type WebhookFormat } from '../lib/notifications/format';
import { isDeliverable, openWebhook, type SealedColumns } from '../lib/notifications/config';
import { EmailBatch } from '../lib/email/sender';
import { notificationBody } from '../lib/email/render';
import { describeTransportError } from '../lib/email/transport';

interface BacklogRow {
  tenant_id: string;
  tenant_name: string;
  worker_actor_id: string;
  due: string;
}

interface ClaimRow extends SealedColumns {
  delivery_id: string;
  endpoint_id: string;
  endpoint_name: string;
  format: WebhookFormat;
  /** 0690. 'email' takes the SMTP path below instead of a POST. */
  transport: 'webhook' | 'email';
  email_address: string | null;
  event_type: string;
  subject: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  organization_name: string | null;
  attempts: number;
  max_attempts: number;
  timeout_ms: number;
  custom_headers: Record<string, string>;
}

/**
 * How many audit rows one fan-out pass reads per tenant.
 *
 * Not configurable, and the reason is the same as for the password parameters:
 * a number an operator can turn down is a control somebody turns down. At 500
 * an hour-long backlog clears in one pass on any realistic deployment, and the
 * job runs every minute.
 */
const FANOUT_BATCH = 500;
const DELIVER_BATCH = 50;

export function fanOutNotificationsJob(): Job {
  return {
    name: 'notifications.fanout',
    // A credential export should show up in a channel while the person who
    // asked for it is still at their desk. A minute is the useful granularity;
    // anything longer and the notification arrives after the conversation.
    everyMs: 60 * 1000,
    lockKey: 0x48_45_4c_4d_08,
    run: fanOutNotifications,
  };
}

export function deliverNotificationsJob(): Job {
  return {
    name: 'notifications.deliver',
    everyMs: 60 * 1000,
    lockKey: 0x48_45_4c_4d_09,
    run: deliverNotifications,
  };
}

/**
 * Tenants to iterate.
 *
 * The fan-out needs every active tenant, not only those with something due —
 * the cursor has to advance past uninteresting audit rows or every run
 * re-reads them.
 */
interface TenantRow {
  tenant_id: string;
  tenant_name: string;
  worker_actor_id: string;
}

async function fanOutNotifications(ctx: JobContext): Promise<JobResult> {
  /*
   * THROUGH A DEFINER FUNCTION, and this was a bug for as long as it was not.
   * The raw `SELECT ... FROM tenant` that used to be here ran on the bare
   * worker pool, and `tenant` is behind RLS keyed on helm.current_tenant_id()
   * — which a worker connection does not set. It returned ZERO ROWS on every
   * tick, so this job never fanned anything out; 0400 traded two-person export
   * approval for these notifications, so the control was not running.
   *
   * Nothing caught it because every test calls helm.fan_out_notifications()
   * inside withTenant(), which is the right way to test the function and skips
   * the enumeration. The deliver half beside this one always used
   * helm.notification_backlog() — a definer function — which is why only the
   * fan-out was affected. See 0700's header for the whole account.
   */
  const tenants = await db('worker')<TenantRow[]>`
    SELECT * FROM helm.notification_fanout_backlog(50)
  `;
  if (tenants.length === 0) return { idle: true };

  let examined = 0;
  let queued = 0;
  let notified = 0;
  let failed = 0;

  for (const tenant of tenants) {
    if (ctx.stopping()) break;
    const log = ctx.log.child({ tenant: tenant.tenant_name });

    try {
      const [row] = await withTenant(
        { tenantId: tenant.tenant_id, actorId: tenant.worker_actor_id, actorType: 'service_account' },
        async (tx) => tx<{
          examined: number; queued: number; cursor_at: string; notified: number;
        }[]>`
          SELECT * FROM helm.fan_out_notifications(${FANOUT_BATCH})
        `,
        { role: 'worker' },
      );

      examined += Number(row?.examined ?? 0);
      queued += Number(row?.queued ?? 0);
      // 0700. Counted separately rather than folded into `queued`, because
      // `queued` means "outbound deliveries" in this job's log line and in
      // 0420's tests — and quietly changing what a number means is worse than
      // adding one. A tenant with no destination at all has queued 0 and
      // notified n, which is the air-gapped install working as intended.
      notified += Number(row?.notified ?? 0);
      if (Number(row?.queued ?? 0) > 0 || Number(row?.notified ?? 0) > 0) {
        log.info('notifications queued', {
          queued: Number(row?.queued ?? 0),
          notified: Number(row?.notified ?? 0),
        });
      }
    } catch (error) {
      // One tenant's failure must not abandon the rest — the same rule the
      // alert evaluator follows, and more important here: this is the control
      // that replaced export approval.
      failed += 1;
      log.error('fan-out failed', describeError(error));
    }
  }

  return {
    counts: { tenants: tenants.length, examined, queued, notified, failed },
    // Idle means "this pass did nothing", and filling a bell is doing
    // something: a tenant with no webhook destination would otherwise look
    // idle forever while its in-app inbox was being written.
    idle: queued === 0 && notified === 0,
  };
}

async function deliverNotifications(ctx: JobContext): Promise<JobResult> {
  const backlog = await db('worker')<BacklogRow[]>`SELECT * FROM helm.notification_backlog(50)`;
  if (backlog.length === 0) return { idle: true };

  let sent = 0;
  let failed = 0;
  let dead = 0;
  let tenantsFailed = 0;

  for (const tenant of backlog) {
    if (ctx.stopping()) break;
    const log = ctx.log.child({ tenant: tenant.tenant_name });
    const actor = {
      tenantId: tenant.tenant_id,
      actorId: tenant.worker_actor_id,
      actorType: 'service_account' as const,
    };

    /*
     * One mail connection per tenant, opened only if this batch actually holds
     * an email destination and closed in the finally below. A tenant whose
     * destinations are all webhooks never opens a socket to the relay, and a
     * tenant with twenty email deliveries opens one — not twenty, which is how
     * a relay's rate limiter decides Helm is a spam source.
     */
    let mail: EmailBatch | null = null;
    let mailOpened = false;
    /*
     * A relay that cannot be OPENED — most often an SMTP password that will not
     * decrypt — is recorded against each email delivery as a failed attempt,
     * not thrown. Thrown, it ended the whole run before anything was recorded:
     * claim_notifications() leaves rows pending, so the same tenant headed the
     * backlog again next tick and every tenant after it waited forever. Recorded,
     * the deliveries back off and eventually go dead like any other failure,
     * and this tenant's webhooks still go out.
     */
    let mailError: string | null = null;

    try {
      const due = await withTenant(
        actor,
        async (tx) => tx<ClaimRow[]>`SELECT * FROM helm.claim_notifications(${DELIVER_BATCH})`,
        { role: 'worker' },
      );

      for (const delivery of due) {
        if (ctx.stopping()) break;

        if (delivery.transport === 'email' && !mailOpened) {
          mailOpened = true;
          try {
            mail = await EmailBatch.open(actor);
          } catch (error) {
            const described = describeError(error);
            mailError = `the mail relay could not be opened: ${String(described.error)}`;
            log.error('the mail relay could not be opened', described);
          }
        }

        const outcome: Outcome = delivery.transport === 'email' && mailError
          ? { ok: false, responseCode: null, error: mailError }
          : await deliverOne(tenant, delivery, log, mail);
        if (outcome.ok) sent += 1;
        else failed += 1;

        // Recorded in its own transaction, deliberately. Batching a tenant's
        // results would mean a crash after twenty successful sends rolls back
        // the record that they happened — and the next run sends them again.
        const status = await withTenant(
          actor,
          async (tx) => {
            const [row] = await tx<{ record_notification_delivery: string }[]>`
              SELECT helm.record_notification_delivery(
                ${delivery.delivery_id}::uuid, ${outcome.ok},
                ${outcome.responseCode}, ${outcome.error ?? null})
            `;
            return row?.record_notification_delivery ?? 'unknown';
          },
          { role: 'worker' },
        );

        if (status === 'dead') {
          dead += 1;
          // Worth a log line of its own. A dead delivery is not retried, so
          // this is the last time anything says the notification did not
          // arrive.
          log.warn('notification gave up', {
            destination: delivery.endpoint_name,
            event: delivery.event_type,
            attempts: delivery.attempts + 1,
            ...(outcome.error ? { error: outcome.error } : {}),
          });
        }
      }
    } catch (error) {
      // One tenant's database or delivery fault must not abandon the tenants
      // after it — the header's promise, which this loop did not keep.
      tenantsFailed += 1;
      log.error('notification delivery failed for this tenant; continuing', describeError(error));
    } finally {
      mail?.close();
    }
  }

  return {
    counts: { sent, failed, dead, tenantsFailed },
    idle: sent === 0 && failed === 0 && tenantsFailed === 0,
  };
}

interface Outcome {
  ok: boolean;
  responseCode: number | null;
  error?: string;
}

async function deliverOne(
  tenant: BacklogRow,
  delivery: ClaimRow,
  log: JobContext['log'],
  mail: EmailBatch | null,
): Promise<Outcome> {
  /*
   * EMAIL TAKES THE SAME QUEUE AND A DIFFERENT WIRE. The payload was already
   * filtered by helm.notification_payload()'s allow-list and the subject built
   * by helm.notification_subject(), so this renders exactly what the other four
   * formats render — §2's rule that formatting differs between platforms and
   * facts do not.
   *
   * No envelope to open: an email destination has no URL and no signing secret,
   * and the relay's own password is read once per batch by EmailBatch.
   */
  if (delivery.transport === 'email') {
    if (!delivery.email_address) {
      // The transport CHECK makes this unreachable; reported rather than
      // crashing the batch if a row ever gets there another way.
      return { ok: false, responseCode: null, error: 'an email destination with no address' };
    }
    if (!mail) {
      return {
        ok: false,
        responseCode: null,
        error: 'outbound email is not configured for this tenant',
      };
    }
    try {
      await mail.send({
        to: delivery.email_address,
        subject: delivery.subject,
        text: notificationBody({
          subject: delivery.subject,
          eventType: delivery.event_type,
          organizationName: delivery.organization_name,
          occurredAt: delivery.occurred_at,
          payload: delivery.payload,
        }),
      });
      return { ok: true, responseCode: null };
    } catch (error) {
      const described = describeTransportError(error);
      log.warn('a notification could not be emailed', {
        destination: delivery.endpoint_name,
        reason: described.reason,
      });
      return { ok: false, responseCode: null, error: described.message };
    }
  }

  let url: string;
  let signingSecret: string | undefined;

  try {
    const opened = await openWebhook(tenant.tenant_id, delivery.endpoint_id, delivery);
    url = opened.url;
    signingSecret = opened.signingSecret;
  } catch (error) {
    // The AAD refused, or the KEK is unavailable. Not retryable in any useful
    // sense and worth saying plainly rather than as a network error.
    const described = describeError(error);
    log.error('could not open a destination URL', {
      destination: delivery.endpoint_name,
      ...described,
    });
    return { ok: false, responseCode: null, error: `could not open the destination URL: ${described.error}` };
  }

  if (!isDeliverable(url)) {
    return { ok: false, responseCode: null, error: 'the destination URL is not https' };
  }

  const event: NotificationEvent = {
    event: delivery.event_type,
    subject: delivery.subject,
    payload: delivery.payload,
    occurredAt: delivery.occurred_at,
    organizationName: delivery.organization_name,
    tenantName: tenant.tenant_name,
  };

  const body = JSON.stringify(formatPayload(delivery.format, event));

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    // Named so a receiver can filter Helm's traffic and so a platform's abuse
    // logs say who was calling.
    'user-agent': 'lake-effect-helm/1 (+notifications)',
    ...delivery.custom_headers,
  };

  if (signingSecret) {
    // HMAC over the exact bytes sent, with the timestamp inside the signed
    // material so a captured request cannot be replayed later. A receiver that
    // verifies this knows the body is Helm's and is fresh; one that does not is
    // trusting whoever found the URL.
    const { createHmac } = await import('node:crypto');
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac('sha256', signingSecret)
      .update(`${timestamp}.${body}`, 'utf8')
      .digest('hex');
    headers['x-helm-timestamp'] = timestamp;
    headers['x-helm-signature'] = `sha256=${signature}`;
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(delivery.timeout_ms),
      redirect: 'error',
    });

    if (!response.ok) {
      // The body often says exactly what is wrong — Discord names the field it
      // rejected — so the first part of it is kept. Truncated because a chat
      // platform returning HTML would otherwise fill the error column.
      const detail = await response.text().catch(() => '');
      return {
        ok: false,
        responseCode: response.status,
        error: `${response.status} ${response.statusText}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
      };
    }

    return { ok: true, responseCode: response.status };
  } catch (error) {
    const described = describeError(error);
    return { ok: false, responseCode: null, error: String(described.error ?? 'delivery failed') };
  }
}
