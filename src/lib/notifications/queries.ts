/**
 * What the settings page shows about outbound notifications.
 *
 * Both reads go through SECURITY DEFINER functions: helm_app cannot read a
 * webhook URL, and helm.webhook_endpoints() hands back a host and a digest in
 * its place. The row types here are the functions' result shapes; the mappers
 * turn them into what the card renders. They lived in the page until the page
 * was 800 lines of which 250 were row shapes.
 */
import type { HelmTx } from '../db/client';
import type {
  NotificationDelivery,
  NotificationDestination,
} from '@/components/notification-settings';

interface DestinationRow {
  id: string;
  name: string;
  format: NotificationDestination['format'];
  is_active: boolean;
  transport: NotificationDestination['transport'];
  email_address: string | null;
  organization_id: string | null;
  organization_name: string | null;
  events: string[];
  url_host: string | null;
  url_digest: string | null;
  signing_secret_set: boolean;
  max_attempts: number;
  timeout_ms: number;
  last_delivery_at: Date | null;
  last_delivery_ok: boolean | null;
  last_delivery_error: string | null;
  consecutive_failures: number;
  pending_count: string;
  dead_count: string;
  updated_at: Date;
}

interface DeliveryRow {
  id: string;
  endpoint_name: string;
  event_type: string;
  subject: string;
  status: string;
  attempts: number;
  response_code: number | null;
  error: string | null;
  created_at: Date;
  delivered_at: Date | null;
}

/** The subscribable vocabulary, mirroring helm.notification_events(). */
export const NOTIFICATION_EVENTS = [
  'export.requested', 'export.rendered', 'export.downloaded', 'export.revoked',
  'secret.revealed', 'access.denied', 'expiration.warning',
  'integration.failed', 'key.rotated',
] as const;

export function toDestination(row: DestinationRow): NotificationDestination {
  return {
    id: row.id,
    name: row.name,
    format: row.format,
    isActive: row.is_active,
    transport: row.transport,
    emailAddress: row.email_address,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    events: row.events,
    urlHost: row.url_host,
    urlDigest: row.url_digest,
    signingSecretSet: row.signing_secret_set,
    maxAttempts: row.max_attempts,
    timeoutMs: row.timeout_ms,
    lastDeliveryAt: row.last_delivery_at?.toISOString() ?? null,
    lastDeliveryOk: row.last_delivery_ok,
    lastDeliveryError: row.last_delivery_error,
    consecutiveFailures: row.consecutive_failures,
    pendingCount: Number(row.pending_count),
    deadCount: Number(row.dead_count),
  };
}

export function toDelivery(row: DeliveryRow): NotificationDelivery {
  return {
    id: row.id,
    destination: row.endpoint_name,
    event: row.event_type,
    subject: row.subject,
    status: row.status,
    attempts: row.attempts,
    responseCode: row.response_code,
    error: row.error,
    createdAt: row.created_at.toISOString(),
    deliveredAt: row.delivered_at?.toISOString() ?? null,
  };
}


/** Every destination the tenant has configured, as the card renders them. */
export async function listNotificationDestinations(tx: HelmTx): Promise<NotificationDestination[]> {
  const rows = await tx<DestinationRow[]>`SELECT * FROM helm.webhook_endpoints()`;
  return rows.map(toDestination);
}

/** The most recent deliveries, newest first. */
export async function listRecentDeliveries(tx: HelmTx, limit = 20): Promise<NotificationDelivery[]> {
  const rows = await tx<DeliveryRow[]>`SELECT * FROM helm.recent_notifications(${limit})`;
  return rows.map(toDelivery);
}
