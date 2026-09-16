import { z } from 'zod';
import { tenantRoute, readJson } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { getExportService } from '@/lib/exports/service';

const scopeSchema = z.object({
  nodeIds: z.array(z.guid()).max(5000).optional(),
  nodeTypes: z.array(z.string().max(40)).max(20).optional(),
  includeSops: z.boolean().optional(),
  includeGraph: z.boolean().optional(),
});

const requestSchema = z.object({
  organizationId: z.guid(),
  kind: z.enum(['client_offboarding', 'compliance_audit', 'disaster_recovery', 'asset_inventory', 'ad_hoc']),
  format: z.enum(['pdf', 'json', 'zip']).default('zip'),
  // Mirrors the database CHECK. Validating it here too means the requester gets
  // "write a longer reason" rather than a constraint violation.
  reason: z.string().trim().min(10).max(2000),
  includeSecrets: z.boolean().default(false),
  scope: scopeSchema.default({}),
  ttlHours: z.number().int().min(1).max(720).default(72),
});

/**
 * Zod schema to the parser readJson expects, with issues surfaced to the caller.
 * Matches the pattern in the other routes.
 */
const parser = <T>(schema: { safeParse: (raw: unknown) => { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, label: string) =>
  (raw: unknown): T => {
    const result = schema.safeParse(raw);
    if (!result.success) {
      throw ApiError.invalid(label, {
        issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return result.data;
  };

const listSchema = z.object({
  organizationId: z.guid().optional(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'expired', 'revoked']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * GET /api/exports — the export ledger.
 *
 * Deliberately readable by anyone who may create an export, not just by the
 * person who made each one. "Who exported this client's credentials, when, and
 * who approved it" is a question the whole team should be able to answer
 * without asking an administrator to run a query.
 */
export const GET = tenantRoute(
  async ({ tx: _tx, identity, request }) => {
    const url = new URL(request.url);
    const parsed = listSchema.safeParse({
      organizationId: url.searchParams.get('organizationId') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
    });
    if (!parsed.success) throw ApiError.invalid('invalid export filters');

    const { organizationId, status, limit } = parsed.data;
    const exports = await getExportService().list(
      { tenantId: identity.tenantId, actorId: identity.actorId, actorType: identity.actorType },
      {
        limit,
        ...(organizationId ? { organizationId } : {}),
        ...(status ? { status } : {}),
      },
    );
    return { exports };
  },
  { permissions: ['export:create'] },
);

/**
 * POST /api/exports — request one.
 *
 * A secret-bearing export is created but not renderable: helm.export_backlog()
 * only hands the worker jobs that a second person has approved. The response
 * says so explicitly rather than leaving the caller to infer it from a status.
 */
export const POST = tenantRoute(
  async ({ identity, request }) => {
    const body = await readJson(request, parser(requestSchema, 'invalid export request'));

    const result = await getExportService().request(
      { tenantId: identity.tenantId, actorId: identity.actorId, actorType: identity.actorType },
      body,
    );

    return {
      exportJobId: result.exportJobId,
      status: 'queued',
      needsApproval: result.needsApproval,
      message: result.needsApproval
        ? 'This export contains credentials and will not render until a second person approves it.'
        : 'Queued for rendering.',
    };
  },
  { permissions: ['export:create'] },
);

export const dynamic = 'force-dynamic';
