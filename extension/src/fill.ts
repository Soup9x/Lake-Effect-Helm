/**
 * Filling a sign-in form in the tab the popup opened on.
 *
 * WHERE IT RUNS. `formInPage` is handed to chrome.scripting.executeScript,
 * which sends its source, not its closure: it must stay self-contained. It
 * runs in the extension's isolated world, so the page's own script never sees
 * the values passed to it, only what ends up in the form's fields.
 *
 * WHICH FRAMES. activeTab, granted by opening the popup, reaches the tab's own
 * origin and nothing else, so a login form in a frame from another site is
 * never filled. The popup also fills only the frame whose host is the tab's,
 * and pins it by document id so a navigation in between fills nothing.
 *
 * TWO-STEP SIGN-INS. Microsoft's, Google's and many others ask for the
 * username on one screen and the password on the next. Each click fills what
 * is on screen now: the username, then the password, then a one-time code.
 * A username alone needs nothing from Helm; a password or code is revealed
 * only once a field for it has been found.
 */

export interface FillValues {
  username?: string;
  password?: string;
  code?: string;
}

/** What one frame holds, or, after a fill, how many fields were written. */
export interface FormProbe {
  host: string;
  username: boolean;
  password: boolean;
  code: boolean;
  filled: number;
}

/**
 * With null, look; with values, fill. One function rather than two, so the
 * fields filled are certainly the fields found.
 */
export function formInPage(values: FillValues | null): FormProbe {
  const shown = (input: HTMLInputElement) =>
    !input.disabled && !input.readOnly && input.getClientRects().length > 0
    && getComputedStyle(input).visibility !== 'hidden';
  const inputs = Array.from(document.querySelectorAll('input')).filter(shown);
  const textual = (input: HTMLInputElement) => ['text', 'email', 'tel'].includes(input.type);
  const hints = (input: HTMLInputElement) =>
    `${input.name} ${input.id} ${input.placeholder} ${input.getAttribute('aria-label') ?? ''}`;
  const isCode = (input: HTMLInputElement) =>
    input.autocomplete === 'one-time-code'
    || /\b(otp|totp|mfa|2fa|one.?time|verification.?code|auth.?code|security.?code)\b/i.test(hints(input));

  // A sign-up or change-password form's new password is not this one.
  const password = inputs.find((i) => i.type === 'password' && !i.autocomplete.includes('new-password')) ?? null;
  const before = (password ? inputs.slice(0, inputs.indexOf(password)) : inputs)
    .filter((i) => textual(i) && !isCode(i));
  const named = (i: HTMLInputElement) =>
    /\b(username|email)\b/.test(i.autocomplete)
    || i.type === 'email'
    || /user|e-?mail|login|account|identifier/i.test(hints(i));
  // Beside a password, the text field just before it is the username even
  // unnamed. Without one, only a field that says so is: a page's own search
  // box is not a username.
  const username = before.find(named) ?? (password ? before.at(-1) : undefined) ?? null;
  const code = password ? null : inputs.find((i) => (textual(i) || i.type === 'number') && isCode(i)) ?? null;

  let filled = 0;
  const write = (input: HTMLInputElement | null, value: string | undefined) => {
    if (!input || value === undefined) return;
    input.focus();
    // Through the prototype's setter, so a framework that tracks the
    // element's own value property (React does) notices the change.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    filled += 1;
  };
  if (values) {
    write(username, values.username);
    write(password, values.password);
    write(code, values.code);
    (password ?? code ?? username)?.focus();
  }

  return { host: location.host, username: username !== null, password: password !== null, code: code !== null, filled };
}
