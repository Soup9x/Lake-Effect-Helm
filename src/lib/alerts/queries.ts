/**
 * The tenant's default expiry alert rule (0730), read and written under RLS.
 *
 * alert_rule's policies require rank 60 to write; the route additionally
 * declares alert:manage, which only super_admin and tier3 hold.
 */
import type { HelmTx } from '../db/client';
import { DEFAULT_LEAD_DAYS, type ExpiryAlertSetting } from './expiry';

export async function readExpiryAlertSetting(tx: HelmTx): Promise<ExpiryAlertSetting> {
  const [row] = await tx<{ is_active: boolean; lead_days: number[] }[]>`
    SELECT is_active, lead_days FROM alert_rule
    WHERE tenant_id = helm.current_tenant_id() AND is_default
  `;
  // 0730 gives every tenant one; a missing row would mean a tenant created by
  // something that bypassed the trigger. Reported as the default rather than
  // failing the whole Settings page over it.
  if (!row) return { enabled: true, leadDays: [...DEFAULT_LEAD_DAYS] };
  return { enabled: row.is_active, leadDays: row.lead_days.map(Number) };
}

export async function writeExpiryAlertSetting(
  tx: HelmTx,
  next: ExpiryAlertSetting,
): Promise<ExpiryAlertSetting> {
  const [row] = await tx<{ id: string; is_active: boolean; lead_days: number[] }[]>`
    UPDATE alert_rule
    SET is_active = ${next.enabled}, lead_days = ${next.leadDays}::integer[], updated_at = now()
    WHERE tenant_id = helm.current_tenant_id() AND is_default
    RETURNING id, is_active, lead_days
  `;
  if (!row) {
    // RLS declined, or the default rule is missing. Either way nothing changed,
    // and saying "saved" would be the wrong answer.
    throw new Error('the expiry alert rule was not updated');
  }

  // Switching expiry warnings off is the kind of change somebody asks about
  // after a certificate lapsed, so it leaves a record.
  await tx`
    SELECT helm.audit(
      'alert.rule_updated', 'alert_rule', ${row.id}::uuid, 'success'::audit_outcome,
      NULL::uuid, NULL::uuid, NULL::text,
      ${tx.json({ enabled: row.is_active, leadDays: row.lead_days.map(Number) })}::jsonb
    )
  `;
  return { enabled: row.is_active, leadDays: row.lead_days.map(Number) };
}
