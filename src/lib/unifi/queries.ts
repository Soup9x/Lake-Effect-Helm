/**
 * What the settings page shows about UniFi controllers.
 *
 * helm.unifi_mappings() returns settings and health. The API key is a reference
 * into `secret`, and the result type carries whether one is set, not what it
 * is; the same for the webhook secret.
 */
import type { HelmTx } from '../db/client';
import type { OrganizationOption, UnifiMapping } from '@/components/unifi-settings';

/** helm.unifi_mappings(): settings and health, never the API key. */
interface UnifiRow {
  id: string;
  organization_id: string;
  organization_name: string;
  name: string;
  controller_url: string;
  unifi_site_id: string;
  is_active: boolean;
  api_key_set: boolean;
  tls_verify: boolean;
  tls_pinned_sha256: string | null;
  tls_exception_ack_at: Date | null;
  tls_exception_ack_by_name: string | null;
  poll_interval_seconds: number;
  last_poll_at: Date | null;
  last_poll_ok: boolean | null;
  last_poll_error: string | null;
  consecutive_failures: number;
  next_poll_at: Date;
  last_device_count: number | null;
  last_client_count: number | null;
  asset_count: string;
  webhook_state: UnifiMapping['webhookState'];
  webhook_secret_set: boolean;
  webhook_last_event_at: Date | null;
  webhook_last_error: string | null;
  webhook_events_received: string;
  webhook_events_rejected: string;
}

export function toUnifiMapping(row: UnifiRow): UnifiMapping {
  return {
    id: row.id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    name: row.name,
    controllerUrl: row.controller_url,
    unifiSiteId: row.unifi_site_id,
    isActive: row.is_active,
    // Whether a key exists, never the key itself — helm_app cannot read secret
    // material, so there is nothing here that could carry it.
    apiKeySet: row.api_key_set,
    tlsVerify: row.tls_verify,
    tlsPinnedSha256: row.tls_pinned_sha256,
    tlsExceptionAckAt: row.tls_exception_ack_at?.toISOString() ?? null,
    tlsExceptionAckByName: row.tls_exception_ack_by_name,
    pollIntervalSeconds: row.poll_interval_seconds,
    lastPollAt: row.last_poll_at?.toISOString() ?? null,
    lastPollOk: row.last_poll_ok,
    lastPollError: row.last_poll_error,
    consecutiveFailures: row.consecutive_failures,
    nextPollAt: row.next_poll_at.toISOString(),
    lastDeviceCount: row.last_device_count,
    lastClientCount: row.last_client_count,
    assetCount: Number(row.asset_count),
    // Receiver health (0450). Whether a secret is set, never what it is —
    // helm.unifi_mappings() has no column that could carry it.
    webhookState: row.webhook_state,
    webhookSecretSet: row.webhook_secret_set,
    webhookLastEventAt: row.webhook_last_event_at?.toISOString() ?? null,
    webhookLastError: row.webhook_last_error,
    webhookEventsReceived: Number(row.webhook_events_received),
    webhookEventsRejected: Number(row.webhook_events_rejected),
  };
}


export async function listUnifiMappings(tx: HelmTx): Promise<UnifiMapping[]> {
  const rows = await tx<UnifiRow[]>`SELECT * FROM helm.unifi_mappings()`;
  return rows.map(toUnifiMapping);
}

/**
 * The clients a mapping may be attached to. RLS scopes this to the tenant and
 * to the organisations this actor may see, so the picker cannot offer a client
 * they have no access to.
 */
export function listOrganizationOptions(tx: HelmTx): Promise<OrganizationOption[]> {
  return tx<OrganizationOption[]>`SELECT id, name FROM organization ORDER BY name`;
}
