/**
 * What the integration-era widgets read (1230).
 *
 * Every query here runs under the caller's RLS, so a client-side user sees
 * their own organisation's devices and expirations and no integrations at all
 * (integration_connection is tenant-wide only), from the same SQL a super admin
 * runs. Nothing here is fetched unless the widget asking for it is on the
 * layout; the dashboard page decides that.
 */
import type { HelmTx } from '@/lib/db/client';

// ---------------------------------------------------------------------------
// Integration health
// ---------------------------------------------------------------------------

export type IntegrationState = 'healthy' | 'failing' | 'partial' | 'stale' | 'paused' | 'waiting';

export interface IntegrationHealthRow {
  id: string;
  provider: string;
  name: string;
  /** The client a per-client connection belongs to (Proxmox, M365); null when tenant-wide. */
  organizationName: string | null;
  state: IntegrationState;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  /** The last failure, or the warning a partial run left. */
  message: string | null;
}

const PROVIDER_LABELS: Record<string, string> = {
  ninja_one: 'NinjaOne',
  action1: 'Action1',
  microsoft_graph: 'Microsoft 365',
  proxmox: 'Proxmox',
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider.replace(/_/g, ' ');
}

/**
 * The state of one connection, worst first.
 *
 * STALE is the one that matters most and is easiest to miss: nothing is red,
 * the last run succeeded, and it succeeded a week ago because the worker
 * stopped picking it up. Three missed intervals is the same threshold the
 * UniFi widget uses (src/lib/ui/sync-health.ts).
 */
export function integrationState(row: {
  syncEnabled: boolean;
  intervalMinutes: number;
  lastSyncAt: Date | null;
  lastSuccessAt: Date | null;
  consecutiveFailures: number;
  lastRunStatus: string | null;
}, now = Date.now()): IntegrationState {
  if (!row.syncEnabled) return 'paused';
  if (row.consecutiveFailures > 0) return 'failing';
  if (!row.lastSyncAt) return 'waiting';
  if (row.lastRunStatus === 'partial') return 'partial';
  const since = row.lastSuccessAt ?? row.lastSyncAt;
  if (now - since.getTime() > row.intervalMinutes * 3 * 60_000) return 'stale';
  return 'healthy';
}

const STATE_ORDER: Record<IntegrationState, number> = {
  failing: 0, stale: 1, partial: 2, waiting: 3, paused: 4, healthy: 5,
};

export async function listIntegrationHealth(tx: HelmTx): Promise<IntegrationHealthRow[]> {
  const rows = await tx<{
    id: string; provider: string; display_name: string; organization_name: string | null;
    sync_enabled: boolean; sync_interval_minutes: number;
    last_sync_at: Date | null; last_success_at: Date | null;
    consecutive_failures: number; last_error: string | null;
    last_run_status: string | null; last_run_error: string | null;
  }[]>`
    SELECT c.id, c.provider::text AS provider, c.display_name, o.name AS organization_name,
           c.sync_enabled, c.sync_interval_minutes, c.last_sync_at, c.last_success_at,
           c.consecutive_failures, c.last_error,
           r.status AS last_run_status, r.error_summary AS last_run_error
    FROM integration_connection c
    LEFT JOIN organization o ON o.id = c.organization_id
    LEFT JOIN LATERAL (
      SELECT status::text AS status, error_summary
      FROM integration_sync_run
      WHERE connection_id = c.id AND finished_at IS NOT NULL
      ORDER BY coalesce(started_at, requested_at) DESC NULLS LAST
      LIMIT 1
    ) r ON true
    WHERE c.disabled_at IS NULL
    ORDER BY c.provider, o.name NULLS FIRST, c.display_name
  `;

  const now = Date.now();
  return rows
    .map((r) => {
      const state = integrationState({
        syncEnabled: r.sync_enabled,
        intervalMinutes: r.sync_interval_minutes,
        lastSyncAt: r.last_sync_at,
        lastSuccessAt: r.last_success_at,
        consecutiveFailures: r.consecutive_failures,
        lastRunStatus: r.last_run_status,
      }, now);
      return {
        id: r.id,
        provider: r.provider,
        name: r.display_name,
        organizationName: r.organization_name,
        state,
        lastSyncAt: r.last_sync_at?.toISOString() ?? null,
        lastSuccessAt: r.last_success_at?.toISOString() ?? null,
        consecutiveFailures: r.consecutive_failures,
        message: state === 'failing' ? r.last_error ?? r.last_run_error
          : state === 'partial' ? r.last_run_error
          : null,
      };
    })
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);
}

