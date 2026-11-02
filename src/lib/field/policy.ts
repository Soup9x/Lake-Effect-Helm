/**
 * Field view's policy, as the application reads and writes it (1250).
 *
 * The table is reachable only through helm.field_view_policy() and
 * helm.set_field_view_policy(), as session_policy is (0890). The idle and
 * absolute limits are ENFORCED by the sign-in role on every request
 * (lib/auth/session-policy.ts); what is read here shapes the pages and the
 * critical-credential rule.
 */
import { z } from 'zod';
import type { HelmTx } from '../db/client';
import { withTenant } from '../db/client';
import type { SessionContextRequest } from '../db/context';
import { ApiError } from '../api/errors';

import { FIELD_SECTIONS, type FieldViewPolicy } from './sections';

export { FIELD_SECTION_LABELS, FIELD_SECTIONS, type FieldSection, type FieldViewPolicy } from './sections';

export const fieldViewPolicySchema = z.object({
  enabled: z.boolean(),
  idleMinutes: z.number().int().min(2).max(240),
  absoluteHours: z.number().int().min(1).max(72),
  criticalOnPhone: z.enum(['step_up', 'block']),
  sections: z.array(z.enum(FIELD_SECTIONS)).max(FIELD_SECTIONS.length),
});

export type FieldViewPolicyInput = z.infer<typeof fieldViewPolicySchema>;

export async function readFieldViewPolicy(tx: HelmTx): Promise<FieldViewPolicy> {
  const [row] = await tx<{
    enabled: boolean; idle_minutes: number; absolute_hours: number;
    critical_on_phone: string; sections: string[]; updated_at: Date | null;
  }[]>`SELECT * FROM helm.field_view_policy()`;
  return {
    enabled: row?.enabled ?? true,
    idleMinutes: row?.idle_minutes ?? 10,
    absoluteHours: row?.absolute_hours ?? 12,
    criticalOnPhone: row?.critical_on_phone === 'block' ? 'block' : 'step_up',
    // In the canonical order, and only names this build knows.
    sections: FIELD_SECTIONS.filter((s) => (row?.sections ?? [...FIELD_SECTIONS]).includes(s)),
    updatedAt: row?.updated_at ?? null,
  };
}

export async function writeFieldViewPolicy(tx: HelmTx, input: FieldViewPolicyInput): Promise<void> {
  const sections = FIELD_SECTIONS.filter((s) => input.sections.includes(s));
  await tx`
    SELECT helm.set_field_view_policy(
      ${input.enabled}::boolean, ${input.idleMinutes}::integer, ${input.absoluteHours}::integer,
      ${input.criticalOnPhone}::text, ${sections}::text[])
  `;
}

/**
 * A critical credential, on a phone, when the administrator said not on
 * phones. Checked by the reveal and copy routes for Field view sessions only;
 * the ordinary step-up and reason rules still apply on top when it is allowed.
 */
export async function assertFieldMayReveal(actor: SessionContextRequest, secretId: string): Promise<void> {
  const blocked = await withTenant(actor, async (tx) => {
    const policy = await readFieldViewPolicy(tx);
    if (policy.criticalOnPhone !== 'block') return false;
    const [row] = await tx<{ sensitivity: string }[]>`
      SELECT sensitivity::text FROM v_secret_metadata WHERE id = ${secretId}::uuid
    `;
    return row?.sensitivity === 'critical';
  });
  if (blocked) {
    throw ApiError.forbidden(
      'Critical credentials are not shown in Field view. Open it on a computer, or switch to the full site.',
    );
  }
}
