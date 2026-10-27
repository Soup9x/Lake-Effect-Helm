import { tenantRoute } from '@/lib/api/handler';
import { requireExtensionCaller, requireExtensionToken } from '@/lib/extension/http';
import { renewExtensionToken } from '@/lib/extension/pairing';

/**
 * POST /api/extension/renew — swap this extension's token for a fresh one.
 *
 * The extension calls it once its token is in its last week, so a browser in
 * daily use stays paired and one left alone for a month lapses. The request
 * was signed by the pairing's device key to get this far (identity.ts), and
 * the database revokes the old token as it writes the new one.
 */
export const POST = tenantRoute(async ({ tx, identity, session }) => {
  requireExtensionToken(identity);
  requireExtensionCaller(identity, session);
  return renewExtensionToken(tx);
});

export const dynamic = 'force-dynamic';
