import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { getSecretService } from '@/lib/services';

/**
 * UniFi controller mappings.
 *
 * EVERY WRITE IS GATED ON integration:network:manage AND NOTHING ELSE.
 *
 * Not tenant:write: making a technician a super_admin so they can type in a
 * controller URL would hand them the tenant's authentication settings and key
 * rotation at the same time. Not integration:manage either, which would bundle
 * this with the notification webhooks and whatever lands in that bucket later.
 *
 * The permission is checked twice on purpose — here by tenantRoute, so the
 * request is refused before any work happens, and again inside
 * helm.set_unifi_mapping(), so a caller reaching the function by any other path
 * is refused by the database. Neither check is redundant: the first gives a 403
 * with a message, the second is the one that actually holds.
 *
 * THE API KEY GOES INTO `secret`, through SecretService, exactly like a
 * client's credentials. That is what gives it the reveal ladder, an audit row
 * per access, rotation, and the helm_app-writes-but-never-reads boundary. A
 * bespoke encrypted column on the mapping would have had to re-earn all four.
 */

/**
 * The rank the sync worker runs at — system_sync, rank 80.
 *
 * A credential the worker cannot reveal is a mapping that can never poll, so
 * the stored floor must never exceed this. A super_admin (rank 100)
 * configuring a controller must not lock the worker out of the key it needs.
 */
const SYNC_ROLE_RANK = 80;

const mappingSchema = z.object({
  id: z.guid().optional(),
  organizationId: z.guid(),
  name: z.string().trim().min(1).max(80),
  /**
   * Origin only. The Integration API path is appended verbatim, so a trailing
   * slash produces a double slash that 404s on some builds — refused here
   * rather than silently trimmed, because an operator who pasted a full URL
   * should be told which part to remove.
   */
  controllerUrl: z
    .string()
    .trim()
    .url()
    .refine((u) => u.startsWith('https://'), 'the controller URL must be https')
    .refine((u) => {
      try {
        const parsed = new URL(u);
        return parsed.pathname === '/' && parsed.search === '' && parsed.hash === '';
      } catch {
        return false;
      }
    }, 'give the controller origin only — https://host[:port], with no path'),
  unifiSiteId: z.string().trim().min(1).max(128),
  isActive: z.boolean(),
  /** Per mapping. A busy site and a quiet one do not want the same number. */
  pollIntervalSeconds: z.number().int().min(30).max(86_400),
  /**
   * Absent means "keep the stored key", so changing a poll interval does not
   * require re-pasting the credential — the friction that ends with an API key
   * in a team note so it can be re-typed.
   */
  apiKey: z.string().trim().min(8).max(512).optional(),
  /**
   * A pinned certificate fingerprint. NOT a verification disable: the mapping
   * will accept this certificate and no other. Sent only after an operator has
   * seen the fingerprint in the connection test and accepted it.
   */
  tlsPinnedSha256: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{64}$/, 'a sha256 fingerprint is 64 lowercase hex characters')
    .nullable()
    .optional(),
});

interface MappingRow {
  id: string;
  organization_id: string;
  organization_name: string;
  name: string;
  controller_url: string;
  unifi_site_id: string;
  is_active: boolean;
  api_key_set: boolean;
  tls_verify: boolean;
  tls_pinned_sha256: string | null;
  tls_exception_ack_at: Date | null;
  tls_exception_ack_by_name: string | null;
  poll_interval_seconds: number;
  last_poll_at: Date | null;
  last_poll_ok: boolean | null;
  last_poll_error: string | null;
  consecutive_failures: number;
  next_poll_at: Date;
  last_device_count: number | null;
  last_client_count: number | null;
  asset_count: string;
  updated_at: Date;
}