// ---------------------------------------------------------------------------
// Devices needing attention
// ---------------------------------------------------------------------------

export interface DeviceAttentionRow {
  nodeId: string;
  name: string;
  organizationId: string;
  organizationName: string;
  /** Short phrases, worst first: "Offline", "3 critical patches", … */
  issues: string[];
  /** Whether any issue is the serious kind (offline, critical patches, antivirus). */
  serious: boolean;
  sources: string[];
}

/**
 * Devices whose synced profile says something is wrong.
 *
 * The rules, per source, are what the device cards already flag:
 *
 *   NinjaOne   offline · critical patches pending · needs a reboot ·
 *              a volume under 10% free · antivirus off or out of date
 *   Action1    agent not connected · not seen for 30+ days (onlineStatus
 *              ERROR) · critical updates missing · needs a reboot ·
 *              vulnerability status ERROR
 *
 * The antivirus test matches NinjaOne's wording loosely ("OFF", "DISABLED",
 * "OUT_OF_DATE") because the field values were read from the API reference,
 * not from a real tenant; see the NinjaOne runbook. A device linked to both
 * tools appears once, with both sets of issues.
 *
 * Filtered in SQL so a tenant with two thousand healthy devices does not ship
 * two thousand profiles to the page to find the eleven that matter.
 */
export async function listDevicesNeedingAttention(
  tx: HelmTx,
  limit = 25,
): Promise<{ rows: DeviceAttentionRow[]; total: number }> {
  const rows = await tx<{
    node_id: string; name: string; organization_id: string; organization_name: string;
    issues: string[]; serious: boolean; sources: string[]; total: number;
  }[]>`
    WITH flagged AS (
      SELECT ei.node_id, ei.external_type,
             array_remove(ARRAY[
               CASE WHEN ei.external_type = 'ninja_device'
                         AND (p ->> 'offline') = 'true' THEN 'Offline' END,
               CASE WHEN ei.external_type = 'action1_device'
                         AND (p ->> 'onlineStatus') = 'ERROR' THEN 'Not seen in 30+ days' END,
               CASE WHEN ei.external_type = 'action1_device'
                         AND p ? 'agentStatus' AND (p ->> 'agentStatus') !~* '^connected$'
                    THEN 'Agent ' || lower(p ->> 'agentStatus') END,
               CASE WHEN coalesce((p -> 'pendingPatches' ->> 'critical')::int, 0) > 0
                    THEN (p -> 'pendingPatches' ->> 'critical') || ' critical patch'
                         || CASE WHEN (p -> 'pendingPatches' ->> 'critical')::int = 1 THEN '' ELSE 'es' END END,
               CASE WHEN coalesce((p -> 'missingUpdates' ->> 'critical')::int, 0) > 0
                    THEN (p -> 'missingUpdates' ->> 'critical') || ' critical update'
                         || CASE WHEN (p -> 'missingUpdates' ->> 'critical')::int = 1 THEN '' ELSE 's' END END,
               CASE WHEN EXISTS (
                      SELECT 1 FROM jsonb_array_elements(
                        CASE WHEN jsonb_typeof(p -> 'antivirus') = 'array' THEN p -> 'antivirus' ELSE '[]' END) av
                      WHERE (av ->> 'state') ~* '(off|disabled|expired|snoozed)'
                         OR (av ->> 'definitions') ~* 'out')
                    THEN 'Antivirus problem' END,
               CASE WHEN (p ->> 'vulnerabilityStatus') = 'ERROR' THEN 'Vulnerabilities' END,
               CASE WHEN EXISTS (
                      SELECT 1 FROM jsonb_array_elements(
                        CASE WHEN jsonb_typeof(p -> 'volumes') = 'array' THEN p -> 'volumes' ELSE '[]' END) v
                      WHERE jsonb_typeof(v -> 'capacityGb') = 'number'
                        AND jsonb_typeof(v -> 'freeGb') = 'number'
                        AND (v ->> 'capacityGb')::numeric > 0
                        AND (v ->> 'freeGb')::numeric / (v ->> 'capacityGb')::numeric < 0.1)
                    THEN 'Disk under 10% free' END,
               CASE WHEN (p ->> 'needsReboot') = 'true' THEN 'Needs a reboot' END
             ], NULL) AS issues
      FROM external_identity ei
      CROSS JOIN LATERAL (SELECT ei.profile AS p) prof
      WHERE ei.external_type IN ('ninja_device', 'action1_device')
        AND jsonb_typeof(ei.profile) = 'object'
    ),
    per_node AS (
      SELECT f.node_id,
             array_agg(DISTINCT CASE f.external_type
               WHEN 'ninja_device' THEN 'NinjaOne' ELSE 'Action1' END) AS sources,
             (SELECT array_agg(DISTINCT i) FROM flagged f2, unnest(f2.issues) i
               WHERE f2.node_id = f.node_id) AS issues
      FROM flagged f
      WHERE cardinality(f.issues) > 0
      GROUP BY f.node_id
    )
    SELECT n.id AS node_id, n.name, o.id AS organization_id, o.name AS organization_name,
           pn.issues, pn.sources,
           EXISTS (SELECT 1 FROM unnest(pn.issues) i
                   WHERE i ~ '^(Offline|Not seen|Agent|Antivirus)' OR i ~ 'critical') AS serious,
           count(*) OVER ()::int AS total
    FROM per_node pn
    JOIN asset_node n ON n.id = pn.node_id AND n.archived_at IS NULL
    JOIN organization o ON o.id = n.organization_id AND o.deleted_at IS NULL
    ORDER BY 7 DESC, cardinality(pn.issues) DESC, o.name, n.name
    LIMIT ${limit}
  `;

  // Worst first within a device, so the line reads in order of urgency.
  const rank = (issue: string) =>
    /^(Offline|Not seen|Agent)/.test(issue) ? 0
      : /critical/.test(issue) ? 1
      : /^Antivirus|^Vulnerab/.test(issue) ? 2
      : /^Disk/.test(issue) ? 3
      : 4;

  return {
    total: rows[0]?.total ?? 0,
    rows: rows.map((r) => ({
      nodeId: r.node_id,
      name: r.name,
      organizationId: r.organization_id,
      organizationName: r.organization_name,
      issues: [...r.issues].sort((a, b) => rank(a) - rank(b)),
      serious: r.serious,
      sources: r.sources,
    })),
  };
}

