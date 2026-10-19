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
  /** The run's default assignee, by name. Null when nobody was named. */
  assignedTo: string | null;
  dueAt: string | null;
  /** Who finished it, for the Completed tab. */
  completedBy: string | null;
  organizationId: string;
  organizationName: string;
}

/** Runs for one client, newest first. Open ones are what somebody came for. */
export function listRunsForOrganization(
  tx: HelmTx,
  organizationId: string,
  limit = 200,
): Promise<RunSummary[]> {
  return listRuns(tx, { organizationId }, limit);
}

/** Runs of one procedure, for the Runs card on its own page. */
export function listRunsForSop(tx: HelmTx, sopId: string, limit = 200): Promise<RunSummary[]> {
  return listRuns(tx, { sopId }, limit);
}

async function listRuns(
  tx: HelmTx,
  where: { organizationId: string } | { sopId: string },
  limit: number,
): Promise<RunSummary[]> {
  const rows = await tx<{
    run_id: string; title: string; status: string; sop_id: string; sop_name: string;
    ticket_ref: string | null; started_at: Date | null; completed_at: Date | null;
    total_steps: string; done_steps: string; remaining_required_steps: string;
    assigned_to_name: string | null; due_at: Date | null;
    completed_by_name: string | null; organization_id: string; organization_name: string;
  }[]>`
    SELECT p.run_id, p.title, p.status::text, p.sop_id, n.name AS sop_name,
           p.ticket_ref, p.started_at, p.completed_at,
           p.total_steps, p.done_steps, p.remaining_required_steps,
           u.name AS assigned_to_name, r.due_at,
           coalesce(cu.name, cu.email::text) AS completed_by_name,
           p.organization_id, o.name AS organization_name
    FROM v_sop_run_progress p
    JOIN asset_node n ON n.id = p.sop_id
    -- The view predates assignment (0090) and does not carry it. Joining the
    -- run itself rather than widening the view: v_sop_run_progress aggregates
    -- step counts, and adding non-aggregated columns to it means adding them
    -- to its GROUP BY, which is a change every other reader pays for.
    JOIN sop_run r ON r.id = p.run_id
    LEFT JOIN app_user u ON u.id = r.assigned_to
    LEFT JOIN app_user cu ON cu.id = r.completed_by
    JOIN organization o ON o.id = p.organization_id
    WHERE ${'organizationId' in where
      ? tx`p.organization_id = ${where.organizationId}::uuid`
      : tx`p.sop_id = ${where.sopId}::uuid`}
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
    assignedTo: r.assigned_to_name,
    dueAt: r.due_at?.toISOString() ?? null,
    completedBy: r.completed_by_name,
    organizationId: r.organization_id,
    organizationName: r.organization_name,
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
  /** Both the id and the name: the picker needs one, the reader the other. */
  assignedToId: string | null;
  assignedTo: string | null;
  dueAt: string | null;
  /**
   * Computed in SQL against now(), not in the component.
   *
   * A client component that compares a date to Date.now() during render gets
   * one answer on the server and possibly another in the browser a moment
   * later, which is a hydration mismatch — and it would put the definition of
   * "overdue" in two places, where the dashboard count has a third. One
   * predicate, in the database, read by everybody.
   */
  overdue: boolean;
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
  assignedTo: string | null;
  dueAt: string | null;
  steps: RunStepView[];
}

export async function readRun(tx: HelmTx, runId: string): Promise<RunView | null> {
  const [run] = await tx<{
    id: string; title: string; status: string; organization_id: string;
    organization_name: string; sop_id: string; sop_name: string; version: number;
    ticket_ref: string | null; started_at: Date | null; started_by_name: string | null;
    completed_at: Date | null; abandoned_reason: string | null;
    assigned_to_name: string | null; due_at: Date | null;
  }[]>`
    SELECT r.id, r.title, r.status::text, r.organization_id, o.name AS organization_name,
           r.sop_id, n.name AS sop_name, v.version, r.ticket_ref,
           r.started_at, u.name AS started_by_name, r.completed_at, r.abandoned_reason,
           a.name AS assigned_to_name, r.due_at
    FROM sop_run r
    JOIN organization o ON o.id = r.organization_id
    JOIN asset_node n ON n.id = r.sop_id
    JOIN sop_version v ON v.id = r.sop_version_id
    LEFT JOIN app_user u ON u.id = r.started_by
    LEFT JOIN app_user a ON a.id = r.assigned_to
    WHERE r.id = ${runId}::uuid
  `;
  if (!run) return null;

  const steps = await tx<{
    id: string; position: number; title: string; body: string | null; status: string;
    is_optional: boolean; note: string | null; completed_at: Date | null;
    completed_by_name: string | null; assigned_to: string | null;
    assigned_to_name: string | null; due_at: Date | null; overdue: boolean;
  }[]>`
    SELECT s.id, s.position, s.title, s.body, s.status::text, s.is_optional, s.note,
           s.completed_at, u.name AS completed_by_name,
           s.assigned_to, a.name AS assigned_to_name, s.due_at,
           coalesce(s.due_at < now() AND s.status = 'pending', false) AS overdue
    FROM sop_run_step s
    LEFT JOIN app_user u ON u.id = s.completed_by
    LEFT JOIN app_user a ON a.id = s.assigned_to
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
    assignedTo: run.assigned_to_name,
    dueAt: run.due_at?.toISOString() ?? null,
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
      assignedToId: s.assigned_to,
      assignedTo: s.assigned_to_name,
      dueAt: s.due_at?.toISOString() ?? null,
      overdue: s.overdue,
    })),
  };
}

