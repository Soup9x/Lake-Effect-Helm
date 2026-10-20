import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { readNinjaSettings } from '@/lib/ninja/queries';

/**
 * Which client each NinjaOne organisation imports to (0980). Null stops
 * importing it; what was already imported stays, as the client's own
 * documentation.
 */
const schema = z.object({
  mappings: z.array(z.object({
    ninjaOrgId: z.string().trim().min(1).max(64),
    organizationId: z.guid().nullable(),
  })).min(1).max(1000),
});

export const PUT = tenantRoute(
  async ({ tx, request }) => {
    const body = await readJson(request, (raw) => {
      const result = schema.safeParse(raw);
      if (!result.success) throw ApiError.invalid('invalid organisation mapping', { issues: zodIssues(result.error) });
      return result.data;
    });

    const current = await readNinjaSettings(tx);
    if (!current.connection) throw ApiError.notFound('NinjaOne is not set up');

    for (const mapping of body.mappings) {
      const [row] = await tx<{ map_ninja_organization: boolean }[]>`
        SELECT helm.map_ninja_organization(
          ${current.connection.id}::uuid, ${mapping.ninjaOrgId}, ${mapping.organizationId}::uuid)
      `;
      if (!row?.map_ninja_organization) {
        throw ApiError.notFound(`NinjaOne has no organisation ${mapping.ninjaOrgId}`);
      }
    }

    return readNinjaSettings(tx);
  },
  { permissions: ['integration:rmm:manage'] },
);

export const dynamic = 'force-dynamic';
