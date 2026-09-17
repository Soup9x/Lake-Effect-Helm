import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { MAX_SELECTION, bulkAddTags, bulkRemoveTags } from '@/lib/bulk/service';

const schema = z.object({
  target: z.enum(['client', 'node']),
  ids: z.array(z.guid()).min(1).max(MAX_SELECTION),
  tags: z.array(z.string().trim().min(1).max(60)).min(1).max(20),
  mode: z.enum(['add', 'remove']).default('add'),
});

/**
 * POST /api/bulk/tags — tag or untag a selection.
 *
 * `asset:write` and `organization:write` are declared as a fast, clear refusal
 * for somebody who holds neither. They are NOT the boundary: the UPDATE runs
 * under RLS, which decides per row whether this actor may write it, and a
 * selection spanning clients they can and cannot reach is refused entirely
 * rather than partly applied. See lib/bulk/service.ts.
 */
export const POST = tenantRoute(
  async ({ tx, request }) => {
    const body = await readJson(request, (raw) => {
      const result = schema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid bulk tag request', {
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      return result.data;
    });

    const outcome =
      body.mode === 'add'
        ? await bulkAddTags(tx, body.target, body.ids, body.tags)
        : await bulkRemoveTags(tx, body.target, body.ids, body.tags);

    // Audited as ONE event naming the whole selection rather than N events.
    // "Somebody tagged 40 clients" is the fact worth reading back; forty
    // identical rows is the same fact spread thin enough to scroll past.
    await tx`
      SELECT helm.audit(
        ${`bulk.tag_${body.mode}`},
        ${body.target === 'client' ? 'organization' : 'asset_node'},
        NULL::uuid,
        'success'::audit_outcome,
        NULL::uuid, NULL::uuid, NULL::text,
        ${tx.json({ count: outcome.affected.length, tags: body.tags, ids: outcome.affected })}::jsonb
      )
    `;

    return { affected: outcome.affected.length, ids: outcome.affected };
  },
  { permissions: ['asset:write'] },
);

export const dynamic = 'force-dynamic';
