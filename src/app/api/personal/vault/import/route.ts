import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { importEntries } from '@/lib/personal/vault';
import { requirePerson, vaultEntrySchema } from '@/lib/personal/http';
import { MAX_IMPORT_ENTRIES } from '@/lib/personal/import';

/**
 * POST /api/personal/vault/import — many entries into the signed-in person's
 * own vault, from another password manager's export.
 *
 * THE FILE IS READ IN THE BROWSER (src/lib/personal/import.ts), which shows
 * what it found before anything is sent; this route is handed the entries and
 * validates each exactly as a single add is validated. All of them land in one
 * transaction, or none do.
 */
const schema = z.object({
  entries: z.array(vaultEntrySchema).min(1).max(MAX_IMPORT_ENTRIES),
});

export const POST = tenantRoute(async ({ tx, request, identity }) => {
  requirePerson(identity);
  const body = await readJson(request, (raw) => {
    const result = schema.safeParse(raw);
    if (!result.success) {
      throw ApiError.invalid(`between 1 and ${MAX_IMPORT_ENTRIES} entries, each with a name`, {
        issues: zodIssues(result.error),
      });
    }
    return result.data;
  }, 16 * 1024 * 1024);
  return await importEntries(tx, identity.tenantId, identity.actorId, body.entries);
});

export const dynamic = 'force-dynamic';
