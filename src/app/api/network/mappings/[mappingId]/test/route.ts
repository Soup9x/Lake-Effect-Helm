import { z } from 'zod';
import { tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { getSecretService } from '@/lib/services';
import { UnifiError, inspectCertificate, listSites } from '@/lib/unifi/client';

const idSchema = z.guid();

interface MappingRow {
  id: string;
  name: string;
  controller_url: string;
  unifi_site_id: string;
  api_key_set: boolean;
  tls_pinned_sha256: string | null;
}

/**
 * Prove a controller is reachable and the key works, before a sync depends on it.
 *
 * THREE STAGES, IN THIS ORDER, and the order is the security property:
 *
 *   1. READ THE CERTIFICATE WITHOUT TRUSTING IT. A TLS connection that sends
 *      nothing, just to learn the fingerprint. An operator cannot pin a
 *      certificate they have not been shown, and showing it must not cost them
 *      the API key.
 *
 *   2. DECIDE WHETHER WE CAN TALK AT ALL. If the certificate chains to a CA
 *      this host trusts, ordinary verification applies. If it does not — the
 *      normal state of a local UniFi console — the mapping needs a pin, and
 *      without one the test STOPS HERE and reports the fingerprint for the
 *      operator to accept. It does not quietly proceed.
 *
 *   3. ONLY THEN USE THE KEY. GET /sites, which is the cheapest call that
 *      exercises authentication, the version floor and the site id together.
 *
 * What this cannot prove is that the key has the right scope on every endpoint
 * the sync uses — /sites answering does not guarantee /devices will. The
 * response says so rather than showing a tick that means more than it does.
 */
export const POST = tenantRoute(
  async ({ tx, params, session }) => {
    const mappingId = idSchema.safeParse(params.mappingId);
    if (!mappingId.success) throw ApiError.invalid('invalid mapping id');

    const rows = await tx<MappingRow[]>`SELECT * FROM helm.unifi_mappings()`;
    const mapping = rows.find((m) => m.id === mappingId.data);
    if (!mapping) throw ApiError.notFound('there is no such controller mapping');

    // Stage 1.
    let certificate;
    try {
      certificate = await inspectCertificate(mapping.controller_url);
    } catch (error) {
      if (!(error instanceof UnifiError)) throw error;
      return {
        ok: false,
        stage: 'tls' as const,
        message: error.message,
        remedy: error.remedy ?? null,
      };
    }

    // Stage 2.
    const pinned = mapping.tls_pinned_sha256;
    const pinMatches = pinned !== null && pinned === certificate.sha256;

    if (!certificate.trusted && !pinMatches) {
      return {
        ok: false,
        stage: 'tls' as const,
        message: pinned
          ? 'The controller is presenting a different certificate from the one pinned for this mapping.'
          : 'The controller’s certificate is not trusted by this server.',
        remedy: pinned
          ? 'If the controller was legitimately rebuilt or renewed, accept the new fingerprint below. If it was not, stop and find out why.'
          : 'A local UniFi console ships a self-signed certificate. Check the fingerprint below against the console, then accept it to pin it for this mapping. Pinning is not the same as turning verification off — the mapping will accept this certificate and no other.',
        certificate: {
          sha256: certificate.sha256,
          subject: certificate.subject,
          issuer: certificate.issuer,
          validTo: certificate.validTo,
          selfSigned: certificate.selfSigned,
        },
      };
    }

    if (!mapping.api_key_set) {
      return {
        ok: false,
        stage: 'credential' as const,
        message: 'The certificate is acceptable, but no API key has been stored yet.',
        remedy:
          'Create one in the console under Settings → Control Plane → Integrations → API Keys, then save it here.',
      };
    }

    // Stage 3. The key is revealed through the audited path, as a reveal with a
    // stated reason, so a connection test leaves the same trail an actual poll
    // would — testing a credential is using it.
    const [secretRow] = await tx<{ api_key_secret_id: string }[]>`
      SELECT api_key_secret_id FROM unifi_site_mapping WHERE id = ${mappingId.data}::uuid
    `;
    if (!secretRow?.api_key_secret_id) {
      throw ApiError.invalid('the mapping has no stored API key');
    }

    const revealed = await getSecretService().reveal(
      { tenantId: session.tenantId, actorId: session.actorId, actorType: session.actorType },
      secretRow.api_key_secret_id,
      { purpose: 'integration', reason: `connection test for ${mapping.name}` },
    );

    try {
      const sites = await listSites({
        controllerUrl: mapping.controller_url,
        apiKey: revealed.value.expose(),
        pinnedSha256: pinMatches ? pinned : null,
        timeoutMs: 15_000,
      });

      const match = sites.find((s) => s.id === mapping.unifi_site_id);

      return {
        ok: match !== undefined,
        stage: 'sites' as const,
        message: match
          ? `Reached the controller and found site "${match.name ?? match.id}".`
          : `The key works, but this controller has no site with id "${mapping.unifi_site_id}".`,
        remedy: match
          ? null
          : `Sites on this controller: ${sites.map((s) => `${s.name ?? '(unnamed)'} (${s.id})`).join(', ') || 'none'}.`,
        stillUnproven: match
          ? 'This checked /sites. It does not guarantee the key has scope on /devices and /clients — the first sync will show that.'
          : null,
        certificate: {
          sha256: certificate.sha256,
          subject: certificate.subject,
          selfSigned: certificate.selfSigned,
          pinned: pinMatches,
        },
      };
    } catch (error) {
      if (!(error instanceof UnifiError)) throw error;
      return {
        ok: false,
        stage: 'api' as const,
        message: error.message,
        remedy: error.remedy ?? null,
      };
    } finally {
      revealed.value.dispose();
    }
  },
  { permissions: ['integration:network:manage'] },
);

export const dynamic = 'force-dynamic';
