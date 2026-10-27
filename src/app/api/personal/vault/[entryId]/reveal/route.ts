import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { revealPassword } from '@/lib/personal/vault';
import { requirePerson } from '@/lib/personal/http';

/**
 * The password of one of the signed-in person's own entries, for showing or
 * copying, with one audit row that names the entry's id but not its name.
 */
const schema = z.object({ purpose: z.enum(['view', 'copy']).default('view') });

export const POST = tenantRoute(async ({ tx, request, identity, params }) => {
  requirePerson(identity, { allowExtension: true });
  const id = z.guid().safeParse(params.entryId);
  if (!id.success) throw ApiError.invalid('not an entry id');
  const body = await readJson(request, (raw) => {
    const result = schema.safeParse(raw ?? {});
    if (!result.success) throw ApiError.invalid('invalid reveal request');
    return result.data;
  });
  // The extension copies; it has no screen to show a password on (1120).
  if (identity.tokenType === 'browser_extension' && body.purpose !== 'copy') {
    throw ApiError.forbidden('the browser extension can only copy a password');
  }
  return revealPassword(tx, identity.tenantId, id.data, body.purpose);
});

export const dynamic = 'force-dynamic';
