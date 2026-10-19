import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';

/**
 * POST /api/networks/{networkId}/topology/links — draw a line between two boxes.
 *
 * NOT the dependency graph. `POST /api/assets/links` records reliance and is
 * gated on asset:link; this records a cable. A firewall is connected to a
 * switch it does not depend on, and a server depends on a domain controller it
 * has no wire to, so the two produce different pictures from the same estate
 * and neither is a subset of the other.
 *
 * Direction is stored but means only "the order it was drawn": v1 renders a
 * plain line either way, and the pair uniqueness index is built on both
 * columns, so A→B and B→A are one cable.
 */
const createSchema = z.object({
  fromNodeId: z.guid(),
  toNodeId: z.guid(),
  label: z.string().trim().max(80).optional(),
});

export const POST = tenantRoute(
  async ({ tx, request, params }) => {
    const networkId = params.networkId;
    if (!networkId || !z.guid().safeParse(networkId).success) {
      throw ApiError.invalid('networkId must be a UUID');
    }

    const body = await readJson(request, (raw) => {
      const result = createSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid topology link', {
          issues: zodIssues(result.error),
        });
      }
      return result.data;
    });

    if (body.fromNodeId === body.toNodeId) {
      throw ApiError.invalid('a link needs two different nodes');
    }

    try {
      const [link] = await tx<{ id: string }[]>`
        INSERT INTO topology_link (tenant_id, network_id, from_node_id, to_node_id, label)
        VALUES (
          helm.require_tenant_id(), ${networkId}::uuid,
          ${body.fromNodeId}::uuid, ${body.toNodeId}::uuid,
          ${body.label ?? null})
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
        throw ApiError.invalid('no such network or box');
      }
      // The endpoint guard in 0570: both boxes must be on this diagram.
      if (code === '23514' || /must join two nodes on its own diagram/.test(String((error as Error).message))) {
        throw ApiError.invalid('both boxes must be on this diagram');
      }
      throw error;
    }
  },
  { permissions: ['asset:write'] },
);

export const dynamic = 'force-dynamic';