// ---------------------------------------------------------------------------
// One kind of expiration
// ---------------------------------------------------------------------------

export interface ExpiringRow {
  id: string;
  nodeId: string | null;
  label: string;
  organizationId: string;
  organizationName: string;
  expiresAt: Date;
  daysRemaining: number;
  severity: string;
  autoRenew: boolean;
}

/**
 * Expirations of one kind within `days`, including ones already past (they are
 * still the most urgent thing on the list until somebody acknowledges them).
 */
export async function listExpiring(
  tx: HelmTx,
  kind: 'domain_registration' | 'device_warranty',
  days = 90,
  limit = 10,
): Promise<{ rows: ExpiringRow[]; total: number }> {
  const rows = await tx<{
    id: string; node_id: string | null; label: string; organization_id: string;
    organization_name: string; expires_at: Date; days_remaining: number;
    severity: string; auto_renew: boolean; total: number;
  }[]>`
    SELECT id, node_id, label, organization_id, organization_name, expires_at,
           days_remaining, severity::text AS severity, coalesce(auto_renew, false) AS auto_renew,
           count(*) OVER ()::int AS total
    FROM v_expiration_dashboard
    WHERE kind = ${kind}::expiration_kind AND days_remaining <= ${days}
    ORDER BY expires_at
    LIMIT ${limit}
  `;
  return {
    total: rows[0]?.total ?? 0,
    rows: rows.map((r) => ({
      id: r.id,
      nodeId: r.node_id,
      label: r.label,
      organizationId: r.organization_id,
      organizationName: r.organization_name,
      expiresAt: r.expires_at,
      daysRemaining: r.days_remaining,
      severity: r.severity,
      autoRenew: r.auto_renew,
    })),
  };
}
