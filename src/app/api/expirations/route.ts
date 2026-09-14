import { z } from 'zod';
import { tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';

const querySchema = z.object({
  organizationId: z.guid().optional(),
  withinDays: z.coerce.number().int().min(1).max(3650).default(90),
  severity: z.enum(['info', 'notice', 'warning', 'critical', 'expired']).optional(),
});

interface ExpirationRow {
  id: string;
  organization_id: string;
  organization_name: string;
  kind: string;
  node_id: string | null;
  label: string;
  expires_at: Date;
  auto_renew: boolean;
  criticality: number;
  severity: string;
  days_remaining: number;
}

/**
 * GET /api/expirations — the single pane of glass.
 *
 * One indexed range scan over the projection maintained by triggers, rather
 * than a UNION across eight source tables. Severity is computed at read time:
 * a stored severity is wrong the moment the clock passes midnight and nobody
 * has run a job.
 */
export const GET = tenantRoute(
  async ({ tx, request }) => {
    const url = new URL(request.url);
    const parsed = querySchema.safeParse({
      organizationId: url.searchParams.get('organizationId') ?? undefined,
      withinDays: url.searchParams.get('withinDays') ?? undefined,
      severity: url.searchParams.get('severity') ?? undefined,
    });
    if (!parsed.success) throw ApiError.invalid('invalid expiration filters');

    const { organizationId, withinDays, severity } = parsed.data;

    const rows = await tx<ExpirationRow[]>`
      SELECT * FROM v_expiration_dashboard
      WHERE expires_at <= now() + (${withinDays} || ' days')::interval
        ${organizationId ? tx`AND organization_id = ${organizationId}::uuid` : tx``}
        ${severity ? tx`AND severity = ${severity}::alert_severity` : tx``}
      ORDER BY expires_at
      LIMIT 500
    `;

    return {
      expirations: rows.map((r) => ({
        id: r.id,
        organizationId: r.organization_id,
        organizationName: r.organization_name,
        kind: r.kind,
        nodeId: r.node_id,
        label: r.label,
        expiresAt: r.expires_at,
        autoRenew: r.auto_renew,
        criticality: r.criticality,
        severity: r.severity,
        daysRemaining: r.days_remaining,
      })),
    };
  },
  { permissions: ['asset:read'] },
);

export const dynamic = 'force-dynamic';