function present(row: MappingRow) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    name: row.name,
    controllerUrl: row.controller_url,
    unifiSiteId: row.unifi_site_id,
    isActive: row.is_active,
    // Whether a key exists, never the key. helm_app cannot read secret material
    // and this shape could not carry it even if it tried.
    apiKeySet: row.api_key_set,
    tlsVerify: row.tls_verify,
    tlsPinnedSha256: row.tls_pinned_sha256,
    tlsExceptionAckAt: row.tls_exception_ack_at?.toISOString() ?? null,
    tlsExceptionAckByName: row.tls_exception_ack_by_name,
    pollIntervalSeconds: row.poll_interval_seconds,
    lastPollAt: row.last_poll_at?.toISOString() ?? null,
    lastPollOk: row.last_poll_ok,
    lastPollError: row.last_poll_error,
    consecutiveFailures: row.consecutive_failures,
    nextPollAt: row.next_poll_at.toISOString(),
    lastDeviceCount: row.last_device_count,
    lastClientCount: row.last_client_count,
    assetCount: Number(row.asset_count),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Reading is open to any tenant-wide role.
 *
 * "Which controller does this client use, and is it polling" is something a
 * Tier 1 on a support call needs to answer, and the row carries no credential —
 * only a reference to one.
 */
export const GET = tenantRoute(async ({ tx }) => {
  const rows = await tx<MappingRow[]>`SELECT * FROM helm.unifi_mappings()`;
  return { mappings: rows.map(present) };
});

export const PUT = tenantRoute(
  async ({ tx, request, session }) => {
    const body = await readJson(request, (raw) => {
      const result = mappingSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid controller mapping', {
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      return result.data;
    });

    const existing = await tx<MappingRow[]>`SELECT * FROM helm.unifi_mappings()`;
    const current = body.id ? existing.find((m) => m.id === body.id) : undefined;

    if (body.id && !current) {
      throw ApiError.notFound('there is no such controller mapping');
    }

    if (!current && body.apiKey === undefined) {
      throw ApiError.invalid('an API key is required the first time a controller is configured');
    }

    if (body.isActive && !current?.api_key_set && body.apiKey === undefined) {
      throw ApiError.invalid('a mapping cannot be made active without an API key');
    }

    let secretId: string | null = null;

    if (body.apiKey !== undefined) {
      /*
       * Stored as a secret, in the caller's transaction.
       *
       * createInTransaction rather than create: the credential and the mapping
       * that points at it must land together, or a failure between them leaves
       * either a mapping referencing nothing or an orphaned credential in the
       * vault. The export engine learned the same lesson.
       *
       * THE REVEAL FLOOR IS THE CONFIGURER'S OWN RANK, CLAMPED TO THE WORKER'S.
       *
       * Hardcoding a rank was the first attempt and it was wrong at both ends.
       * Too high and the person who holds integration:network:manage cannot
       * create the credential at all — an invisible second gate on top of the
       * permission, which is exactly what this design set out not to have. Too
       * high in the other direction and system_sync (rank 80) cannot reveal the
       * key, so every poll fails.
       *
       * The actor's own rank is the honest floor: whoever configured the
       * controller can read back what they stored, and anybody more junior
       * cannot. Clamped to SYNC_ROLE_RANK so the worker is never locked out.
       *
       * sensitivity 'elevated' regardless: an API key that reads a client's
       * entire network inventory is not a standard-sensitivity password.
       */
      const created = await getSecretService().createInTransaction(
        tx,
        {
          tenantId: session.tenantId,
          actorId: session.actorId,
          actorType: session.actorType,
        },
        {
          organizationId: body.organizationId,
          kind: 'api_key',
          label: `UniFi controller — ${body.name}`,
          sensitivity: 'elevated',
          minRoleRank: Math.min(session.roleRank, SYNC_ROLE_RANK),
          requiresReason: false,
        },
        body.apiKey,
      );
      secretId = created.secretId;
    }

    const [saved] = await tx<{ set_unifi_mapping: string }[]>`
      SELECT helm.set_unifi_mapping(
        ${body.id ?? null}::uuid,
        ${body.organizationId}::uuid,
        ${body.name},
        ${body.controllerUrl},
        ${body.unifiSiteId},
        ${body.isActive},
        ${body.pollIntervalSeconds},
        ${secretId}::uuid,
        ${body.tlsPinnedSha256 ?? null})
    `;

    if (!saved?.set_unifi_mapping) {
      throw ApiError.invalid('the controller mapping could not be saved');
    }

    const rows = await tx<MappingRow[]>`SELECT * FROM helm.unifi_mappings()`;
    return { mappings: rows.map(present) };
  },
  { permissions: ['integration:network:manage'] },
);

export const dynamic = 'force-dynamic';
