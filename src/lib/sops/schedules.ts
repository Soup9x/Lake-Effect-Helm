/**
 * Recurring checklists: a procedure that raises a run every so many days.
 *
 * The rows are written through RLS as the request role; what makes them real
 * is the worker, which calls helm.raise_scheduled_runs() per tenant (0770).
 * This module reads and writes the rows for the routes and the card.
 */
import type { HelmTx } from '../db/client';

export interface ScheduleRow {
  id: string;
  sopId: string;
  organizationId: string;
  siteId: string | null;
  siteName: string | null;
  assignedTo: string | null;
  assignedToName: string | null;
  intervalDays: number;
  nextRunAt: string;
  dueAfterDays: number | null;
  title: string | null;
  enabled: boolean;
  lastRaisedAt: string | null;
  lastRunId: string | null;
  lastError: string | null;
  createdAt: string;
}

interface RawRow {
  id: string; sop_id: string; organization_id: string; site_id: string | null; site_name: string | null;
  assigned_to: string | null; assigned_to_name: string | null; interval_days: number;
  next_run_at: Date; due_after_days: number | null; title: string | null; enabled: boolean;
  last_raised_at: Date | null; last_run_id: string | null; last_error: string | null; created_at: Date;
}

function toRow(r: RawRow): ScheduleRow {
  return {
    id: r.id,
    sopId: r.sop_id,
    organizationId: r.organization_id,
    siteId: r.site_id,
    siteName: r.site_name,
    assignedTo: r.assigned_to,
    assignedToName: r.assigned_to_name,
    intervalDays: r.interval_days,
    nextRunAt: r.next_run_at.toISOString(),
    dueAfterDays: r.due_after_days,
    title: r.title,
    enabled: r.enabled,
    lastRaisedAt: r.last_raised_at?.toISOString() ?? null,
    lastRunId: r.last_run_id,
    lastError: r.last_error,
    createdAt: r.created_at.toISOString(),
  };
}

const SELECT = (tx: HelmTx) => tx`
  SELECT s.id, s.sop_id, s.organization_id, s.site_id, st.name AS site_name,
         s.assigned_to, coalesce(u.name, u.email::text) AS assigned_to_name,
         s.interval_days, s.next_run_at, s.due_after_days, s.title, s.enabled,
         s.last_raised_at, s.last_run_id, s.last_error, s.created_at
  FROM sop_schedule s
  LEFT JOIN site st ON st.id = s.site_id
  LEFT JOIN app_user u ON u.id = s.assigned_to
`;

export async function listSchedules(tx: HelmTx, sopId: string): Promise<ScheduleRow[]> {
  const rows = await tx<RawRow[]>`
    ${SELECT(tx)} WHERE s.sop_id = ${sopId}::uuid ORDER BY s.enabled DESC, s.next_run_at
  `;
  return rows.map(toRow);
}

export async function readSchedule(tx: HelmTx, id: string): Promise<ScheduleRow | null> {
  const [row] = await tx<RawRow[]>`${SELECT(tx)} WHERE s.id = ${id}::uuid`;
  return row ? toRow(row) : null;
}

export interface ScheduleInput {
  intervalDays: number;
  /** The first slot, ISO. */
  firstRunAt: string;
  dueAfterDays?: number | null | undefined;
  assignedTo?: string | null | undefined;
  siteId?: string | null | undefined;
  title?: string | null | undefined;
}

export async function createSchedule(
  tx: HelmTx,
  tenantId: string,
  sopId: string,
  actorId: string,
  input: ScheduleInput,
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO sop_schedule (
      tenant_id, organization_id, sop_id, site_id, assigned_to,
      interval_days, next_run_at, due_after_days, title, created_by
    )
    SELECT ${tenantId}::uuid, n.organization_id, ${sopId}::uuid, ${input.siteId ?? null}::uuid,
           ${input.assignedTo ?? null}::uuid, ${input.intervalDays}, ${input.firstRunAt}::timestamptz,
           ${input.dueAfterDays ?? null}, ${input.title ?? null}, ${actorId}::uuid
    FROM asset_node n WHERE n.id = ${sopId}::uuid AND n.node_type = 'sop'
    RETURNING id
  `;
  if (!row) throw new Error('no such procedure');
  return row.id;
}

export interface SchedulePatch {
  enabled?: boolean | undefined;
  intervalDays?: number | undefined;
  nextRunAt?: string | undefined;
  dueAfterDays?: number | null | undefined;
  assignedTo?: string | null | undefined;
  siteId?: string | null | undefined;
  title?: string | null | undefined;
}

export async function updateSchedule(tx: HelmTx, id: string, patch: SchedulePatch): Promise<boolean> {
  const [row] = await tx<{ id: string }[]>`
    UPDATE sop_schedule SET
      enabled        = ${patch.enabled === undefined ? tx`enabled` : patch.enabled},
      interval_days  = ${patch.intervalDays === undefined ? tx`interval_days` : patch.intervalDays},
      next_run_at    = ${patch.nextRunAt === undefined ? tx`next_run_at` : tx`${patch.nextRunAt}::timestamptz`},
      due_after_days = ${patch.dueAfterDays === undefined ? tx`due_after_days` : patch.dueAfterDays},
      assigned_to    = ${patch.assignedTo === undefined ? tx`assigned_to` : tx`${patch.assignedTo}::uuid`},
      site_id        = ${patch.siteId === undefined ? tx`site_id` : tx`${patch.siteId}::uuid`},
      title          = ${patch.title === undefined ? tx`title` : patch.title}
    WHERE id = ${id}::uuid
    RETURNING id
  `;
  return row !== undefined;
}

export async function deleteSchedule(tx: HelmTx, id: string): Promise<boolean> {
  const [row] = await tx<{ id: string }[]>`
    DELETE FROM sop_schedule WHERE id = ${id}::uuid RETURNING id
  `;
  return row !== undefined;
}

/** True when the person is an active member of the tenant; the route's clearer 400. */
export async function isActiveMember(tx: HelmTx, tenantId: string, userId: string): Promise<boolean> {
  const [row] = await tx<{ ok: boolean }[]>`
    SELECT true AS ok FROM membership
    WHERE tenant_id = ${tenantId}::uuid AND user_id = ${userId}::uuid
      AND status = 'active' AND (expires_at IS NULL OR expires_at > now())
  `;
  return row !== undefined;
}
