import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { sealWebhook, isDeliverable } from '@/lib/notifications/config';

/**
 * Outbound notification destinations.
 *
 * THE URL ONLY EVER TRAVELS INWARDS. No response shape here carries it, and
 * helm_app — the role these handlers run as — cannot read the column it lives
 * in even if one did (0420 asserts that per column, at migration time). What
 * the browser is told is the host and a twelve-character digest: enough to tell
 * three Discord webhooks apart, not enough to be one.
 *
 * GET is open to any tenant-wide role, because "where do export alerts go" is
 * something a Tier 3 engineer on a call needs to answer. Writes require
 * `integration:manage`, which tier3 holds — a notification destination is an
 * integration, and unlike RADIUS or OIDC it does not change how anybody
 * authenticates.
 */

/** Kept in step with helm.notification_events(); the database refuses the rest. */
const EVENTS = [
  'export.requested',
  'export.rendered',
  'export.downloaded',
  'export.revoked',
  'secret.revealed',
  'access.denied',
  'expiration.warning',
  'integration.failed',
  'key.rotated',
] as const;

const destinationSchema = z.object({
  id: z.guid().optional(),
  name: z.string().trim().min(1).max(80),
  format: z.enum(['generic', 'slack', 'discord', 'teams']),
  isActive: z.boolean(),
  /** Null means every client in the tenant. */
  organizationId: z.guid().nullable().optional(),
  events: z.array(z.enum(EVENTS)).min(1, 'choose at least one event'),
  maxAttempts: z.number().int().min(1).max(20),
  timeoutMs: z.number().int().min(500).max(30_000),
  /**
   * Absent means "leave the stored URL alone", which is what somebody adding an
   * event type wants. Demanding it on every save is how a webhook URL ends up
   * in a team note so it can be re-pasted.
   */
  url: z.string().url().optional(),
  /** Optional HMAC key, so a bespoke receiver can verify the body is Helm's. */
  signingSecret: z.string().min(16).max(256).optional(),
});

interface DestinationRow {
  id: string;
  name: string;
  format: string;
  is_active: boolean;
  organization_id: string | null;
  organization_name: string | null;
  events: string[];
  url_host: string;
  url_digest: string;
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

function present(row: DestinationRow) {
  return {
    id: row.id,
    name: row.name,
    format: row.format,
    isActive: row.is_active,
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
    updatedAt: row.updated_at.toISOString(),
  };
}

interface HistoryRow {
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

export const GET = tenantRoute(async ({ tx }) => {
  const [destinations, history] = await Promise.all([
    tx<DestinationRow[]>`SELECT * FROM helm.webhook_endpoints()`,
    tx<HistoryRow[]>`SELECT * FROM helm.recent_notifications(20)`,
  ]);

  return {
    destinations: destinations.map(present),
    // The delivery log, so the page can answer "did it go out" without anybody
    // going near the credential. Subjects and outcomes only.
    history: history.map((h) => ({
      id: h.id,
      destination: h.endpoint_name,
      event: h.event_type,
      subject: h.subject,
      status: h.status,
      attempts: h.attempts,
      responseCode: h.response_code,
      error: h.error,
      createdAt: h.created_at.toISOString(),
      deliveredAt: h.delivered_at?.toISOString() ?? null,
    })),
    events: EVENTS,
  };
});

export const PUT = tenantRoute(
  async ({ tx, request, session }) => {
    const body = await readJson(request, (raw) => {
      const result = destinationSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid notification destination', {
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      return result.data;
    });

    const existing = await tx<DestinationRow[]>`SELECT * FROM helm.webhook_endpoints()`;
    const current = body.id ? existing.find((d) => d.id === body.id) : undefined;

    if (body.id && !current) {
      throw ApiError.notFound('there is no such notification destination');
    }

    if (!current && body.url === undefined) {
      throw ApiError.invalid('a webhook URL is required the first time a destination is created');
    }

    if (body.url !== undefined) {
      // Said here as well as in the delivery worker: a notification names which
      // client has which expiring asset and who exported what. That is
      // reconnaissance, and an internal network is not a reason to put it on
      // the wire in clear.
      if (!isDeliverable(body.url)) {
        throw ApiError.invalid('the webhook URL must be https');
      }

      // The id is chosen HERE rather than by the database, because the AAD
      // binds the ciphertext to the endpoint it belongs to and the seal has to
      // happen before the insert.
      const id = body.id ?? crypto.randomUUID();

      // Encrypted in the application, because this is where the KEK provider
      // is. The database is handed ciphertext and has never been able to
      // produce plaintext from it.
      const sealed = await sealWebhook(session.tenantId, id, body.url, body.signingSecret);

      await tx`
        SELECT helm.set_webhook_endpoint(
          ${id}::uuid, ${body.name}, ${body.format}::webhook_format, ${body.isActive},
          ${body.organizationId ?? null}::uuid, ${body.events}::text[],
          ${sealed.urlHost}, ${sealed.urlDigest}, ${sealed.signingSecretSet},
          ${body.maxAttempts}::smallint, ${body.timeoutMs},
          ${sealed.wrapProvider}, ${sealed.kekId}, ${sealed.wrappedDek},
          ${sealed.ciphertext}, ${sealed.nonce}, ${sealed.tag}, ${sealed.aad})
      `;
    } else {
      const [updated] = await tx<{ update_webhook_endpoint: boolean }[]>`
        SELECT helm.update_webhook_endpoint(
          ${body.id!}::uuid, ${body.name}, ${body.format}::webhook_format,
          ${body.isActive}, ${body.organizationId ?? null}::uuid,
          ${body.events}::text[], ${body.maxAttempts}::smallint, ${body.timeoutMs})
      `;
      if (!updated?.update_webhook_endpoint) {
        throw ApiError.notFound('there is no such notification destination');
      }
    }

    const destinations = await tx<DestinationRow[]>`SELECT * FROM helm.webhook_endpoints()`;
    return { destinations: destinations.map(present) };
  },
  { permissions: ['integration:manage'] },
);

export const dynamic = 'force-dynamic';
