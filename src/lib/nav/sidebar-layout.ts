/**
 * Which categories a person wants in the drawer, and in what order.
 *
 * WHAT THIS REPLACES. `secondary` in org-categories.ts split sixteen categories
 * into a primary eight and a "More" disclosure holding the rest. It is a
 * reasonable guess at what a technician reaches often, and it was the same
 * guess for an MSP whose work is networks as for one whose work is licence
 * renewals. Here the split becomes a list somebody owns: the categories they
 * name are the primary section, in their order, and everything else falls
 * through to "More".
 *
 * `secondary` keeps its job as the DEFAULT rather than losing it. DEFAULT_
 * SIDEBAR below is derived from the flag, so a person who has never touched
 * this sees precisely the drawer they see today — the flag stops being the only
 * possible answer without stopping being the first one.
 *
 * THE SLUG LIST IS NOT WRITTEN TWICE HERE. SIDEBAR_SLUGS is ORG_CATEGORIES read
 * for its slugs, so adding a category to the registry adds it here with no
 * second edit. The copy that does exist is in the database —
 * helm.sidebar_layout_valid() in db/sql/0620 — and 0370 explains why that one
 * is worth paying for: the database refuses an unknown slug so a malformed
 * layout is never stored, and the interface needs the labels and icons anyway.
 * tests/integration/sidebar.test.ts asserts the two agree, so a category added
 * to the registry without a migration fails there rather than as an
 * unexplained 500 on somebody's save.
 *
 * FLEXIBLE ASSET TYPES ARE NOT IN HERE, and that is deliberate rather than
 * unfinished. They are tenant data, so they cannot appear in an IMMUTABLE
 * validator's literal list, and they already manage their own presence: the
 * drawer lists the ones with at least one record (see loadOrgNav's HAVING
 * clause), which is the same question "do I want this in my sidebar" answers
 * for a fixed category. A type with no records is absent whatever anybody
 * prefers.
 */
import { ORG_CATEGORIES, type OrgCategory } from './org-categories';

/** Every slug the database will accept. The TS half of the mirror. */
export const SIDEBAR_SLUGS: readonly string[] = ORG_CATEGORIES.map((c) => c.slug);

/**
 * The ceiling, matching the one in helm.sidebar_layout_valid().
 *
 * Twenty against sixteen categories: room for a few more without a migration
 * whose only purpose is the ceiling, and still a bound. Duplicated for the same
 * reason the slug list is — the route names the offending value, the constraint
 * makes the layout unstorable by any path.
 */
export const SIDEBAR_MAX = 20;

/** What somebody sees before they have chosen: today's primary eight. */
export const DEFAULT_SIDEBAR: readonly string[] = ORG_CATEGORIES
  .filter((c) => !c.secondary)
  .map((c) => c.slug);

const KNOWN = new Set(SIDEBAR_SLUGS);

export function isSidebarSlug(value: unknown): value is string {
  return typeof value === 'string' && KNOWN.has(value);
}

/**
 * Read a layout out of the database, tolerating anything.
 *
 * The CHECK constraint means a stored layout is already valid, so this exists
 * for the row that predates a category being RETIRED: a slug removed from the
 * registry is still in somebody's saved layout, and the drawer must drop it
 * rather than render a dead link. Dropping is safe — the customise control
 * writes the layout back the next time they touch it.
 *
 * `fallback` is used ONLY when there is no row at all. An empty stored array is
 * a choice, not an absence: somebody who wants the drawer to be nothing but
 * "More" has said so, and handing them the default back would make the control
 * appear not to work. The caller decides which case it has — see
 * getSidebarLayout(), where the distinction is a `null` rather than a `[]`.
 */
export function readSidebar(stored: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(stored)) return [...fallback];
  const seen = new Set<string>();
  for (const value of stored) if (isSidebarSlug(value)) seen.add(value);
  return [...seen].slice(0, SIDEBAR_MAX);
}

export interface SidebarSplit {
  /** In the person's order. */
  primary: OrgCategory[];
  /** Everything else, in registry order, for the "More" disclosure. */
  more: OrgCategory[];
}

/**
 * A layout as the two lists the drawer draws.
 *
 * ORDER COMES FROM DIFFERENT PLACES ON PURPOSE. The primary list follows the
 * person's arrangement, because that arrangement IS the feature. "More" follows
 * the registry, because it is a reference list somebody scans for one thing
 * rather than a list they arranged — and ordering it by what they happened to
 * remove would put the categories in an order with no meaning at all.
 *
 * An unknown slug in `layout` is skipped rather than throwing. readSidebar()
 * has normally already removed it; this is the second lock, for a caller that
 * assembled a layout some other way.
 */
export function splitSidebar(layout: readonly string[]): SidebarSplit {
  const wanted = new Set(layout);
  const byCategory = new Map(ORG_CATEGORIES.map((c) => [c.slug, c]));

  return {
    primary: layout.flatMap((slug) => {
      const category = byCategory.get(slug);
      return category ? [category] : [];
    }),
    more: ORG_CATEGORIES.filter((c) => !wanted.has(c.slug)),
  };
}
