import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';

const createSchema = z.object({
  organizationId: z.guid(),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).nullable().optional(),
  /** Which location it is of, if one. */
  siteId: z.guid().nullable().optional(),
  /** Which network entry it is mainly about, if one. */
  networkId: z.guid().nullable().optional(),
  isInternalOnly: z.boolean().default(false),
});

/**
 * POST /api/diagrams — start a new network diagram for a client (0880).
 *
 * The organization is not re-checked here: an id this actor cannot reach fails
 * the composite foreign key, and a location or network entry of another client
 * fails 0880's guard. Both are one answer each, deliberately.
 */
export const POST = tenantRoute(
  async ({ tx, request, identity }) => {
    const body = await readJson(request, (raw) => {
      const result = createSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid diagram', { issues: zodIssues(result.error) });
      }
      return result.data;
    });

    let created: { id: string; name: string } | undefined;
    try {
      [created] = await tx<{ id: string; name: string }[]>`
        INSERT INTO network_diagram (
          tenant_id, organization_id, site_id, network_id, name, description,
          is_internal_only, created_by, updated_by
        )
        VALUES (
          ${identity.tenantId}::uuid, ${body.organizationId}::uuid,
          ${body.siteId ?? null}::uuid, ${body.networkId ?? null}::uuid,
          ${body.name}, ${body.description || null}, ${body.isInternalOnly},
          ${identity.actorId}::uuid, ${identity.actorId}::uuid
        )
        RETURNING id, name
      `;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === '23503') throw ApiError.invalid('no such client, location or network');
      if (code === '23514') {
        throw ApiError.invalid('the location and network must be this client’s');
      }
      throw error;
    }
    if (!created) throw ApiError.conflict('the diagram could not be created');

    return { diagram: created };
  },
  { permissions: ['asset:write'] },
);

export const dynamic = 'force-dynamic';
