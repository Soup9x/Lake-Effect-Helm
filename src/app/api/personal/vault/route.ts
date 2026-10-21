import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { createEntry, listVault } from '@/lib/personal/vault';
import { requirePerson, vaultEntrySchema } from '@/lib/personal/http';

/**
 * The signed-in person's own vault (1030). No permission gates it beyond
 * being a person signed in to this tenant: the owner policy is the rule.
 */
export const GET = tenantRoute(async ({ tx, identity }) => {
  requirePerson(identity);
  return { entries: await listVault(tx) };
});

export const POST = tenantRoute(async ({ tx, request, identity }) => {
  requirePerson(identity);
  const body = await readJson(request, (raw) => {
    const result = vaultEntrySchema.safeParse(raw);
    if (!result.success) throw ApiError.invalid('a name for the entry', { issues: zodIssues(result.error) });
    return result.data;
  });
  return { entry: await createEntry(tx, identity.tenantId, identity.actorId, body) };
});

export const dynamic = 'force-dynamic';
