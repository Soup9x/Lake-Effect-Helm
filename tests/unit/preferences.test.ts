/**
 * The display name composed from its halves, away from a database.
 *
 * composedName() exists so the form can show what a save is about to do, and
 * this file is what keeps it honest against the trigger in 0630 that actually
 * does it. Two implementations of one rule is a cost paid deliberately — the
 * form cannot ask the database what a name would become before saving it — so
 * tests/integration/preferences.test.ts runs the same table through the real
 * UPDATE and asserts the two agree. That is the test that matters; this one
 * covers the shapes a round trip is slow to enumerate.
 *
 * THE RULE, stated once: the halves compose the name when either is present;
 * when both are absent the existing name is left alone. Clearing them says "I
 * will not maintain these", not "I have no name" — and blanking somebody's
 * display name because they emptied two optional boxes would be a surprising
 * way to lose the only label an audit row shows.
 */
import { describe, expect, it } from 'vitest';
import { composedName, isTheme, readTheme, THEMES } from '../../src/lib/ui/preferences';

describe('composing a display name', () => {
  it('joins both halves', () => {
    expect(composedName('Ada', 'Lovelace', 'old')).toBe('Ada Lovelace');
  });

  it('uses one half on its own', () => {
    // A mononym, or an IdP that sends a given name and nothing else.
    expect(composedName('Ada', null, 'old')).toBe('Ada');
    expect(composedName(null, 'Lovelace', 'old')).toBe('Lovelace');
  });

  it('leaves the existing name alone when both halves are absent', () => {
    expect(composedName(null, null, 'SMITH, J (Contractor)')).toBe('SMITH, J (Contractor)');
  });

  it('treats a whitespace-only half as absent', () => {
    // The form sends trimmed values and the route trims again, but the rule has
    // to hold for a caller that does neither — otherwise a space becomes a name.
    expect(composedName('   ', '  ', 'old')).toBe('old');
    expect(composedName('  Ada  ', '   ', 'old')).toBe('Ada');
  });

  it('trims and single-spaces the join', () => {
    expect(composedName('  Ada  ', '  Lovelace  ', null)).toBe('Ada Lovelace');
  });

  it('can leave the name null, when there was none and no halves', () => {
    // An account with neither has no display name, and the interface falls back
    // to the email address. That is not an error state to invent a value for.
    expect(composedName(null, null, null)).toBeNull();
  });

  it('does not let an empty composition win over an existing name', () => {
    // The specific regression: an early version returned '' here, which stored
    // a blank display name and rendered as an empty space in the audit log.
    expect(composedName('', '', 'Ada')).toBe('Ada');
    expect(composedName('', '', 'Ada')).not.toBe('');
  });
});

describe('the theme', () => {
  it('has exactly the three states globals.css keys off', () => {
    // A fourth would store a value no selector matches, which renders as light
    // and looks like the preference was ignored.
    expect([...THEMES]).toEqual(['system', 'light', 'dark']);
  });

  it('recognises its own values and nothing else', () => {
    for (const theme of THEMES) expect(isTheme(theme)).toBe(true);
    for (const other of ['puce', '', 'Dark', null, 7, undefined]) {
      expect(isTheme(other), `${String(other)} should not be a theme`).toBe(false);
    }
  });

  it('falls back to system for anything unreadable', () => {
    expect(readTheme('dark')).toBe('dark');
    expect(readTheme('puce')).toBe('system');
    expect(readTheme(null)).toBe('system');
    expect(readTheme(undefined)).toBe('system');
  });
});

/**
 * The script that applies the account's theme.
 *
 * ThemeSync is a server component with no hooks and no children — a pure
 * function from a theme to an element — so its output is testable directly,
 * which is unusual enough in this codebase to be worth taking advantage of.
 * Three claims in its header are assertions rather than prose:
 *
 *   * `system` emits NOTHING. There is no attribute to set, and removing one
 *     would undo the choice the root layout's script just made from
 *     localStorage.
 *   * it defers to a local choice, by checking both the attribute the first
 *     script would have set and localStorage itself.
 *   * it NEVER WRITES localStorage. Writing would turn the account default
 *     into a permanent local override on first visit, and a later change on
 *     the preferences page would never reach that browser again. This is the
 *     one that would be easy to "fix" into a bug.
 */
