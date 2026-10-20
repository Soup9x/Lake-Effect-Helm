import { tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';

/**
 * "Sync now" (0980): makes the connection due, and the worker runs it within
 * a minute. Not run here — paging every device inside an HTTP request would
 * hold a transaction open for as long as NinjaOne takes.
 */
export const POST = tenantRoute(
  async ({ tx }) => {
    const [row] = await tx<{ request_ninja_sync: boolean }[]>`SELECT helm.request_ninja_sync()`;
    if (!row?.request_ninja_sync) {
      throw ApiError.invalid('NinjaOne is not set up, or syncing is turned off');
    }
    return { queued: true };
  },
  { permissions: ['integration:rmm:manage'] },
);

export const dynamic = 'force-dynamic';
