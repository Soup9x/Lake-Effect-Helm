import { tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import {
  OidcDiscoveryError,
  discover,
  discoveryUrl,
  pkceWarnings,
  redirectUri,
  scopeWarnings,
} from '@/lib/auth/oidc';
import { oidcForTenant, recordOidcTest } from '@/lib/auth/oidc-config';

/**
 * Prove the configuration works, before somebody's sign-in depends on it.
 *
 * WHAT THIS PROVES, and — just as importantly — WHAT IT DOES NOT.
 *
 *   PROVES   the issuer resolves from this server, TLS verifies against this
 *            container's trust store, the document parses, it really is an
 *            OpenID Connect configuration rather than a plain OAuth 2.0 one,
 *            the issuer it declares matches the one that was typed, and it
 *            offers the authorization code flow.
 *
 *   DOES NOT  prove the client id and secret are right, or that the redirect
 *            URI is registered. Only a real authorization round-trip shows
 *            that, and a round-trip needs a person at a browser.
 *
 * The response says so in as many words, because a green tick that means less
 * than it appears to is worse than no tick: it moves the discovery of a broken
 * setup from a settings page to somebody's Monday morning.
 *
 * Runs on the auth pool for the provider lookup, because that is the only role
 * that can read the client secret — though this test does not need the secret
 * at all, and reads the row for the issuer and scopes. Authorisation happened
 * before we got here: tenantRoute checked tenant:write against the database.
 */
export const POST = tenantRoute(
  async ({ session, request }) => {
    const provider = await oidcForTenant(session.tenantId);
    if (!provider) {
      throw ApiError.notFound('no OIDC provider is configured for this tenant');
    }

    try {
      const doc = await discover(provider.issuer);
      const warnings = [...scopeWarnings(doc, provider.scopes), ...pkceWarnings(doc)];

      await recordOidcTest(session.tenantId, true);

      return {
        ok: true,
        message:
          'Discovery succeeded. The issuer is reachable, its certificate verified, and it ' +
          'advertises the authorization code flow.',
        /**
         * Stated on success, not buried in documentation. This is the step that
         * is easy to skip and expensive to skip.
         */
        stillUnproven:
          'This does not check the client id, the client secret or the redirect URI — only ' +
          'a real sign-in does. Sign in once with this provider before relying on it.',
        discovery: {
          url: discoveryUrl(provider.issuer),
          issuer: doc.issuer,
          authorizationEndpoint: doc.authorizationEndpoint,
          tokenEndpoint: doc.tokenEndpoint,
          jwksUri: doc.jwksUri,
          userinfoEndpoint: doc.userinfoEndpoint,
          scopesSupported: doc.scopesSupported,
          codeChallengeMethodsSupported: doc.codeChallengeMethodsSupported,
        },
        redirectUri: redirectUri(originOf(request), provider.slug),
        warnings: warnings.map((w) => w.message),
      };
    } catch (error) {
      if (!(error instanceof OidcDiscoveryError)) throw error;

      await recordOidcTest(session.tenantId, false, error.message);

      // A failed test is a 200 with ok:false, not a 4xx. The request was valid
      // and was carried out; what failed is the thing being tested, and the
      // page needs the remedy text rather than an error envelope.
      return {
        ok: false,
        message: error.message,
        remedy: error.remedy ?? null,
        discovery: { url: discoveryUrl(provider.issuer) },
        redirectUri: redirectUri(originOf(request), provider.slug),
        warnings: [],
      };
    }
  },
  { permissions: ['tenant:write'] },
);

/** Same rule as the settings route: the origin the operator is actually on. */
function originOf(request: Request): string {
  // AUTH_URL only. NEXTAUTH_URL is the Auth.js v4 name and this project is on
  // v5; accepting it here would have added an undocumented variable that
  // silently overrides a documented one.
  const configured = process.env.AUTH_URL;
  if (configured) return configured.replace(/\/+$/, '');
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  const proto = request.headers.get('x-forwarded-proto') ?? 'https';
  if (host) return `${proto}://${host}`;
  return new URL(request.url).origin;
}

export const dynamic = 'force-dynamic';
