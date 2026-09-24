import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';

/**
 * POST /api/sites/{siteId}/topology/links — draw a line between two boxes.
 *
 * NOT the dependency graph. `POST /api/assets/links` records reliance and is
 * gated on asset:link; this records a cable. A firewall is connected to a
 * switch it does not depend on, and a server depends on a domain controller it
 * has no wire to, so the two produce different pictures from the same estate
 * and neither is a subset of the other.
 *
 * Direction is stored but not meaningful to the renderer: v1 draws straight
 * lines. It is kept because the sync has it — a device knows its uplink — and
 * re-deriving it later from a controller that may no longer report the device
 * would be impossible.
 */
const createSchema = z.object({
  fromNodeId: z.guid(),
  toNodeId: z.guid(),
  label: z.string().trim().max(80).optional(),
});

export const POST = tenantRoute(
  async ({ tx, request, params }) => {
    const siteId = params.siteId;
    if (!siteId || !z.guid().safeParse(siteId).success) {
      throw ApiError.invalid('siteId must be a UUID');
    }

    const body = await readJson(request, (raw) => {
      const result = createSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid topology link', {
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      return result.data;
    });

    if (body.fromNodeId === body.toNodeId) {
      throw ApiError.invalid('a link needs two different nodes');
    }

    try {
      const [link] = await tx<{ id: string }[]>`
        INSERT INTO topology_link (tenant_id, site_id, from_node_id, to_node_id, label, source)
        VALUES (
          helm.require_tenant_id(), ${siteId}::uuid,
          ${body.fromNodeId}::uuid, ${body.toNodeId}::uuid,
          ${body.label ?? null}, 'manual')
        RETURNING id
      `;
      if (!link) throw ApiError.conflict('the link could not be created');
      return { linkId: link.id };
    } catch (error) {
      const code = (error as { code?: string }).code;

      // The pair index covers both directions, so drawing a line that already
      // exists — either way round — is a duplicate rather than a second cable.
      if (code === '23505') {
        throw ApiError.conflict('these two nodes are already linked');
      }
      if (code === '23503') {
        throw ApiError.invalid('no such site or node');
      }
      // The endpoint guard in 0570: both nodes must be on this site.
      if (code === '23514' || /must join two nodes on its own site/.test(String((error as Error).message))) {
        throw ApiError.invalid('both nodes must be on this site');
      }
      throw error;
    }
  },
  { permissions: ['asset:write'] },
);

export const dynamic = 'force-dynamic';
