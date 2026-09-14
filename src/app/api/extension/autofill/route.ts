import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';

const bodySchema = z.object({
  /** The browser-reported host. Never a page-supplied string. */
  host: z.string().min(3).max(253),
  /** eTLD+1, computed by the extension from the Public Suffix List. */
  registrableDomain: z.string().min(3).max(253),
});

interface CandidateRow {
  credential_id: string;
  organization_id: string;
  organization_name: string;
  label: string;
  username: string | null;
  credential_type: string;
  match_type: string;
  require_confirmation: boolean;
  sensitivity: string;
  has_totp: boolean;
}

/**
 * POST /api/extension/autofill — candidate credentials for a page.
 *
 * Returns METADATA ONLY. The extension shows the technician a list; picking one
 * is a separate call to the reveal endpoint, and that is the moment audited.
 * Merely visiting a page must never count as accessing a credential, or the
 * audit log fills with noise and stops meaning anything.
 *
 * Matching happens server-side, in SQL, against normalised hosts. The extension
 * sends what the browser reports and never a pattern: an extension that could
 * supply its own matching rule could ask for every credential in the vault.
 *
 * Elevated and critical credentials are excluded by the resolver itself — a
 * domain admin password is never offered in a browser popup, however the rule
 * was configured.
 */
export const POST = tenantRoute(
  async ({ tx, request }) => {
    const body = await readJson(request, (raw) => {
      const result = bodySchema.safeParse(raw);
      if (!result.success) throw ApiError.invalid('host and registrableDomain are required');
      return result.data;
    });

    // Lowercase here so the comparison matches what credential_domain stores.
    // The host must already be punycode; a unicode host would let a homograph
    // domain match a legitimate rule.
    const host = body.host.trim().toLowerCase();
    const registrable = body.registrableDomain.trim().toLowerCase();

    if (!/^[a-z0-9.-]+$/.test(host) || !/^[a-z0-9.-]+$/.test(registrable)) {
      throw ApiError.invalid('host must be an ASCII (punycode) hostname');
    }

    const rows = await tx<CandidateRow[]>`
      SELECT * FROM helm.resolve_autofill_candidates(${host}::citext, ${registrable}::citext)
    `;

    return {
      candidates: rows.map((r) => ({
        credentialId: r.credential_id,
        organizationId: r.organization_id,
        organizationName: r.organization_name,
        label: r.label,
        username: r.username,
        credentialType: r.credential_type,
        matchType: r.match_type,
        requireConfirmation: r.require_confirmation,
        hasTotp: r.has_totp,
      })),
    };
  },
  { permissions: ['secret:read'] },
);

export const dynamic = 'force-dynamic';
