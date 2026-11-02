import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { createBoardLink, listBoardLinks, normaliseOrigin } from '@/lib/homarr/board';

/**
 * Homarr board links (1240). Gated on tenant:write here and again in the
 * SECURITY DEFINER functions.
 *
 * The token is returned exactly once, in the response that creates it, and
 * never again: only its SHA-256 is stored.
 */
const schema = z.object({
  name: z.string().trim().min(1).max(120),
  /** Homarr addresses, as typed. Reduced to origins below. */
  allowedOrigins: z.array(z.string().trim().min(1).max(500)).min(1).max(10),
  showDetails: z.boolean(),
});

export const GET = tenantRoute(
  async ({ tx }) => ({ links: await listBoardLinks(tx) }),
  { permissions: ['tenant:write'] },
);

export const POST = tenantRoute(
  async ({ tx, request }) => {
    const body = await readJson(request, (raw) => {
      const result = schema.safeParse(raw);
      if (!result.success) throw ApiError.invalid('invalid Homarr board link', { issues: zodIssues(result.error) });
      return result.data;
    });

    const origins: string[] = [];
    for (const typed of body.allowedOrigins) {
      const origin = normaliseOrigin(typed);
      if (!origin) {
        throw ApiError.invalid(`${typed} is not a web address; give Homarr's address the way you open it, like https://homarr.example.com or http://192.168.1.20:7575`);
      }
      if (!origins.includes(origin)) origins.push(origin);
    }

    const created = await createBoardLink(tx, { name: body.name, allowedOrigins: origins, showDetails: body.showDetails });
    return { id: created.id, token: created.token, links: await listBoardLinks(tx) };
  },
  { permissions: ['tenant:write'] },
);

export const dynamic = 'force-dynamic';
