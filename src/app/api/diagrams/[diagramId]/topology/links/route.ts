import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { ARROWS, DIAGRAM_COLORS, LINE_STYLES } from '@/lib/topology/style';

/**
 * POST /api/diagrams/{diagramId}/topology/links — draw a line between two boxes.
 *
 * NOT the dependency graph. `POST /api/assets/links` records reliance and is
 * gated on asset:link; this records a cable. A firewall is connected to a
 * switch it does not depend on, and a server depends on a domain controller it
 * has no wire to, so the two produce different pictures from the same estate
 * and neither is a subset of the other.
 *
 * Direction is stored but means only "the order it was drawn": an arrow
 * (1190) is drawn relative to it, and the pair uniqueness index is built on
 * both columns, so A→B and B→A are one cable.
 */
const createSchema = z.object({
  fromNodeId: z.guid(),
  toNodeId: z.guid(),
  label: z.string().trim().max(80).optional(),
  lineStyle: z.enum(LINE_STYLES).optional(),
  arrow: z.enum(ARROWS).optional(),
  color: z.enum(DIAGRAM_COLORS).optional(),
});

export const POST = tenantRoute(
  async ({ tx, request, params }) => {
    const diagramId = params.diagramId;
    if (!diagramId || !z.guid().safeParse(diagramId).success) {
      throw ApiError.invalid('diagramId must be a UUID');
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

    // A diagram this reader cannot see, or that is not there, is a 404 rather
    // than the write policy's refusal: one answer for both, as on GET.
    const [diagram] = await tx`SELECT 1 FROM network_diagram WHERE id = ${diagramId}::uuid`;
    if (!diagram) throw ApiError.notFound('no such diagram');

    try {
      const [link] = await tx<{ id: string }[]>`
        INSERT INTO topology_link (
          tenant_id, diagram_id, from_node_id, to_node_id, label, line_style, arrow, color)
        VALUES (
          helm.require_tenant_id(), ${diagramId}::uuid,
          ${body.fromNodeId}::uuid, ${body.toNodeId}::uuid,
          ${body.label ?? null}, ${body.lineStyle ?? 'solid'}, ${body.arrow ?? 'none'},
          ${body.color ?? null})
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
        throw ApiError.invalid('no such diagram or box');
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
