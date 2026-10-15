import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { RUN_STEP_STATES } from '@/lib/sops/steps';

/**
 * PATCH /api/sop-runs/[runId]/steps/[stepId] — check a step off, or skip it.
 *
 * THREE STATES, NOT SEVEN. sop_step_status carries pending, in_progress, done,
 * skipped, blocked, failed and not_applicable. This route drives the three a
 * person working through a list can reach, and the others keep their place in
 * the enum with no control until something is built that means them — a
 * `blocked` step wants a reason and a way to unblock, `failed` wants an
 * incident, `not_applicable` wants a judgement recorded. Offering a dropdown of
 * seven words with no behaviour behind four of them is the shape this plan has
 * been removing. Recorded as deferred in docs/history/itg-parity.md.
 *
 * completed_at IS SET BY THIS ROUTE, not defaulted, because
 * sop_run_step_terminal_has_actor requires it for every terminal status —
 * done, skipped, failed, not_applicable. Returning a step to `pending` clears
 * it again, so unchecking a box genuinely undoes the check rather than leaving
 * a timestamp that says it was finished.
 *
 * A NOTE IS REQUIRED TO SKIP A MANDATORY STEP, by
 * sop_run_step_skip_needs_note. The constraint is the authority; the message
 * here exists so the answer is a 400 naming the step rather than a 500 naming
 * a constraint.
 *
 * A COMPLETED RUN IS CLOSED. Editing a step after the run is finished would
 * rewrite the evidence the run exists to be — so this refuses rather than
 * silently reopening it. That covers reassignment too: handing somebody a step
 * on a run that is already over is not a smaller act than checking one off.
 *
 * EVERY FIELD IS OPTIONAL, AND AT LEAST ONE IS REQUIRED (0650). Checking a step
 * off and handing it to somebody else are separate acts that happen at
 * separate moments, so `status` cannot be mandatory — but a PATCH with nothing
 * in it is a mistake rather than a no-op, and saying so beats a 200 that did
 * nothing. Each column is left alone unless its key was sent, which is why
 * every assignment below is a ternary against `undefined` rather than a
 * COALESCE: null means "clear this" and COALESCE cannot tell the two apart.
 */
const patchSchema = z
  .object({
    status: z.enum(RUN_STEP_STATES).optional(),
    note: z.string().trim().max(4000).nullable().optional(),
    assignedTo: z.guid().nullable().optional(),
    dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'no changes to make' });

interface StepRow {
  id: string;
  status: string;
  is_optional: boolean;
  run_status: string;
}

export const PATCH = tenantRoute(
  async ({ tx, request, identity, params }) => {
    const runId = z.guid().safeParse(params.runId);
    const stepId = z.guid().safeParse(params.stepId);
    if (!runId.success || !stepId.success) throw ApiError.invalid('not a run step');

    const body = await readJson(request, (raw) => {
      const result = patchSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('a step status of pending, done or skipped, an assignee or a due date', {
          issues: zodIssues(result.error),
        });
      }
      return result.data;
    });

    // The step AND its run's status, so "the run is finished" is answered
    // before anything is written rather than by a constraint afterwards. The
    // join is what ties the step to the run in the URL: a step id from another
    // run matches nothing.
    const [step] = await tx<StepRow[]>`
      SELECT s.id, s.status::text, s.is_optional, r.status::text AS run_status
      FROM sop_run_step s
      JOIN sop_run r ON r.id = s.run_id
      WHERE s.id = ${stepId.data}::uuid AND s.run_id = ${runId.data}::uuid
    `;
    if (!step) throw ApiError.notFound('no such step on that run');

    if (step.run_status === 'completed' || step.run_status === 'abandoned') {
      throw ApiError.conflict(`this run is ${step.run_status} and its steps can no longer change`);
    }

    if (body.status === 'skipped' && !step.is_optional && !body.note) {
      throw ApiError.invalid('skipping a required step needs a reason', {
        issues: [{ path: 'note', message: 'required when skipping a step that is not optional' }],
      });
    }

    // Active membership, for the reason POST /api/sop-runs gives: the composite
    // key to membership refuses a stranger but cannot ask about `status`.
    if (body.assignedTo) {
      const [member] = await tx<{ ok: boolean }[]>`
        SELECT true AS ok FROM membership
        WHERE tenant_id = helm.current_tenant_id()
          AND user_id = ${body.assignedTo}::uuid
          AND status = 'active'
          AND (expires_at IS NULL OR expires_at > now())
      `;
      if (!member) throw ApiError.invalid('that person is not an active member of this tenant');
    }

    /*
     * completed_at/completed_by move only when the STATUS moves. A PATCH that
     * reassigns a step must not stamp it as finished, and must not wipe the
     * stamp off one that already is — so the timestamp follows `body.status`
     * being present, not merely the step being terminal.
     */
    const terminal = body.status !== undefined && body.status !== 'pending';
    const [updated] = await tx<{ id: string; status: string }[]>`
      UPDATE sop_run_step SET
        status       = ${body.status === undefined
          ? tx`status` : tx`${body.status}::sop_step_status`},
        note         = ${body.note === undefined ? tx`note` : body.note},
        assigned_to  = ${body.assignedTo === undefined
          ? tx`assigned_to` : tx`${body.assignedTo}::uuid`},
        due_at       = ${body.dueAt === undefined ? tx`due_at` : tx`${body.dueAt}::timestamptz`},
        completed_at = ${body.status === undefined
          ? tx`completed_at` : terminal ? tx`now()` : tx`NULL`},
        completed_by = ${body.status === undefined
          ? tx`completed_by` : terminal ? tx`${identity.actorId}::uuid` : tx`NULL`}
      WHERE id = ${stepId.data}::uuid
      RETURNING id, status::text
    `;
    if (!updated) throw ApiError.notFound('no such step on that run');

    /*
     * 0690's reminders, on both edges of this one UPDATE.
     *
     * BEING GIVEN WORK IS AN ACT, NOT A STATE, so it is raised here rather
     * than swept for: an hourly sweep cannot tell a step assigned yesterday
     * from one assigned a moment ago, and a step with no due date would
     * otherwise never produce anything at all. The function is a no-op when
     * mail is off, when the person has turned that kind off, and when somebody
     * assigns a step to themselves.
     *
     * FINISHING IT STOPS THE REMINDERS, and suppressing rather than deleting
     * is what keeps the unique key doing its job — a deleted row would let the
     * next sweep raise the same reminder again for a step that is already done.
     *
     * Both are inside this transaction, so a reminder is never queued for an
     * assignment that rolled back.
     */
    if (body.assignedTo) {
      await tx`SELECT helm.raise_assignment_reminder(${updated.id}::uuid)`;
    }
    if (body.status !== undefined && body.status !== 'pending') {
      await tx`SELECT helm.suppress_reminders_for_step(${updated.id}::uuid)`;
    }

    return { stepId: updated.id, status: updated.status };
  },
  { permissions: ['sop:execute'] },
);

export const dynamic = 'force-dynamic';
