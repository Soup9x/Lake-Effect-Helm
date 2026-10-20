/**
 * What happened to one client lately, read two different ways.
 *
 * THE SPLIT IS THE POINT, and it is not arbitrary. Helm records two kinds of
 * history and they live in two places:
 *
 *   `audit_log`   security-relevant EVENTS. A reveal, a rotation, an export, a
 *                 refusal. Hash-chained, append-only, and the thing an auditor
 *                 reads. It does not contain "somebody corrected the switch's
 *                 serial number", because the write paths do not audit ordinary
 *                 field edits and should not: an audit trail that logs every
 *                 typo correction is one nobody reads.
 *
 *   `updated_at`  the current state of a documentation row, maintained by
 *                 helm.touch_updated_at() on every UPDATE, with `updated_by`
 *                 set by each write path. It says what changed and when, and
 *                 nothing about what it changed FROM.
 *
 * So "Activity" reads the first and "Recently updated" reads the second, and
 * neither can be derived from the other. A password rotation appears in
 * Activity (`secret.rotated`) and NOT in Recently updated, because rotating a
 * secret touches `secret`, not the credential's `asset_node` row. A corrected
 * hostname appears in Recently updated and not in Activity. Both are true; the
 * two widgets sit side by side for that reason.
 *
 * NEITHER FUNCTION AUTHORISES ANYTHING, and neither needs to. Every table read
 * here is under RLS:
 *
 *   audit_log   (tenant_id = helm.current_tenant_id())
 *               AND helm.has_permission('audit:read')
 *               AND (helm.is_tenant_wide()
 *                    OR (organization_id IS NOT NULL
 *                        AND helm.org_in_scope(organization_id)
 *                        AND helm.node_visible(node_id)))
 *
 *   the rest    tenant, org scope and is_internal_only, as everywhere else.
 *
 * An actor without `audit:read` gets an empty array from listClientActivity(),
 * not an error — which the caller must distinguish from "nothing has happened",
 * because the two look identical from here. See the `canReadAudit` prop on
 * ActivityFeedWidget.
 */
import type { HelmTx } from '../db/client';

export interface UpdatedItem {
  id: string;
  name: string;
  /** A node_type, or the table a non-node row came from. */
  source: string;
  at: Date;
  /** Who, where a write path recorded one. Null for a row nothing has edited. */
  by: string | null;
}

/**
 * The client's documentation, most recently changed first.
 *
 * Four arms, one per thing the client page lists. Deliberately NOT five:
 *
 *   - the `organization` row itself is excluded. "This client was updated" on
 *     the client's own page is not news, and quick-notes edits would otherwise
 *     dominate a list meant to surface the estate.
 *   - `attachment` reports `uploaded_at` because the table has no `updated_at`,
 *     and that is the right column rather than a compromise: a document is a
 *     file, uploading is how it changes, and renaming one does not alter what
 *     it says.
 *
 * LIMIT applies after the UNION, so the newest N across all four come back
 * rather than N of each.
 */
export async function listRecentlyUpdated(
  tx: HelmTx,
  organizationId: string,
  limit = 6,
): Promise<UpdatedItem[]> {
  const rows = await tx<
    { id: string; name: string; source: string; at: Date; by: string | null }[]
  >`
    WITH changed AS (
      SELECT n.id, n.name, n.node_type::text AS source, n.updated_at AS at, n.updated_by AS who
      FROM asset_node n
      WHERE n.organization_id = ${organizationId}::uuid AND n.archived_at IS NULL
      UNION ALL
      SELECT s.id, s.name, 'site', s.updated_at, s.updated_by
      FROM site s
      WHERE s.organization_id = ${organizationId}::uuid AND s.deleted_at IS NULL AND s.archived_at IS NULL
      UNION ALL
      -- concat_ws, not ||. contact.last_name is NOT NULL today, so the two are
      -- equivalent right now; the difference is what happens if that ever
      -- relaxes. Concatenating a NULL with || yields NULL, so this row would
      -- render as a blank line rather than as a first name -- and the query
      -- would keep working while the widget quietly showed nothing.
      SELECT c.id, concat_ws(' ', c.first_name, c.last_name), 'contact',
             c.updated_at, c.updated_by
      FROM contact c
      WHERE c.organization_id = ${organizationId}::uuid AND c.deleted_at IS NULL
      UNION ALL
      SELECT a.id, a.filename, 'attachment', a.uploaded_at, a.uploaded_by
      FROM attachment a
      WHERE a.organization_id = ${organizationId}::uuid
        AND a.is_document AND a.deleted_at IS NULL AND a.archived_at IS NULL
    )
    SELECT c.id::text, c.name, c.source, c.at,
           -- Same fallback the documents query uses: app_user.name is nullable
           -- and an address identifies somebody where a dash does not.
           coalesce(u.name, u.email::text) AS by
    FROM changed c
    LEFT JOIN app_user u ON u.id = c.who
    ORDER BY c.at DESC
    LIMIT ${limit}
  `;
  return rows;
}

export interface ClientActivityItem {
  eventUid: string;
  occurredAt: Date;
  actorLabel: string;
  action: string;
  outcome: string;
  reason: string | null;
}

/**
 * The client-scoped slice of the audit log.
 *
 * `organization_id IS NOT NULL` is implied by the equality, which matters
 * because it is the condition `audit_log_org_idx` is partial on — tenant-level
 * events (a sign-in, a key rotation) carry no organisation and are correctly
 * absent from a client's feed.
 *
 * A KNOWN UNDER-REPORT, written down because a pass here does not mean the feed
 * is complete for everybody. `helm.write_secret_version()` audits
 * secret.created/secret.rotated with `node_id` set to the SECRET's id, and the
 * policy above calls helm.node_visible(node_id), which is EXISTS(asset_node
 * WHERE id = node_id ...). No asset_node has a secret's id, so for an actor who
 * is not tenant-wide those two rows are filtered out. That direction is safe —
 * it hides rather than leaks — so it is not this widget's to fix; fixing it
 * means changing an RLS policy, which is a migration. Recorded in
 * docs/history/itg-parity.md.
 */
export async function listClientActivity(
  tx: HelmTx,
  organizationId: string,
  limit = 12,
): Promise<ClientActivityItem[]> {
  const rows = await tx<
    {
      event_uid: string; occurred_at: Date; actor_label: string;
      action: string; outcome: string; reason: string | null;
    }[]
  >`
    SELECT event_uid, occurred_at, actor_label, action, outcome::text, reason
    FROM audit_log
    WHERE organization_id = ${organizationId}::uuid
    ORDER BY occurred_at DESC
    LIMIT ${limit}
  `;
  return rows.map((row) => ({
    eventUid: row.event_uid,
    occurredAt: row.occurred_at,
    actorLabel: row.actor_label,
    action: row.action,
    outcome: row.outcome,
    reason: row.reason,
  }));
}
