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

/**
 * An ISO instant into the value `<input type="datetime-local">` expects.
 *
 * WHY THIS IS NOT `iso.slice(0, 16)`, which is the obvious version and is
 * wrong. toISOString() is UTC, and a datetime-local input means LOCAL wall
 * clock with no zone at all. Slicing shows a task due at 17:00 in Chicago as
 * "21:00" — and then saving the form, which converts the field back with
 * `new Date(value).toISOString()`, moves the deadline four hours later. Every
 * open-and-save would push it again.
 *
 * So the string is built from the local getters, which is the only way to get
 * the browser's own wall clock. Seconds are dropped because the input does not
 * show them by default and a value carrying them is rejected by some browsers.
 *
 * Returns '' for null, an empty string or an unparseable value, because that is
 * what an empty input holds — a date picker cannot show "invalid".
 */
export function toDateTimeLocalInput(value: Date | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The same conversion back: a datetime-local value to an ISO instant.
 *
 * `new Date('2026-10-20T17:00')` reads a zoneless string as local time, which
 * is what the input meant, so toISOString() is the whole conversion. It is a
 * function rather than an inline expression so that it sits beside its inverse
 * and the pair can be tested as a round trip — which is the property that
 * matters and the one neither half can establish alone.
 */
export function fromDateTimeLocalInput(value: string): string | null {
  if (value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
