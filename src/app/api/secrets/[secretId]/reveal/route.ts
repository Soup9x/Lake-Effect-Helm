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

    /*
     * A TOTP SEED IS NOT REVEALABLE HERE, and by 0590 this is no longer the
     * check that enforces it.
     *
     * The seed is a code-generating key with an unbounded lifetime. Handing it
     * to a browser means every future code for that account can be computed off
     * the record, by anything that scraped the response, forever — which makes
     * the secret:reveal gate on the code endpoint decorative. POST
     * /api/assets/{nodeId}/totp/code generates the code server-side and returns
     * six digits.
     *
     * That rule now lives in helm.reveal_secret, which refuses a seed under any
     * purpose but 'totp', 'export' and 'rotation'. So the ordinary attempt never
     * gets here: it is denied before the key is unwrapped, and it writes one
     * `secret.reveal_denied` row naming the cause. This check used to BE the
     * enforcement, and refused after a successful reveal — which worked, but
     * recorded the attempt as `secret.revealed` / success, indistinguishable
     * from a technician legitimately reading a code.
     *
     * What still arrives here is purpose 'export' on a seed that really is in a
     * live export job, held by a caller who really does have secret:export. The
     * database is right to grant that; this route is still right to refuse it,
     * because the offboarding bundle is rendered by the export worker and never
     * travels through an HTTP response to a browser. The reveal genuinely
     * happened, so its success row stands; auditRevealWithheld records that the
     * material was then withheld, and carries the granted event's id so the two
     * rows pair up.
     */
    if (revealed.kind === 'totp_seed') {
      revealed.value.dispose();
      await getSecretService().auditRevealWithheld(
        {
          tenantId: identity.tenantId,
          actorId: identity.actorId,
          actorType: identity.actorType,
        },
        secretId,
        {
          cause: 'seed_not_directly_revealable',
          purpose: body.purpose,
          grantedEventUid: revealed.auditEventUid,
        },
      );
      throw ApiError.forbidden(
        'a TOTP seed cannot be read directly — request the current code instead',
      );
    }

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
