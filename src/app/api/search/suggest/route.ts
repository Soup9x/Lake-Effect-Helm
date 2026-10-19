import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { search } from '@/lib/search/service';
import { clientForPath } from '@/lib/search/scope';

/**
 * POST /api/search/suggest — what the top bar's search box shows as you type.
 *
 * A POST WITH A BODY, NOT A GET, on purpose. /search says why it was a plain
 * form: a request per keystroke puts every partial hostname into the URL, and
 * URLs are what access logs keep. A body is not logged, so typing "acme-fw" is
 * not seven log lines.
 *
 * `path` is the page the box is on. It decides which client "This client"
 * means (lib/search/scope.ts) and is resolved under RLS like everything else.
 * An empty `q` returns only that client, so the box can label its toggle
 * before anybody has typed.
 *
 * The same helm.search() as the full page, capped: these are suggestions, and
 * "See all results" is one click away.
 */
const bodySchema = z.object({
  q: z.string().max(256),
  path: z.string().max(512).default('/'),
  scope: z.enum(['client', 'all']).default('client'),
});

const SUGGESTION_LIMIT = 8;

export const POST = tenantRoute(
  async ({ tx, request }) => {
    const body = await readJson(request, (raw) => {
      const parsed = bodySchema.safeParse(raw);
      if (!parsed.success) throw ApiError.invalid('invalid search', { issues: zodIssues(parsed.error) });
      return parsed.data;
    });

    const client = await clientForPath(tx, body.path);
    const scoped = body.scope === 'client' && client !== null;
    const q = body.q.trim();
    if (q.length === 0) return { client, scoped, groups: [], hasMore: false };

    const results = await search(tx, {
      query: q,
      ...(scoped ? { organizationId: client.id } : {}),
      limit: SUGGESTION_LIMIT,
    });

    // The client each hit belongs to, for the line under it when searching
    // everywhere. One query for the page, not one per hit.
    const ids = [...new Set(results.hits.map((h) => h.organizationId))];
    const names = ids.length === 0 ? [] : await tx<{ id: string; name: string }[]>`
      SELECT id, name FROM organization WHERE id = ANY(${ids}::uuid[])
    `;
    const nameOf = new Map(names.map((r) => [r.id, r.name]));

    return {
      client,
      scoped,
      hasMore: results.hasMore,
      groups: results.groups.map((g) => ({
        kind: g.kind,
        label: g.label,
        hits: g.hits.map((h) => ({
          key: `${h.entityType}:${h.entityId}`,
          title: h.title,
          subtitle: h.subtitle,
          organizationName: nameOf.get(h.organizationId) ?? null,
          href: h.href,
        })),
      })),
    };
  },
  { permissions: ['asset:read'] },
);

export const dynamic = 'force-dynamic';
