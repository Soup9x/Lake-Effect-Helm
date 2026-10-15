import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';

/**
 * PATCH /api/sops/[sopId] — edit a procedure's own columns.
 *
 * NOT the name: that lives on asset_node and PATCH /api/assets/[nodeId]
 * already owns it, along with the site, tags and the internal-only flag. Two
 * routes writing one column is how they come to disagree about which validates
 * what.
 *
 * NOT the steps either — PUT .../steps replaces the ordered list in one
 * statement, for the reason given there.
 *
 * `last_reviewed_at` is settable because "I have read this and it is still
 * right" is the act a review interval exists to measure, and it is the only
 * way an SOP leaves the expirations pane. It is set to now() rather than to a
 * date the caller chooses: a review you can backdate is a review you can
 * fabricate.
 */
const patchSchema = z
  .object({
    category: z.string().trim().max(80).nullable().optional(),
    summary: z.string().trim().max(2000).nullable().optional(),
    body: z.string().trim().max(50_000).nullable().optional(),
    isGlobal: z.boolean().optional(),
    reviewIntervalDays: z.number().int().min(1).max(3650).nullable().optional(),
    estimatedMinutes: z.number().int().min(1).max(10_000).nullable().optional(),
    requiresApproval: z.boolean().optional(),
    /** true marks it reviewed now. There is no way to say "reviewed last March". */
    reviewedNow: z.literal(true).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' });

export const PATCH = tenantRoute(
  async ({ tx, request, identity, params }) => {
    const sopId = z.guid().safeParse(params.sopId);
    if (!sopId.success) throw ApiError.invalid('not a procedure id');

    const body = await readJson(request, (raw) => {
      const result = patchSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid changes', {
          issues: zodIssues(result.error),
        });
      }
      return result.data;
    });

    // `undefined` leaves a column alone and `null` clears it, so each is a
    // ternary rather than a COALESCE — COALESCE cannot tell the two apart and
    // clearing a summary would silently do nothing.
    const [updated] = await tx<{ id: string }[]>`
      UPDATE sop SET
        category             = ${body.category === undefined ? tx`category` : body.category},
        summary              = ${body.summary === undefined ? tx`summary` : body.summary},
        body                 = ${body.body === undefined ? tx`body` : body.body},
        is_global            = COALESCE(${body.isGlobal ?? null}, is_global),
        requires_approval    = COALESCE(${body.requiresApproval ?? null}, requires_approval),
        review_interval_days = ${body.reviewIntervalDays === undefined
          ? tx`review_interval_days` : body.reviewIntervalDays},
        estimated_minutes    = ${body.estimatedMinutes === undefined
          ? tx`estimated_minutes` : body.estimatedMinutes},
        last_reviewed_at     = ${body.reviewedNow ? tx`now()` : tx`last_reviewed_at`},
        reviewed_by          = ${body.reviewedNow
          ? tx`${identity.actorId}::uuid` : tx`reviewed_by`}
      WHERE id = ${sopId.data}::uuid
      RETURNING id
    `;

    // RLS removed a procedure this actor may not write, so "no such procedure"
    // and "not yours" arrive as one answer — which is the intent.
    if (!updated) throw ApiError.notFound('no such procedure');

    return { sopId: updated.id };
  },
  { permissions: ['sop:write'] },
);

export const dynamic = 'force-dynamic';
