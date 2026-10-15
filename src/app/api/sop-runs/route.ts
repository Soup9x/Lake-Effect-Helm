import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { stepsFromSnapshot } from '@/lib/sops/steps';

/**
 * POST /api/sop-runs — start a checklist against a client.
 *
 * THIS IS THE STEP COPY 0090 DESCRIBES and nothing has ever performed. The run
 * points at a published sop_version and its steps are copied from that
 * version's snapshot, by value, in the same transaction as the run row:
 *
 *   "Step definition is COPIED in, not referenced: sop_step rows can be edited
 *    or deleted, and a completed run must still be readable years later."
 *
 * So a run started today is unaffected by tomorrow's edit to the template, and
 * the evidence of what was followed survives the procedure being rewritten.
 *
 * FROM THE SNAPSHOT, NOT FROM sop_step. Copying the live rows would reintroduce
 * exactly the coupling the snapshot exists to break — a template edited between
 * publish and run would silently change what the run says it followed.
 *
 * sop:execute, which tier1 and above hold. NOTE A PRE-EXISTING MISMATCH worth
 * knowing about: client_admin also holds sop:execute in the seed, but
 * sop_run's RLS requires role rank 40 and client_admin is rank 30 — so a
 * client administrator passes this route's gate and is then refused by the
 * database. Not changed here: reconciling them is a permission decision beyond
 * this group, and failing closed is the safe direction. It is written up in
 * docs/itg-parity.md.
 */
const createSchema = z.object({
  sopId: z.guid('sopId must be a UUID'),
  organizationId: z.guid('organizationId must be a UUID'),
  siteId: z.guid().nullable().optional(),
  /** Defaults to the procedure's name — a run is usually "this, for them, now". */
  title: z.string().trim().min(1).max(200).optional(),
  ticketRef: z.string().trim().max(120).nullable().optional(),
  subjectNodeId: z.guid().nullable().optional(),
  /**
   * The run's default assignee and due date, stamped onto every step it
   * creates. 0650's header says why they are stamped rather than inherited at
   * read time: My Tasks filters on the step's own column, and an index can
   * serve that where COALESCE across a join cannot.
   */
  assignedTo: z.guid().nullable().optional(),
  dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
});

interface VersionRow {
  version_id: string;
  version: number;
  snapshot: unknown;
  sop_name: string;
}

export const POST = tenantRoute(
  async ({ tx, request, identity }) => {
    const body = await readJson(request, (raw) => {
      const result = createSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid run', {
          issues: zodIssues(result.error),
        });
      }
      return result.data;
    });

    /*
     * The procedure's CURRENT published version.
     *
     * Joined on sop.current_version rather than taking max(version), because
     * current_version is what publishing advances and is therefore the one
     * answer to "what does this procedure say now". A procedure that has never
     * been published has current_version 0 and matches nothing here — which is
     * the right refusal: there is no frozen text to run against.
     */
    const [version] = await tx<VersionRow[]>`
      SELECT v.id AS version_id, v.version, v.snapshot, n.name AS sop_name
      FROM sop s
      JOIN asset_node n ON n.id = s.id
      JOIN sop_version v ON v.sop_id = s.id AND v.version = s.current_version
      WHERE s.id = ${body.sopId}::uuid AND n.archived_at IS NULL
    `;
    if (!version) {
      // Covers "no such procedure", "not yours" and "never published" alike.
      throw ApiError.notFound('no published version of that procedure');
    }

    /*
     * The assignee must be an ACTIVE member of this tenant.
     *
     * sop_run_step_assignee_fk already makes a stranger unrepresentable — it is
     * a composite key against membership (tenant_id, user_id) — but a foreign
     * key cannot ask about `status`, and it would answer 23503, which this
     * route already maps to "no such client, site or subject". Checking here
     * means the answer names the actual problem. The constraint remains the
     * backstop for everything this query cannot see.
     */
    if (body.assignedTo) {
      const [member] = await tx<{ ok: boolean }[]>`
        SELECT true AS ok FROM membership
        WHERE tenant_id = ${identity.tenantId}::uuid
          AND user_id = ${body.assignedTo}::uuid
          AND status = 'active'
          AND (expires_at IS NULL OR expires_at > now())
      `;
      if (!member) throw ApiError.invalid('that person is not an active member of this tenant');
    }

    const steps = stepsFromSnapshot(version.snapshot);
    if (steps.length === 0) {
      /*
       * A published version always has steps — the publish route refuses an
       * empty list — so reaching here means the snapshot is older than this
       * module's format or was written by hand. Refusing beats creating a run
       * that is complete before anybody opens it, and says which version to
       * look at.
       */
      throw ApiError.invalid(
        `version ${version.version} of that procedure has no readable steps; publish it again`,
      );
    }

    let run: { id: string } | undefined;
    try {
      [run] = await tx<{ id: string }[]>`
        INSERT INTO sop_run (
          tenant_id, organization_id, site_id, sop_id, sop_version_id,
          title, ticket_ref, subject_node_id, status, started_at, started_by,
          assigned_to, due_at
        )
        VALUES (
          ${identity.tenantId}::uuid, ${body.organizationId}::uuid,
          ${body.siteId ?? null}::uuid, ${body.sopId}::uuid, ${version.version_id}::uuid,
          ${body.title ?? version.sop_name}, ${body.ticketRef ?? null},
          ${body.subjectNodeId ?? null}::uuid,
          'in_progress', now(), ${identity.actorId}::uuid,
          ${body.assignedTo ?? null}::uuid, ${body.dueAt ?? null}::timestamptz
        )
        RETURNING id
      `;
    } catch (error) {
      if ((error as { code?: string }).code === '23503') {
        throw ApiError.invalid('no such client, site or subject');
      }
      throw error;
    }
    if (!run) throw ApiError.conflict('the run could not be started');

    /*
     * 'in_progress' from the start rather than 'not_started'.
     *
     * Starting a run IS the act — somebody pressed the button because they are
     * doing the thing now — and a status nothing can leave would need a second
     * control whose only job is to say "actually beginning". sop_run_status
     * keeps 'not_started' for a scheduler that creates runs ahead of time,
     * which is K's territory.
     */
    for (const step of steps) {
      const [inserted] = await tx<{ id: string }[]>`
        INSERT INTO sop_run_step (
          tenant_id, run_id, position, title, body, kind, status, assigned_to, due_at
        )
        VALUES (
          ${identity.tenantId}::uuid, ${run.id}::uuid, ${step.position},
          ${step.title}, ${step.body}, 'manual', 'pending',
          ${body.assignedTo ?? null}::uuid, ${body.dueAt ?? null}::timestamptz
        )
        RETURNING id
      `;

      /*
       * 0690's "you have been given this" reminder, raised per step.
       *
       * PER STEP RATHER THAN PER RUN, which is a real choice: starting a run
       * with an assignee hands that person every step, and the thing they act
       * on is a step. A single run-level message would then have to list them,
       * and the due-date reminders are per step anyway — so one shape for both
       * beats two.
       *
       * A no-op when mail is off for the tenant, when the person has turned
       * that kind off, and when somebody started the run for themselves, which
       * is the common case and must not produce three emails to the person who
       * just pressed the button.
       */
      if (inserted && body.assignedTo) {
        await tx`SELECT helm.raise_assignment_reminder(${inserted.id}::uuid)`;
      }
    }

    return {
      runId: run.id,
      steps: steps.length,
      version: version.version,
      assignedTo: body.assignedTo ?? null,
      dueAt: body.dueAt ?? null,
    };
  },
  { permissions: ['sop:execute'] },
);

export const dynamic = 'force-dynamic';
