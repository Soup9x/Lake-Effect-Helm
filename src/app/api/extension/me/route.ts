import { tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { requireExtensionCaller, requireExtensionToken } from '@/lib/extension/http';
import { listMyBrowsers, revokeMyBrowser } from '@/lib/extension/pairing';
import { canSave } from '@/lib/extension/save';
import type { ExtensionMe } from '@/lib/extension/types';

/**
 * The extension asking who it is signed in as, and signing itself out.
 *
 * GET answers with the person, the tenant and this pairing, which is what the
 * extension's settings page shows and how it knows when to renew. DELETE
 * unpairs this browser: what "Sign out" in the extension does.
 */
export const GET = tenantRoute(async ({ tx, identity, session }): Promise<ExtensionMe> => {
  requireExtensionToken(identity);
  requireExtensionCaller(identity, session);

  const current = (await listMyBrowsers(tx)).find((b) => b.current);
  if (!current?.expiresAt) throw ApiError.notFound('this browser is not paired');

  const [who] = await tx<{ tenant_name: string }[]>`
    SELECT tenant_name FROM helm.memberships_for_user(${identity.actorId}::uuid)
    WHERE tenant_id = ${identity.tenantId}::uuid
  `;
  const [user] = await tx<{ email: string; name: string | null }[]>`
    SELECT email::text AS email, name FROM app_user WHERE id = ${identity.actorId}::uuid
  `;

  return {
    installId: current.id,
    label: current.label,
    userName: user?.name ?? session.actorLabel,
    userEmail: user?.email ?? '',
    tenantId: identity.tenantId,
    tenantName: who?.tenant_name ?? '',
    expiresAt: current.expiresAt,
    canSave: canSave(session.permissions),
  };
});

export const DELETE = tenantRoute(async ({ tx, identity }) => {
  requireExtensionToken(identity);
  const current = (await listMyBrowsers(tx)).find((b) => b.current);
  if (!current || !(await revokeMyBrowser(tx, current.id))) {
    throw ApiError.notFound('this browser is not paired');
  }
  return { revoked: true };
});

export const dynamic = 'force-dynamic';
