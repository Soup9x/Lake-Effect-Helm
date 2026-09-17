import { z } from 'zod';
import { tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { MAX_PAGE_SIZE, RESULT_KINDS, search } from '@/lib/search/service';

const querySchema = z.object({
  q: z.string().min(1, 'a search term is required'),
  organizationId: z.guid().optional(),
  // Repeatable: ?kind=client&kind=credential
  //
  // An allow-list rather than passing the parameter through: `kind` is a text
  // column, and letting a caller filter on an arbitrary value turns the filter
  // into a probe for which kinds exist.
  kind: z.array(z.enum(RESULT_KINDS)).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/**
 * GET /api/search?q=acme-fw-01
 *
 * Results are scoped by RLS on `search_document`, not by anything this route
 * does — a co-managed client searching "globex" gets nothing because the policy
 * says so, and would still get nothing if this handler were rewritten badly.
 */
export const GET = tenantRoute(
  async ({ tx, request }) => {
    const url = new URL(request.url);
    const parsed = querySchema.safeParse({
      q: url.searchParams.get('q') ?? '',
      organizationId: url.searchParams.get('organizationId') ?? undefined,
      kind: url.searchParams.getAll('kind').length > 0 ? url.searchParams.getAll('kind') : undefined,
      limit: url.searchParams.get('limit') ?? undefined,
      offset: url.searchParams.get('offset') ?? undefined,
    });

    if (!parsed.success) {
      throw ApiError.invalid('invalid search parameters', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }

    const { q, organizationId, kind, limit, offset } = parsed.data;
    return search(tx, { query: q, organizationId, kinds: kind, limit, offset });
  },
  { permissions: ['asset:read'] },
);

export const dynamic = 'force-dynamic';
