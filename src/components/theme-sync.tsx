import { readTheme, type Theme } from '@/lib/ui/preferences';

/**
 * The account's theme, applied when this browser has no opinion of its own.
 *
 * A SERVER COMPONENT RENDERING AN INLINE SCRIPT, and the shape is copied from
 * THEME_SCRIPT in theme-toggle.tsx for the same reason that one exists: a
 * preference applied in an effect arrives after first paint, which is a white
 * flash on every navigation for somebody who chose dark — exactly the thing
 * dark mode is for. Anything deferred is already too late.
 *
 * THERE ARE NOW TWO SUCH SCRIPTS AND THEY COMPOSE. The root layout's runs
 * first, in <head>, and applies this browser's explicit choice from
 * localStorage. This one runs in the body, knows the account's preference
 * because the server resolved the session, and applies it ONLY if the first
 * script set nothing — so the precedence is local choice, then account, then
 * the operating system, which is the chain src/lib/ui/preferences.ts documents.
 *
 * IT DELIBERATELY DOES NOT WRITE localStorage. Writing would turn the account
 * default into a permanent local override on first visit, and a later change on
 * the preferences page would then never reach this browser again. Re-applying
 * from the account on every load costs nothing and keeps the account value
 * authoritative until somebody overrides it here.
 *
 * `system` emits nothing at all: there is no attribute to set, and removing one
 * would undo the choice the first script just made.
 */
export function ThemeSync({ accountTheme }: { accountTheme: Theme }) {
  const theme = readTheme(accountTheme);
  if (theme === 'system') return null;

  /*
   * The interpolation is safe by construction rather than by escaping: the
   * value is narrowed to the 'light' | 'dark' union above, both of which are
   * bare identifiers, so nothing a person can store reaches this string. The
   * column is CHECK-constrained to the same three values, which is the second
   * lock rather than the first.
   */
  const script =
    `(function(){try{if(!document.documentElement.hasAttribute('data-theme')`
    + `&&!localStorage.getItem('helm.theme')){`
    + `document.documentElement.setAttribute('data-theme','${theme}')}}catch(e){`
    // A privacy configuration that throws on localStorage still gets the
    // account's theme: the attribute check alone is enough to know the first
    // script found nothing, and a theme must never be why a vault fails to
    // render.
    + `try{if(!document.documentElement.hasAttribute('data-theme')){`
    + `document.documentElement.setAttribute('data-theme','${theme}')}}catch(e2){}}})();`;

  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
