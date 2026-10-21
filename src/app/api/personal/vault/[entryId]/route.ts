import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { deleteEntry, getEntry, updateEntry } from '@/lib/personal/vault';
import { requirePerson, vaultEntrySchema } from '@/lib/personal/http';

/**
 * One entry of the signed-in person's vault. Somebody else's entry is a 404,
 * exactly like one that does not exist: the owner policy matches no row.
 */
const patchSchema = vaultEntrySchema.partial().refine((v) => Object.keys(v).length > 0, { message: 'nothing to change' });

function entryId(params: Record<string, string>): string {
  const id = z.guid().safeParse(params.entryId);
  if (!id.success) throw ApiError.invalid('not an entry id');
  return id.data;
}

export const PATCH = tenantRoute(async ({ tx, request, identity, params }) => {
  requirePerson(identity);
  const id = entryId(params);
  const body = await readJson(request, (raw) => {
    const result = patchSchema.safeParse(raw);
    if (!result.success) throw ApiError.invalid('invalid change', { issues: zodIssues(result.error) });
    return result.data;
  });
  if (!(await getEntry(tx, id))) throw ApiError.notFound('no such entry');
  return { entry: await updateEntry(tx, identity.tenantId, id, body) };
});

export const DELETE = tenantRoute(async ({ tx, identity, params }) => {
  requirePerson(identity);
  if (!(await deleteEntry(tx, entryId(params)))) throw ApiError.notFound('no such entry');
  return { deleted: true };
});

export const dynamic = 'force-dynamic';
