/**
 * The account-level preferences, and the one rule that decides which wins.
 *
 * THEME HAS TWO HOMES ON PURPOSE, which needs explaining because two sources of
 * truth is normally a smell.
 *
 * ThemeToggle has stored the choice in localStorage since the theme was built,
 * and its header argued against ever putting it on the server: "it is a
 * per-browser preference, not a fact about the account, and a technician using
 * a bright workshop machine and a dark laptop wants different answers on each.
 * It also means changing it costs no request and cannot fail." Every word of
 * that is still true and none of it is being undone.
 *
 * What it does not give you is the thing the parity list asks for: sign in on a
 * new machine and Helm is light again, every time, forever. So the account
 * value is a DEFAULT and the local choice is an OVERRIDE:
 *
 *   1. this browser's explicit choice      localStorage
 *   2. this account's preference           app_user.theme
 *   3. the operating system                prefers-color-scheme
 *
 * That is the same precedence globals.css already uses one level down — "an
 * explicit choice always wins, and the system preference applies only when no
 * explicit choice has been made" — so it is one chain with three links rather
 * than a new idea. A local override still costs no request and still cannot
 * fail; what changed is only what happens when there is nothing local to read.
 *
 * TIME ZONE IS SIMPLER: one home, the account, and NULL means no preference.
 * The interface keeps rendering UTC with an explicit suffix either way — see
 * src/lib/ui/format.ts for why that is not negotiable for a shared fact like an
 * expiry date. A zone is for the places that show a reader's own local time
 * beside it.
 */

/** The three states globals.css keys off. `system` is an answer, not an absence. */
export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

/** Read a stored theme, tolerating anything. A bad value is "system". */
export function readTheme(stored: unknown): Theme {
  return isTheme(stored) ? stored : 'system';
}

export interface AccountPreferences {
  /** The display name — composed from the halves when they are set. */
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  /** An IANA zone name, or null for "render UTC and say so". */
  timezone: string | null;
  theme: Theme;
}

/**
 * What the display name will be after a save.
 *
 * ONE DEFINITION, used by the form to show what it is about to do and by the
 * tests to pin it against what the database trigger actually does. The trigger
 * in 0630 is the authority — this exists so the form does not have to guess,
 * and so a change to one side fails a test rather than quietly disagreeing.
 *
 * The rule: the halves compose the name when either is present; when both are
 * absent the existing name is left alone, because clearing them says "I will
 * not maintain these", not "I have no name".
 */
export function composedName(
  firstName: string | null,
  lastName: string | null,
  existing: string | null,
): string | null {
  const composed = [firstName, lastName]
    .map((part) => (part ?? '').trim())
    .filter((part) => part !== '')
    .join(' ');
  return composed === '' ? existing : composed;
}
