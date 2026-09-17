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
   * Expirations is top-level AND shows a trail, when it is filtered to one
   * client — somebody who arrived there from a client's health badge is in a
   * nested view whatever the URL shape says. Named here rather than filtered
   * out by a substring, so the exception is a statement instead of a silence.
   */
  const TRAIL_WHEN_FILTERED = new Set([join(APP, 'expirations', 'page.tsx')]);

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
