import { z } from 'zod';
import { tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { getLinkEngine } from '@/lib/services';
import { ALL_RELATIONS } from '@/lib/graph/relations';

const querySchema = z.object({
  // neighbours: one hop. dependencies: what this needs. impact: what breaks.
  view: z.enum(['neighbours', 'dependencies', 'impact']).default('neighbours'),
  depth: z.coerce.number().int().min(1).max(6).default(3),
  relation: z.array(z.enum(ALL_RELATIONS as [string, ...string[]])).optional(),
});

/**
 * GET /api/assets/:nodeId/graph?view=impact
 *
 * The traversal runs under the caller's RLS, so a client user tracing a
 * dependency stops at their organisation boundary rather than discovering that
 * another client's asset exists. That is a property of helm.asset_graph_walk,
 * not of this handler.
 */
export const GET = tenantRoute(
  async ({ request, params, identity }) => {
    const nodeId = params.nodeId;
    if (!nodeId || !z.guid().safeParse(nodeId).success) {
      throw ApiError.invalid('nodeId must be a UUID');
    }

    const url = new URL(request.url);
    const parsed = querySchema.safeParse({
      view: url.searchParams.get('view') ?? undefined,
      depth: url.searchParams.get('depth') ?? undefined,
      relation:
        url.searchParams.getAll('relation').length > 0
          ? url.searchParams.getAll('relation')
          : undefined,
    });
    if (!parsed.success) throw ApiError.invalid('invalid graph parameters');

    const links = getLinkEngine();
    const actor = { tenantId: identity.tenantId, actorId: identity.actorId };
    const { view, depth, relation } = parsed.data;

    switch (view) {
      case 'dependencies':
        return { view, nodes: await links.dependenciesOf(actor, nodeId, depth) };
      case 'impact':
        return { view, nodes: await links.impactOf(actor, nodeId, depth) };
      default:
        return {
          view,
          edges: await links.neighbours(actor, nodeId, {
            ...(relation ? { relations: relation as never } : {}),
          }),
        };
    }
  },
  { permissions: ['asset:read'] },
);

export const dynamic = 'force-dynamic';
