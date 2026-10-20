/**
 * The Microsoft 365 settings card (0990): one row per connected client,
 * without its secret, with what it has imported and how its last run went.
 * Read under RLS: tenant-wide roles see every client's connection.
 */
import type { HelmTx as Tx } from '@/lib/db/client';

export interface M365Connection {
  id: string;
  organizationId: string;
  organizationName: string;
  tenant: string;
  tenantName: string | null;
  clientId: string;
  secretSet: boolean;
  syncEnabled: boolean;
  intervalMinutes: number;
  syncUsers: boolean;
  syncLicences: boolean;
  syncDomains: boolean;
  status: string;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  contacts: number;
  licences: number;
  domains: number;
  lastRun: {
    status: string;
    startedAt: string | null;
    created: number;
    updated: number;
    failed: number;
    error: string | null;
  } | null;
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

export async function listM365Connections(tx: Tx): Promise<M365Connection[]> {
  const rows = await tx<{
    id: string; organization_id: string; organization_name: string; tenant: string | null;
    tenant_name: string | null; client_id: string | null; secret_set: boolean; sync_enabled: boolean;
    sync_interval_minutes: number; sync_users: boolean; sync_licences: boolean; sync_domains: boolean;
    status: string; last_sync_at: Date | null; last_success_at: Date | null; consecutive_failures: number;
    last_error: string | null; contacts: number; licences: number; domains: number;
    run_status: string | null; run_started_at: Date | null; run_created: number | null;
    run_updated: number | null; run_failed: number | null; run_error: string | null;
  }[]>`
    SELECT c.id, c.organization_id, o.name AS organization_name,
           c.config ->> 'tenant_id' AS tenant, c.config ->> 'tenant_name' AS tenant_name,
           c.config ->> 'client_id' AS client_id,
           c.credential_secret_ids ? 'client_secret' AS secret_set,
           c.sync_enabled, c.sync_interval_minutes,
           coalesce((c.config ->> 'sync_users')::boolean, true) AS sync_users,
           coalesce((c.config ->> 'sync_licences')::boolean, true) AS sync_licences,
           coalesce((c.config ->> 'sync_domains')::boolean, true) AS sync_domains,
           c.status::text AS status, c.last_sync_at, c.last_success_at, c.consecutive_failures, c.last_error,
           (SELECT count(*)::int FROM m365_contact_link l WHERE l.connection_id = c.id) AS contacts,
           (SELECT count(*)::int FROM external_identity ei
             WHERE ei.connection_id = c.id AND ei.external_type = 'm365_sku') AS licences,
           (SELECT count(*)::int FROM external_identity ei
             WHERE ei.connection_id = c.id AND ei.external_type = 'm365_domain') AS domains,
           r.status::text AS run_status, r.started_at AS run_started_at, r.records_created AS run_created,
           r.records_updated AS run_updated, r.records_failed AS run_failed, r.error_summary AS run_error
    FROM integration_connection c
    JOIN organization o ON o.id = c.organization_id
    LEFT JOIN LATERAL (
      SELECT * FROM integration_sync_run s WHERE s.connection_id = c.id
      ORDER BY s.started_at DESC NULLS LAST LIMIT 1
    ) r ON true
    WHERE c.provider = 'microsoft_graph'
    ORDER BY lower(o.name)
  `;

  return rows.map((r) => ({
    id: r.id,
    organizationId: r.organization_id,
    organizationName: r.organization_name,
    tenant: r.tenant ?? '',
    tenantName: r.tenant_name,
    clientId: r.client_id ?? '',
    secretSet: r.secret_set,
    syncEnabled: r.sync_enabled,
    intervalMinutes: r.sync_interval_minutes,
    syncUsers: r.sync_users,
    syncLicences: r.sync_licences,
    syncDomains: r.sync_domains,
    status: r.status,
    lastSyncAt: iso(r.last_sync_at),
    lastSuccessAt: iso(r.last_success_at),
    consecutiveFailures: r.consecutive_failures,
    lastError: r.last_error,
    contacts: r.contacts,
    licences: r.licences,
    domains: r.domains,
    lastRun: r.run_status ? {
      status: r.run_status,
      startedAt: iso(r.run_started_at),
      created: r.run_created ?? 0,
      updated: r.run_updated ?? 0,
      failed: r.run_failed ?? 0,
      error: r.run_error,
    } : null,
  }));
}