// ---------------------------------------------------------------------------
// My Tasks
// ---------------------------------------------------------------------------

export interface TaskRow {
  stepId: string;
  position: number;
  title: string;
  status: string;
  isOptional: boolean;
  dueAt: string | null;
  /** Against now() in SQL, for the reason RunStepView.overdue gives. */
  overdue: boolean;
  /** Null for an unassigned step, which only the "anyone" filter returns. */
  assignedTo: string | null;
  runId: string;
  runTitle: string;
  runStatus: string;
  organizationId: string;
  organizationName: string;
  sopName: string;
}

export interface TaskFilters {
  /**
   * Whose tasks. 'mine' resolves to helm.current_actor_id() IN SQL rather than
   * to an id this function was handed, which is the point: "mine" cannot then
   * be made to mean somebody else by a query parameter, a stale prop or a
   * mistake three layers up. 'anyone' drops the predicate and RLS decides.
   */
  who?: 'mine' | 'anyone';
  /**
   * 'open' is the default and means what somebody can still do something
   * about: a step that is still pending, on a run that is still live. A
   * pending step on an ABANDONED run is not a task — the run was given up on,
   * and listing its steps as work would be the product arguing with itself.
   */
  state?: 'open' | 'overdue' | 'all';
  limit?: number;
}

/**
 * The page the parity item asks for: "tasks assigned to me".
 *
 * ORDERED BY WHAT IS MOST LATE. Dated work first, soonest first — so overdue
 * steps lead, because their dates are the earliest — and undated work last.
 *
 * `(s.due_at IS NULL)` is EXPLICIT RATHER THAN LOAD-BEARING, and a test cannot
 * tell: Postgres already sorts NULLs last for an ascending order, so removing
 * the term changes nothing today. It is kept because the default reverses under
 * DESC — `ORDER BY due_at DESC` puts undated work FIRST — so a later change to
 * "most recently due" would silently lead with the rows that have no date at
 * all. Measured rather than assumed; said here because a reader who deletes it
 * will see a green suite.
 */
