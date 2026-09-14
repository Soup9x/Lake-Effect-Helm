import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { getSecretService } from '@/lib/services';

const bodySchema = z.object({
  reason: z.string().max(500).optional(),
  purpose: z.enum(['view', 'copy', 'autofill', 'export', 'integration']).default('view'),
  version: z.number().int().min(1).optional(),
});

/**
 * POST /api/secrets/:secretId/reveal
 *
 * POST, not GET, and deliberately so. A GET would end up in browser history, in
 * a proxy access log, in a Referer header, and would be prefetchable and
 * CSRF-able — for the one endpoint in the product that hands out plaintext
 * credentials.
 *
 * The response carries `auditEventUid`. Every reveal is recorded before the
 * material is returned; surfacing the id lets support answer "who saw this and
 * when" from one lookup, and lets the UI cite it in a break-glass confirmation.
 */
export const POST = tenantRoute(
  async ({ request, params, identity }) => {
    const secretId = params.secretId;
    if (!secretId || !z.guid().safeParse(secretId).success) {
      throw ApiError.invalid('secretId must be a UUID');
    }

    const body = await readJson(request, (raw) => {
      const result = bodySchema.safeParse(raw ?? {});
      if (!result.success) throw ApiError.invalid('invalid reveal request');
      return result.data;
    });

    // Refusals throw SecretAccessDeniedError, which the handler maps to a
    // status the client can act on — step_up_required prompts a re-auth,
    // forbidden does not. The denial is already committed to the audit log by
    // the time this throws.
    const revealed = await getSecretService().reveal(
      {
        tenantId: identity.tenantId,
        actorId: identity.actorId,
        actorType: identity.actorType,
      },
      secretId,
      {
        ...(body.reason ? { reason: body.reason } : {}),
        purpose: body.purpose,
        ...(body.version ? { version: body.version } : {}),
      },
    );

    // Dispose immediately: the plaintext exists in this process only for as long
    // as it takes to serialise the response.
    return revealed.value.use((plaintext) => ({
      secretId: revealed.secretId,
      version: revealed.version,
      kind: revealed.kind,
      value: plaintext,
      auditEventUid: revealed.auditEventUid,
    }));
  },
  { permissions: ['secret:reveal'] },
);

export const dynamic = 'force-dynamic';
