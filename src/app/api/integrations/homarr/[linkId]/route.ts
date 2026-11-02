import { z } from 'zod';
import { tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { listBoardLinks, revokeBoardLink } from '@/lib/homarr/board';

/** Revoke a Homarr board link (1240). The page stops working at once. */
const idSchema = z.guid();

export const DELETE = tenantRoute(
  async ({ tx, params }) => {
    const id = idSchema.safeParse(params.linkId);
    if (!id.success) throw ApiError.notFound('there is no such link');
    await revokeBoardLink(tx, id.data);
    return { links: await listBoardLinks(tx) };
  },
  { permissions: ['tenant:write'] },
);

export const dynamic = 'force-dynamic';
