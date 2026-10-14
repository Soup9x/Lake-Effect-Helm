/**
 * The drawer's arrangement, away from a database.
 *
 * Three properties, and each one has a failure mode that would be quiet:
 *
 *   1. THE DEFAULT IS TODAY'S DRAWER. `secondary` stopped being the only answer
 *      and kept being the first one. If DEFAULT_SIDEBAR drifted from the flag,
 *      every existing user's drawer would rearrange itself on deploy — and
 *      nothing else in the system would notice, because every layout it could
 *      produce is valid.
 *   2. A RETIRED CATEGORY IS DROPPED, not rendered as a dead link. The CHECK
 *      constraint means a stored layout was valid when it was written; it says
 *      nothing about a slug removed from the registry afterwards.
 *   3. THE SPLIT LOSES NOTHING. Every category is either in the primary list or
 *      under "More". A category that fell out of both would be unreachable with
 *      no error anywhere — the worst shape this bug could take, because the
 *      records are still there and the only symptom is a person who cannot find
 *      them.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ORG_CATEGORIES } from '../../src/lib/nav/org-categories';
import {
  DEFAULT_SIDEBAR, SIDEBAR_MAX, SIDEBAR_SLUGS, isSidebarSlug, readSidebar, splitSidebar,
} from '../../src/lib/nav/sidebar-layout';

describe('the slug list', () => {
  it('is the registry, not a second hand-written copy', () => {
    expect([...SIDEBAR_SLUGS]).toEqual(ORG_CATEGORIES.map((c) => c.slug));
  });

  it('holds every category exactly once', () => {
    expect(new Set(SIDEBAR_SLUGS).size).toBe(SIDEBAR_SLUGS.length);
  });

  it('accepts a known slug and refuses anything else', () => {
    expect(isSidebarSlug('passwords')).toBe(true);
    expect(isSidebarSlug('not_a_category')).toBe(false);
    expect(isSidebarSlug('')).toBe(false);
    expect(isSidebarSlug(null)).toBe(false);
    expect(isSidebarSlug(7)).toBe(false);
  });

  it('fits under the ceiling with room to spare', () => {
    // If the registry ever outgrows the cap, a layout naming everything becomes
    // unstorable — and the only symptom is a save that fails for one person who
    // happened to want all of them.
    expect(SIDEBAR_SLUGS.length).toBeLessThanOrEqual(SIDEBAR_MAX);
  });
});

describe('the default', () => {
  it('is exactly the categories the registry does not mark secondary', () => {
    expect([...DEFAULT_SIDEBAR]).toEqual(
      ORG_CATEGORIES.filter((c) => !c.secondary).map((c) => c.slug),
    );
  });

  it('is in registry order, not alphabetical or arbitrary', () => {
    const positions = DEFAULT_SIDEBAR.map((slug) => SIDEBAR_SLUGS.indexOf(slug));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('is neither everything nor nothing', () => {
    // A default of everything makes "More" pointless; a default of nothing
    // makes the drawer look broken on first use.
    expect(DEFAULT_SIDEBAR.length).toBeGreaterThan(0);
    expect(DEFAULT_SIDEBAR.length).toBeLessThan(ORG_CATEGORIES.length);
  });
});

describe('reading a stored layout', () => {
  it('keeps a valid one as it is', () => {
    expect(readSidebar(['passwords', 'documents'], DEFAULT_SIDEBAR))
      .toEqual(['passwords', 'documents']);
  });

  it('preserves order, because the order is the whole feature', () => {
    const reversed = [...DEFAULT_SIDEBAR].reverse();
    expect(readSidebar(reversed, DEFAULT_SIDEBAR)).toEqual(reversed);
  });

  it('drops a slug the registry no longer knows', () => {
    expect(readSidebar(['passwords', 'retired_category', 'documents'], DEFAULT_SIDEBAR))
      .toEqual(['passwords', 'documents']);
  });

  it('drops a duplicate rather than rendering a category twice', () => {
    expect(readSidebar(['passwords', 'passwords'], DEFAULT_SIDEBAR)).toEqual(['passwords']);
  });

  it('keeps an empty array empty, because that is a choice', () => {
    // The fallback is for a MISSING ROW. If [] fell through to the default,
    // somebody who emptied their drawer would watch the control appear to do
    // nothing, repeatedly.
    expect(readSidebar([], DEFAULT_SIDEBAR)).toEqual([]);
  });

  it('falls back for anything that is not an array at all', () => {
    for (const stored of [null, undefined, {}, 'passwords', 7, true]) {
      expect(readSidebar(stored, DEFAULT_SIDEBAR)).toEqual([...DEFAULT_SIDEBAR]);
    }
  });

  it('honours a caller-supplied fallback, not just the shipped one', () => {
    // The three-level resolution depends on this: the tenant default is handed
    // in as the fallback for a user with no row.
    expect(readSidebar(null, ['sops'])).toEqual(['sops']);
  });

  it('truncates a layout longer than the ceiling', () => {
    const tooMany = [...SIDEBAR_SLUGS, ...SIDEBAR_SLUGS];
    expect(readSidebar(tooMany, DEFAULT_SIDEBAR).length).toBeLessThanOrEqual(SIDEBAR_MAX);
  });
});

describe('splitting a layout into the two lists', () => {
  it('loses no category, whatever the layout', () => {
    for (const layout of [
      [],
      [...DEFAULT_SIDEBAR],
      ['sops'],
      [...SIDEBAR_SLUGS],
      ['passwords', 'retired_category'],
    ]) {
      const { primary, more } = splitSidebar(layout);
      const seen = [...primary, ...more].map((c) => c.slug).sort();
      expect(seen, `layout ${JSON.stringify(layout)} lost a category`)
        .toEqual([...SIDEBAR_SLUGS].sort());
    }
  });

  it('puts nothing in both lists at once', () => {
    const { primary, more } = splitSidebar(['passwords', 'sops']);
    const inPrimary = new Set(primary.map((c) => c.slug));
    expect(more.some((c) => inPrimary.has(c.slug))).toBe(false);
  });

  it('follows the person"s order in the primary list', () => {
    const { primary } = splitSidebar(['sops', 'passwords', 'contacts']);
    expect(primary.map((c) => c.slug)).toEqual(['sops', 'passwords', 'contacts']);
  });

  it('follows the registry"s order under More, not the order of removal', () => {
    // "More" is a reference list somebody scans for one thing, not a list they
    // arranged. Ordering it by what they happened to remove would put the
    // categories in an order with no meaning at all.
    const { more } = splitSidebar(['passwords']);
    const positions = more.map((c) => SIDEBAR_SLUGS.indexOf(c.slug));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('skips an unknown slug instead of inventing a category for it', () => {
    const { primary } = splitSidebar(['passwords', 'retired_category']);
    expect(primary.map((c) => c.slug)).toEqual(['passwords']);
  });

  it('reproduces today"s drawer from the default', () => {
    // The regression this whole file exists to prevent: the shipped default
    // must render the same two lists the hardcoded flag used to produce.
    const { primary, more } = splitSidebar([...DEFAULT_SIDEBAR]);
    expect(primary.map((c) => c.slug)).toEqual(
      ORG_CATEGORIES.filter((c) => !c.secondary).map((c) => c.slug),
    );
    expect(more.map((c) => c.slug)).toEqual(
      ORG_CATEGORIES.filter((c) => c.secondary).map((c) => c.slug),
    );
  });

  it('gives every category to More when the layout is empty', () => {
    const { primary, more } = splitSidebar([]);
    expect(primary).toEqual([]);
    expect(more.map((c) => c.slug)).toEqual([...SIDEBAR_SLUGS]);
  });
});

/**
 * The drawer reads the layout, and the registry's flag no longer reaches it.
 *
 * READ FROM THE SOURCE, which needs defending. Sidebar is a client component
 * holding usePathname() and useShell(), so exercising it needs a DOM and two
 * providers that this suite does not have — and the integration test can only
 * see the PROPS the layout hands it, not what it does with them. Replacing
 * `splitSidebar(layout)` with the old hardcoded filter passed every other test
 * in this change, which is how this one came to exist.
 *
 * tests/unit/breadcrumbs.test.ts makes the same move for the same reason and
 * its header says why it is worth making: a blunt instrument that catches the
 * edit six months from now whose author never read this file. Nothing else can.
 *
 * The second assertion is the load-bearing one, and it is about architecture
 * rather than spelling: `secondary` has exactly one job left, deciding
 * DEFAULT_SIDEBAR. A drawer that consults it again is a drawer that has
 * stopped being customisable, whatever it was handed.
 */
describe('the drawer"s wiring', () => {
  const source = readFileSync('src/components/shell/sidebar.tsx', 'utf8');

  it('splits the layout it was given', () => {
    expect(source).toMatch(/splitSidebar\(\s*layout\s*\)/);
  });

  it('does not consult the registry"s secondary flag', () => {
    expect(source, 'the drawer is deriving its own split again').not.toMatch(/\bsecondary\b\s*[),]/);
    expect(source).not.toContain('c.secondary');
  });

  it('is reading a file that exists and holds the drawer', () => {
    // Without this, a renamed or moved file would make both assertions above
    // vacuous in the one direction that matters: the regex finding nothing.
    expect(source).toContain('export function Sidebar(');
    expect(source.length).toBeGreaterThan(1000);
  });
});
