import { z } from 'zod';
import { tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { listM365Connections } from '@/lib/m365/queries';

/**
 * Disconnect a client's Microsoft 365 (0990). The contacts, licences and
 * domains it imported stay; only the links back to Microsoft 365 go.
 */
const idSchema = z.guid();

export const DELETE = tenantRoute(
  async ({ tx, params }) => {
    const id = idSchema.safeParse(params.connectionId);
    if (!id.success) throw ApiError.notFound('there is no such connection');
    const [row] = await tx<{ forget_m365_connection: boolean }[]>`
      SELECT helm.forget_m365_connection(${id.data}::uuid)
    `;
    if (!row?.forget_m365_connection) throw ApiError.notFound('there is no such connection');
    return { connections: await listM365Connections(tx) };
  },
  { permissions: ['integration:m365:manage'] },
);

export const dynamic = 'force-dynamic';
