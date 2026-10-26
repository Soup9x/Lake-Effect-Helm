/**
 * What the NinjaOne settings card shows (0980): the connection without its
 * secret, NinjaOne's organisations and the client each imports to, and the
 * last few runs. Read under RLS — any tenant-wide role may look; changing it
 * is integration:rmm:manage.
 */
import type { HelmTx as Tx } from '@/lib/db/client';

export interface NinjaConnection {
  id: string;
  baseUrl: string;
  /** Where people sign in, for links (1090). Null: the regional host. */
  portalUrl: string | null;
  clientId: string;
  /** Whether a secret is stored. Never the secret. */
  secretSet: boolean;
  syncEnabled: boolean;
  intervalMinutes: number;
  status: string;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  deviceCount: number;
}

export interface NinjaOrganizationRow {
  ninjaOrgId: string;
  name: string;
  organizationId: string | null;
  organizationName: string | null;
  /** The client is archived, so nothing imports to it until it is restored. */
  organizationArchived: boolean;
  /** Somebody chose "Don't import", or deleted the client (1070). Null and unmapped: undecided. */
  excludedAt: string | null;
  deviceCount: number | null;
  seenAt: string;
}

export interface NinjaRun {
  id: string;
  status: string;
  trigger: string;
  startedAt: string | null;
  finishedAt: string | null;
  seen: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  error: string | null;
}

export interface NinjaSettings {
  connection: NinjaConnection | null;
  organizations: NinjaOrganizationRow[];
  runs: NinjaRun[];
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

export async function readNinjaSettings(tx: Tx): Promise<NinjaSettings> {
  const [row] = await tx<{
    id: string; base_url: string; portal_url: string | null; client_id: string | null; secret_set: boolean;
    sync_enabled: boolean; sync_interval_minutes: number; status: string;
    last_sync_at: Date | null; last_success_at: Date | null; consecutive_failures: number;
    last_error: string | null; device_count: number;
  }[]>`
    SELECT c.id, c.base_url, c.config ->> 'portal_url' AS portal_url, c.config ->> 'client_id' AS client_id,
           c.credential_secret_ids ? 'client_secret' AS secret_set,
           c.sync_enabled, c.sync_interval_minutes, c.status::text AS status,
           c.last_sync_at, c.last_success_at, c.consecutive_failures, c.last_error,
           (SELECT count(*)::int FROM external_identity ei
             WHERE ei.connection_id = c.id AND ei.external_type = 'ninja_device') AS device_count
    FROM integration_connection c
    WHERE c.provider = 'ninja_one' AND c.organization_id IS NULL
    ORDER BY c.created_at LIMIT 1
  `;
  if (!row) return { connection: null, organizations: [], runs: [] };

  const [organizations, runs] = await Promise.all([
    tx<{
      ninja_org_id: string; name: string; organization_id: string | null;
      organization_name: string | null; organization_archived: boolean; excluded_at: Date | null;
      device_count: number | null; seen_at: Date;
    }[]>`
      SELECT n.ninja_org_id, n.name, n.organization_id, o.name AS organization_name,
             coalesce(o.archived_at IS NOT NULL, false) AS organization_archived, n.excluded_at,
             n.device_count, n.seen_at
      FROM ninja_organization n
      LEFT JOIN organization o ON o.id = n.organization_id
      WHERE n.connection_id = ${row.id}::uuid
      ORDER BY lower(n.name), n.ninja_org_id
    `,
    tx<{
      id: string; status: string; trigger_source: string; started_at: Date | null; finished_at: Date | null;
      records_seen: number; records_created: number; records_updated: number;
      records_skipped: number; records_failed: number; error_summary: string | null;
    }[]>`
      SELECT id, status::text AS status, trigger_source, started_at, finished_at,
             records_seen, records_created, records_updated, records_skipped, records_failed,
             error_summary
      FROM integration_sync_run
      WHERE connection_id = ${row.id}::uuid
      ORDER BY started_at DESC NULLS LAST LIMIT 5
    `,
  ]);

  return {
    connection: {
      id: row.id,
      baseUrl: row.base_url,
      portalUrl: row.portal_url,
      clientId: row.client_id ?? '',
      secretSet: row.secret_set,
      syncEnabled: row.sync_enabled,
      intervalMinutes: row.sync_interval_minutes,
      status: row.status,
      lastSyncAt: iso(row.last_sync_at),
      lastSuccessAt: iso(row.last_success_at),
      consecutiveFailures: row.consecutive_failures,
      lastError: row.last_error,
      deviceCount: row.device_count,
    },
    organizations: organizations.map((o) => ({
      ninjaOrgId: o.ninja_org_id,
      name: o.name,
      organizationId: o.organization_id,
      organizationName: o.organization_name,
      organizationArchived: o.organization_archived,
      excludedAt: iso(o.excluded_at),
      deviceCount: o.device_count,
      seenAt: o.seen_at.toISOString(),
    })),
    runs: runs.map((r) => ({
      id: r.id,
      status: r.status,
      trigger: r.trigger_source,
      startedAt: iso(r.started_at),
      finishedAt: iso(r.finished_at),
      seen: r.records_seen,
      created: r.records_created,
      updated: r.records_updated,
      skipped: r.records_skipped,
      failed: r.records_failed,
      error: r.error_summary,
    })),
  };
}
