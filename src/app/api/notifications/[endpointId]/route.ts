import { z } from 'zod';
import { tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';

/** Validated rather than passed through: params is Record<string, string> and
 *  an absent segment would otherwise reach the query as undefined. */
const idSchema = z.guid();

/**
 * Forget a destination entirely.
 *
 * DELETE rather than `is_active = false`, so a decommissioned channel does not
 * leave a live webhook URL in the database until somebody notices. Turning it
 * off without forgetting it is a PUT with isActive false.
 */
export const DELETE = tenantRoute(
  async ({ tx, params }) => {
    const endpointId = idSchema.safeParse(params.endpointId);
    if (!endpointId.success) throw ApiError.invalid('invalid destination id');

    const [gone] = await tx<{ forget_webhook_endpoint: boolean }[]>`
      SELECT helm.forget_webhook_endpoint(${endpointId.data}::uuid)
    `;
    if (!gone?.forget_webhook_endpoint) {
      throw ApiError.notFound('there is no such notification destination');
    }
    return { removed: true };
  },
  { permissions: ['integration:manage'] },
);

export const dynamic = 'force-dynamic';
