/**
 * The retry rule, without a browser.
 *
 * This is the logic that turns "re-authenticate, then try again" from advice
 * into behaviour, and every clause of it is a decision that can regress
 * silently — a prompt that opens on the wrong refusal, a retry that loops, a
 * cancel that reports the wrong reason. The components are thin wrappers over
 * this; the rule is tested here.
 */
import { describe, expect, it, vi } from 'vitest';
import { STEP_UP_CODE, withStepUp } from '../../src/lib/ui/step-up';

const refused = (code: string) => ({ ok: false as const, status: 403, code, message: `refused: ${code}` });
const granted = <T,>(value: T) => ({ ok: true as const, status: 200, value });

describe('withStepUp', () => {
  it('never prompts when the action succeeds', async () => {
    const attempt = vi.fn().mockResolvedValue(granted('plaintext'));
    const prompt = vi.fn().mockResolvedValue(true);

    const result = await withStepUp(attempt, prompt);

    expect(result).toEqual(granted('plaintext'));
    expect(prompt).not.toHaveBeenCalled();
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('prompts and retries once on step_up_required', async () => {
    const attempt = vi
      .fn()
      .mockResolvedValueOnce(refused(STEP_UP_CODE))
      .mockResolvedValueOnce(granted('plaintext'));
    const prompt = vi.fn().mockResolvedValue(true);

    const result = await withStepUp(attempt, prompt);

    expect(result).toEqual(granted('plaintext'));
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('does NOT prompt for a refusal a password cannot clear', async () => {
    // A rank too low needs somebody else to act. Offering a password box says
    // "this is yours to fix", which it is not.
    for (const code of ['forbidden', 'not_found', 'reason_required', 'rate_limited']) {
      const attempt = vi.fn().mockResolvedValue(refused(code));
      const prompt = vi.fn().mockResolvedValue(true);

      const result = await withStepUp(attempt, prompt);

      expect(result).toEqual(refused(code));
      expect(prompt).not.toHaveBeenCalled();
      expect(attempt).toHaveBeenCalledTimes(1);
    }
  });

  it('returns the ORIGINAL refusal when the prompt is dismissed', async () => {
    // Not a synthetic "you cancelled": the person asked to see a credential and
    // did not, and the reason on screen should stay the server's.
    const attempt = vi.fn().mockResolvedValue(refused(STEP_UP_CODE));
    const prompt = vi.fn().mockResolvedValue(false);

    const result = await withStepUp(attempt, prompt);

    expect(result).toEqual(refused(STEP_UP_CODE));
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('stops after one retry even if the second attempt is refused the same way', async () => {
    // The loop this prevents: a verification that expires between the two calls,
    // or a clock skew, would otherwise re-open the prompt forever.
    const attempt = vi.fn().mockResolvedValue(refused(STEP_UP_CODE));
    const prompt = vi.fn().mockResolvedValue(true);

    const result = await withStepUp(attempt, prompt);

    expect(result).toEqual(refused(STEP_UP_CODE));
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});
