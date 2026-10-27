import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { deviceKeyFingerprint, parseDevicePublicKey } from '@/lib/auth/device-signature';
import { requireExtensionCaller } from '@/lib/extension/http';
import { formatFingerprint, listMyBrowsers, pairExtension } from '@/lib/extension/pairing';
import type { ExtensionPairing } from '@/lib/extension/types';

/**
 * Your paired browsers.
 *
 * GET lists them. POST pairs one: the pairing page calls it when the person
 * presses Pair, in a signed-in Helm tab, with the public key the extension
 * handed that page. The token is in the response once, and the page passes it
 * straight to the extension in the same tab; the row holds its hash.
 *
 * A SESSION, NEVER A TOKEN. The database refuses a pairing from a
 * token-authenticated request (1120); this says so first, in a sentence.
 */
const pairSchema = z.object({
  /** SubjectPublicKeyInfo DER, base64url, as WebCrypto exports a P-256 key. */
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{80,300}$/),
  label: z.string().trim().min(1).max(80),
  browser: z.string().trim().max(40).nullable().optional(),
  extensionVersion: z.string().trim().max(20).nullable().optional(),
});

export const GET = tenantRoute(async ({ tx }) => ({ browsers: await listMyBrowsers(tx) }));

export const POST = tenantRoute(async ({ tx, request, identity, session }): Promise<ExtensionPairing> => {
  if (identity.method === 'api_token') {
    throw ApiError.forbidden('a browser extension can only be paired from a signed-in Helm tab');
  }
  requireExtensionCaller(identity, session);

  const body = await readJson(request, (raw) => {
    const result = pairSchema.safeParse(raw);
    if (!result.success) {
      throw ApiError.invalid('a device key, and a name of at most 80 characters', {
        issues: zodIssues(result.error),
      });
    }
    return result.data;
  });

  const publicKey = Buffer.from(body.publicKey, 'base64url');
  if (!parseDevicePublicKey(publicKey)) {
    throw ApiError.invalid('that is not a P-256 device key; start pairing again from the extension');
  }

  const paired = await pairExtension(tx, {
    label: body.label,
    browser: body.browser ?? null,
    extensionVersion: body.extensionVersion ?? null,
    publicKey,
  });

  const [tenant] = await tx<{ name: string }[]>`SELECT name FROM tenant WHERE id = ${identity.tenantId}::uuid`;

  return {
    installId: paired.installId,
    token: paired.token,
    expiresAt: paired.expiresAt,
    tenantName: tenant?.name ?? '',
    keySha256: formatFingerprint(deviceKeyFingerprint(publicKey)),
  };
});

export const dynamic = 'force-dynamic';
