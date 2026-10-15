/**
 * Expiry alert settings — the pure half, safe to import from a client form.
 *
 * The database half (reading and writing the tenant's default rule) is in
 * ./queries.ts. They are separate so a 'use client' component never pulls a
 * module that also holds SQL into the browser bundle.
 */

/** What a tenant gets from 0730 before anybody changes it. */
export const DEFAULT_LEAD_DAYS: readonly number[] = [30, 14, 7, 1];

/** Enough for a sensible schedule; more is a list nobody reads. */
export const MAX_LEAD_DAYS = 6;

/**
 * A year. The table allows ten (alert_rule_lead_days_sane), but a warning a
 * year out is a calendar entry, not an alert, and a typo of 3000 for 30 should
 * be caught here rather than fire tomorrow for everything.
 */
export const LEAD_DAY_MAX = 365;

export interface ExpiryAlertSetting {
  enabled: boolean;
  /** Days before expiry at which to warn, most distant first. */
  leadDays: number[];
}

/**
 * Parse "30, 14, 7, 1" into a validated schedule, or say what is wrong.
 *
 * De-duplicated and sorted most-distant-first, which is how the rule is stored
 * and how people read a schedule. 0 is allowed: "on the day".
 */
export function parseLeadDays(
  raw: string | readonly number[],
): { ok: true; leadDays: number[] } | { ok: false; error: string } {
  const values = typeof raw === 'string'
    ? raw.split(/[\s,]+/).filter((part) => part.length > 0).map((part) => Number(part))
    : [...raw];

  if (values.length === 0) {
    return { ok: false, error: 'Give at least one number of days.' };
  }
  for (const value of values) {
    if (!Number.isInteger(value) || value < 0 || value > LEAD_DAY_MAX) {
      return { ok: false, error: `Each lead time must be a whole number of days from 0 to ${LEAD_DAY_MAX}.` };
    }
  }

  const leadDays = [...new Set(values)].sort((a, b) => b - a);
  if (leadDays.length > MAX_LEAD_DAYS) {
    return { ok: false, error: `At most ${MAX_LEAD_DAYS} lead times.` };
  }
  return { ok: true, leadDays };
}
