import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import {
  addDependency, DEPENDENCY_KINDS, DependencyError, listDependencies, listDependents, removeDependency,
} from '@/lib/documents/links';

const idOrThrow = (raw: string | undefined): string => {
  const parsed = z.guid().safeParse(raw);
  if (!parsed.success) throw ApiError.invalid('invalid document id');
  return parsed.data;
};

/** GET — what this document depends on, and the documents that depend on it. */
export const GET = tenantRoute(
  async ({ tx, params }) => {
    const pageId = idOrThrow(params.pageId);
    return {
      dependencies: await listDependencies(tx, pageId),
      dependents: await listDependents(tx, 'document', pageId),
    };
  },
  { permissions: ['asset:read'] },
);

const addSchema = z.object({
  kind: z.enum(DEPENDENCY_KINDS),
  targetId: z.guid(),
  note: z.string().trim().max(1000).optional(),
});

/** POST — link this document to an asset, document, contact, location or diagram of the same client. */
export const POST = tenantRoute(
  async ({ tx, request, params, identity }) => {
    const pageId = idOrThrow(params.pageId);
    const body = await readJson(request, (raw) => {
      const result = addSchema.safeParse(raw);
      if (!result.success) throw ApiError.invalid('invalid dependency', { issues: zodIssues(result.error) });
      return result.data;
    });
    try {
      const id = await addDependency(tx, identity.tenantId, identity.actorId, {
        pageId, kind: body.kind, targetId: body.targetId, note: body.note || undefined,
      });
      return { id };
    } catch (error) {
      if (error instanceof DependencyError) {
        if (error.code === 'not_found') throw ApiError.notFound(error.message);
        if (error.code === 'duplicate') throw ApiError.conflict(error.message);
        throw ApiError.invalid(error.message);
      }
      throw error;
    }
  },
  { permissions: ['asset:write'] },
);

const removeSchema = z.object({ id: z.guid() });

/** DELETE — remove one dependency, by the link's id. */
export const DELETE = tenantRoute(
  async ({ tx, request, params }) => {
    const pageId = idOrThrow(params.pageId);
    const body = await readJson(request, (raw) => {
      const result = removeSchema.safeParse(raw);
      if (!result.success) throw ApiError.invalid('invalid dependency', { issues: zodIssues(result.error) });
      return result.data;
    });
    if (!(await removeDependency(tx, pageId, body.id))) throw ApiError.notFound('no such dependency');
    return { removed: true };
  },
  { permissions: ['asset:write'] },
);

export const dynamic = 'force-dynamic';
