import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { clientNamedLike } from '@/lib/integrations/client-for';
import { readAction1Settings } from '@/lib/action1/queries';

/**
 * Which client each Action1 organization imports to (1160). Null is "Don't
 * import"; what was already imported stays, as the client's own documentation.
 * 'new' imports it to a client of the same name, created if Helm has none, as
 * NinjaOne's does.
 */
const schema = z.object({
  mappings: z.array(z.object({
    action1OrgId: z.string().trim().min(1).max(100),
    organizationId: z.union([z.guid(), z.literal('new')]).nullable(),
  })).min(1).max(1000),
});

export const PUT = tenantRoute(
  async ({ tx, request, session, identity }) => {
    const body = await readJson(request, (raw) => {
      const result = schema.safeParse(raw);
      if (!result.success) throw ApiError.invalid('invalid organization mapping', { issues: zodIssues(result.error) });
      return result.data;
    });

    const current = await readAction1Settings(tx);
    if (!current.connection) throw ApiError.notFound('Action1 is not set up');

    if (body.mappings.some((m) => m.organizationId === 'new') && !session.permissions.includes('organization:write')) {
      throw ApiError.forbidden('creating clients requires organization:write');
    }

    for (const mapping of body.mappings) {
      let organizationId = mapping.organizationId;
      if (organizationId === 'new') {
        const org = current.organizations.find((o) => o.action1OrgId === mapping.action1OrgId);
        if (!org) throw ApiError.notFound(`Action1 has no organization ${mapping.action1OrgId}`);
        organizationId = await clientNamedLike(tx, identity, org.name, `action1-${org.action1OrgId.slice(0, 8)}`);
      }

      const [row] = await tx<{ map_action1_organization: boolean }[]>`
        SELECT helm.map_action1_organization(
          ${current.connection.id}::uuid, ${mapping.action1OrgId}, ${organizationId}::uuid)
      `;
      if (!row?.map_action1_organization) {
        throw ApiError.notFound(`Action1 has no organization ${mapping.action1OrgId}`);
      }
    }

    return readAction1Settings(tx);
  },
  { permissions: ['integration:rmm:manage'] },
);

export const dynamic = 'force-dynamic';
