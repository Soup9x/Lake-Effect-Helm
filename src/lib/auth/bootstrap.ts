/**
 * Installing the session resolver.
 *
 * Two paths, and the second one is the reason this file exists rather than
 * importing auth/config.ts everywhere.
 *
 * NORMAL. Importing auth/config.ts registers the Auth.js resolver. It is a
 * dynamic import because that module constructs the auth pool on import, and a
 * process that only runs background jobs has no business opening it.
 *
 * DEVELOPMENT. Helm is an on-premises product, so the first thing an operator
 * does is stand it up against their own database — before Entra or SAML is
 * configured, and often before they have decided which. Without a way in,
 * "evaluate Helm" means "first configure enterprise SSO", and the predictable
 * result is a hand-rolled bypass with none of the guards below.
 *
 * So the bypass exists, and it is built with its refusal rather than having one
 * bolted on later:
 *
 *   * It requires HELM_DEV_SESSION_EMAIL to be set explicitly. There is no
 *     default and no "if nothing else works" fallback.
 *   * It THROWS when NODE_ENV=production. Not a warning — a warning in a log
 *     nobody reads is not a control.
 *   * It resolves a real app_user row. It cannot conjure an identity that does
 *     not exist, and the membership, role, scope and permissions still come
 *     from the database via helm.set_session_context(). The bypass answers
 *     "who", exactly like Auth.js does; it grants nothing.
 *   * It says so on every start-up.
 */
import { withoutTenantContext } from '../db/client';
import { hasSessionResolver, useSessionResolver, type SessionUser } from './session';

let installed = false;

export async function installSessionResolver(): Promise<void> {
  if (installed) return;
  installed = true;

  // Someone already chose one — a test with a fake identity, or a deployment
  // wiring its own. Stand down rather than overwrite it.
  if (hasSessionResolver()) return;

  const devEmail = process.env.HELM_DEV_SESSION_EMAIL?.trim();

  if (devEmail) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'HELM_DEV_SESSION_EMAIL is set and NODE_ENV=production. This bypasses ' +
          'authentication entirely; unset it before running in production.',
      );
    }

    console.warn(
      `[helm] AUTHENTICATION BYPASSED: every request is ${devEmail}. ` +
        'Development only — unset HELM_DEV_SESSION_EMAIL to use Auth.js.',
    );

    useSessionResolver(async (): Promise<SessionUser | null> => {
      // The AUTH pool, not the app pool. app_user is RLS-protected and only
      // helm_auth holds the unconditional policy, because resolving a user
      // before any tenant context exists is precisely what a login does. Using
      // the app pool here would correctly return nothing — the same wall the
      // real adapter would hit.
      const rows = await withoutTenantContext(
        (tx) => tx<{ id: string; email: string; name: string | null }[]>`
          SELECT id, email::text, name FROM app_user
          WHERE email = ${devEmail}::citext AND disabled_at IS NULL
        `,
        { role: 'auth' },
      );
      const user = rows[0];
      // A real row or nothing. The bypass cannot invent a user, so a typo in
      // the variable produces "not signed in" rather than a phantom identity.
      return user ? { id: user.id, email: user.email, name: user.name ?? undefined } : null;
    });
    return;
  }

  await import('./config');
}
