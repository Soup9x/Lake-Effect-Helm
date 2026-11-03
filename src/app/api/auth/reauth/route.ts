import { tenantRoute } from '@/lib/api/handler';
import { hasLocalPassword, reauthProviderFor, totpEnrolled } from '@/lib/auth/sso-reauth';

/**
 * GET /api/auth/reauth — how this person can confirm it is them (1270).
 *
 *   password  they have a Helm password
 *   sso       the provider their account is linked to, when it can be used
 *   totp      they have an authenticator app set up in Helm, so the actions
 *             that ask for one will ask for it after a provider sign-in too
 *
 * Asked by the prompts when they open, so a person with no password is shown
 * the single sign-on button rather than a password box they cannot fill in.
 */
export const GET = tenantRoute(async ({ identity }) => {
  if (identity.method !== 'session' || identity.actorType !== 'user') {
    return { password: true, sso: null, totp: false };
  }
  const [password, provider, totp] = await Promise.all([
    hasLocalPassword(identity.actorId),
    reauthProviderFor(identity.actorId),
    totpEnrolled(identity.actorId),
  ]);
  return {
    password,
    sso: provider ? { name: provider.displayName } : null,
    totp,
  };
});

export const dynamic = 'force-dynamic';
