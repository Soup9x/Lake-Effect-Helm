import { z } from 'zod';
import { tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';

/** DELETE one line. Nothing re-derives it, so it stays deleted. */
export const DELETE = tenantRoute(
  async ({ tx, params }) => {
    const networkId = params.networkId;
    const linkId = params.linkId;
    if (!networkId || !z.guid().safeParse(networkId).success) {
      throw ApiError.invalid('networkId must be a UUID');
    }
    if (!linkId || !z.guid().safeParse(linkId).success) {
      throw ApiError.invalid('linkId must be a UUID');
    }

    const [row] = await tx<{ id: string }[]>`
      DELETE FROM topology_link
      WHERE id = ${linkId}::uuid AND network_id = ${networkId}::uuid
      RETURNING id
    `;
    if (!row) throw ApiError.notFound('no such topology link');

    return { deleted: row.id };
  },
  { permissions: ['asset:write'] },
);

export const dynamic = 'force-dynamic';
