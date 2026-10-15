/**
 * "Try, prompt for a re-authentication, try once more."
 *
 * WHY THIS IS A MODULE AND NOT THREE COPIES. Three places in the interface run
 * an action the database may refuse pending a step-up — revealing a credential,
 * rotating one, and creating a `critical` one. Each of them had its own
 * hand-rolled handling of the refusal, and all three handled it by printing
 * advice ("re-authenticate, then try again") that nothing in the product could
 * carry out. Putting the sequence in one place means the retry rule is written
 * down once, and can be tested without a DOM.
 *
 * THE RULE, and every clause of it is a decision:
 *
 *   The prompt only opens for `step_up_required`. Any other refusal — a rank
 *   too low, a missing permission — is returned untouched, because a password
 *   box cannot help and showing one implies it can.
 *
 *   Exactly ONE retry. If the second attempt is refused for the same reason,
 *   that answer is final. Looping would turn a server-side disagreement (a
 *   clock skew, a verification that expired between the two calls) into a
 *   prompt the person cannot escape.
 *
 *   A cancelled prompt returns the ORIGINAL refusal, not a synthetic "you
 *   cancelled". The person asked to see a credential and did not see it; the
 *   reason on screen should stay the reason the server gave.
 *
 *   The retry re-runs the WHOLE attempt rather than replaying a stored request.
 *   The step-up is a row the database reads when the next request opens its
 *   session context, so the retry has to be a genuinely new request — and any
 *   field the person edited while the prompt was open goes with it.
 */

import type { ApiResult } from './api';

/** The code the API returns when a re-authentication would clear the refusal. */
export const STEP_UP_CODE = 'step_up_required';

/**
 * What an attempt comes back as. The same shape api.ts gives every call, so a
 * component's `() => apiFetch(...)` is an attempt as it stands.
 */
export type AttemptResult<T> = ApiResult<T>;

/**
 * Run `attempt`; if it is refused pending a step-up, run `prompt` and try once
 * more.
 *
 * `prompt` resolves true when the person completed a re-authentication and
 * false when they dismissed it or it failed — the dialog owns that decision and
 * its own error rendering, because "that password is not correct" belongs
 * beside the password box and not beside the credential.
 */
export async function withStepUp<T>(
  attempt: () => Promise<AttemptResult<T>>,
  prompt: () => Promise<boolean>,
): Promise<AttemptResult<T>> {
  const first = await attempt();
  if (first.ok || first.code !== STEP_UP_CODE) return first;

  const verified = await prompt();
  if (!verified) return first;

  return attempt();
}
