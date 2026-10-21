import { z } from 'zod';
import { tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { currentCode } from '@/lib/personal/vault';
import { requirePerson } from '@/lib/personal/http';

/** The current one-time code of one of the signed-in person's own entries. The seed never leaves. */
export const POST = tenantRoute(async ({ tx, identity, params }) => {
  requirePerson(identity);
  const id = z.guid().safeParse(params.entryId);
  if (!id.success) throw ApiError.invalid('not an entry id');
  return currentCode(tx, identity.tenantId, id.data);
});

export const dynamic = 'force-dynamic';
