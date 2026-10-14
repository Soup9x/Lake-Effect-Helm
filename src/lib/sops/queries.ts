/**
 * Reading procedures and their runs.
 *
 * Everything here goes through RLS like any other read, so a procedure in
 * another tenant, or in an organisation this actor has no scope over, simply
 * matches no row. `sop` carries the node-subtype policy (0200) and `sop_run`
 * the organisation-scoped one, which is why neither query names a tenant.
 */
import type { HelmTx } from '../db/client';
import { stepsFromSnapshot } from './steps';

export interface TemplateStep {
  id: string;
  position: number;
  title: string;
  body: string | null;
}

export interface PublishedVersion {
  id: string;
  version: number;
  publishedAt: string;
  publishedBy: string | null;
  changeNote: string | null;
  /** How many steps the frozen snapshot holds — not the live list's length. */
  steps: number;
}

export interface TemplateView {
  steps: TemplateStep[];
  /** The version a run would be started from, or null if never published. */
  current: PublishedVersion | null;
  versions: number;
  /**
   * Whether the live step list differs from the current published snapshot.
   *
   * The reason this is worth computing: a procedure whose steps have been
   * edited since publishing is one where "start a run" uses the OLD text, and
   * nothing on screen would otherwise say so. Compared by value rather than by
   * a dirty flag, because there is no column for one and a flag would be a
   * second thing to keep true.
   */
  unpublishedChanges: boolean;
}

export async function readTemplate(tx: HelmTx, sopId: string): Promise<TemplateView> {
  const [steps, versionRows] = await Promise.all([
    tx<{ id: string; position: number; title: string; body: string | null }[]>`
      SELECT id, position, title, body FROM sop_step
      WHERE sop_id = ${sopId}::uuid ORDER BY position
    `,
    tx<{
      id: string; version: number; published_at: Date; change_note: string | null;
      published_by_name: string | null; snapshot: unknown; is_current: boolean;
    }[]>`
      SELECT v.id, v.version, v.published_at, v.change_note,
             u.name AS published_by_name, v.snapshot,
             v.version = s.current_version AS is_current
      FROM sop_version v
      JOIN sop s ON s.id = v.sop_id
      LEFT JOIN app_user u ON u.id = v.published_by
      WHERE v.sop_id = ${sopId}::uuid
      ORDER BY v.version DESC
    `,
  ]);

  const currentRow = versionRows.find((v) => v.is_current);
  const snapshotSteps = currentRow ? stepsFromSnapshot(currentRow.snapshot) : [];

  return {
    steps: steps.map((s) => ({ id: s.id, position: s.position, title: s.title, body: s.body })),
    current: currentRow
      ? {
          id: currentRow.id,
          version: currentRow.version,
          publishedAt: currentRow.published_at.toISOString(),
          publishedBy: currentRow.published_by_name,
          changeNote: currentRow.change_note,
          steps: snapshotSteps.length,
        }
      : null,
    versions: versionRows.length,
    unpublishedChanges:
      currentRow !== undefined
      && (snapshotSteps.length !== steps.length
        || steps.some((step, index) => {
          const published = snapshotSteps[index];
          return !published
            || published.title !== step.title
            || (published.body ?? null) !== step.body;
        })),
  };
}

export interface RunSummary {
  id: string;
  title: string;
  status: string;
  sopId: string;
  sopName: string;
  ticketRef: string | null;
  startedAt: string | null;
  completedAt: string | null;
  totalSteps: number;
  doneSteps: number;
  remainingRequired: number;
}

