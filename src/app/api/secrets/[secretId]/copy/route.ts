import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { getSecretService } from '@/lib/services';

const bodySchema = z.object({ field: z.string().max(64).default('password') });

/**
 * POST /api/secrets/:secretId/copy
 *
 * Called by the UI when a value reaches the clipboard.
 *
 * Worth having as its own event: a technician who reveals a password on screen
 * and one who copies it have both taken it out of the system, and an audit
 * trail showing only the reveal understates what happened. A clipboard is also
 * readable by every other application on the machine.
 */
export const POST = tenantRoute(
  async ({ request, params, identity }) => {
    const secretId = params.secretId;
    if (!secretId || !z.guid().safeParse(secretId).success) {
      throw ApiError.invalid('secretId must be a UUID');
    }

    const body = await readJson(request, (raw) => {
      const result = bodySchema.safeParse(raw ?? {});
      if (!result.success) throw ApiError.invalid('invalid copy request');
      return result.data;
    });

    const auditEventUid = await getSecretService().recordCopy(
      { tenantId: identity.tenantId, actorId: identity.actorId },
      secretId,
      body.field,
    );

    return { auditEventUid };
  },
  { permissions: ['secret:read'] },
);

export const dynamic = 'force-dynamic';
