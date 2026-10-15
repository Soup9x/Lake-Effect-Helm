/**
 * The windows documentation health is measured against.
 *
 * MIRRORS THE DATABASE, AND A TEST ASSERTS IT. `helm.default_health_days()`
 * holds the 180 that decision 3 chose, and `documentation_health_setting`'s
 * column defaults and `v_documentation_health`'s coalesce both call it — so
 * there is one literal in SQL. This file is the second copy, which exists
 * because a form needs the number before it has asked the database anything,
 * and `tests/unit/health-window.test.ts` fails if the two stop agreeing.
 *
 * That construction is D's: `SIDEBAR_SLUGS` against
 * `helm.sidebar_layout_valid()`, with the test that stops a list being
 * extended in one place only.
 *
 * TWO WINDOWS, NOT ONE, because they measure different things. An MSP may
 * reasonably consider a year acceptable for a record to go unrevised while
 * wanting to know about anything nobody has opened in a quarter. Both default
 * to the same number so a tenant that never touches this gets decision 3's
 * answer for both.
 */

/** Decision 3's number. Must equal `helm.default_health_days()`. */
export const DEFAULT_HEALTH_DAYS = 180;

/**
 * A day is the smallest window that is not a stopwatch; ten years is past the
 * point where "stale" means anything. Must equal the CHECK constraints on
 * `documentation_health_setting`.
 */
export const HEALTH_DAYS_MIN = 1;
export const HEALTH_DAYS_MAX = 3650;

export interface HealthSetting {
  staleAfterDays: number;
  unviewedAfterDays: number;
  /** Whether a row exists, as opposed to these being the shipped defaults. */
  configured: boolean;
}

export const HEALTH_DEFAULTS: HealthSetting = {
  staleAfterDays: DEFAULT_HEALTH_DAYS,
  unviewedAfterDays: DEFAULT_HEALTH_DAYS,
  configured: false,
};

/**
 * The three segments, as counts and never as a score.
 *
 * Decision 20's rule, carried from G: Helm can see what has been documented,
 * not what exists, and a blended percentage is an invented weighting pretending
 * to be a judgement. Each of these is a sentence that is either true or false
 * about a client, and the ring draws them in proportion without naming a total
 * out of a hundred.
 */
export interface DocumentationHealth {
  total: number;
  /** Revised inside the window. */
  current: number;
  /** Revised, but longer ago than the window. */
  stale: number;
  /** Created before the window and never revised since. */
  neverRevised: number;
  /** Not opened by anyone inside the window. Beside the ring, not in it. */
  unviewed: number;
  lastRevisedAt: string | null;
  lastViewedAt: string | null;
  staleAfterDays: number;
  unviewedAfterDays: number;
}

/**
 * Whether the three ring segments still account for every record.
 *
 * Not defensive programming: the segments are three independent SQL FILTER
 * clauses, and "they partition the total" is the kind of property that is true
 * when written and false after somebody edits one of them. The page calls this
 * and renders the honest thing if it ever fails, rather than drawing a ring
 * with a gap in it and letting a reader infer a meaning from the gap.
 */
export function segmentsAccountForAll(health: DocumentationHealth): boolean {
  return health.current + health.stale + health.neverRevised === health.total;
}

/**
 * What to say about a client's documentation in one line.
 *
 * Written here rather than in the component because it is the sentence people
 * will quote at each other, and a sentence worth getting right is worth
 * testing. Leads with the actionable segment rather than the reassuring one:
 * "nothing needs attention" is only said when that is true.
 */
export function healthSummary(health: DocumentationHealth): string {
  if (health.total === 0) return 'Nothing is documented for this client yet.';

  const needsAttention = health.stale + health.neverRevised;
  if (needsAttention === 0) {
    return `All ${health.total} records were revised in the last ${health.staleAfterDays} days.`;
  }

  const parts: string[] = [];
  if (health.neverRevised > 0) {
    parts.push(`${health.neverRevised} never revised since being created`);
  }
  if (health.stale > 0) {
    parts.push(`${health.stale} not revised in ${health.staleAfterDays} days`);
  }
  return `${needsAttention} of ${health.total} records need a look: ${parts.join(', ')}.`;
}
