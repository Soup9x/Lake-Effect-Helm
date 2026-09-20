/**
 * The move, which both the drag handler and the arrow buttons perform.
 *
 * Off-by-one in a reorder is the kind of bug that looks like the interface
 * "feeling wrong" rather than like a defect: the item lands one place too far,
 * but only when moving in one direction, because the target index was computed
 * against the array before the item was removed from it.
 */
import { describe, expect, it } from 'vitest';
import { reorder } from '../../src/lib/workspace/widgets';

const L = ['a', 'b', 'c', 'd'] as const;

describe('reorder', () => {
  it('moves an item forwards to exactly the index asked for', () => {
    expect(reorder(L, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves an item backwards to exactly the index asked for', () => {
    // The direction that breaks when the target is computed pre-removal.
    expect(reorder(L, 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('is symmetric: moving there and back returns the original', () => {
    expect(reorder(reorder(L, 0, 3), 3, 0)).toEqual([...L]);
  });

  it('treats a one-step move the same as an arrow press', () => {
    expect(reorder(L, 1, 2)).toEqual(['a', 'c', 'b', 'd']);
    expect(reorder(L, 2, 1)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('handles the ends without wrapping', () => {
    expect(reorder(L, 0, 3)).toEqual(['b', 'c', 'd', 'a']);
    expect(reorder(L, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('returns the list unchanged for a move that goes nowhere', () => {
    expect(reorder(L, 2, 2)).toEqual([...L]);
  });

  it('returns the list unchanged for an index off the end', () => {
    // A drag released outside the list, and an arrow pressed on the last item.
    expect(reorder(L, 0, 9)).toEqual([...L]);
    expect(reorder(L, -1, 1)).toEqual([...L]);
    expect(reorder(L, 3, 4)).toEqual([...L]);
  });

  it('does not mutate its input', () => {
    const original = [...L];
    reorder(original, 0, 3);
    expect(original).toEqual([...L]);
  });
});
