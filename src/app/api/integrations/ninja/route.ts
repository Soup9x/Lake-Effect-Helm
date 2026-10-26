import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { getSecretService } from '@/lib/services';
import { NINJA_REGION_URLS, NinjaError, fetchToken, listOrganizations } from '@/lib/ninja/client';
import { readNinjaSettings } from '@/lib/ninja/queries';

/**
 * The NinjaOne connection (0980).
 *
 * GATED ON integration:rmm:manage, here so the request is refused with a
 * message and again inside helm.set_ninja_connection(), which is the check
 * that holds.
 *
 * A NEW SECRET IS TRIED BEFORE IT IS SAVED. Saving a secret that NinjaOne
 * refuses would leave a connection that fails every hour until somebody
 * notices; asking NinjaOne first means the person who typed it is told now,
 * and nothing is stored. The organisations NinjaOne returns are recorded at the
 * same time, so they can be mapped to clients straight away rather than after
 * the first sync.
 *
 * THE SECRET GOES INTO `secret` in the MSP's own organisation, as an elevated
 * API key whose reveal floor is the saver's rank clamped to the sync worker's,
 * exactly as the UniFi key does. The trigger in 0980 refuses any other home.
 */

/** system_sync's rank. The stored floor must never lock the worker out. */
const SYNC_ROLE_RANK = 80;

const schema = z.object({
  baseUrl: z.enum(NINJA_REGION_URLS),
  clientId: z.string().trim().min(8).max(200),
  /** Absent keeps the stored secret. */
  clientSecret: z.string().trim().min(8).max(500).optional(),
  syncEnabled: z.boolean(),
  intervalMinutes: z.number().int().min(15).max(1440),
  /**
   * Where people sign in, for links (1090): an https origin, or null for the
   * regional host. Absent leaves it as it is.
   */
  portalUrl: z.string().trim()
    .transform((v) => v.replace(/\/+$/, ''))
    .pipe(z.string().regex(/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/, 'an https address with no path, like https://yourcompany.rmmservices.net'))
    .nullable().optional(),
});

export const GET = tenantRoute(async ({ tx }) => readNinjaSettings(tx));

export const PUT = tenantRoute(
  async ({ tx, request, session }) => {
    const body = await readJson(request, (raw) => {
      const result = schema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid NinjaOne settings', { issues: zodIssues(result.error) });
      }
      return result.data;
    });

    const current = await readNinjaSettings(tx);
    if (!current.connection?.secretSet && body.clientSecret === undefined) {
      throw ApiError.invalid('the client secret is needed the first time NinjaOne is set up');
    }
    if (current.connection && body.clientSecret === undefined
        && (current.connection.baseUrl !== body.baseUrl || current.connection.clientId !== body.clientId)) {
      throw ApiError.invalid('enter the client secret again when changing the region or client id, so they can be tried together');
    }

    let secretId: string | null = null;
    let organizations: { id: string; name: string | null }[] | null = null;

    if (body.clientSecret !== undefined) {
      try {
        const target = { baseUrl: body.baseUrl, clientId: body.clientId, clientSecret: body.clientSecret };
        const token = await fetchToken(target);
        organizations = (await listOrganizations(target, token))
          .map((o) => ({ id: String(o.id), name: o.name ?? null }));
      } catch (error) {
        if (error instanceof NinjaError) {
          throw ApiError.invalid(`${error.message}. Nothing was saved.`, {
            kind: error.kind,
            ...(error.remedy ? { remedy: error.remedy } : {}),
          });
        }
        throw error;
      }

      const [internal] = await tx<{ id: string }[]>`
        SELECT id FROM organization WHERE is_msp_internal AND deleted_at IS NULL LIMIT 1
      `;
      if (!internal) {
        throw ApiError.invalid('this MSP has no internal organisation to keep the secret in', {
          remedy: 'Mark your own organisation as the MSP\'s on the server; see docs/deployment/on-premises.md §6.',
        });
      }

      const created = await getSecretService().createInTransaction(
        tx,
        { tenantId: session.tenantId, actorId: session.actorId, actorType: session.actorType },
        {
          organizationId: internal.id,
          kind: 'api_key',
          label: 'NinjaOne API client secret',
          sensitivity: 'elevated',
          minRoleRank: Math.min(session.roleRank, SYNC_ROLE_RANK),
          requiresReason: false,
        },
        body.clientSecret,
      );
      secretId = created.secretId;
    }

    const [saved] = await tx<{ set_ninja_connection: string }[]>`
      SELECT helm.set_ninja_connection(
        ${body.baseUrl}, ${body.clientId}, ${secretId}::uuid,
        ${body.syncEnabled}, ${body.intervalMinutes})
    `;
    if (!saved?.set_ninja_connection) throw ApiError.invalid('the NinjaOne connection could not be saved');

    if (organizations) {
      await tx`
        SELECT helm.record_ninja_organizations(${saved.set_ninja_connection}::uuid, ${tx.json(organizations)})
      `;
    }
    if (body.portalUrl !== undefined) {
      await tx`SELECT helm.set_ninja_portal_url(${body.portalUrl})`;
    }

    return {
      ...(await readNinjaSettings(tx)),
      ...(organizations ? { tested: { organizations: organizations.length } } : {}),
    };
  },
  { permissions: ['integration:rmm:manage'] },
);

export const dynamic = 'force-dynamic';
