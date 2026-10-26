import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { BASE_URL, ProxmoxError, readCertificate } from '@/lib/proxmox/client';

/**
 * The certificate a Proxmox address presents (1110), so a person can compare
 * its fingerprint with the one Proxmox shows under the host's System →
 * Certificates and decide to trust it. Connects, reads the certificate and
 * hangs up: nothing is sent, so no credential is involved.
 */
const schema = z.object({
  baseUrl: z.string().trim()
    .transform((v) => v.replace(/\/+$/, ''))
    .pipe(z.string().regex(BASE_URL, 'an https address with no path, like https://pve.example.com:8006')),
});

export const POST = tenantRoute(
  async ({ request }) => {
    const body = await readJson(request, (raw) => {
      const result = schema.safeParse(raw);
      if (!result.success) throw ApiError.invalid('invalid address', { issues: zodIssues(result.error) });
      return result.data;
    });
    try {
      return { certificate: await readCertificate(body.baseUrl) };
    } catch (error) {
      if (error instanceof ProxmoxError) {
        throw ApiError.invalid(error.message, { kind: error.kind, ...(error.remedy ? { remedy: error.remedy } : {}) });
      }
      throw error;
    }
  },
  { permissions: ['integration:hypervisor:manage'] },
);

export const dynamic = 'force-dynamic';
