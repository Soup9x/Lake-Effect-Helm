/**
 * Reading documentation health, and the windows it is measured against.
 *
 * EVERY QUERY HERE IS UNDER RLS and none of them authorises anything.
 * `v_documentation_health` carries security_invoker, so it sees exactly the
 * organisations the reader's own policies allow — a client user asking for
 * their own organisation gets their row and nothing else, and asking for
 * somebody else's gets nothing rather than an error.
 *
 * THE VIEW IS NOT A SCORE and this file does not make one out of it. See
 * decision 20 and 0680's header.
 */
import type { HelmTx } from '../db/client';
import {
  DEFAULT_HEALTH_DAYS, HEALTH_DEFAULTS,
  type DocumentationHealth, type HealthSetting,
} from './window';

interface HealthRow {
  total_count: number;
  current_count: number;
  stale_count: number;
  never_revised_count: number;
  unviewed_count: number;
  last_revised_at: Date | null;
  last_viewed_at: Date | null;
  stale_after_days: number;
  unviewed_after_days: number;
}

/**
 * One client's health, or null if the reader cannot see that organisation.
 *
 * Null rather than a zeroed row for an invisible client, because the two are
 * different answers and the caller renders them differently: a client with no
 * documentation gets a ring of zeroes and an invitation, while a client the
 * reader cannot see gets no card at all.
 */
export async function readDocumentationHealth(
  tx: HelmTx,
  organizationId: string,
): Promise<DocumentationHealth | null> {
  const [row] = await tx<HealthRow[]>`
    SELECT total_count, current_count, stale_count, never_revised_count,
           unviewed_count, last_revised_at, last_viewed_at,
           stale_after_days, unviewed_after_days
    FROM v_documentation_health
    WHERE organization_id = ${organizationId}::uuid
  `;
  if (!row) return null;

  return {
    total: Number(row.total_count),
    current: Number(row.current_count),
    stale: Number(row.stale_count),
    neverRevised: Number(row.never_revised_count),
    unviewed: Number(row.unviewed_count),
    lastRevisedAt: row.last_revised_at?.toISOString() ?? null,
    lastViewedAt: row.last_viewed_at?.toISOString() ?? null,
    staleAfterDays: Number(row.stale_after_days),
    unviewedAfterDays: Number(row.unviewed_after_days),
  };
}

/**
 * The records behind a segment, so a count is somewhere to go rather than
 * something to look at.
 *
 * G's lesson: the empty cells are the feature, and a number that cannot be
 * clicked is a number people stop believing. The predicates here are the view's
 * own, repeated — which is a real duplication and the alternative is worse: a
 * `WHERE segment = 'stale'` against the view would need the view to emit one
 * row per node rather than per client, turning an aggregate every client page
 * runs into a scan of the whole estate. The agreement is asserted instead, in
 * tests/integration/health.test.ts, by checking the listed rows against the
 * counted ones for every segment.
 */
export async function listHealthSegment(
  tx: HelmTx,
  organizationId: string,
  segment: 'current' | 'stale' | 'never_revised' | 'unviewed',
  limit = 100,
): Promise<{ id: string; name: string; nodeType: string; updatedAt: string;
             lastViewedAt: string | null }[]> {
  const rows = await tx<{
    id: string; name: string; node_type: string;
    updated_at: Date; last_viewed_at: Date | null;
  }[]>`
    WITH win AS (
      SELECT stale_after_days, unviewed_after_days
      FROM v_documentation_health WHERE organization_id = ${organizationId}::uuid
    )
    SELECT n.id, n.name, n.node_type::text AS node_type, n.updated_at,
           v.last_viewed_at
    FROM asset_node n
    CROSS JOIN win w
    LEFT JOIN node_view_stat v ON v.node_id = n.id
    WHERE n.organization_id = ${organizationId}::uuid
      AND n.archived_at IS NULL
      AND CASE ${segment}::text
        WHEN 'current' THEN
          n.updated_at >= now() - make_interval(days => w.stale_after_days)
        WHEN 'stale' THEN
          n.updated_at < now() - make_interval(days => w.stale_after_days)
            AND n.updated_at > n.created_at
        WHEN 'never_revised' THEN
          n.updated_at < now() - make_interval(days => w.stale_after_days)
            AND n.updated_at = n.created_at
        WHEN 'unviewed' THEN
          v.last_viewed_at IS NULL
            OR v.last_viewed_at < now() - make_interval(days => w.unviewed_after_days)
        ELSE false
      END
    ORDER BY n.updated_at, n.name
    LIMIT ${limit}
  `;
  return rows.map((r: {
    id: string; name: string; node_type: string;
    updated_at: Date; last_viewed_at: Date | null;
  }) => ({
    id: r.id,
    name: r.name,
    nodeType: r.node_type,
    updatedAt: r.updated_at.toISOString(),
    lastViewedAt: r.last_viewed_at?.toISOString() ?? null,
  }));
}

/**
 * The tenant's windows, or the shipped defaults when nobody has set them.
 *
 * `configured` distinguishes the two, which the settings screen needs and the
 * ring does not: an absent row and a row saying 180 behave identically for
 * measurement, and differently for a sentence that says whether anybody has
 * made a decision here.
 */
export async function readHealthSetting(tx: HelmTx): Promise<HealthSetting> {
  const [row] = await tx<{ stale_after_days: number; unviewed_after_days: number }[]>`
    SELECT stale_after_days, unviewed_after_days
    FROM documentation_health_setting
    WHERE tenant_id = helm.current_tenant_id()
  `;
  if (!row) return { ...HEALTH_DEFAULTS };
  return {
    staleAfterDays: Number(row.stale_after_days),
    unviewedAfterDays: Number(row.unviewed_after_days),
    configured: true,
  };
}

/**
 * Set the windows. Gated by RLS on `tenant:write`, not by this function.
 *
 * Upsert on the primary key, so turning the dial twice does not accumulate
 * rows and there is no read-then-write race between two administrators.
 */
export async function writeHealthSetting(
  tx: HelmTx,
  next: { staleAfterDays: number; unviewedAfterDays: number },
  actorId: string,
): Promise<HealthSetting> {
  const [row] = await tx<{ stale_after_days: number; unviewed_after_days: number }[]>`
    INSERT INTO documentation_health_setting (
      tenant_id, stale_after_days, unviewed_after_days, updated_by
    )
    VALUES (
      helm.current_tenant_id(), ${next.staleAfterDays}, ${next.unviewedAfterDays},
      ${actorId}::uuid
    )
    ON CONFLICT (tenant_id) DO UPDATE SET
      stale_after_days    = EXCLUDED.stale_after_days,
      unviewed_after_days = EXCLUDED.unviewed_after_days,
      updated_at          = now(),
      updated_by          = EXCLUDED.updated_by
    RETURNING stale_after_days, unviewed_after_days
  `;
  if (!row) {
    // RLS refused the write and said nothing, which is how a policy declines.
    // Reported rather than returned as a success with stale numbers.
    throw new Error('the documentation health window was not written');
  }
  return {
    staleAfterDays: Number(row.stale_after_days),
    unviewedAfterDays: Number(row.unviewed_after_days),
    configured: true,
  };
}

/** Re-exported so a caller needs one import. */
export { DEFAULT_HEALTH_DAYS };
