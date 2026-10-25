import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { getSecretService } from '@/lib/services';
import { ENTRA_TENANT, GraphError, fetchToken, readOrganization } from '@/lib/m365/client';
import { listM365Connections } from '@/lib/m365/queries';

/**
 * Microsoft 365 connections, one per client (0990).
 *
 * GATED ON integration:m365:manage, here and again in helm.set_m365_connection().
 *
 * A NEW SECRET IS TRIED FIRST: Helm signs in to the client's tenant and reads
 * its name before storing anything, so a wrong tenant, client id or secret is
 * reported to the person who typed it and nothing is saved.
 *
 * ONE APP FOR EVERY CLIENT is the usual way: a multi-tenant app registration of
 * the MSP's, consented in each client's tenant. `reuseSecretFrom` names an
 * existing connection whose secret to use, so it is pasted once rather than
 * once per client. The secret lives in the MSP's own organisation either way.
 */

/** system_sync's rank: the stored floor must never lock the worker out. */
const SYNC_ROLE_RANK = 80;

const schema = z.object({
  organizationId: z.guid(),
  tenant: z.string().trim().regex(ENTRA_TENANT, 'a tenant ID (a GUID) or one of its domains'),
  clientId: z.guid(),
  clientSecret: z.string().trim().min(8).max(500).optional(),
  reuseSecretFrom: z.guid().optional(),
  syncEnabled: z.boolean(),
  intervalMinutes: z.number().int().min(30).max(10080),
  syncUsers: z.boolean(),
  syncLicences: z.boolean(),
  syncDomains: z.boolean(),
});

export const GET = tenantRoute(async ({ tx }) => ({ connections: await listM365Connections(tx) }));

export const PUT = tenantRoute(
  async ({ tx, request, session }) => {
    const body = await readJson(request, (raw) => {
      const result = schema.safeParse(raw);
      if (!result.success) throw ApiError.invalid('invalid Microsoft 365 connection', { issues: zodIssues(result.error) });
      return result.data;
    });
    if (body.clientSecret && body.reuseSecretFrom) {
      throw ApiError.invalid('give a new secret or reuse one, not both');
    }

    const existing = (await listM365Connections(tx)).find((c) => c.organizationId === body.organizationId);
    const changedApp = existing && (existing.tenant !== body.tenant || existing.clientId !== body.clientId);
    if (!body.clientSecret && !body.reuseSecretFrom && (!existing || changedApp)) {
      throw ApiError.invalid(existing
        ? 'enter the client secret again when changing the tenant or client ID, so they can be tried together'
        : 'a client secret is needed to connect Microsoft 365');
    }

    let secretId: string | null = null;
    let tenantName: string | null = null;

    if (body.reuseSecretFrom) {
      const [source] = await tx<{ secret_id: string | null }[]>`
        SELECT credential_secret_ids ->> 'client_secret' AS secret_id
        FROM integration_connection
        WHERE id = ${body.reuseSecretFrom}::uuid AND provider = 'microsoft_graph'
          AND config ->> 'client_id' = ${body.clientId}
      `;
      if (!source?.secret_id) {
        throw ApiError.invalid('that connection does not use this client ID, so its secret cannot be reused');
      }
      secretId = source.secret_id;
    }

    if (body.clientSecret) {
      try {
        const target = { tenant: body.tenant, clientId: body.clientId, clientSecret: body.clientSecret };
        const token = await fetchToken(target);
        tenantName = (await readOrganization(target, token)).displayName;
      } catch (error) {
        if (error instanceof GraphError) {
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
          label: `Microsoft 365 app secret (${body.clientId.slice(0, 8)}…)`,
          sensitivity: 'elevated',
          minRoleRank: Math.min(session.roleRank, SYNC_ROLE_RANK),
          requiresReason: false,
        },
        body.clientSecret,
      );
      secretId = created.secretId;
    }

    await tx`
      SELECT helm.set_m365_connection(
        ${body.organizationId}::uuid, ${body.tenant}, ${tenantName}, ${body.clientId},
        ${secretId}::uuid, ${body.syncEnabled}, ${body.intervalMinutes},
        ${body.syncUsers}, ${body.syncLicences}, ${body.syncDomains})
    `;

    return {
      connections: await listM365Connections(tx),
      ...(tenantName ? { tested: { tenantName } } : {}),
    };
  },
  { permissions: ['integration:m365:manage'] },
);

export const dynamic = 'force-dynamic';
