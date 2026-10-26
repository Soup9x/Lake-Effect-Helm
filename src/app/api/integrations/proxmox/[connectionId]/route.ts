import { z } from 'zod';
import { tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { listProxmoxConnections } from '@/lib/proxmox/queries';

/**
 * Disconnect a Proxmox cluster (1110). The hosts and VMs it imported stay;
 * only the links back to Proxmox go.
 */
const idSchema = z.guid();

export const DELETE = tenantRoute(
  async ({ tx, params }) => {
    const id = idSchema.safeParse(params.connectionId);
    if (!id.success) throw ApiError.notFound('there is no such connection');
    const [row] = await tx<{ forget_proxmox_connection: boolean }[]>`
      SELECT helm.forget_proxmox_connection(${id.data}::uuid)
    `;
    if (!row?.forget_proxmox_connection) throw ApiError.notFound('there is no such connection');
    return { connections: await listProxmoxConnections(tx) };
  },
  { permissions: ['integration:hypervisor:manage'] },
);

export const dynamic = 'force-dynamic';
