/**
 * What the health badge says, in words.
 *
 * The badge is a coloured dot, and a coloured dot alone is unusable to anybody
 * who cannot distinguish the three colours — so the sentence below IS the
 * control for those readers, and it is also what everybody else gets on hover.
 * A sentence that reads "At risk . : *.acme.test" is not a smaller problem than
 * a wrong colour; it is the same problem.
 */
import { describe, expect, it } from 'vitest';
import { healthExplanation } from '../../src/components/ui/health-dot';

const green = { health: 'green', expiredCount: 0, criticalCount: 0, warningCount: 0, reasons: null };

describe('the health explanation', () => {
  it('says nothing is wrong when nothing is', () => {
    expect(healthExplanation(green)).toBe('Nothing tracked is expiring.');
  });

  it('counts what is wrong and then names it', () => {
    expect(
      healthExplanation({
        health: 'red',
        expiredCount: 1,
        criticalCount: 2,
        warningCount: 0,
        reasons: ['*.acme.test', 'acme.test'],
      }),
    ).toBe('1 expired, 2 critical: *.acme.test, acme.test');
  });

  it('omits a zero rather than saying "0 expired"', () => {
    expect(healthExplanation({ ...green, health: 'amber', warningCount: 3, reasons: null })).toBe(
      '3 expiring soon',
    );
  });

  it('NEVER leaves a dangling separator when the counts are all zero', () => {
    // The regression. The favourites widget passed zeros with real reasons and
    // the sentence came out as ": *.acme.test" — a colon separating nothing
    // from something.
    const sentence = healthExplanation({
      health: 'red',
      expiredCount: 0,
      criticalCount: 0,
      warningCount: 0,
      reasons: ['*.acme.test'],
    });
    expect(sentence.trim()).not.toMatch(/^[:,]/);
    expect(sentence).toBe('*.acme.test');
  });

  it('...and says something true when it has neither half', () => {
    expect(
      healthExplanation({ ...green, health: 'red', reasons: null }),
    ).toBe('Something tracked needs attention.');
  });
});
