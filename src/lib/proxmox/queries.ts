/**
 * The Proxmox settings card (1110): one row per connected cluster, without its
 * token secret, with what it has imported and how its last run went. Read
 * under RLS: tenant-wide roles see every connection.
 */
import type { HelmTx as Tx } from '@/lib/db/client';

export interface ProxmoxConnection {
  id: string;
  organizationId: string;
  organizationName: string;
  name: string;
  baseUrl: string;
  tokenId: string;
  /** The pinned certificate's sha256, or null for ordinary verification. */
  tlsSha256: string | null;
  /** Whether a secret is stored. Never the secret. */
  secretSet: boolean;
  syncEnabled: boolean;
  intervalMinutes: number;
  status: string;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  hosts: number;
  guests: number;
  lastRun: {
    status: string;
    startedAt: string | null;
    created: number;
    updated: number;
    skipped: number;
    failed: number;
    error: string | null;
  } | null;
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

export async function listProxmoxConnections(tx: Tx): Promise<ProxmoxConnection[]> {
  const rows = await tx<{
    id: string; organization_id: string; organization_name: string; display_name: string; base_url: string;
    token_id: string | null; tls_sha256: string | null; secret_set: boolean; sync_enabled: boolean;
    sync_interval_minutes: number; status: string; last_sync_at: Date | null; last_success_at: Date | null;
    consecutive_failures: number; last_error: string | null; hosts: number; guests: number;
    run_status: string | null; run_started_at: Date | null; run_created: number | null;
    run_updated: number | null; run_skipped: number | null; run_failed: number | null; run_error: string | null;
  }[]>`
    SELECT c.id, c.organization_id, o.name AS organization_name, c.display_name, c.base_url,
           c.config ->> 'token_id' AS token_id, c.config ->> 'tls_sha256' AS tls_sha256,
           c.credential_secret_ids ? 'token_secret' AS secret_set,
           c.sync_enabled, c.sync_interval_minutes,
           c.status::text AS status, c.last_sync_at, c.last_success_at, c.consecutive_failures, c.last_error,
           (SELECT count(*)::int FROM external_identity ei
             WHERE ei.connection_id = c.id AND ei.external_type = 'proxmox_node') AS hosts,
           (SELECT count(*)::int FROM external_identity ei
             WHERE ei.connection_id = c.id AND ei.external_type = 'proxmox_guest') AS guests,
           r.status::text AS run_status, r.started_at AS run_started_at, r.records_created AS run_created,
           r.records_updated AS run_updated, r.records_skipped AS run_skipped,
           r.records_failed AS run_failed, r.error_summary AS run_error
    FROM integration_connection c
    JOIN organization o ON o.id = c.organization_id
    LEFT JOIN LATERAL (
      SELECT * FROM integration_sync_run s WHERE s.connection_id = c.id
      ORDER BY s.started_at DESC NULLS LAST LIMIT 1
    ) r ON true
    WHERE c.provider = 'proxmox'
    ORDER BY lower(o.name), lower(c.display_name)
  `;

  return rows.map((r) => ({
    id: r.id,
    organizationId: r.organization_id,
    organizationName: r.organization_name,
    name: r.display_name,
    baseUrl: r.base_url,
    tokenId: r.token_id ?? '',
    tlsSha256: r.tls_sha256,
    secretSet: r.secret_set,
    syncEnabled: r.sync_enabled,
    intervalMinutes: r.sync_interval_minutes,
    status: r.status,
    lastSyncAt: iso(r.last_sync_at),
    lastSuccessAt: iso(r.last_success_at),
    consecutiveFailures: r.consecutive_failures,
    lastError: r.last_error,
    hosts: r.hosts,
    guests: r.guests,
    lastRun: r.run_status ? {
      status: r.run_status,
      startedAt: iso(r.run_started_at),
      created: r.run_created ?? 0,
      updated: r.run_updated ?? 0,
      skipped: r.run_skipped ?? 0,
      failed: r.run_failed ?? 0,
      error: r.run_error,
    } : null,
  }));
}
