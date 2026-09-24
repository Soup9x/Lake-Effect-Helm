import { z } from 'zod';
import { tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';

/**
 * DELETE one line.
 *
 * A synced line deletes like any other and is re-derived on the next poll for
 * as long as the controller still reports that uplink. Removing a line the
 * telemetry keeps asserting is therefore temporary, and saying so in the
 * response lets the interface say it too rather than leaving somebody to
 * discover it five minutes later.
 */
export const DELETE = tenantRoute(
  async ({ tx, params }) => {
    const siteId = params.siteId;
    const linkId = params.linkId;
    if (!siteId || !z.guid().safeParse(siteId).success) {
      throw ApiError.invalid('siteId must be a UUID');
    }
    if (!linkId || !z.guid().safeParse(linkId).success) {
      throw ApiError.invalid('linkId must be a UUID');
    }

    const [row] = await tx<{ id: string; source: string }[]>`
      DELETE FROM topology_link
      WHERE id = ${linkId}::uuid AND site_id = ${siteId}::uuid
      RETURNING id, source::text AS source
    `;
    if (!row) throw ApiError.notFound('no such topology link');

    return { deleted: row.id, wasSynced: row.source === 'unifi_sync' };
  },
  { permissions: ['asset:write'] },
);

export const dynamic = 'force-dynamic';
