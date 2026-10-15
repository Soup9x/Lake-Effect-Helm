import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { readSmtpSetting, writeSmtpSetting } from '@/lib/email/settings';

/**
 * The mail relay.
 *
 * GATED ON tenant:write TWICE OVER, and the second one is the real gate:
 * `helm.set_smtp_setting()` checks the permission itself, because helm_app has
 * no INSERT or UPDATE on smtp_setting at all. The route's own gate exists so
 * the refusal is a 403 naming the permission rather than a 500 naming a
 * function — the same split 0670's external checks use.
 *
 * GET IS NOT GATED, and returns no password. Every role benefits from knowing
 * whether mail works at all: a notification toggle on the account screen with
 * no relay behind it is a control that does nothing, and the screen says so.
 * The envelope columns are unreachable from this role, so there is nothing to
 * redact — `passwordSet` is a boolean the database computed.
 *
 * PLAINTEXT NEEDS A SEPARATE FIELD, NOT A SILENT FALLBACK.
 * `acknowledgePlaintext` must be true to save `security: 'plaintext'`, and the
 * database records who did it and when. A tenant that later moves to STARTTLS
 * has the acknowledgement cleared, so the record always describes the setting
 * that is actually in force rather than one somebody accepted in 2024.
 *
 * THE PASSWORD IS OMITTED TO KEEP IT, not to clear it. Saving the host should
 * not require re-typing a password the browser never received — so `password`
 * absent means "leave it alone", an empty string means "there is none", and a
 * value means "replace it". Stated here because a three-way field is the kind
 * of thing a caller gets wrong.
 */
const schema = z.object({
  enabled: z.boolean(),
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  security: z.enum(['starttls', 'tls', 'plaintext']),
  tlsVerify: z.boolean(),
  /**
   * The relay's certificate, in PEM, when pinning a private one. NOT a
   * fingerprint: a fingerprint cannot be enforced — Node skips
   * checkServerIdentity when rejectUnauthorized is false and refuses a
   * self-signed chain before reaching it when true. See 0690's header.
   */
  tlsPinnedCertificate: z.string().trim().max(16384).nullable().optional(),
  username: z.string().trim().max(320).nullable().optional(),
  password: z.string().max(1024).optional(),
  fromAddress: z.string().trim().email().max(320),
  fromName: z.string().trim().max(120).nullable().optional(),
  /** Empty means the sending address's own domain. See 0690's header. */
  allowedRecipientDomains: z.array(z.string().trim().min(1).max(253)).max(50).optional(),
  acknowledgePlaintext: z.boolean().optional(),
});

export const GET = tenantRoute(async ({ tx }) => readSmtpSetting(tx));

export const PUT = tenantRoute(
  async ({ tx, request }) => {
    const body = await readJson(request, (raw) => {
      const result = schema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('a host, a port, a security mode and a sending address', {
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      return result.data;
    });

    if (body.security === 'plaintext' && body.acknowledgePlaintext !== true) {
      // Refused here rather than left to the CHECK, so the answer names the
      // field and says what is at stake instead of quoting a constraint.
      throw ApiError.invalid(
        'sending without TLS puts the relay password and every notification on '
        + 'the network in clear text. Set acknowledgePlaintext to confirm.',
        { issues: [{ path: 'security', message: 'needs acknowledgePlaintext' }] },
      );
    }

    if (body.tlsPinnedCertificate && body.security === 'plaintext') {
      throw ApiError.invalid(
        'a pinned certificate cannot be checked on a plaintext connection, '
        + 'because no certificate is ever presented.',
        { issues: [{ path: 'tlsPinnedCertificate', message: 'incompatible with plaintext' }] },
      );
    }

    if (!body.tlsVerify && !body.tlsPinnedCertificate && body.security !== 'plaintext') {
      throw ApiError.invalid(
        'turning verification off with no pinned certificate accepts any '
        + 'certificate at all. Paste the relay’s certificate to pin it, or '
        + 'leave verification on.',
        { issues: [{ path: 'tlsVerify', message: 'needs a pinned certificate' }] },
      );
    }

    return writeSmtpSetting(tx, body);
  },
  { permissions: ['tenant:write'] },
);

export const dynamic = 'force-dynamic';
