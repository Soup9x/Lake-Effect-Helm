/**
 * The sentence shown before something is destroyed.
 *
 * Worth testing because it is the only description the person gets of what they
 * are about to lose, and the failure mode is quiet: an "and" in the wrong place
 * reads oddly, a zero rendered as "0 sites" reads as though the client had
 * sites, and an empty object rendering as "" reads as though nothing would go.
 */
import { describe, expect, it } from 'vitest';
import { describeCascade } from '../../src/components/delete-permanently';

describe('describeCascade', () => {
  it('lists what is actually there', () => {
    expect(describeCascade({ assets: 7, secrets: 2, sites: 1 })).toBe(
      '7 assets, 2 credentials and 1 site',
    );
  });

  it('omits the zeros rather than listing them', () => {
    // "7 assets, 0 sites and 0 contacts" invites the reader to wonder what a
    // zero site is.
    expect(describeCascade({ assets: 7, sites: 0, contacts: 0 })).toBe('7 assets');
  });

  it('singularises', () => {
    expect(describeCascade({ assets: 1, sites: 1 })).toBe('1 asset and 1 site');
  });

  it('says so plainly when nothing else goes', () => {
    // An empty string here would read as "deleting this client also deletes ,
    // in one operation".
    expect(describeCascade({})).toBe('nothing else is recorded against it');
    expect(describeCascade({ assets: 0 })).toBe('nothing else is recorded against it');
  });

  it('handles a single category without a stray conjunction', () => {
    expect(describeCascade({ secrets: 3 })).toBe('3 credentials');
  });
});
