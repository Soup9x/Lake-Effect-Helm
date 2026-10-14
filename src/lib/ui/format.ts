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

/**
 * UTC, and the reader's own local time beside it.
 *
 * THE UTC RULE ABOVE IS NOT BEING RELAXED. "expires 2026-03-01" meaning three
 * different instants is how a certificate lapses on a Sunday, so a SHARED fact
 * — an expiry, a rotation due date, an audit timestamp read by whoever
 * investigates — stays UTC-suffixed and unconverted.
 *
 * This is for the other case, the one that header already names when it says
 * "where local time matters the UI says both": a timestamp about the READER
 * themselves. "You signed in at 14:30 UTC" is worse than useless to somebody
 * in Toronto trying to recognise their own session; it is the one place a
 * person's own zone is the point rather than an ambiguity.
 *
 * `zone` null, or a zone this runtime does not know, falls back to plain UTC
 * rather than throwing. Intl raises a RangeError on an unknown time zone, and a
 * preference must never be why a page fails to render — the database refuses an
 * unknown zone on write (0630), so this is the second lock.
 */
export function formatDateTimeLocal(
  value: Date | string | null | undefined,
  zone: string | null,
): string {
  const utc = formatDateTime(value);
  if (!zone || utc === '—') return utc;

  const date = value instanceof Date ? value : new Date(value as string);
  try {
    const local = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(date);
    // en-CA gives YYYY-MM-DD, so this reads the same way as the UTC half.
    return `${utc} · ${local.replace(',', '')} ${zone.split('/').pop()?.replace(/_/g, ' ') ?? zone}`;
  } catch {
    return utc;
  }
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
