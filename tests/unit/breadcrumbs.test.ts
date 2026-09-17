/**
 * Breadcrumbs, and the promise that every nested page has them.
 *
 * "Applied consistently across every nested view" is a property of the whole
 * app or it is not a property at all: a trail that appears on the pages
 * somebody thought of is a navigation aid you cannot rely on, which is worse
 * than none — you learn to look for it, and then one day it is not there.
 *
 * The first test reads the SOURCE of every dynamic route. That is a blunt
 * instrument and deliberately so: it catches the page added six months from now
 * whose author never read this file. Nothing else can — there is no type that
 * says "a page under a dynamic segment must pass a trail", and a runtime check
 * would only fire on a page somebody already visited.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Breadcrumbs } from '../../src/components/ui/breadcrumbs';

const APP = 'src/app/(app)';

function pagesUnder(dir: string, nested = false): { path: string; nested: boolean }[] {
  const found: { path: string; nested: boolean }[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // A [param] segment means this route is a detail view of something that
      // was reached from a list — the definition of nested, here.
      found.push(...pagesUnder(full, nested || entry.startsWith('[')));
    } else if (entry === 'page.tsx') {
      found.push({ path: full, nested });
    }
  }
  return found;
}

describe('every nested page', () => {
  const pages = pagesUnder(APP);

  it('was found at all, so the sweep below quantifies over something', () => {
    expect(pages.length).toBeGreaterThan(5);
    expect(pages.some((p) => p.nested)).toBe(true);
  });

  for (const page of pages.filter((p) => p.nested)) {
    it(`passes a trail: ${page.path}`, () => {
      const source = readFileSync(page.path, 'utf8');
      expect(source).toMatch(/trail=\{/);
    });
  }

  /**
   * Two pages are top-level AND show a trail, each when a filter puts them
   * under something: expirations narrowed to one client, and the clients list
   * showing the archive. Somebody who arrived at either from the page above is
   * in a nested view whatever the URL shape says.
   *
   * Named here rather than filtered out by a substring, so each exception is a
   * statement instead of a silence.
   */
  const TRAIL_WHEN_FILTERED = new Set([
    join(APP, 'expirations', 'page.tsx'),
    // The clients list is top-level, and `?archived=1` is a view UNDER it: the
    // archive is reached from the list and returns to it, which is a trail
    // whatever the URL shape says.
    join(APP, 'organizations', 'page.tsx'),
  ]);

  it('leaves top-level pages alone', () => {
    // Not an accident to be corrected later. A one-item breadcrumb reading
    // "Clients" above a heading reading "Clients", beside a nav item reading
    // "Clients", is three copies of one fact.
    const unexpected = pages
      .filter((p) => !p.nested && !TRAIL_WHEN_FILTERED.has(p.path))
      .filter((p) => /trail=\{/.test(readFileSync(p.path, 'utf8')))
      .map((p) => p.path);
    expect(unexpected).toEqual([]);
  });

  it('...and the one named exception really is one', () => {
    for (const path of TRAIL_WHEN_FILTERED) {
      expect(readFileSync(path, 'utf8')).toMatch(/trail=\{/);
    }
  });
});

describe('the trail itself', () => {
  it('renders nothing when there are no ancestors', () => {
    expect(Breadcrumbs({ trail: [] })).toBeNull();
  });

  it('renders something when there are', () => {
    expect(Breadcrumbs({ trail: [{ label: 'Clients', href: '/organizations' }] })).not.toBeNull();
  });
});
