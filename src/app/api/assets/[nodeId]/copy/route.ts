import { z } from 'zod';
import { readJson, serviceRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { copyEntries } from '@/lib/assets/copy';

/**
 * POST /api/assets/:nodeId/copy — a new entry from this one, under a new name.
 *
 * What comes across, and how a credential's password is read and stored for
 * the copy, is copyEntries()'s business (src/lib/assets/copy.ts). A
 * serviceRoute, as the reveal route is, so the password's reveal is audited
 * with this request's id, address and user agent.
 */
const schema = z.object({
  name: z.string().trim().min(1).max(200),
  /** For a password that requires one, recorded with the reveal. */
  reason: z.string().trim().max(500).optional(),
});

export const POST = serviceRoute(
  async ({ actor, request, params }) => {
    const nodeId = z.guid().safeParse(params.nodeId);
    if (!nodeId.success) throw ApiError.invalid('not an entry id');

    const body = await readJson(request, (raw) => {
      const result = schema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('a name for the copy', { issues: zodIssues(result.error) });
      }
      return result.data;
    });

    const [copy] = await copyEntries(actor, [{ id: nodeId.data, name: body.name }], { reason: body.reason });
    return {
      asset: { id: copy!.id, name: copy!.name, nodeType: copy!.nodeType },
      passwordCopied: copy!.passwordCopied,
    };
  },
  { permissions: ['asset:write'] },
);

export const dynamic = 'force-dynamic';
