/**
 * The session policy as the settings card and its route read it (0890).
 * Shared so the page and the route cannot disagree about a field's name.
 */
import { z } from 'zod';
import type { HelmTx } from '../db/client';

export interface SessionPolicySettings {
  idleMinutes: number;
  /** Null: no absolute limit. */
  absoluteHours: number | null;
  stepUpMinutes: number;
  lockoutThreshold: number;
  lockoutMaxMinutes: number;
  /** Every local sign-in needs an authenticator code (0960). */
  requireLocalTotp: boolean;
  /** Null until somebody first saves; the values are then the defaults. */
  updatedAt: string | null;
}

/** The same bounds as 0890's CHECK constraints, so the route says why. */
export const sessionPolicySchema = z.object({
  idleMinutes: z.number().int().min(5).max(1440),
  absoluteHours: z.number().int().min(1).max(720).nullable(),
  stepUpMinutes: z.number().int().min(1).max(60),
  lockoutThreshold: z.number().int().min(3).max(20),
  lockoutMaxMinutes: z.number().int().min(1).max(1440),
  requireLocalTotp: z.boolean(),
});

export async function readSessionPolicy(tx: HelmTx): Promise<SessionPolicySettings> {
  const [row] = await tx<{
    idle_minutes: number; absolute_hours: number | null; step_up_minutes: number;
    lockout_threshold: number; lockout_max_minutes: number; require_local_totp: boolean;
    updated_at: Date | null;
  }[]>`SELECT * FROM helm.session_policy()`;
  return {
    idleMinutes: row?.idle_minutes ?? 480,
    absoluteHours: row?.absolute_hours ?? null,
    stepUpMinutes: row?.step_up_minutes ?? 15,
    lockoutThreshold: row?.lockout_threshold ?? 5,
    lockoutMaxMinutes: row?.lockout_max_minutes ?? 15,
    requireLocalTotp: row?.require_local_totp ?? false,
    updatedAt: row?.updated_at?.toISOString() ?? null,
  };
}
