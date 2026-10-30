import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { countDeliveryLog, listDeliveryLog } from '@/lib/notifications/queries';

/**
 * The notification delivery log (1220).
 *
 * GET reads one side of the archive: the live log, or ?archived=1. Open to any
 * tenant-wide role, like the destinations it describes.
 *
 * POST archives, restores or deletes, and needs integration:manage. The
 * database decides what each may touch: a pending delivery is never archived,
 * and only archived rows at least two days old are ever deleted — so a delete
 * can report fewer rows than were asked for, and the count says how many.
 */
const actionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('archive'),
    ids: z.array(z.guid()).min(1).max(1000).optional(),
    /** With no ids: every finished delivery older than this. 0 is all of them. */
    olderThanDays: z.number().int().min(0).max(3650).default(0),
  }),
  z.object({ action: z.literal('restore'), ids: z.array(z.guid()).min(1).max(1000).optional() }),
  z.object({ action: z.literal('delete'), ids: z.array(z.guid()).min(1).max(1000).optional() }),
]);

export const GET = tenantRoute(async ({ tx, request }) => {
  const archived = new URL(request.url).searchParams.get('archived') === '1';
  const [deliveries, counts] = await Promise.all([
    listDeliveryLog(tx, archived),
    countDeliveryLog(tx),
  ]);
  return { deliveries, counts };
});

export const POST = tenantRoute(
  async ({ tx, request }) => {
    const body = await readJson(request, (raw) => {
      const result = actionSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid delivery log action', { issues: zodIssues(result.error) });
      }
      return result.data;
    });
    const ids = body.ids ?? null;

    let count: number;
    if (body.action === 'archive') {
      const [row] = await tx<{ n: number }[]>`
        SELECT helm.archive_notifications(${ids}::uuid[], ${body.olderThanDays}) AS n`;
      count = row?.n ?? 0;
    } else if (body.action === 'restore') {
      const [row] = await tx<{ n: number }[]>`
        SELECT helm.restore_notifications(${ids}::uuid[]) AS n`;
      count = row?.n ?? 0;
    } else {
      const [row] = await tx<{ n: number }[]>`
        SELECT helm.delete_archived_notifications(${ids}::uuid[]) AS n`;
      count = row?.n ?? 0;
    }
    return { count, counts: await countDeliveryLog(tx) };
  },
  { permissions: ['integration:manage'] },
);

export const dynamic = 'force-dynamic';
