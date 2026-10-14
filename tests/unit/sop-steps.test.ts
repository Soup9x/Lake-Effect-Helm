/**
 * Checklist templates and snapshots, away from a database.
 *
 * THE SNAPSHOT IS WHY THIS FILE MATTERS. 0090 made a run copy its steps from an
 * immutable published version rather than referencing the living template, so
 * that "today's edit cannot rewrite yesterday's evidence". That makes
 * stepsFromSnapshot() a reader of data which may be years old and which nothing
 * can migrate — sop_version is append-only by trigger. So it has to be tolerant
 * in a specific way: a shape it does not recognise must yield an empty list
 * rather than throwing, because a throw makes an old run unopenable, which
 * destroys exactly the evidence the design protects.
 */
import { describe, expect, it } from 'vitest';
import {
  buildSnapshot, isRunStepState, normaliseSteps, RUN_STEP_STATES, STEP_LIMITS,
  stepsFromSnapshot, unsettledRequiredSteps, validateSteps,
} from '../../src/lib/sops/steps';

describe('validating a step list', () => {
  it('accepts an ordinary list', () => {
    expect(validateSteps([{ title: 'Disable the account' }, { title: 'Forward the mailbox' }]))
      .toEqual([]);
  });

  it('refuses an empty list, with the complaint on the list rather than a row', () => {
    // index -1 is how the editor knows to show this above the rows instead of
    // beside one of them.
    const issues = validateSteps([]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.index).toBe(-1);
  });

  it('names the offending row for a blank title', () => {
    const issues = validateSteps([{ title: 'Fine' }, { title: '   ' }, { title: 'Also fine' }]);
    expect(issues.map((i) => i.index)).toEqual([1]);
  });

  it('refuses a title over the limit but not one at it', () => {
    expect(validateSteps([{ title: 'a'.repeat(STEP_LIMITS.maxTitle) }])).toEqual([]);
    expect(validateSteps([{ title: 'a'.repeat(STEP_LIMITS.maxTitle + 1) }])).toHaveLength(1);
  });

  it('refuses a body over the limit', () => {
    expect(validateSteps([{ title: 'x', body: 'a'.repeat(STEP_LIMITS.maxBody + 1) }]))
      .toHaveLength(1);
  });

  it('refuses a list longer than the ceiling', () => {
    const many = Array.from({ length: STEP_LIMITS.maxSteps + 1 }, (_, i) => ({ title: `s${i}` }));
    expect(validateSteps(many).some((i) => i.index === -1)).toBe(true);
  });
});

describe('normalising steps', () => {
  it('trims, and turns a blank body into null', () => {
    expect(normaliseSteps([{ title: '  Do it  ', body: '   ' }]))
      .toEqual([{ title: 'Do it', body: null }]);
  });

  it('treats a null body and an absent one the same way', () => {
    expect(normaliseSteps([{ title: 'a', body: null }, { title: 'b' }]))
      .toEqual([{ title: 'a', body: null }, { title: 'b', body: null }]);
  });

  it('keeps a real body, trimmed', () => {
    expect(normaliseSteps([{ title: 'a', body: '  why  ' }]))
      .toEqual([{ title: 'a', body: 'why' }]);
  });
});

describe('building a snapshot', () => {
  const procedure = { title: 'Offboard', summary: 'When somebody leaves', body: null };

  it('numbers the steps from one, in order', () => {
    const snapshot = buildSnapshot(procedure, [{ title: 'a' }, { title: 'b' }, { title: 'c' }]);
    expect(snapshot.steps.map((s) => s.position)).toEqual([1, 2, 3]);
    expect(snapshot.steps.map((s) => s.title)).toEqual(['a', 'b', 'c']);
  });

  it('carries the procedure"s own text, so an old version is readable alone', () => {
    // A reader of a five-year-old run should not have to resolve the live
    // procedure — which may have been renamed, or deleted — to know what was
    // being followed.
    const snapshot = buildSnapshot(procedure, [{ title: 'a' }]);
    expect(snapshot.title).toBe('Offboard');
    expect(snapshot.summary).toBe('When somebody leaves');
  });

  it('declares its own format version', () => {
    // Not the procedure's version — that is sop_version.version. This says
    // which SHAPE a future reader is looking at before it trusts any key.
    expect(buildSnapshot(procedure, [{ title: 'a' }]).format).toBe(1);
  });

  it('round-trips through stepsFromSnapshot', () => {
    const steps = [{ title: 'a', body: 'why' }, { title: 'b' }];
    expect(stepsFromSnapshot(buildSnapshot(procedure, steps)))
      .toEqual([{ position: 1, title: 'a', body: 'why' }, { position: 2, title: 'b', body: null }]);
  });
});

describe('reading a snapshot back', () => {
  it('yields nothing for a shape it does not understand, rather than throwing', () => {
    // The property that keeps an old run openable. Every one of these would be
    // a 500 on a run page if this threw.
    for (const bad of [null, undefined, 7, 'steps', [], {}, { steps: 'no' }, { steps: {} }]) {
      expect(() => stepsFromSnapshot(bad)).not.toThrow();
      expect(stepsFromSnapshot(bad), `${JSON.stringify(bad)} should yield []`).toEqual([]);
    }
  });

  it('skips an unusable step but keeps the rest', () => {
    const steps = stepsFromSnapshot({
      format: 1,
      steps: [
        { position: 1, title: 'good' },
        { position: 2 },
        null,
        { position: 3, title: '   ' },
        { position: 4, title: 'also good' },
      ],
    });
    expect(steps.map((s) => s.title)).toEqual(['good', 'also good']);
  });

  it('falls back to array order when a position is missing or absurd', () => {
    const steps = stepsFromSnapshot({
      steps: [{ title: 'a' }, { title: 'b', position: 0 }, { title: 'c', position: -3 }],
    });
    expect(steps.map((s) => s.position)).toEqual([1, 2, 3]);
  });

  it('honours a stated position, because that is what was published', () => {
    const steps = stepsFromSnapshot({ steps: [{ title: 'a', position: 7 }] });
    expect(steps[0]!.position).toBe(7);
  });
});

describe('the step states the run page drives', () => {
  it('is exactly the three a person can reach', () => {
    // sop_step_status has seven. The other four stay in the enum with no
    // control until something is built that means them — see the module header.
    expect([...RUN_STEP_STATES]).toEqual(['pending', 'done', 'skipped']);
  });

  it('refuses a state the UI has no control for', () => {
    for (const state of RUN_STEP_STATES) expect(isRunStepState(state)).toBe(true);
    for (const other of ['blocked', 'failed', 'not_applicable', 'in_progress', '', null]) {
      expect(isRunStepState(other), `${String(other)} should not be drivable`).toBe(false);
    }
  });
});

describe('what is left to do', () => {
  it('counts pending required steps and no others', () => {
    expect(unsettledRequiredSteps([
      { status: 'pending', isOptional: false },
      { status: 'pending', isOptional: true },
      { status: 'done', isOptional: false },
      { status: 'skipped', isOptional: false },
    ])).toBe(1);
  });

  it('is zero when only optional steps are pending', () => {
    // That is what optional means, and it is why the complete button is not
    // gated on every step being touched.
    expect(unsettledRequiredSteps([
      { status: 'pending', isOptional: true },
      { status: 'done', isOptional: false },
    ])).toBe(0);
  });

  it('counts a skipped step as settled, because somebody decided about it', () => {
    expect(unsettledRequiredSteps([{ status: 'skipped', isOptional: false }])).toBe(0);
  });

  it('is zero for an empty run', () => {
    expect(unsettledRequiredSteps([])).toBe(0);
  });
});
