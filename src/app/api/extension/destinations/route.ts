import { tenantRoute } from '@/lib/api/handler';
import { requireExtensionCaller } from '@/lib/extension/http';
import { listDestinations } from '@/lib/extension/save';
import type { ExtensionDestinations } from '@/lib/extension/types';

/**
 * GET /api/extension/destinations — where the extension may save a login:
 * the clients the person can see, each with its sites, for the picker in the
 * save prompt and the popup's add form. The person's own vault is always
 * there and is not listed. Empty, with canSave false, for a pairing that
 * cannot save (1200).
 */
export const GET = tenantRoute(async ({ tx, identity, session }): Promise<ExtensionDestinations> => {
  requireExtensionCaller(identity, session);
  return listDestinations(tx, session.permissions);
}, { permissions: ['organization:read'] });

export const dynamic = 'force-dynamic';
