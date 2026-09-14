import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { getLinkEngine } from '@/lib/services';
import { ALL_RELATIONS } from '@/lib/graph/relations';

const linkSchema = z.object({
  sourceNodeId: z.guid(),
  relation: z.enum(ALL_RELATIONS as [string, ...string[]]),
  targetNodeId: z.guid(),
  note: z.string().max(1000).optional(),
  confidence: z.number().int().min(1).max(100).optional(),
});

const parse = (raw: unknown) => {
  const result = linkSchema.safeParse(raw);
  if (!result.success) {
    throw ApiError.invalid('invalid link', {
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
};

/**
 * POST /api/assets/links
 *
 * Idempotent in both directions: "firewall secures network" and "network
 * secured_by firewall" are the same fact and produce one row. `created` says
 * whether anything actually changed, so a bulk importer can report honestly.
 */
export const POST = tenantRoute(
  async ({ request, identity }) => {
    const body = await readJson(request, parse);
    return getLinkEngine().link(
      { tenantId: identity.tenantId, actorId: identity.actorId },
      {
        sourceNodeId: body.sourceNodeId,
        relation: body.relation as never,
        targetNodeId: body.targetNodeId,
        ...(body.note ? { note: body.note } : {}),
        ...(body.confidence ? { confidence: body.confidence } : {}),
      },
    );
  },
  { permissions: ['asset:link'] },
);

/**
 * DELETE /api/assets/links
 *
 * Takes the relationship in the body rather than an edge id, because the caller
 * naturally knows it as "these two, this way round" — and may be looking at the
 * reverse of how it is stored.
 */
export const DELETE = tenantRoute(
  async ({ request, identity }) => {
    const body = await readJson(request, parse);
    const removed = await getLinkEngine().unlink(
      { tenantId: identity.tenantId, actorId: identity.actorId },
      body.sourceNodeId,
      body.relation as never,
      body.targetNodeId,
    );
    return { removed };
  },
  { permissions: ['asset:link'] },
);

export const dynamic = 'force-dynamic';
