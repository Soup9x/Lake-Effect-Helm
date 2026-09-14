import { z } from 'zod';
import { tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';

const querySchema = z.object({
  entityId: z.guid().optional(),
  organizationId: z.guid().optional(),
  action: z.string().max(64).optional(),
  since: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

interface AuditRow {
  event_uid: string;
  occurred_at: Date;
  actor_label: string;
  actor_role_key: string | null;
  action: string;
  outcome: string;
  entity_type: string | null;
  entity_id: string | null;
  organization_id: string | null;
  reason: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
}

/**
 * GET /api/audit — read the audit trail.
 *
 * Scoped by the audit_log policy, which gives MSP staff the whole tenant and a
 * co-managed client only events for their own organisation. That asymmetry is
 * the co-managed transparency story: a client can see who touched their
 * documentation without seeing anyone else's.
 *
 * Chain columns (prev_hash, row_hash, chain_seq) are deliberately not returned.
 * Verification is a separate operation through helm.verify_audit_chain(); an
 * API that hands out the hashes invites clients to implement their own
 * verification against a partial view and conclude, wrongly, that it is broken.
 */
export const GET = tenantRoute(
  async ({ tx, request }) => {
    const url = new URL(request.url);
    const parsed = querySchema.safeParse({
      entityId: url.searchParams.get('entityId') ?? undefined,
      organizationId: url.searchParams.get('organizationId') ?? undefined,
      action: url.searchParams.get('action') ?? undefined,
      since: url.searchParams.get('since') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
    });
    if (!parsed.success) throw ApiError.invalid('invalid audit filters');

    const { entityId, organizationId, action, since, limit } = parsed.data;

    const rows = await tx<AuditRow[]>`
      SELECT event_uid, occurred_at, actor_label, actor_role_key, action,
             outcome::text AS outcome, entity_type, entity_id, organization_id,
             reason, metadata, host(ip) AS ip
      FROM audit_log
      WHERE true
        ${entityId ? tx`AND entity_id = ${entityId}::uuid` : tx``}
        ${organizationId ? tx`AND organization_id = ${organizationId}::uuid` : tx``}
        ${action ? tx`AND action = ${action}` : tx``}
        ${since ? tx`AND occurred_at >= ${since}::timestamptz` : tx``}
      ORDER BY occurred_at DESC
      LIMIT ${limit}
    `;

    return {
      events: rows.map((r) => ({
        eventUid: r.event_uid,
        occurredAt: r.occurred_at,
        actorLabel: r.actor_label,
        actorRole: r.actor_role_key,
        action: r.action,
        outcome: r.outcome,
        entityType: r.entity_type,
        entityId: r.entity_id,
        organizationId: r.organization_id,
        reason: r.reason,
        metadata: r.metadata,
        ip: r.ip,
      })),
    };
  },
  { permissions: ['audit:read'] },
);

export const dynamic = 'force-dynamic';
