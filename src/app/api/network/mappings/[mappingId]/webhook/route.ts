/**
 * Configuring a mapping's webhook receiver.
 *
 * Gated on integration:network:manage, the same permission every other part of
 * mapping configuration needs. A signing secret is a way in: it must not be
 * easier to set than the controller URL it belongs to.
 *
 * PUT generates a secret and returns it ONCE. It is shown to the operator so
 * they can paste it into the console, and never again — what is stored is
 * sealed, and helm.unifi_mappings() reports only whether one exists.
 */
import { z } from 'zod';
import { tenantRoute, readJson } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { generateWebhookSecret, sealWebhookSecret } from '@/lib/unifi/webhook-secret';
import { registerWebhook } from '@/lib/unifi/client';
import { getSecretService } from '@/lib/services';

const idSchema = z.guid();

const bodySchema = z.object({
  /**
   * Whether to ask the controller to register the endpoint itself.
   *
   * Optional because it frequently cannot work: webhook registration is not
   * available on every console, and the fallback — the operator adding the
   * endpoint by hand — is a perfectly good outcome that should not require the
   * automated attempt to have been made first.
   */
  attemptRegistration: z.boolean().optional(),
  /** Where the controller should post. Required only when registering. */
  callbackUrl: z.string().trim().url().optional(),
});

interface MappingRow {
  id: string;
  name: string;
  controller_url: string;
  unifi_site_id: string;
  api_key_set: boolean;
  tls_pinned_sha256: string | null;
}

export const PUT = tenantRoute(
  async ({ tx, request, params, session }) => {
    const mappingId = idSchema.safeParse(params.mappingId);
    if (!mappingId.success) throw ApiError.invalid('invalid mapping id');

    const body = await readJson(request, (raw) => {
      const result = bodySchema.safeParse(raw ?? {});
      if (!result.success) throw ApiError.invalid('invalid webhook configuration');
      return result.data;
    });

    const rows = await tx<MappingRow[]>`SELECT * FROM helm.unifi_mappings()`;
    const mapping = rows.find((m) => m.id === mappingId.data);
    if (!mapping) throw ApiError.notFound('there is no such controller mapping');

    // Generated, never chosen. A signing secret somebody invented is one
    // somebody can guess, and there is no reason for a human to pick this value.
    const secret = generateWebhookSecret();
    const sealed = await sealWebhookSecret(session.tenantId, mappingId.data, secret);

    const [saved] = await tx<{ set_unifi_webhook_secret: boolean }[]>`
      SELECT helm.set_unifi_webhook_secret(
        ${mappingId.data}::uuid,
        ${sealed.wrapProvider}, ${sealed.kekId}, ${sealed.wrappedDek},
        ${sealed.ciphertext}, ${sealed.nonce}, ${sealed.tag}, ${sealed.aad})
    `;
    if (!saved?.set_unifi_webhook_secret) {
      throw ApiError.invalid('the webhook secret could not be stored');
    }

    /*
     * Optionally ask the controller to register the endpoint.
     *
     * A failure here is NOT an error for the request: the secret is stored, the
     * receiver works, and an operator can add the endpoint in the console by
     * hand. What the response carries is what happened, so the settings card
     * can say "this console does not support registration — add it manually"
     * rather than showing a tick that means nothing.
     */
    let registration: { attempted: boolean; ok: boolean; state: string; message: string | null } = {
      attempted: false,
      ok: false,
      state: 'pending',
      message: null,
    };

    if (body.attemptRegistration && body.callbackUrl && mapping.api_key_set) {
      const revealed = await getSecretService().reveal(
        { tenantId: session.tenantId, actorId: session.actorId, actorType: session.actorType },
        await apiKeySecretId(tx, mappingId.data),
        { purpose: 'integration', reason: `webhook registration for ${mapping.name}` },
      );
      try {
        const result = await registerWebhook({
          controllerUrl: mapping.controller_url,
          apiKey: revealed.value.expose(),
          pinnedSha256: mapping.tls_pinned_sha256,
          timeoutMs: 15_000,
          siteId: mapping.unifi_site_id,
          callbackUrl: body.callbackUrl,
        });
        registration = {
          attempted: true,
          ok: result.supported,
          state: result.supported ? 'pending' : 'unsupported',
          message: result.message,
        };
      } finally {
        revealed.value.dispose();
      }

      await tx`
        SELECT helm.set_unifi_webhook_state(
          ${mappingId.data}::uuid, ${registration.state}, ${registration.message})
      `;
    }

    return {
      // The one and only time this is returned. Paste it into the console now.
      secret,
      registration,
      mappings: await tx`SELECT * FROM helm.unifi_mappings()`,
    };
  },
  { permissions: ['integration:network:manage'] },
);

/** The mapping's API key, read inside the caller's transaction. */
async function apiKeySecretId(
  tx: Parameters<Parameters<typeof tenantRoute>[0]>[0]['tx'],
  mappingId: string,
): Promise<string> {
  const [row] = await tx<{ api_key_secret_id: string | null }[]>`
    SELECT api_key_secret_id FROM unifi_site_mapping WHERE id = ${mappingId}::uuid
  `;
  if (!row?.api_key_secret_id) {
    throw ApiError.invalid('the mapping has no stored API key');
  }
  return row.api_key_secret_id;
}

/** Stop listening. The stored secret goes with it. */
export const DELETE = tenantRoute(
  async ({ tx, params }) => {
    const mappingId = idSchema.safeParse(params.mappingId);
    if (!mappingId.success) throw ApiError.invalid('invalid mapping id');

    const [cleared] = await tx<{ set_unifi_webhook_state: boolean }[]>`
      SELECT helm.set_unifi_webhook_state(${mappingId.data}::uuid, 'disabled', NULL)
    `;
    if (!cleared?.set_unifi_webhook_state) {
      throw ApiError.notFound('there is no such controller mapping');
    }
    return { disabled: true };
  },
  { permissions: ['integration:network:manage'] },
);

export const dynamic = 'force-dynamic';
