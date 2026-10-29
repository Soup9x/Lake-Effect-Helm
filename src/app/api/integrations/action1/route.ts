import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { getSecretService } from '@/lib/services';
import { ACTION1_REGION_URLS, Action1Error, fetchToken, listOrganizations } from '@/lib/action1/client';
import { readAction1Settings } from '@/lib/action1/queries';

/**
 * The Action1 connection (1160), as the NinjaOne one (0980):
 *
 * GATED ON integration:rmm:manage, here and again inside
 * helm.set_action1_connection(), which is the check that holds.
 *
 * A NEW SECRET IS TRIED BEFORE IT IS SAVED, and the organizations Action1
 * lists are recorded at the same time, so they can be mapped straight away.
 *
 * THE SECRET GOES INTO `secret` in the MSP's own organisation, as an elevated
 * API key whose reveal floor never locks the sync worker out. The trigger in
 * 1160 refuses any other home.
 */

/** system_sync's rank. The stored floor must never lock the worker out. */
const SYNC_ROLE_RANK = 80;

const schema = z.object({
  baseUrl: z.enum(ACTION1_REGION_URLS),
  clientId: z.string().trim().min(8).max(300),
  /** Absent keeps the stored secret. */
  clientSecret: z.string().trim().min(8).max(500).optional(),
  syncEnabled: z.boolean(),
  intervalMinutes: z.number().int().min(15).max(1440),
});

export const GET = tenantRoute(async ({ tx }) => readAction1Settings(tx));

export const PUT = tenantRoute(
  async ({ tx, request, session }) => {
    const body = await readJson(request, (raw) => {
      const result = schema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid Action1 settings', { issues: zodIssues(result.error) });
      }
      return result.data;
    });

    const current = await readAction1Settings(tx);
    if (!current.connection?.secretSet && body.clientSecret === undefined) {
      throw ApiError.invalid('the client secret is needed the first time Action1 is set up');
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
        if (error instanceof Action1Error) {
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
          label: 'Action1 API client secret',
          sensitivity: 'elevated',
          minRoleRank: Math.min(session.roleRank, SYNC_ROLE_RANK),
          requiresReason: false,
        },
        body.clientSecret,
      );
      secretId = created.secretId;
    }

    const [saved] = await tx<{ set_action1_connection: string }[]>`
      SELECT helm.set_action1_connection(
        ${body.baseUrl}, ${body.clientId}, ${secretId}::uuid,
        ${body.syncEnabled}, ${body.intervalMinutes})
    `;
    if (!saved?.set_action1_connection) throw ApiError.invalid('the Action1 connection could not be saved');

    if (organizations) {
      await tx`
        SELECT helm.record_action1_organizations(${saved.set_action1_connection}::uuid, ${tx.json(organizations)})
      `;
    }

    return {
      ...(await readAction1Settings(tx)),
      ...(organizations ? { tested: { organizations: organizations.length } } : {}),
    };
  },
  { permissions: ['integration:rmm:manage'] },
);

export const dynamic = 'force-dynamic';
