/**
 * Reading and writing a drawer layout.
 *
 * THREE LEVELS, AND THE ORDER MATTERS:
 *
 *   1. the person's own row in user_sidebar
 *   2. the tenant's row in tenant_sidebar_default, set by an administrator
 *   3. DEFAULT_SIDEBAR in the code
 *
 * A MISSING ROW AND AN EMPTY ARRAY ARE DIFFERENT ANSWERS, which is the one
 * thing in this file that is easy to get wrong and silent when it is. Somebody
 * who removed every category from their drawer has expressed a preference; if
 * `[]` fell through to the default they would watch the control appear to do
 * nothing, repeatedly. So the fallback is decided by whether a ROW exists, and
 * `categories` is read only once one does.
 */
import type { HelmTx } from '../db/client';
import { DEFAULT_SIDEBAR, readSidebar } from './sidebar-layout';

/** The layout to render for the current actor, resolved through all three levels. */
export async function getSidebarLayout(tx: HelmTx): Promise<string[]> {
  // Personal RLS means this can only ever be the caller's own row; there is no
  // WHERE naming the user, and adding one would imply the policy were optional.
  const [mine] = await tx<{ categories: unknown }[]>`
    SELECT categories FROM user_sidebar
  `;
  if (mine) return readSidebar(mine.categories, DEFAULT_SIDEBAR);

  return getTenantSidebarDefault(tx);
}

export interface TenantDefault {
  categories: string[];
  /** Whether an administrator has actually set one, or this is the code's. */
  set: boolean;
}

/**
 * The tenant's default, and whether it is a tenant's at all.
 *
 * BOTH FROM ONE READ, because the two answers come from the same row and the
 * settings card needs them together: it says either "12 of 16 shown by default"
 * or "not set — new users get Helm's own default of 8", and those are the same
 * list with different meanings. Asking twice would be two round trips that can
 * disagree.
 *
 * Readable by every role in the tenant, which is why the drawer can render from
 * it for a client-side user too — see 0620's note on why this table does not
 * use the tenant-wide read predicate.
 */
export async function readTenantSidebarDefault(tx: HelmTx): Promise<TenantDefault> {
  const [row] = await tx<{ categories: unknown }[]>`
    SELECT categories FROM tenant_sidebar_default
  `;
  return row
    ? { categories: readSidebar(row.categories, DEFAULT_SIDEBAR), set: true }
    : { categories: [...DEFAULT_SIDEBAR], set: false };
}

/** Just the list, for the callers that do not care which level it came from. */
export async function getTenantSidebarDefault(tx: HelmTx): Promise<string[]> {
  return (await readTenantSidebarDefault(tx)).categories;
}

/**
 * `tx.json(categories)`, NOT `JSON.stringify(categories)`.
 *
 * postgres.js sends a plain JS string as a text parameter, so
 * `${JSON.stringify(['passwords'])}::jsonb` arrives as the jsonb SCALAR
 * `"[\"passwords\"]"` — a quoted string containing brackets, not an array.
 * helm.sidebar_layout_valid() then correctly reports it is not an array, the
 * CHECK refuses it, and it surfaces as a 500 on saving any layout at all. The
 * dashboard hit exactly this (see setLayout in workspace/queries.ts); the note
 * is repeated rather than referenced because the mistake is invisible at the
 * call site.
 */
export async function setSidebarLayout(tx: HelmTx, categories: string[]): Promise<string[]> {
  await tx`
    INSERT INTO user_sidebar (tenant_id, user_id, categories)
    VALUES (helm.current_tenant_id(), helm.current_actor_id(), ${tx.json(categories)}::jsonb)
    ON CONFLICT (tenant_id, user_id) DO UPDATE SET categories = EXCLUDED.categories
  `;
  return categories;
}

/**
 * Stop having an opinion, and follow the tenant default again.
 *
 * Deleting the row rather than writing the default INTO it, because those are
 * different states: a copy of today's default would silently stop tracking an
 * administrator's later change, and the person who pressed "reset" would have
 * no way to tell. Without this there is no way back at all — the first save is
 * otherwise permanent, which is a trap in a control whose whole purpose is
 * rearranging things to see what you prefer.
 */
export async function clearSidebarLayout(tx: HelmTx): Promise<string[]> {
  await tx`DELETE FROM user_sidebar`;
  return getTenantSidebarDefault(tx);
}

/** The administrator's write. `updated_by` is for "who changed my drawer". */
export async function setTenantSidebarDefault(
  tx: HelmTx,
  categories: string[],
  actorId: string,
): Promise<string[]> {
  await tx`
    INSERT INTO tenant_sidebar_default (tenant_id, categories, updated_by)
    VALUES (helm.current_tenant_id(), ${tx.json(categories)}::jsonb, ${actorId}::uuid)
    ON CONFLICT (tenant_id) DO UPDATE
      SET categories = EXCLUDED.categories, updated_by = EXCLUDED.updated_by
  `;
  return categories;
}
