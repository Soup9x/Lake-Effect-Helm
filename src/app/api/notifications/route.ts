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
 *
 * TWO TRANSPORTS, AND THE ADDRESS IS NOT A SECRET. 0690 gave a destination a
 * `transport`: a webhook POST or an email to a fixed address. The address is
 * returned in full where the URL never is, because for Discord and Teams the
 * URL *is* the credential, while an address is a destination somebody has to be
 * able to read to know where notifications are going.
 *
 * A TRANSPORT IS FIXED ONCE THE DESTINATION EXISTS. Switching one would have to
 * clear the envelope columns of the transport being left behind, re-validate
 * against the other transport's rules, and decide what the delivery history
 * now describes — for a saving of one "new destination" click. Refused with an
 * explanation instead, which is also why the stored transport is compared here
 * rather than passed blindly to the database.
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
  /**
   * Defaulted rather than required, so every caller written against 0420 still
   * means what it meant. A transport cannot be changed afterwards — see the
   * header — so the default only ever decides what a NEW destination is.
   */
  transport: z.enum(['webhook', 'email']).default('webhook'),
  /**
   * The payload shape, which only a webhook has.
   *
   * Optional HERE rather than defaulted, so the handler can tell "an email
   * caller left out a field that has no meaning for it" from "a webhook caller
   * forgot the platform". A webhook still has to name one, as it did before
   * 0690; `set_webhook_endpoint` stores 'generic' for an email destination
   * whatever arrives.
   */
  format: z.enum(['generic', 'slack', 'discord', 'teams']).optional(),
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
  /**
   * Where an email destination sends. Required to create one; on a save of an
   * existing one it may be omitted, and omitting it is what keeps the delivery
   * history — see the PUT.
   *
   * The database checks it against the tenant's allowed recipient domains, and
   * checks it AGAIN at send time, because a tenant can narrow those domains
   * after a destination was added.
   */
  emailAddress: z.string().trim().email().max(320).optional(),
});

interface DestinationRow {
  id: string;
  name: string;
  format: string;
  is_active: boolean;
  transport: 'webhook' | 'email';
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

function present(row: DestinationRow) {
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
    // Null for an email destination rather than '' — there is no URL, which is
    // a different thing from a URL nobody has set.
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

    if (current && current.transport !== body.transport) {
      // Refused rather than quietly ignored, which is what would happen
      // otherwise: an email destination saved as a webhook with no URL takes
      // the update path, and that function does not touch `transport`, so the
      // screen would report a change that never happened.
      throw ApiError.invalid(
        `this destination sends by ${current.transport} and that cannot be `
        + 'changed. Add a new destination and remove this one.',
        { issues: [{ path: 'transport', message: 'fixed once the destination exists' }] },
      );
    }

    if (body.transport === 'email') {
      if (body.url !== undefined || body.signingSecret !== undefined) {
        throw ApiError.invalid(
          'an email destination has no URL and nothing to sign: a signature '
          + 'proves a POST body came from Helm, and a mailbox has the envelope '
          + 'sender for that.',
          { issues: [{ path: 'url', message: 'not used by an email destination' }] },
        );
      }
      if (!current && body.emailAddress === undefined) {
        throw ApiError.invalid('an email destination needs an address');
      }
    } else {
      if (body.emailAddress !== undefined) {
        throw ApiError.invalid(
          'a webhook destination posts to a URL; it has no recipient address.',
          { issues: [{ path: 'emailAddress', message: 'not used by a webhook destination' }] },
        );
      }
      // Required for a webhook, exactly as it was before 0690: a Discord
      // destination quietly saved as generic JSON would POST a body Discord
      // refuses, and the first sign of it would be a delivery log nobody is
      // watching.
      if (body.format === undefined) {
        throw ApiError.invalid('a webhook destination needs a platform', {
          issues: [{ path: 'format', message: 'required for a webhook destination' }],
        });
      }
    }

    /*
     * WHICH FUNCTION, AND WHY THE ADDRESS IS COMPARED FIRST.
     *
     * `set_webhook_endpoint` writes the whole row and clears the delivery
     * history, because a destination whose target changed has not proved
     * anything by what the old one did. `update_webhook_endpoint` leaves the
     * target and the history alone.
     *
     * For a webhook the choice is simply whether a URL was supplied, since the
     * URL never comes back to the browser and so is only ever sent when it is
     * being set. An address DOES come back, so a form will send the same one on
     * every save — comparing it is what stops "rename this destination" from
     * silently resetting its failure count.
     */
    const addressChanged = body.transport === 'email'
      && body.emailAddress !== undefined
      && body.emailAddress.toLowerCase() !== (current?.email_address ?? '').toLowerCase();

    if (addressChanged) {
      // NO ENVELOPE AT ALL: nothing to seal and no HMAC key. 0690 made 0420's
      // "there is always an envelope" CHECK conditional on the transport for
      // exactly this call, and the id is left to the database because without
      // an AAD there is nothing it has to be chosen early for.
      await tx`
        SELECT helm.set_webhook_endpoint(
          ${body.id ?? null}::uuid, ${body.name}, ${body.format ?? 'generic'}::webhook_format,
          ${body.isActive}, ${body.organizationId ?? null}::uuid,
          ${body.events}::text[],
          NULL, NULL, false,
          ${body.maxAttempts}::smallint, ${body.timeoutMs},
          NULL, NULL, NULL, NULL, NULL, NULL, NULL,
          'email'::notification_transport, ${body.emailAddress!})
      `;
    } else if (body.url !== undefined) {
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
          ${id}::uuid, ${body.name}, ${body.format ?? 'generic'}::webhook_format, ${body.isActive},
          ${body.organizationId ?? null}::uuid, ${body.events}::text[],
          ${sealed.urlHost}, ${sealed.urlDigest}, ${sealed.signingSecretSet},
          ${body.maxAttempts}::smallint, ${body.timeoutMs},
          ${sealed.wrapProvider}, ${sealed.kekId}, ${sealed.wrappedDek},
          ${sealed.ciphertext}, ${sealed.nonce}, ${sealed.tag}, ${sealed.aad})
      `;
    } else {
      // Everything but the target: a webhook saved without a URL, or an email
      // destination whose address is the one already stored. This function
      // touches neither the envelope nor the delivery history, which is the
      // whole reason the two cases share it.
      const [updated] = await tx<{ update_webhook_endpoint: boolean }[]>`
        SELECT helm.update_webhook_endpoint(
          ${body.id!}::uuid, ${body.name}, ${body.format ?? 'generic'}::webhook_format,
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
