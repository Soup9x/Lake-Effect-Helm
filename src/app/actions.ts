'use server';

/**
 * Server actions.
 *
 * Only actions that change UI state live here. Anything that touches tenant
 * data goes through the service layer with a tenant context, exactly like the
 * API routes — a server action is not a privileged back door, it is another
 * caller.
 */
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { getServerIdentity, TENANT_COOKIE } from '@/lib/auth/server-identity';

/**
 * Switch the active tenant.
 *
 * Writes a cookie and nothing else. The switch is not trusted: every subsequent
 * render re-derives the identity, checks the requested tenant against the
 * user's memberships, and helm.set_session_context() checks it again from the
 * membership row. Setting this cookie by hand to another MSP's id produces the
 * same result as not setting it — you see your own tenants.
 */
export async function switchTenant(tenantId: string): Promise<void> {
  const identity = await getServerIdentity();

  if (!identity.memberships.some((m) => m.tenantId === tenantId)) {
    // Refused here for a clear failure, and it would be refused twice more
    // downstream regardless.
    throw new Error('you do not have access to that tenant');
  }

  (await cookies()).set(TENANT_COOKIE, tenantId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });

  revalidatePath('/', 'layout');
}
