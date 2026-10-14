import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';

/**
 * POST /api/sops — write down a procedure.
 *
 * ITS OWN ROUTE RATHER THAN A LINE IN /api/assets, because that route says why:
 * "`credential`, `sop` and `flexible_asset` are absent on purpose. Each is a
 * node in the graph, but each is created by the flow that owns its payload."
 * A procedure's payload is its steps, so this is that flow. Adding 'sop' to
 * CREATABLE would have let somebody create the node and skip the part that
 * gives it meaning, which is the gap that left the category page saying "SOPs
 * are the one category with no create path".
 *
 * TWO ROWS, ONE TRANSACTION. asset_node carries the shared shape and takes part
 * in the graph; `sop` holds what is only true of a procedure. The composite key
 * asset_node (id, node_type) is what stops the second row claiming a different
 * type from the first.
 *
 * STEPS ARE NOT CREATED HERE. A procedure with no steps is a legitimate draft —
 * somebody writes the summary, then the steps, then publishes — and
 * PUT .../steps is one statement that replaces the whole ordered list, which is
 * a better fit for an editor than a create-then-append sequence. Publishing is
 * what refuses an empty one.
 *
 * sop:write, which tier2 and above hold. The RLS on `sop` independently
 * requires role rank 60, and those two agree by construction: tier2's rank IS
 * 60. Worth stating because they are set in different files.
 */
const createSchema = z.object({
  organizationId: z.guid('organizationId must be a UUID'),
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().max(80).nullable().optional(),
  summary: z.string().trim().max(2000).nullable().optional(),
  body: z.string().trim().max(50_000).nullable().optional(),
  isGlobal: z.boolean().optional(),
  reviewIntervalDays: z.number().int().min(1).max(3650).nullable().optional(),
  estimatedMinutes: z.number().int().min(1).max(10_000).nullable().optional(),
});

export const POST = tenantRoute(
  async ({ tx, request, identity }) => {
    const body = await readJson(request, (raw) => {
      const result = createSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid procedure', {
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      return result.data;
    });

    let node: { id: string } | undefined;
    try {
      [node] = await tx<{ id: string }[]>`
        INSERT INTO asset_node (
          tenant_id, organization_id, node_type, name, criticality, created_by, updated_by
        )
        VALUES (
          ${identity.tenantId}::uuid, ${body.organizationId}::uuid, 'sop',
          ${body.name}, 3, ${identity.actorId}::uuid, ${identity.actorId}::uuid
        )
        RETURNING id
      `;
    } catch (error) {
      // organization_id is reached through a composite key carrying tenant_id,
      // so another tenant's id fails here rather than being re-checked above.
      if ((error as { code?: string }).code === '23503') {
        throw ApiError.invalid('no such client');
      }
      throw error;
    }
    if (!node) throw ApiError.conflict('the procedure could not be created');

    await tx`
      INSERT INTO sop (
        id, tenant_id, node_type, category, summary, body, is_global,
        review_interval_days, estimated_minutes, owner_user_id
      )
      VALUES (
        ${node.id}::uuid, ${identity.tenantId}::uuid, 'sop',
        ${body.category ?? null}, ${body.summary ?? null}, ${body.body ?? null},
        ${body.isGlobal ?? false},
        ${body.reviewIntervalDays ?? null}, ${body.estimatedMinutes ?? null},
        ${identity.actorId}::uuid
      )
    `;

    return { sopId: node.id };
  },
  { permissions: ['sop:write'] },
);

export const dynamic = 'force-dynamic';
