import { z } from 'zod';
import { tenantRoute, readJson } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { getExportService } from '@/lib/exports/service';

const idSchema = z.guid();
const revokeSchema = z.object({ reason: z.string().trim().min(10).max(2000) });

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

export const GET = tenantRoute(
  async ({ identity, params }) => {
    const exportJobId = idSchema.safeParse(params.exportJobId);
    if (!exportJobId.success) throw ApiError.invalid('invalid export id');

    const job = await getExportService().get(
      { tenantId: identity.tenantId, actorId: identity.actorId, actorType: identity.actorType },
      exportJobId.data,
    );
    return { export: job };
  },
  { permissions: ['export:create'] },
);

/**
 * DELETE /api/exports/:id — revoke.
 *
 * Available to the requester as well as an approver, and that is deliberate:
 * the person who realises they asked for the wrong thing should be able to stop
 * it without first finding a second person. The database enforces the same rule.
 */
export const DELETE = tenantRoute(
  async ({ identity, params, request }) => {
    const exportJobId = idSchema.safeParse(params.exportJobId);
    if (!exportJobId.success) throw ApiError.invalid('invalid export id');

    const { reason } = await readJson(request, parser(revokeSchema, 'a revocation needs a reason'));
    const revoked = await getExportService().revoke(
      { tenantId: identity.tenantId, actorId: identity.actorId, actorType: identity.actorType },
      exportJobId.data,
      reason,
    );

    return { revoked, message: revoked ? 'Export revoked.' : 'Export was already revoked.' };
  },
  { permissions: ['export:create'] },
);

export const dynamic = 'force-dynamic';
