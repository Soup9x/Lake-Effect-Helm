import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { clearMyBrowsers } from '@/lib/extension/pairing';

const clearSchema = z.object({ id: z.guid().nullable().optional() });

/**
 * POST /api/extension/installs/clear — take removed and lapsed browsers off
 * your list (1180): the one named by `id`, or all of them without one.
 *
 * A live pairing is never cleared; it is removed first, which revokes it. An
 * administrator still sees cleared rows, and the audit still points at them.
 */
export const POST = tenantRoute(async ({ tx, request }) => {
  const body = await readJson(request, (raw) => {
    const result = clearSchema.safeParse(raw ?? {});
    if (!result.success) throw ApiError.invalid('not a paired browser id', { issues: zodIssues(result.error) });
    return result.data;
  });
  const cleared = await clearMyBrowsers(tx, body.id ?? null);
  if (body.id && cleared === 0) throw ApiError.notFound('no removed or lapsed browser by that id');
  return { cleared };
});

export const dynamic = 'force-dynamic';
