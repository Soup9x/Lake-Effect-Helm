/**
 * Presentation helpers.
 *
 * All dates render in UTC with an explicit suffix. A documentation platform is
 * read by a technician in Buffalo, a client in Toronto and an auditor wherever
 * they are, and "expires 2026-03-01" meaning three different instants is how a
 * certificate lapses on a Sunday. Where local time matters the UI says both.
 */
export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toISOString().slice(0, 10);
}

export function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** "in 12 days" / "6 days ago". Day granularity: these are expiry dates. */
export function relativeDays(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${Math.abs(days)} days ago`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** snake_case and kebab-case to something a person reads. */
export function humanise(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}
