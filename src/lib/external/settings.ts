/**
 * Reading and writing the outbound-check opt-in.
 *
 * ABSENT MEANS OFF, and every reader goes through here so that is true in one
 * place. A tenant that never visited the settings screen has no row, which is
 * indistinguishable from both switches being off — which is what decision 4
 * means by "an air-gapped install must keep working with zero configuration".
 */
import type { HelmTx } from '../db/client';

export interface ExternalCheckSetting {
  domainsEnabled: boolean;
  certificatesEnabled: boolean;
  intervalHours: number;
  rdapBaseUrl: string;
  updatedAt: string | null;
  /** Null until somebody has saved it once, which the screen says out loud. */
  configured: boolean;
}

/** The shipped defaults, which are also what an absent row means. */
const EXTERNAL_CHECK_DEFAULTS = {
  domainsEnabled: false,
  certificatesEnabled: false,
  intervalHours: 24,
  rdapBaseUrl: 'https://rdap.org',
} as const;

export const INTERVAL_MIN_HOURS = 1;
export const INTERVAL_MAX_HOURS = 8760;

export async function readExternalCheckSetting(tx: HelmTx): Promise<ExternalCheckSetting> {
  const [row] = await tx<{
    domains_enabled: boolean; certificates_enabled: boolean; interval_hours: number;
    rdap_base_url: string; updated_at: Date;
  }[]>`
    SELECT domains_enabled, certificates_enabled, interval_hours, rdap_base_url, updated_at
    FROM external_check_setting
    WHERE tenant_id = helm.current_tenant_id()
  `;

  if (!row) {
    return { ...EXTERNAL_CHECK_DEFAULTS, updatedAt: null, configured: false };
  }

  return {
    domainsEnabled: row.domains_enabled,
    certificatesEnabled: row.certificates_enabled,
    intervalHours: row.interval_hours,
    rdapBaseUrl: row.rdap_base_url,
    updatedAt: row.updated_at.toISOString(),
    configured: true,
  };
}

/**
 * Save it, creating the row on first use.
 *
 * ON CONFLICT rather than a read-then-write: two administrators saving at once
 * would otherwise race to insert the same primary key and one would get a
 * constraint violation instead of a saved setting. The policies on the table
 * check tenant:write on both INSERT and UPDATE, so the upsert is gated whichever
 * arm it takes.
 */
export async function writeExternalCheckSetting(
  tx: HelmTx,
  values: {
    domainsEnabled: boolean;
    certificatesEnabled: boolean;
    intervalHours: number;
    rdapBaseUrl: string;
  },
  actorId: string,
): Promise<ExternalCheckSetting> {
  await tx`
    INSERT INTO external_check_setting (
      tenant_id, domains_enabled, certificates_enabled, interval_hours,
      rdap_base_url, updated_at, updated_by
    )
    VALUES (
      helm.require_tenant_id(), ${values.domainsEnabled}, ${values.certificatesEnabled},
      ${values.intervalHours}, ${values.rdapBaseUrl}, now(), ${actorId}::uuid
    )
    ON CONFLICT (tenant_id) DO UPDATE SET
      domains_enabled      = EXCLUDED.domains_enabled,
      certificates_enabled = EXCLUDED.certificates_enabled,
      interval_hours       = EXCLUDED.interval_hours,
      rdap_base_url        = EXCLUDED.rdap_base_url,
      updated_at           = now(),
      updated_by           = EXCLUDED.updated_by
  `;

  return readExternalCheckSetting(tx);
}
