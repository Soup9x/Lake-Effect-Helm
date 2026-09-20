/**
 * Putting a value on the clipboard, and refusing to put anything else there.
 *
 * WHY THIS IS A MODULE AND NOT A ONE-LINER AT THE CALL SITE.
 *
 * The reveal button copied the word `undefined` for as long as it had existed.
 * It POSTed to /api/secrets/:id/copy — a route that records a copy EVENT and
 * deliberately decrypts nothing — and then wrote `body.value` from the reply.
 * There is no `value` in that reply. Every copy put nine characters on the
 * clipboard and the interface said "Copied" underneath, so the failure looked
 * exactly like a success until somebody pasted.
 *
 * Two things let that survive. `navigator.clipboard.writeText` takes a
 * DOMString, so `undefined` is COERCED rather than rejected — there is no
 * runtime error to notice. And the response was read through
 * `as { value: string }`, an assertion that silences the one check which would
 * have caught it. A cast is not a parse.
 *
 * So the rule lives here instead: a value that is not a non-empty string is a
 * FAILURE, not something to stringify. And the two halves of an audited copy —
 * record the event, then write the text — are sequenced once, rather than in
 * each component that grows a copy button.
 *
 * ORDER, and each step is a decision:
 *
 *   The value is checked FIRST, so a copy that cannot happen does not leave an
 *   audit row claiming it did.
 *
 *   The recording happens BEFORE the write. If it fails, nothing is copied:
 *   an unaudited copy of a client credential is the case this product exists
 *   to prevent, and a button that does nothing is the better failure.
 *
 *   A write that throws AFTER a successful recording leaves the audit log
 *   saying a copy happened when it did not. That asymmetry is deliberate. The
 *   log may overstate what left the building; it must never understate it.
 */

export type CopyOutcome =
  /** On the clipboard, and recorded. */
  | 'copied'
  /** Nothing to copy: the caller held no value. Nothing was recorded. */
  | 'nothing-to-copy'
  /** The audit call failed or was refused, so the write never ran. */
  | 'not-recorded'
  /** Recorded, but the browser would not give up the clipboard. */
  | 'clipboard-refused';

/** What the browser offers, injectable so this is testable without a DOM. */
export type ClipboardWriter = (text: string) => Promise<void>;

const browserClipboard: ClipboardWriter = (text) => navigator.clipboard.writeText(text);

/**
 * Record a copy, then copy.
 *
 * `value` is typed `unknown` ON PURPOSE. The defect this replaces came from a
 * value the types promised was a string and was not, so the check has to be a
 * real one at runtime; a `string` parameter would just move the same assertion
 * up one line.
 *
 * `record` returns whether the event was written. It is called inside the try,
 * so a caller can hand over a bare `fetch` without wrapping it.
 */
export async function copyAudited({
  value,
  record,
  write = browserClipboard,
}: {
  value: unknown;
  record: () => Promise<boolean>;
  write?: ClipboardWriter;
}): Promise<CopyOutcome> {
  if (typeof value !== 'string' || value.length === 0) return 'nothing-to-copy';

  let recorded: boolean;
  try {
    recorded = await record();
  } catch {
    // A network failure is not a recorded copy.
    return 'not-recorded';
  }
  if (!recorded) return 'not-recorded';

  try {
    await write(value);
  } catch {
    // Permission refused, an insecure origin, or a browser that hides the
    // clipboard from a background tab. The reveal itself still worked.
    return 'clipboard-refused';
  }

  return 'copied';
}

/**
 * A copy with nothing to record — a redirect URI, an endpoint, an id.
 *
 * Same guard, no audit step. Routed through copyAudited rather than calling
 * `writeText` directly so there is ONE place in the product that decides what
 * is allowed onto a clipboard; an unguarded second call site is how the first
 * one went unnoticed.
 */
export function copyUnaudited(
  value: unknown,
  write: ClipboardWriter = browserClipboard,
): Promise<CopyOutcome> {
  return copyAudited({ value, record: async () => true, write });
}

/** What to put on screen after a copy. `copied` renders its own success line. */
export function copyFailureMessage(outcome: CopyOutcome): string | null {
  switch (outcome) {
    case 'copied':
      return null;
    case 'nothing-to-copy':
      return 'Nothing to copy — reveal the value first.';
    case 'not-recorded':
      return 'Not copied: the copy could not be recorded in the audit log.';
    case 'clipboard-refused':
      return 'Your browser refused clipboard access. Select the value and copy it manually.';
  }
}
