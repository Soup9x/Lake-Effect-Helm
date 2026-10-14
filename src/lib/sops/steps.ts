/**
 * Checklist templates, their published versions, and the steps a run executes.
 *
 * WHAT WAS MISSING. 0090 modelled all of this — a procedure, its editable
 * steps, immutable published versions, runs that snapshot the version they
 * executed against, and per-step execution state. Nothing in the application
 * ever touched `sop_version`, `sop_run` or `sop_run_step`: the only SOP
 * reference anywhere in src/ was the export collector reading templates, the
 * category page said in a comment that "SOPs are the one category with no
 * create path", and the integration fixture had no SOP rows at all. The model
 * was complete and unreachable.
 *
 * THIS MODULE IS THE PART THAT CAN BE TESTED WITHOUT A DATABASE: what a step
 * list may contain, what a published snapshot looks like, and how a run's steps
 * are derived from one. The routes do the writing; the shapes live here so both
 * sides agree and so a snapshot written last year can still be read.
 *
 * THE SNAPSHOT IS THE CONTRACT. `sop_run` points at a `sop_version`, and the
 * run's steps are COPIED from that version rather than referenced — 0090's
 * header explains why: "Pointing a run at a living, editable document would let
 * today's edit rewrite yesterday's evidence." So the snapshot has to stay
 * readable indefinitely, which is why it carries an explicit `version` field of
 * its own: a reader a year from now needs to know which shape it is looking at
 * before it trusts any key in it.
 */

/** The step list's bounds. A procedure, not a book. */
export const STEP_LIMITS = {
  maxSteps: 200,
  maxTitle: 200,
  maxBody: 4000,
} as const;

/**
 * A step as the authoring form holds it.
 *
 * `body` is the optional description. The other columns 0090 gives `sop_step`
 * — kind, is_optional, requires_evidence, requires_note, credential_node_id,
 * estimated_minutes — are deliberately NOT here: F1 does not offer them, and
 * offering a field the run page cannot honour is the placeholder shape this
 * plan has been removing. They keep their database defaults and are recorded
 * as deferred in docs/itg-parity.md.
 */
export interface StepDraft {
  title: string;
  /**
   * `null` and `undefined` both mean "no description".
   *
   * Both are accepted because both arrive: the database stores NULL, a form
   * sends '' for a cleared box, and a Zod `.nullable().optional()` field is
   * `string | null | undefined`. Normalising here rather than at three call
   * sites keeps the conversion in one place.
   */
  body?: string | null | undefined;
}

export interface StepIssue {
  /** Index in the submitted list, or -1 for a problem with the list itself. */
  index: number;
  message: string;
}

/**
 * Check a step list before it is stored.
 *
 * Validated HERE and bounded again by the database, which is the same trade
 * every other form in Helm makes: this layer names the offending row so the
 * editor can point at it, and the column types are what make a bad list
 * unstorable by any path.
 */
export function validateSteps(steps: readonly StepDraft[]): StepIssue[] {
  const issues: StepIssue[] = [];

  if (steps.length === 0) {
    // A template with no steps is not a checklist, and a run started from one
    // would be complete the moment it began.
    issues.push({ index: -1, message: 'A checklist needs at least one step.' });
  }
  if (steps.length > STEP_LIMITS.maxSteps) {
    issues.push({
      index: -1,
      message: `A checklist may have at most ${STEP_LIMITS.maxSteps} steps.`,
    });
  }

  steps.forEach((step, index) => {
    const title = step.title.trim();
    if (title === '') {
      issues.push({ index, message: 'A step needs a title.' });
    } else if (title.length > STEP_LIMITS.maxTitle) {
      issues.push({ index, message: `At most ${STEP_LIMITS.maxTitle} characters.` });
    }
    if ((step.body ?? '').length > STEP_LIMITS.maxBody) {
      issues.push({ index, message: `The description may be at most ${STEP_LIMITS.maxBody} characters.` });
    }
  });

  return issues;
}

