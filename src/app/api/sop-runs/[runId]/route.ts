import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { unsettledRequiredSteps } from '@/lib/sops/steps';

/**
 * PATCH /api/sop-runs/[runId] — finish a run, or give up on one.
 *
 * TWO TERMINAL STATES AND THEY ARE NOT THE SAME CLAIM. `completed` says the
 * procedure was followed; `abandoned` says it was not, and
 * sop_run_abandoned_has_reason means it cannot be said without saying why.
 * Collapsing them would make "we stopped halfway because the server was already
 * gone" indistinguishable from "we did all of it".
 *
 * A RUN CANNOT BE COMPLETED WITH MANDATORY STEPS STILL PENDING. Optional steps
 * may be left — that is what optional means. This is checked here so the answer
 * names how many are outstanding; the run page disables the button for the same
 * reason, from the same function.
 *
 * TERMINAL IS TERMINAL. Reopening a completed run would rewrite evidence after
 * the fact, which is the one thing 0090's design is built to prevent, so there
 * is no transition out of completed or abandoned.
 */
const patchSchema = z.union([
  z.object({ status: z.literal('completed') }),
  z.object({
    status: z.literal('abandoned'),
    reason: z.string().trim().min(1).max(2000),
  }),
]);

interface RunRow {
  id: string;
  status: string;
}

export const PATCH = tenantRoute(
  async ({ tx, request, identity, params }) => {
    const runId = z.guid().safeParse(params.runId);
    if (!runId.success) throw ApiError.invalid('not a run id');

    const body = await readJson(request, (raw) => {
      const result = patchSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('completed, or abandoned with a reason', {
          issues: zodIssues(result.error),
        });
      }
      return result.data;
    });

    const [run] = await tx<RunRow[]>`
      SELECT id, status::text FROM sop_run WHERE id = ${runId.data}::uuid
    `;
    if (!run) throw ApiError.notFound('no such run');
    if (run.status === 'completed' || run.status === 'abandoned') {
      throw ApiError.conflict(`this run is already ${run.status}`);
    }

    if (body.status === 'completed') {
      const steps = await tx<{ status: string; is_optional: boolean }[]>`
        SELECT status::text, is_optional FROM sop_run_step WHERE run_id = ${runId.data}::uuid
      `;
      const outstanding = unsettledRequiredSteps(
        steps.map((s) => ({ status: s.status, isOptional: s.is_optional })),
      );
      if (outstanding > 0) {
        throw ApiError.invalid(
          `${outstanding} required step${outstanding === 1 ? '' : 's'} still to do`,
        );
      }
    }

    const [updated] = await tx<{ id: string; status: string }[]>`
      UPDATE sop_run SET
        status           = ${body.status}::sop_run_status,
        completed_at     = ${body.status === 'completed' ? tx`now()` : tx`completed_at`},
        completed_by     = ${body.status === 'completed'
          ? tx`${identity.actorId}::uuid` : tx`completed_by`},
        abandoned_reason = ${body.status === 'abandoned' ? body.reason : tx`abandoned_reason`}
      WHERE id = ${runId.data}::uuid
      RETURNING id, status::text
    `;
    if (!updated) throw ApiError.notFound('no such run');

    return { runId: updated.id, status: updated.status };
  },
  { permissions: ['sop:execute'] },
);

export const dynamic = 'force-dynamic';
