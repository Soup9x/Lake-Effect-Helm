import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADMIN_SECTIONS } from '../../src/lib/settings/sections';

/**
 * Administration's index and sub-navigation are built from one list, so a
 * section renamed or moved without its page would be a link to a 404 on every
 * administration page at once.
 */
describe('Administration sections', () => {
  it.each(ADMIN_SECTIONS.map((s) => [s.title, s.href]))('%s (%s) has a page', (_title, href) => {
    expect(existsSync(join('src/app/(app)', href, 'page.tsx'))).toBe(true);
  });

  it('lists each place once', () => {
    const hrefs = ADMIN_SECTIONS.map((s) => s.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});