/** Trimmed, blank bodies dropped, ready to store or snapshot. */
export function normaliseSteps(steps: readonly StepDraft[]): { title: string; body: string | null }[] {
  return steps.map((step) => {
    const body = (step.body ?? '').trim();
    return { title: step.title.trim(), body: body === '' ? null : body };
  });
}

/**
 * The shape stored in sop_version.snapshot.
 *
 * `version: 1` is the SNAPSHOT format's version, not the procedure's — the
 * procedure's is sop_version.version. Two different numbers with the same word
 * is a trap, so the field is named `format` where it is read back.
 */
export interface SnapshotV1 {
  format: 1;
  /** What the procedure said at publish time, for a reader with no access to the live row. */
  title: string;
  summary: string | null;
  body: string | null;
  steps: { position: number; title: string; body: string | null }[];
}

export function buildSnapshot(
  procedure: { title: string; summary: string | null; body: string | null },
  steps: readonly StepDraft[],
): SnapshotV1 {
  return {
    format: 1,
    title: procedure.title,
    summary: procedure.summary,
    body: procedure.body,
    steps: normaliseSteps(steps).map((step, index) => ({ position: index + 1, ...step })),
  };
}

/**
 * The steps a run should get, read back out of a stored snapshot.
 *
 * TOLERANT ON PURPOSE, and this is the one place in the module where that
 * matters. A snapshot is immutable and may be years old; a reader that threw on
 * an unexpected shape would make an old run unopenable, which is precisely the
 * evidence 0090 built the snapshot to preserve. So an unreadable snapshot
 * yields an empty list and the caller decides — a run with no steps is visible
 * and obviously wrong, where a 500 is neither.
 */
export function stepsFromSnapshot(snapshot: unknown): { position: number; title: string; body: string | null }[] {
  if (typeof snapshot !== 'object' || snapshot === null) return [];
  const steps = (snapshot as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return [];

  return steps.flatMap((raw, index) => {
    if (typeof raw !== 'object' || raw === null) return [];
    const step = raw as { position?: unknown; title?: unknown; body?: unknown };
    if (typeof step.title !== 'string' || step.title.trim() === '') return [];
    return [{
      // A snapshot written by this module always carries a position; falling
      // back to the array order keeps a hand-written one usable.
      position: typeof step.position === 'number' && Number.isInteger(step.position) && step.position > 0
        ? step.position
        : index + 1,
      title: step.title,
      body: typeof step.body === 'string' && step.body !== '' ? step.body : null,
    }];
  });
}

/**
 * The step states F1's run page drives.
 *
 * sop_step_status has seven values. This is the subset a technician working
 * through a list can reach: pending is where every step starts, done is the
 * check box, skipped is the check box with a reason. `blocked`, `failed`,
 * `not_applicable` and `in_progress` stay in the enum — removing them would be
 * a migration against a model that is right — and get no control until
 * something is built that means them. Deferred rather than dropped; see
 * docs/itg-parity.md.
 */
export const RUN_STEP_STATES = ['pending', 'done', 'skipped'] as const;
export type RunStepState = (typeof RUN_STEP_STATES)[number];

export function isRunStepState(value: unknown): value is RunStepState {
  return typeof value === 'string' && (RUN_STEP_STATES as readonly string[]).includes(value);
}

/**
 * Whether a run can be called complete.
 *
 * MIRRORS A CHECK CONSTRAINT RATHER THAN REPLACING IT.
 * sop_run_step_skip_needs_note already refuses a skipped mandatory step with no
 * note, so the database is the authority; this exists so the run page can
 * disable the button and say why instead of offering an action that 400s.
 *
 * A step is "settled" when it is no longer pending. Optional steps may be left
 * pending — that is what optional means — so only mandatory ones block.
 */
export function unsettledRequiredSteps(
  steps: readonly { status: string; isOptional: boolean }[],
): number {
  return steps.filter((step) => step.status === 'pending' && !step.isOptional).length;
}
