import { z } from 'zod';
import { tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';

/** "Sync now" for one cluster (1110): due now, run by the worker within a minute. */
const idSchema = z.guid();

export const POST = tenantRoute(
  async ({ tx, params }) => {
    const id = idSchema.safeParse(params.connectionId);
    if (!id.success) throw ApiError.notFound('there is no such connection');
    const [row] = await tx<{ request_proxmox_sync: boolean }[]>`SELECT helm.request_proxmox_sync(${id.data}::uuid)`;
    if (!row?.request_proxmox_sync) throw ApiError.invalid('that connection does not exist, or syncing is turned off');
    return { queued: true };
  },
  { permissions: ['integration:hypervisor:manage'] },
);

export const dynamic = 'force-dynamic';
