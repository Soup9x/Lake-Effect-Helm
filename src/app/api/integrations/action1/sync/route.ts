import { tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';

/**
 * "Sync now" (1160): makes the connection due, and the worker runs it within
 * a minute rather than inside this request.
 */
export const POST = tenantRoute(
  async ({ tx }) => {
    const [row] = await tx<{ request_action1_sync: boolean }[]>`SELECT helm.request_action1_sync()`;
    if (!row?.request_action1_sync) {
      throw ApiError.invalid('Action1 is not set up, or syncing is turned off');
    }
    return { queued: true };
  },
  { permissions: ['integration:rmm:manage'] },
);

export const dynamic = 'force-dynamic';
