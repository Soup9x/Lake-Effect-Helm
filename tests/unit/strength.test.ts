/**
 * The strength badge's threshold.
 *
 * Worth its own file because the bug it encodes was invisible by inspection:
 * two pages compared a 0-4 band against 50, so every credential in the product
 * — including one scoring the maximum 4 — rendered "Weak". The assertions below
 * are written against the range the database actually permits, so a future
 * change to either end fails here.
 */
import { describe, expect, it } from 'vitest';
import { scoreStrength } from '../../src/lib/crypto/blind-index';
import {
  isWeakStrength,
  strengthLabel,
  STRENGTH_MAX,
  STRENGTH_MIN,
} from '../../src/lib/ui/strength';

describe('isWeakStrength', () => {
  it('does NOT flag the top of the scale — the whole bug', () => {
    // 4 < 50 was true, and so was every other value the column can hold.
    expect(isWeakStrength(4)).toBe(false);
    expect(isWeakStrength(3)).toBe(false);
    expect(isWeakStrength(2)).toBe(false);
  });

  it('flags the bottom two bands', () => {
    expect(isWeakStrength(0)).toBe(true);
    expect(isWeakStrength(1)).toBe(true);
  });

  it('says nothing when there is no score', () => {
    // A secret written before the column existed, or one whose version row
    // carries NULL. Absence of a measurement is not a weak measurement.
    expect(isWeakStrength(null)).toBe(false);
    expect(isWeakStrength(undefined)).toBe(false);
  });

  it('never flags a score the scorer can actually produce as maximal', () => {
    // Ties the badge to the scorer rather than to a number somebody typed.
    // If scoreStrength's range ever widens, this fails instead of silently
    // badging the new top band.
    const strongest = scoreStrength('9Xq#2vLm!7Rt$4Wz&Pd');
    expect(strongest).toBe(STRENGTH_MAX);
    expect(isWeakStrength(strongest)).toBe(false);
  });

  it('flags what the scorer calls the floor', () => {
    const weakest = scoreStrength('abc');
    expect(weakest).toBe(STRENGTH_MIN);
    expect(isWeakStrength(weakest)).toBe(true);
  });
});

describe('strengthLabel', () => {
  it('names every band, so a bare integer is never shown', () => {
    expect(strengthLabel(0)).toBe('Very weak');
    expect(strengthLabel(1)).toBe('Weak');
    expect(strengthLabel(2)).toBe('Fair');
    expect(strengthLabel(3)).toBe('Strong');
    expect(strengthLabel(4)).toBe('Very strong');
  });

  it('returns nothing rather than a label when unscored', () => {
    expect(strengthLabel(null)).toBeNull();
  });

  it('clamps a value outside the range instead of rendering undefined', () => {
    // The CHECK constraint makes this unreachable through the database, which
    // is exactly why it would be a surprise if it ever arrived.
    expect(strengthLabel(99)).toBe('Very strong');
    expect(strengthLabel(-3)).toBe('Very weak');
  });
});

describe('scoreStrength, as the badge reads it', () => {
  it('rates a long passphrase above the weak bands', () => {
    // The reported symptom: a password the user considers strong, called weak.
    // The scorer never thought so — the comparison did.
    expect(isWeakStrength(scoreStrength('correct horse battery staple'))).toBe(false);
    expect(isWeakStrength(scoreStrength('Tr0ub4dor&3xK'))).toBe(false);
    expect(isWeakStrength(scoreStrength('a-very-long-generated-passphrase'))).toBe(false);
  });

  it('still rates genuinely poor material as weak', () => {
    expect(isWeakStrength(scoreStrength('hunter2'))).toBe(true);
    expect(isWeakStrength(scoreStrength('aaaaaaaa'))).toBe(true);
    expect(isWeakStrength(scoreStrength('abc123'))).toBe(true);
  });
});
