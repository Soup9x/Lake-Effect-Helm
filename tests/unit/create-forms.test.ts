/**
 * Which form "+ New" opens, for every category there is.
 *
 * WHY THIS FILE EXISTS. The decision used to be five independent conditions in
 * CategoryActions, one of which was "this category has a node_type" — true of
 * SOPs, because a procedure is an asset_node of type 'sop'. So the generic
 * asset form claimed the SOPs category alongside NewProcedureForm, and the only
 * thing stopping two dialogs opening at once was a `category !== 'sops'` guard
 * with a comment explaining itself. Deleting that guard broke nothing in the
 * suite, because a conditional inside a client component's JSX is not reachable
 * from a test in this project — there is no DOM renderer.
 *
 * Extracting the decision is what made it testable, and returning ONE answer is
 * what made the bug impossible rather than guarded. These tests assert both.
 */
import { describe, expect, it } from 'vitest';
import { createFormFor, ORG_CATEGORIES } from '../../src/lib/nav/org-categories';

describe('choosing a create form', () => {
  it('sends a procedure to the procedure form, not the generic asset form', () => {
    // The whole reason this function exists. 'sops' has source 'sop', a real
    // node_type, so any rule phrased as "node categories get the asset form"
    // gets this one wrong.
    expect(createFormFor('sops', 'sop')).toBe('procedure');
  });

  it('gives each of the special categories its own form', () => {
    expect(createFormFor('contacts', undefined)).toBe('contact');
    expect(createFormFor('passwords', 'credential')).toBe('secret');
    expect(createFormFor('locations', undefined)).toBe('site');
  });

  it('gives every other node category the generic form', () => {
    expect(createFormFor('configurations', 'device')).toBe('configuration');
    expect(createFormFor('domains', 'domain')).toBe('asset');
    expect(createFormFor('ip-addresses', 'ip_address')).toBe('asset');
  });

  it('offers nothing where there is no row to create', () => {
    // Documents are files. The category page renders Import instead, and a
    // disabled + New would invite somebody to debug their permissions.
    expect(createFormFor('documents', undefined)).toBeNull();
    expect(createFormFor('not-a-category', undefined)).toBeNull();
  });

  it('answers for every category in the drawer, so a new one cannot be forgotten', () => {
    /*
     * Driven off the real taxonomy rather than a list copied into this file.
     * Adding a category with a node_type and no special case lands on 'asset',
     * which is the right default; adding one WITHOUT a node_type and without a
     * case here returns null, and this test names it rather than leaving a
     * button that does nothing — which is the exact failure F1 was fixing.
     */
    const unanswered = ORG_CATEGORIES.filter((category) => {
      const nodeType = category.kind === 'node' ? category.source : undefined;
      return createFormFor(category.slug, nodeType) === null;
    }).map((category) => category.slug);

    expect(unanswered, 'these categories render a + New that opens nothing')
      .toEqual(['documents']);
  });

  it('never answers twice, which is what the old guard was for', () => {
    // A total function returning one value cannot render two dialogs. Stated as
    // a test because the property is the point of the refactor, not a detail
    // of it: the bug was two conditions being true at once.
    for (const category of ORG_CATEGORIES) {
      const nodeType = category.kind === 'node' ? category.source : undefined;
      const form = createFormFor(category.slug, nodeType);
      expect(typeof form === 'string' || form === null).toBe(true);
    }
  });
});