describe('the account theme script', () => {
  const scriptFor = async (theme: 'system' | 'light' | 'dark'): Promise<string | null> => {
    const { ThemeSync } = await import('../../src/components/theme-sync');
    const element = ThemeSync({ accountTheme: theme }) as
      { props?: { dangerouslySetInnerHTML?: { __html?: string } } } | null;
    return element?.props?.dangerouslySetInnerHTML?.__html ?? null;
  };

  it('emits nothing for system', async () => {
    expect(await scriptFor('system')).toBeNull();
  });

  it('emits a script naming the theme for light and dark', async () => {
    for (const theme of ['light', 'dark'] as const) {
      const script = await scriptFor(theme);
      expect(script, `${theme} should emit a script`).toBeTruthy();
      expect(script).toContain(`'${theme}'`);
      expect(script).toContain('setAttribute');
    }
  });

  it('defers to a choice this browser already made', async () => {
    const script = (await scriptFor('dark'))!;
    // Both checks, because either alone is insufficient: the attribute catches
    // the root script having already applied a local choice, and localStorage
    // catches a stored choice of 'system' that set no attribute.
    expect(script).toContain('hasAttribute');
    expect(script).toContain('helm.theme');
  });

  it('never writes localStorage', async () => {
    const script = (await scriptFor('dark'))!;
    expect(script, 'the account default must not become a local override')
      .not.toContain('setItem');
    expect(script).not.toContain('removeItem');
  });

  it('survives a browser that throws on localStorage', async () => {
    // A privacy configuration throws outright on access, and a theme must
    // never be why a credential vault fails to render. The fallback still
    // applies the account theme using the attribute check alone.
    const script = (await scriptFor('dark'))!;
    expect((script.match(/catch/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * UTC, and a local companion only where the reader is the subject.
 *
 * THE UTC RULE IS NOT BEING RELAXED and these tests are what says so. A shared
 * fact — an expiry date read by a technician in Buffalo, a client in Toronto
 * and an auditor somewhere else — stays unconverted, because "expires
 * 2026-03-01" meaning three different instants is how a certificate lapses on
 * a Sunday. formatDate and formatDateTime are untouched; this is a third
 * function for the case format.ts's own header already names.
 */
describe('a timestamp with the reader"s own zone beside it', () => {
  const instant = '2026-03-01T14:30:00.000Z';

  it('is plain UTC when there is no preference', async () => {
    const { formatDateTime, formatDateTimeLocal } = await import('../../src/lib/ui/format');
    expect(formatDateTimeLocal(instant, null)).toBe(formatDateTime(instant));
  });

  it('keeps the UTC half verbatim and appends the local one', async () => {
    const { formatDateTime, formatDateTimeLocal } = await import('../../src/lib/ui/format');
    const rendered = formatDateTimeLocal(instant, 'America/New_York');
    // The UTC reading is still there in full — a reader comparing two rows
    // must not have to know which one was converted.
    expect(rendered.startsWith(formatDateTime(instant))).toBe(true);
    // 14:30 UTC on 1 March is 09:30 in New York (EST, before the DST change).
    expect(rendered).toContain('09:30');
    expect(rendered).toContain('New York');
  });

  it('converts, rather than relabelling', async () => {
    const { formatDateTimeLocal } = await import('../../src/lib/ui/format');
    // Two zones, one instant, two different clock readings. A function that
    // only appended a zone name would pass a single-zone test.
    expect(formatDateTimeLocal(instant, 'Asia/Tokyo')).toContain('23:30');
    expect(formatDateTimeLocal(instant, 'Europe/London')).toContain('14:30');
  });

  it('falls back to UTC for a zone this runtime does not know', async () => {
    // Intl throws a RangeError on an unknown zone. The database refuses one on
    // write, so this is the second lock — and a preference must never be why a
    // page fails to render.
    const { formatDateTime, formatDateTimeLocal } = await import('../../src/lib/ui/format');
    expect(formatDateTimeLocal(instant, 'Mars/Olympus_Mons')).toBe(formatDateTime(instant));
  });

  it('handles a missing timestamp the same way the others do', async () => {
    const { formatDateTimeLocal } = await import('../../src/lib/ui/format');
    expect(formatDateTimeLocal(null, 'America/New_York')).toBe('—');
    expect(formatDateTimeLocal(undefined, null)).toBe('—');
  });
});