/** Runs for one client, newest first. Open ones are what somebody came for. */
export async function listRunsForOrganization(
  tx: HelmTx,
  organizationId: string,
  limit = 50,
): Promise<RunSummary[]> {
  const rows = await tx<{
    run_id: string; title: string; status: string; sop_id: string; sop_name: string;
    ticket_ref: string | null; started_at: Date | null; completed_at: Date | null;
    total_steps: string; done_steps: string; remaining_required_steps: string;
  }[]>`
    SELECT p.run_id, p.title, p.status::text, p.sop_id, n.name AS sop_name,
           p.ticket_ref, p.started_at, p.completed_at,
           p.total_steps, p.done_steps, p.remaining_required_steps
    FROM v_sop_run_progress p
    JOIN asset_node n ON n.id = p.sop_id
    WHERE p.organization_id = ${organizationId}::uuid
    ORDER BY
      -- Open runs first, then by recency. A finished run is a record; an open
      -- one is work, and work belongs at the top.
      (p.status IN ('completed', 'abandoned')),
      coalesce(p.started_at, p.completed_at) DESC
    LIMIT ${limit}
  `;

  return rows.map((r) => ({
    id: r.run_id,
    title: r.title,
    status: r.status,
    sopId: r.sop_id,
    sopName: r.sop_name,
    ticketRef: r.ticket_ref,
    startedAt: r.started_at?.toISOString() ?? null,
    completedAt: r.completed_at?.toISOString() ?? null,
    totalSteps: Number(r.total_steps),
    doneSteps: Number(r.done_steps),
    remainingRequired: Number(r.remaining_required_steps),
  }));
}

export interface RunStepView {
  id: string;
  position: number;
  title: string;
  body: string | null;
  status: string;
  isOptional: boolean;
  note: string | null;
  completedAt: string | null;
  completedBy: string | null;
}

export interface RunView {
  id: string;
  title: string;
  status: string;
  organizationId: string;
  organizationName: string;
  sopId: string;
  sopName: string;
  version: number;
  ticketRef: string | null;
  startedAt: string | null;
  startedBy: string | null;
  completedAt: string | null;
  abandonedReason: string | null;
  steps: RunStepView[];
}

export async function readRun(tx: HelmTx, runId: string): Promise<RunView | null> {
  const [run] = await tx<{
    id: string; title: string; status: string; organization_id: string;
    organization_name: string; sop_id: string; sop_name: string; version: number;
    ticket_ref: string | null; started_at: Date | null; started_by_name: string | null;
    completed_at: Date | null; abandoned_reason: string | null;
  }[]>`
    SELECT r.id, r.title, r.status::text, r.organization_id, o.name AS organization_name,
           r.sop_id, n.name AS sop_name, v.version, r.ticket_ref,
           r.started_at, u.name AS started_by_name, r.completed_at, r.abandoned_reason
    FROM sop_run r
    JOIN organization o ON o.id = r.organization_id
    JOIN asset_node n ON n.id = r.sop_id
    JOIN sop_version v ON v.id = r.sop_version_id
    LEFT JOIN app_user u ON u.id = r.started_by
    WHERE r.id = ${runId}::uuid
  `;
  if (!run) return null;

  const steps = await tx<{
    id: string; position: number; title: string; body: string | null; status: string;
    is_optional: boolean; note: string | null; completed_at: Date | null;
    completed_by_name: string | null;
  }[]>`
    SELECT s.id, s.position, s.title, s.body, s.status::text, s.is_optional, s.note,
           s.completed_at, u.name AS completed_by_name
    FROM sop_run_step s
    LEFT JOIN app_user u ON u.id = s.completed_by
    WHERE s.run_id = ${runId}::uuid
    ORDER BY s.position
  `;

  return {
    id: run.id,
    title: run.title,
    status: run.status,
    organizationId: run.organization_id,
    organizationName: run.organization_name,
    sopId: run.sop_id,
    sopName: run.sop_name,
    version: run.version,
    ticketRef: run.ticket_ref,
    startedAt: run.started_at?.toISOString() ?? null,
    startedBy: run.started_by_name,
    completedAt: run.completed_at?.toISOString() ?? null,
    abandonedReason: run.abandoned_reason,
    steps: steps.map((s) => ({
      id: s.id,
      position: s.position,
      title: s.title,
      body: s.body,
      status: s.status,
      isOptional: s.is_optional,
      note: s.note,
      completedAt: s.completed_at?.toISOString() ?? null,
      completedBy: s.completed_by_name,
    })),
  };
}
