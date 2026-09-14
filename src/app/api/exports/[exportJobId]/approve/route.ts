import { z } from 'zod';
import { tenantRoute, readJson } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { getExportService } from '@/lib/exports/service';

const idSchema = z.guid();
const approveSchema = z.object({ reason: z.string().trim().min(10).max(2000).optional() });

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

/**
 * POST /api/exports/:id/approve — the second pair of eyes.
 *
 * The route checks the permission; the DATABASE checks everything that matters
 * — that the approver is not the requester, that the job is still queued, that
 * it has not been approved already — and records the scope digest so a job
 * edited after review cannot be rendered on the strength of that review.
 *
 * Approval is therefore not something a client can talk its way into by
 * calling this endpoint cleverly.
 */
export const POST = tenantRoute(
  async ({ identity, params, request }) => {
    const exportJobId = idSchema.safeParse(params.exportJobId);
    if (!exportJobId.success) throw ApiError.invalid('invalid export id');

    // An approval without a note is fine: the job already carries the
    // requester's reason, and demanding a second one produces "ok" as a reason.
    const body = await readJson(request, parser(approveSchema, 'invalid approval'))
      .catch(() => ({ reason: undefined as string | undefined }));
    const actor = {
      tenantId: identity.tenantId,
      actorId: identity.actorId,
      actorType: identity.actorType,
    };

    await getExportService().approve(actor, exportJobId.data, body.reason);
    const job = await getExportService().get(actor, exportJobId.data);

    return { approved: true, export: job };
  },
  { permissions: ['export:approve'] },
);

export const dynamic = 'force-dynamic';
