import { describe, expect, it } from 'vitest';

/**
 * The column choice stores what is HIDDEN, not what is shown, and that is the
 * decision worth a test: a column added to the product later has to appear for
 * everybody, including the people who saved a choice before it existed.
 *
 * The hook itself needs a DOM and a browser storage, so this tests the rule it
 * encodes rather than the React wiring — which the browser pass exercises.
 */
function visibleColumns(all: readonly string[], hidden: readonly string[]): string[] {
  const set = new Set(hidden);
  return all.filter((c) => !set.has(c));
}

describe('storing what is hidden rather than what is shown', () => {
  it('shows a newly added column to somebody who saved a choice before it existed', () => {
    // Saved when the grid had four columns and they hid one.
    const savedHidden = ['updated'];
    // The product later gains a fifth.
    const now = ['name', 'secondary', 'type', 'updated', 'updatedBy'];

    expect(visibleColumns(now, savedHidden)).toEqual(['name', 'secondary', 'type', 'updatedBy']);
  });

  it('would have hidden it, had the choice stored what was shown', () => {
    // The inverse, as a demonstration of the bug this avoids.
    const savedShown = ['name', 'secondary', 'type'];
    const now = ['name', 'secondary', 'type', 'updated', 'updatedBy'];
    const wrong = now.filter((c) => savedShown.includes(c));
    expect(wrong).not.toContain('updatedBy');
  });

  it('keeps every column when nothing is hidden', () => {
    const all = ['name', 'type'];
    expect(visibleColumns(all, [])).toEqual(all);
  });
});