export async function listMyTasks(tx: HelmTx, filters: TaskFilters = {}): Promise<TaskRow[]> {
  const who = filters.who ?? 'mine';
  const state = filters.state ?? 'open';
  const limit = filters.limit ?? 200;

  const rows = await tx<{
    step_id: string; position: number; title: string; status: string; is_optional: boolean;
    due_at: Date | null; overdue: boolean;
    assigned_to_name: string | null; run_id: string; run_title: string;
    run_status: string; organization_id: string; organization_name: string; sop_name: string;
  }[]>`
    SELECT s.id AS step_id, s.position, s.title, s.status::text, s.is_optional, s.due_at,
           coalesce(s.due_at < now() AND s.status = 'pending', false) AS overdue,
           a.name AS assigned_to_name,
           r.id AS run_id, r.title AS run_title, r.status::text AS run_status,
           o.id AS organization_id, o.name AS organization_name, n.name AS sop_name
    FROM sop_run_step s
    JOIN sop_run r ON r.id = s.run_id
    JOIN organization o ON o.id = r.organization_id
    JOIN asset_node n ON n.id = r.sop_id
    LEFT JOIN app_user a ON a.id = s.assigned_to
    WHERE ${who === 'mine' ? tx`s.assigned_to = helm.current_actor_id()` : tx`TRUE`}
      AND ${state === 'all'
        ? tx`TRUE`
        : tx`s.status = 'pending' AND r.status IN ('not_started', 'in_progress')`}
      AND ${state === 'overdue' ? tx`s.due_at < now()` : tx`TRUE`}
    ORDER BY (s.due_at IS NULL), s.due_at, r.title, s.position
    LIMIT ${limit}
  `;

  return rows.map((r) => ({
    stepId: r.step_id,
    position: r.position,
    title: r.title,
    status: r.status,
    isOptional: r.is_optional,
    dueAt: r.due_at?.toISOString() ?? null,
    overdue: r.overdue,
    assignedTo: r.assigned_to_name,
    runId: r.run_id,
    runTitle: r.run_title,
    runStatus: r.run_status,
    organizationId: r.organization_id,
    organizationName: r.organization_name,
    sopName: r.sop_name,
  }));
}

export interface TaskCounts {
  open: number;
  overdue: number;
}

/**
 * The number on the dashboard, and the one beside it that decides its colour.
 *
 * One round trip for both, because they differ by a single predicate and the
 * dashboard already runs one wide counts query for the same reason.
 */
export async function countMyOpenTasks(tx: HelmTx): Promise<TaskCounts> {
  const [row] = await tx<{ open: string; overdue: string }[]>`
    SELECT count(*) AS open,
           count(*) FILTER (WHERE s.due_at < now()) AS overdue
    FROM sop_run_step s
    JOIN sop_run r ON r.id = s.run_id
    WHERE s.assigned_to = helm.current_actor_id()
      AND s.status = 'pending'
      AND r.status IN ('not_started', 'in_progress')
  `;
  return { open: Number(row?.open ?? 0), overdue: Number(row?.overdue ?? 0) };
}

/**
 * The colleagues a step can be handed to.
 *
 * ACTIVE memberships only, which the composite foreign key cannot express: it
 * refuses a stranger but accepts somebody whose membership was revoked, and
 * that asymmetry is deliberate — a revoked colleague can still HOLD a task,
 * because the work exists and somebody has to take it over, but nobody should
 * be able to hand them a new one.
 */
export async function listAssignableUsers(
  tx: HelmTx,
): Promise<{ id: string; name: string; email: string }[]> {
  const rows = await tx<{ id: string; name: string | null; email: string }[]>`
    SELECT u.id, u.name, u.email
    FROM app_user u
    JOIN membership m ON m.user_id = u.id
    WHERE m.tenant_id = helm.current_tenant_id()
      AND m.status = 'active'
      AND (m.expires_at IS NULL OR m.expires_at > now())
    ORDER BY coalesce(u.name, u.email)
  `;
  return rows.map((r) => ({ id: r.id, name: r.name ?? r.email, email: r.email }));
}
