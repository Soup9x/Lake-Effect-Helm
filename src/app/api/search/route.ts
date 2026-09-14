import { z } from 'zod';
import { tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { MAX_PAGE_SIZE, SEARCHABLE_ENTITY_TYPES, search } from '@/lib/search/service';

const querySchema = z.object({
  q: z.string().min(1, 'a search term is required'),
  organizationId: z.guid().optional(),
  // Repeatable: ?type=asset_node&type=contact
  type: z.array(z.enum(SEARCHABLE_ENTITY_TYPES)).optional(),
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
      type: url.searchParams.getAll('type').length > 0 ? url.searchParams.getAll('type') : undefined,
      limit: url.searchParams.get('limit') ?? undefined,
      offset: url.searchParams.get('offset') ?? undefined,
    });

    if (!parsed.success) {
      throw ApiError.invalid('invalid search parameters', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }

    const { q, organizationId, type, limit, offset } = parsed.data;
    return search(tx, { query: q, organizationId, entityTypes: type, limit, offset });
  },
  { permissions: ['asset:read'] },
);

export const dynamic = 'force-dynamic';
