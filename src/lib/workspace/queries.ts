/**
 * Reads and writes for the per-user workspace.
 *
 * Every function here takes a transaction that already carries the session
 * context, and NONE of them takes a user id. The acting user comes from
 * helm.current_actor_id() inside the RLS policy, so "read somebody else's
 * favourites" is not a thing these functions can be asked to do — it is
 * unexpressible rather than merely unauthorised.
 */
import type { HelmTx } from '../db/client';
import { DEFAULT_LAYOUT, readLayout, type WidgetKey } from './widgets';

export interface FavoriteClient {
  organizationId: string;
  name: string;
  health: string;
  expiredCount: number;
  criticalCount: number;
  warningCount: number;
  reasons: string[] | null;
}

export interface RecentItem {
  kind: 'client' | 'asset';
  id: string;
  href: string;
  name: string;
  /** The client an asset belongs to. Null on a client's own row. */
  context: string | null;
  viewedAt: Date;
}

export async function listFavorites(tx: HelmTx): Promise<FavoriteClient[]> {
  const rows = await tx<
    {
      organization_id: string; name: string; health: string;
      expired_count: number; critical_count: number; warning_count: number;
      reasons: string[] | null;
    }[]
  >`
    SELECT o.id AS organization_id, o.name,
           coalesce(h.health, 'green') AS health,
           coalesce(h.expired_count, 0)  AS expired_count,
           coalesce(h.critical_count, 0) AS critical_count,
           coalesce(h.warning_count, 0)  AS warning_count,
           h.reasons
    FROM user_favorite f
    JOIN organization o ON o.id = f.organization_id
    LEFT JOIN v_client_health h ON h.organization_id = o.id
    WHERE o.deleted_at IS NULL
    ORDER BY o.name
  `;
  return rows.map((r) => ({
    organizationId: r.organization_id,
    name: r.name,
    health: r.health,
    expiredCount: r.expired_count,
    criticalCount: r.critical_count,
    warningCount: r.warning_count,
    reasons: r.reasons,
  }));
}

export async function favoriteIds(tx: HelmTx): Promise<Set<string>> {
  const rows = await tx<{ organization_id: string }[]>`
    SELECT organization_id FROM user_favorite
  `;
  return new Set(rows.map((r) => r.organization_id));
}

