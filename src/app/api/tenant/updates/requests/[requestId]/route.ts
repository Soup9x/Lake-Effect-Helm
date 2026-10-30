import { tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { cancelUpdate } from '@/lib/updates/requests';

/** DELETE: cancel a scheduled update that has not started. */
export const DELETE = tenantRoute(
  async ({ tx, params }) => {
    const id = params.requestId ?? '';
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw ApiError.notFound('no such update');
    return { request: await cancelUpdate(tx, id) };
  },
  { permissions: ['tenant:write'] },
);

export const dynamic = 'force-dynamic';
