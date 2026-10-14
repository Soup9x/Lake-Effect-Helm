import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { normaliseSteps, STEP_LIMITS, validateSteps } from '@/lib/sops/steps';

/**
 * PUT /api/sops/[sopId]/steps — replace the whole ordered list.
 *
 * REPLACE, NOT PATCH, and the reason is `sop_step_position_uk UNIQUE (sop_id,
 * position)`. That constraint is not DEFERRABLE, so it is checked per row
 * within a statement: an UPDATE that shifts several positions can collide
 * halfway through depending on the order the rows happen to be visited, which
 * is a bug that appears only sometimes and only on reorder. Deleting the list
 * and inserting it back has no such window, and the editor's natural shape is
 * "here is the list now" anyway.
 *
 * NOTHING REFERENCES sop_step.id, which is what makes the replace free: a run
 * copies step definitions BY VALUE from a published snapshot (0090 — "Step
 * definition is COPIED in, not referenced: sop_step rows can be edited or
 * deleted, and a completed run must still be readable years later"). So
 * replacing rows cannot orphan a run or rewrite anybody's evidence.
 *
 * WHAT THE REPLACE WOULD LOSE, said plainly because it is the one risk here:
 * sop_step also carries kind, is_optional, requires_evidence, requires_note,
 * credential_node_id and estimated_minutes. F1 neither offers nor sends them,
 * so they take their database defaults and nothing is lost today — there has
 * never been a path that sets them. A later editor that does set them must
 * send them through this route too, or this replace will reset them. That is
 * why the payload is the complete definition of a step rather than a patch.
 */
const stepSchema = z.object({
  title: z.string().trim().min(1).max(STEP_LIMITS.maxTitle),
  body: z.string().trim().max(STEP_LIMITS.maxBody).nullable().optional(),
});

const putSchema = z.object({
  steps: z.array(stepSchema).max(STEP_LIMITS.maxSteps),
});

export const PUT = tenantRoute(
  async ({ tx, request, params }) => {
    const sopId = z.guid().safeParse(params.sopId);
    if (!sopId.success) throw ApiError.invalid('not a procedure id');

    const body = await readJson(request, (raw) => {
      const result = putSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid steps', {
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      return result.data;
    });

    /*
     * An EMPTY list is allowed here and refused at publish.
     *
     * Saving a draft down to nothing while rewriting it is an ordinary thing to
     * do in an editor; starting a run from a procedure with no steps is not.
     * So validateSteps' "needs at least one step" belongs to publishing, and
     * this route only enforces the per-step rules.
     */
    const issues = validateSteps(body.steps).filter((issue) => issue.index >= 0);
    if (issues.length > 0) {
      throw ApiError.invalid('invalid steps', {
        issues: issues.map((i) => ({ path: `steps.${i.index}`, message: i.message })),
      });
    }

    // Prove the procedure is writable BEFORE deleting anything. Without this a
    // PUT against somebody else's procedure would delete no rows, insert no
    // rows and answer 200 — a no-op that looks like success.
    const [sop] = await tx<{ id: string }[]>`
      SELECT id FROM sop WHERE id = ${sopId.data}::uuid
    `;
    if (!sop) throw ApiError.notFound('no such procedure');

    await tx`DELETE FROM sop_step WHERE sop_id = ${sopId.data}::uuid`;

    const steps = normaliseSteps(body.steps);
    for (const [index, step] of steps.entries()) {
      await tx`
        INSERT INTO sop_step (tenant_id, sop_id, position, title, body)
        VALUES (
          helm.current_tenant_id(), ${sopId.data}::uuid, ${index + 1},
          ${step.title}, ${step.body}
        )
      `;
    }

    return { sopId: sopId.data, steps: steps.length };
  },
  { permissions: ['sop:write'] },
);

export const dynamic = 'force-dynamic';