export async function isFavorite(tx: HelmTx, organizationId: string): Promise<boolean> {
  const [row] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM user_favorite
    WHERE organization_id = ${organizationId}::uuid
  `;
  return (row?.n ?? 0) > 0;
}

/**
 * Pin or unpin, and report what the state became.
 *
 * The INSERT names tenant_id from helm.current_tenant_id() rather than from the
 * caller: the WITH CHECK would refuse anything else anyway, and threading a
 * tenant id through an interface that has one in the session context is how the
 * wrong one eventually gets threaded.
 */
export async function setFavorite(
  tx: HelmTx,
  organizationId: string,
  pinned: boolean,
): Promise<boolean> {
  if (pinned) {
    await tx`
      INSERT INTO user_favorite (tenant_id, user_id, organization_id)
      VALUES (helm.current_tenant_id(), helm.current_actor_id(), ${organizationId}::uuid)
      ON CONFLICT (tenant_id, user_id, organization_id) DO NOTHING
    `;
  } else {
    await tx`DELETE FROM user_favorite WHERE organization_id = ${organizationId}::uuid`;
  }
  return pinned;
}

/**
 * Record that the acting user opened something.
 *
 * Fire-and-forget from the caller's point of view: a page that fails to render
 * because it could not write a history row would be trading the thing somebody
 * asked for against a convenience. helm.record_view() already returns quietly
 * for a non-person actor; this swallows the rest, because the one remaining
 * failure mode is not worth a 500 on a page that otherwise worked.
 *
 * THE SAVEPOINT IS WHAT MAKES THAT TRUE, and a bare try/catch made it false.
 *
 * Both callers — the client page and the asset page — call this INSIDE the
 * transaction `withTenant` opened, and before the queries that actually render
 * the page. In Postgres a failed statement aborts its whole transaction: every
 * statement after it fails with 25P02, "current transaction is aborted",
 * until a rollback. Catching the error in JavaScript does not undo that. So
 * swallowing it here did the exact opposite of what it was written to do — one
 * unwritable history row turned into six failed queries and a 500 on every
 * client and asset page, with the catch hiding the cause and the log showing
 * only the meaningless 25P02 from whichever query ran first.
 *
 * Rolling back to a savepoint is the one thing that recovers an aborted
 * transaction without discarding it. The write is attempted inside one, so a
 * failure costs exactly the history row it was trying to write.
 *
 * Not hypothetical: a client whose organisation row is deleted between the
 * page's read and this write violates user_recent_view's foreign key, which is
 * enough.
 */
export async function recordView(
  tx: HelmTx,
  target: { organizationId: string } | { nodeId: string },
): Promise<void> {
  try {
    await tx.savepoint(async (sp) => {
      if ('organizationId' in target) {
        await sp`SELECT helm.record_view(${target.organizationId}::uuid, NULL)`;
      } else {
        await sp`SELECT helm.record_view(NULL, ${target.nodeId}::uuid)`;
      }
    });
  } catch {
    // Deliberately silent, and now safely so: the savepoint has been rolled
    // back, so the caller's transaction is intact and its queries still run.
  }
}

/**
 * The recent list, newest first.
 *
 * Two UNIONed halves rather than one query with a CASE, because a client and an
 * asset need different joins to get a name and each half stays readable. The
 * table prunes itself to 50 on write; the interface asks for ten.
 */
export async function listRecent(tx: HelmTx, limit = 10): Promise<RecentItem[]> {
  const rows = await tx<
    { kind: string; id: string; name: string; context: string | null; viewed_at: Date }[]
  >`
    SELECT 'client' AS kind, o.id::text, o.name, NULL::text AS context, r.viewed_at
    FROM user_recent_view r
    JOIN organization o ON o.id = r.organization_id
    WHERE r.organization_id IS NOT NULL AND o.deleted_at IS NULL
    UNION ALL
    SELECT 'asset' AS kind, n.id::text, n.name, o.name AS context, r.viewed_at
    FROM user_recent_view r
    JOIN asset_node n ON n.id = r.node_id
    JOIN organization o ON o.id = n.organization_id
    WHERE r.node_id IS NOT NULL AND n.archived_at IS NULL
    ORDER BY viewed_at DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    kind: r.kind === 'client' ? 'client' : 'asset',
    id: r.id,
    href: r.kind === 'client' ? `/organizations/${r.id}` : `/assets/${r.id}`,
    name: r.name,
    context: r.context,
    viewedAt: r.viewed_at,
  }));
}

/** The saved layout, or the default for somebody who has never customised it. */
export async function getLayout(tx: HelmTx): Promise<WidgetKey[]> {
  const [row] = await tx<{ widgets: unknown }[]>`SELECT widgets FROM user_dashboard`;
  if (!row) return [...DEFAULT_LAYOUT];
  const layout = readLayout(row.widgets);
  // An empty saved layout is a choice — somebody who removed every widget. A
  // MISSING row is somebody who has never touched it, and that is the default
  // above. Only the second case gets one.
  return layout;
}

/**
 * `tx.json(widgets)`, NOT `JSON.stringify(widgets)`.
 *
 * postgres.js sends a plain JS string as a text parameter, so
 * `${JSON.stringify(['favorites'])}::jsonb` arrives as the jsonb SCALAR
 * `"[\"favorites\"]"` — a quoted string containing brackets, not an array.
 * helm.dashboard_layout_valid() then correctly reports it is not an array and
 * the CHECK constraint refuses it, which surfaces as a 500 on saving any
 * layout at all. `tx.json()` marks the value as JSON so the array arrives as
 * an array.
 *
 * The literal form in a psql prompt works, which is exactly why this was worth
 * a test that goes through the route rather than the SQL.
 */
export async function setLayout(tx: HelmTx, widgets: WidgetKey[]): Promise<WidgetKey[]> {
  await tx`
    INSERT INTO user_dashboard (tenant_id, user_id, widgets)
    VALUES (helm.current_tenant_id(), helm.current_actor_id(), ${tx.json(widgets)}::jsonb)
    ON CONFLICT (tenant_id, user_id) DO UPDATE SET widgets = EXCLUDED.widgets
  `;
  return widgets;
}
