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
import { readJson, serviceRoute, tenantRoute } from '@/lib/api/handler';
import { withTenant } from '@/lib/db/client';
import { ApiError } from '@/lib/api/errors';
import { generateWebhookSecret, sealWebhookSecret } from '@/lib/unifi/webhook-secret';
import { UnifiError, registerWebhook } from '@/lib/unifi/client';
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

export const PUT = serviceRoute(
  async ({ request, params, actor }) => {
    const mappingId = idSchema.safeParse(params.mappingId);
    if (!mappingId.success) throw ApiError.invalid('invalid mapping id');

    const body = await readJson(request, (raw) => {
      const result = bodySchema.safeParse(raw ?? {});
      if (!result.success) throw ApiError.invalid('invalid webhook configuration');
      return result.data;
    });

    // Store the secret and COMMIT before talking to the controller. Registration
    // is up to 15 seconds of network I/O, which must not hold a connection idle
    // in a transaction; and when it failed inside the old single transaction,
    // the UnifiError escaped as a 500 and rolled the new secret back with it.
    const secret = generateWebhookSecret();
    const { mapping, apiKeySecretId } = await withTenant(actor, async (tx) => {
      const rows = await tx<MappingRow[]>`SELECT * FROM helm.unifi_mappings()`;
      const found = rows.find((m) => m.id === mappingId.data);
      if (!found) throw ApiError.notFound('there is no such controller mapping');

      // Generated, never chosen. A signing secret somebody invented is one
      // somebody can guess, and there is no reason for a human to pick this value.
      const sealed = await sealWebhookSecret(actor.tenantId, mappingId.data, secret);
      const [saved] = await tx<{ set_unifi_webhook_secret: boolean }[]>`
        SELECT helm.set_unifi_webhook_secret(
          ${mappingId.data}::uuid,
          ${sealed.wrapProvider}, ${sealed.kekId}, ${sealed.wrappedDek},
          ${sealed.ciphertext}, ${sealed.nonce}, ${sealed.tag}, ${sealed.aad})
      `;
      if (!saved?.set_unifi_webhook_secret) {
        throw ApiError.invalid('the webhook secret could not be stored');
      }

      const [keyRow] = await tx<{ api_key_secret_id: string | null }[]>`
        SELECT api_key_secret_id FROM unifi_site_mapping WHERE id = ${mappingId.data}::uuid
      `;
      return { mapping: found, apiKeySecretId: keyRow?.api_key_secret_id ?? null };
    });

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
      if (!apiKeySecretId) throw ApiError.invalid('the mapping has no stored API key');
      const revealed = await getSecretService().reveal(actor, apiKeySecretId, {
        purpose: 'integration',
        reason: `webhook registration for ${mapping.name}`,
      });
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
      } catch (error) {
        if (!(error instanceof UnifiError)) throw error;
        // Unreachable, refused or timed out: the secret is stored and the
        // endpoint can still be added in the console by hand, so this is a
        // result to show, not a failed request.
        registration = {
          attempted: true,
          ok: false,
          state: 'pending',
          message: error.remedy ? `${error.message} ${error.remedy}` : error.message,
        };
      } finally {
        revealed.value.dispose();
      }
    }

    const mappings = await withTenant(actor, async (tx) => {
      if (registration.attempted) {
        await tx`
          SELECT helm.set_unifi_webhook_state(
            ${mappingId.data}::uuid, ${registration.state}, ${registration.message})
        `;
      }
      return tx`SELECT * FROM helm.unifi_mappings()`;
    });

    return { secret, registration, mappings };
  },
  { permissions: ['integration:network:manage'] },
);

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
