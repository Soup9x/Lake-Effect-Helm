/**
 * Five-field cron, UTC, enough for a backup schedule and nothing more.
 *
 *   minute hour day-of-month month day-of-week
 *
 * Each field takes `*`, a number, a list (1,15), a range (1-5), a step
 * (*​/6, 0-30/10) and the names of months and weekdays. Day-of-month and
 * day-of-week combine with OR when both are restricted, as cron does.
 * Written here rather than taken from a package because the schedule is a
 * security-relevant setting written by an administrator, and forty lines
 * that can be read beat a dependency that cannot.
 */
export interface CronSpec {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function parseField(raw: string, min: number, max: number, names: string[] = []): Set<number> {
  const out = new Set<number>();
  const value = (token: string): number => {
    const named = names.indexOf(token.toLowerCase());
    if (named >= 0) return named + min;
    if (!/^\d+$/.test(token)) throw new Error(`"${token}" is not a number`);
    const n = Number(token);
    if (n < min || n > max) throw new Error(`${n} is outside ${min}-${max}`);
    return n;
  };
  for (const part of raw.split(',')) {
    const [rangeRaw, stepRaw] = part.split('/');
    if (rangeRaw === undefined || rangeRaw === '') throw new Error('empty field');
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) throw new Error(`"${stepRaw}" is not a step`);
    let lo: number;
    let hi: number;
    if (rangeRaw === '*') {
      lo = min; hi = max;
    } else if (rangeRaw.includes('-')) {
      const [a, b] = rangeRaw.split('-');
      lo = value(a!); hi = value(b!);
      if (hi < lo) throw new Error(`${rangeRaw} runs backwards`);
    } else {
      lo = value(rangeRaw);
      hi = stepRaw === undefined ? lo : max;
    }
    for (let n = lo; n <= hi; n += step) out.add(n);
  }
  return out;
}

export function parseCron(expression: string): CronSpec {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('a schedule has five fields: minute hour day month weekday');
  const [m, h, dom, mon, dow] = fields as [string, string, string, string, string];
  const daysOfWeek = parseField(dow.replace(/7/g, '0'), 0, 6, DAYS);
  return {
    minutes: parseField(m, 0, 59),
    hours: parseField(h, 0, 23),
    daysOfMonth: parseField(dom, 1, 31),
    months: parseField(mon, 1, 12, MONTHS),
    daysOfWeek,
    domRestricted: dom !== '*',
    dowRestricted: dow !== '*',
  };
}

/** A human check for a settings form; null when the expression is fine. */
export function cronProblem(expression: string): string | null {
  try {
    parseCron(expression);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

function matches(spec: CronSpec, d: Date): boolean {
  if (!spec.minutes.has(d.getUTCMinutes())) return false;
  if (!spec.hours.has(d.getUTCHours())) return false;
  if (!spec.months.has(d.getUTCMonth() + 1)) return false;
  const dom = spec.daysOfMonth.has(d.getUTCDate());
  const dow = spec.daysOfWeek.has(d.getUTCDay());
  if (spec.domRestricted && spec.dowRestricted) return dom || dow;
  if (spec.domRestricted) return dom;
  if (spec.dowRestricted) return dow;
  return true;
}

/**
 * The first matching minute strictly after `after`, in UTC. Searches minute by
 * minute, bounded at five years so a schedule like "31 Feb" fails loudly
 * instead of looping forever.
 */
export function nextRun(expression: string | CronSpec, after: Date): Date {
  const spec = typeof expression === 'string' ? parseCron(expression) : expression;
  const cursor = new Date(after.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  const limit = after.getTime() + 5 * 366 * 86_400_000;
  while (cursor.getTime() <= limit) {
    if (matches(spec, cursor)) return new Date(cursor.getTime());
    // Skip whole hours and days that cannot match, so a yearly schedule is
    // still found in a few thousand steps rather than millions.
    if (!spec.months.has(cursor.getUTCMonth() + 1)) {
      cursor.setUTCMonth(cursor.getUTCMonth() + 1, 1);
      cursor.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!spec.hours.has(cursor.getUTCHours())) {
      cursor.setUTCHours(cursor.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  throw new Error('the schedule never comes round');
}

/** A sentence for the settings card, for the few shapes people actually use. */
export function describeCron(expression: string): string {
  try {
    const spec = parseCron(expression);
    const pad = (n: number) => String(n).padStart(2, '0');
    if (spec.minutes.size === 1 && spec.hours.size === 1 && !spec.domRestricted && spec.months.size === 12) {
      const [m] = spec.minutes; const [h] = spec.hours;
      const time = `${pad(h!)}:${pad(m!)} UTC`;
      if (!spec.dowRestricted) return `Daily at ${time}`;
      if (spec.daysOfWeek.size === 1) {
        const [d] = spec.daysOfWeek;
        return `Every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d!]} at ${time}`;
      }
    }
    if (spec.minutes.size === 1 && !spec.domRestricted && !spec.dowRestricted && spec.months.size === 12 && spec.hours.size > 1) {
      return `${spec.hours.size} times a day`;
    }
    return expression;
  } catch {
    return expression;
  }
}
