import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { getLinkEngine } from '@/lib/services';
import { ALL_RELATIONS } from '@/lib/graph/relations';

/**
 * `relation` is OPTIONAL and defaults to `related_to`.
 *
 * The interface no longer asks which kind of relationship two assets have. It
 * asks which asset, and optionally why — because in practice the answer to
 * "depends_on or supports?" is "it depends which end you are standing at", and
 * making somebody choose produced a dropdown of twenty-two options in front of
 * a question they had not asked.
 *
 * The vocabulary stays in the schema and in this contract. Intrinsic edges —
 * a device's primary network, a certificate's domain — are projected from
 * foreign keys with real relations, the impact graph traverses them, and an
 * importer or a future integration may well want to state one. What changed is
 * that a person no longer has to.
 *
 * `related_to` is its own inverse, so a link created this way canonicalises to
 * one row whichever way round it was written, and the unique constraint on
 * (source, target, relation) then means one link per pair.
 */
const linkSchema = z.object({
  sourceNodeId: z.guid(),
  relation: z.enum(ALL_RELATIONS as [string, ...string[]]).default('related_to'),
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
