/**
 * OpenID Connect discovery, and the test that proves a configuration works.
 *
 * NOTHING IN THIS FILE NAMES A PRODUCT. That is the point of implementing OIDC
 * rather than "Authentik support": the only things Helm stores are the four the
 * protocol defines — issuer, client id, client secret, scopes — and everything
 * else (authorization endpoint, token endpoint, JWKS, which response modes and
 * PKCE methods are available) is read at runtime from the issuer's discovery
 * document. A provider that did not exist when this was written works if it
 * publishes one.
 *
 * WHAT THE TEST CAN AND CANNOT PROVE, stated here because the UI has to say it
 * honestly rather than show a green tick that means less than it looks like:
 *
 *   CAN   the issuer URL resolves, TLS verifies, the document parses, it is
 *         really an OIDC configuration, its `issuer` matches what was typed
 *         (the check that catches a copy-pasted realm from the wrong realm),
 *         and it offers the endpoints and the code flow Helm needs.
 *
 *   CANNOT  that the client id and secret are correct, or that the redirect URI
 *         is registered. Only a real authorization round-trip proves those, and
 *         a round-trip needs a human at a browser. So the settings page says
 *         "discovery succeeded" rather than "OIDC works", and tells the
 *         operator the one remaining step is to sign in once.
 */

/** How long to wait for a discovery document before calling the issuer down. */
const DISCOVERY_TIMEOUT_MS = 8000;

/** A discovery document, narrowed to the parts Helm actually depends on. */
export interface DiscoveryDocument {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  userinfoEndpoint: string | null;
  scopesSupported: string[] | null;
  responseTypesSupported: string[];
  codeChallengeMethodsSupported: string[] | null;
}

export class OidcDiscoveryError extends Error {
  constructor(
    message: string,
    /** What an operator should change. Rendered next to the failure. */
    readonly remedy?: string,
  ) {
    super(message);
    this.name = 'OidcDiscoveryError';
  }
}

/**
 * The well-known URL for an issuer.
 *
 * Per OpenID Connect Discovery 1.0 §4, the path is appended to the issuer
 * INCLUDING any path component the issuer already has — so a Keycloak realm at
 * https://sso/realms/helm discovers at
 * https://sso/realms/helm/.well-known/openid-configuration, not at the host
 * root. Getting this wrong is the single most common reason "it works in
 * Postman" and not in the application.
 */
export function discoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
}

/** The redirect URI to register at the provider, for a given deployment origin. */
export function redirectUri(origin: string, slug: string): string {
  return `${origin.replace(/\/+$/, '')}/api/auth/callback/${slug}`;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function strArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.filter((v): v is string => typeof v === 'string');
  return out.length > 0 ? out : null;
}

/**
 * Fetch and validate an issuer's discovery document.
 *
 * Throws OidcDiscoveryError with a remedy for everything an operator can fix,
 * because the alternative — a raw fetch error in a toast — is what makes people
 * turn off TLS verification.
 */
export async function discover(issuer: string): Promise<DiscoveryDocument> {
  const url = discoveryUrl(issuer);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    // An on-premises IdP behind a private CA is the common case, and the
    // failure reads as a generic network error unless it is called out.
    if (/certificate|self.signed|unable to verify|CERT_/i.test(cause)) {
      throw new OidcDiscoveryError(
        `TLS verification failed for ${url}: ${cause}`,
        'The provider is presenting a certificate this server does not trust. Add the ' +
          'issuing CA to the container trust store rather than disabling verification.',
      );
    }
    if (controller.signal.aborted) {
      throw new OidcDiscoveryError(
        `No response from ${url} within ${DISCOVERY_TIMEOUT_MS / 1000}s.`,
        'Check that this server can reach the provider — on-premises deployments ' +
          'often have egress rules that do not include the identity provider.',
      );
    }
    throw new OidcDiscoveryError(`Could not reach ${url}: ${cause}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new OidcDiscoveryError(
      `${url} returned ${response.status} ${response.statusText}.`,
      response.status === 404
        ? 'The issuer URL is probably missing a path segment. For Keycloak it ends ' +
          '/realms/<realm>; for Authentik it is the provider’s issuer, usually ' +
          '/application/o/<slug>.'
        : undefined,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new OidcDiscoveryError(
      `${url} did not return JSON.`,
      'That URL is answering with something else — often a login page from a ' +
        'reverse proxy sitting in front of the provider.',
    );
  }

  if (typeof body !== 'object' || body === null) {
    throw new OidcDiscoveryError(`${url} returned JSON that is not an object.`);
  }

  const doc = body as Record<string, unknown>;
  const declaredIssuer = str(doc.issuer);
  const authorizationEndpoint = str(doc.authorization_endpoint);
  const tokenEndpoint = str(doc.token_endpoint);
  const jwksUri = str(doc.jwks_uri);
  const responseTypes = strArray(doc.response_types_supported);

  const missing = [
    declaredIssuer ? null : 'issuer',
    authorizationEndpoint ? null : 'authorization_endpoint',
    tokenEndpoint ? null : 'token_endpoint',
    jwksUri ? null : 'jwks_uri',
  ].filter((m): m is string => m !== null);

  if (missing.length > 0) {
    throw new OidcDiscoveryError(
      `The document at ${url} is missing ${missing.join(', ')}.`,
      'It parses but is not an OpenID Connect configuration. A plain OAuth 2.0 ' +
        'authorization server is not enough — Helm needs an id_token.',
    );
  }

  /*
   * The issuer in the document must equal the issuer that was typed.
   *
   * Required by the spec (Discovery 1.0 §4.3) and worth enforcing for a very
   * practical reason: pointing at the wrong Keycloak realm, or at a proxy that
   * rewrites the host, returns a perfectly valid document for a DIFFERENT
   * issuer. Every token it then signs is rejected at verification time, with an
   * error that appears during somebody's first real sign-in rather than here.
   */
  if (declaredIssuer !== issuer.replace(/\/+$/, '')) {
    throw new OidcDiscoveryError(
      `The provider calls itself "${declaredIssuer}", not "${issuer}".`,
      'Use the issuer exactly as the provider publishes it. A mismatch makes ' +
        'every id_token fail verification once somebody tries to sign in.',
    );
  }

  if (responseTypes && !responseTypes.some((t) => t.split(' ').includes('code'))) {
    throw new OidcDiscoveryError(
      'The provider does not support the authorization code flow.',
      `It advertises: ${responseTypes.join(', ')}. Helm uses the code flow with PKCE.`,
    );
  }

  return {
    issuer: declaredIssuer!,
    authorizationEndpoint: authorizationEndpoint!,
    tokenEndpoint: tokenEndpoint!,
    jwksUri: jwksUri!,
    userinfoEndpoint: str(doc.userinfo_endpoint),
    scopesSupported: strArray(doc.scopes_supported),
    responseTypesSupported: responseTypes ?? [],
    codeChallengeMethodsSupported: strArray(doc.code_challenge_methods_supported),
  };
}

/** A non-fatal observation about a configuration that will still work. */
export interface DiscoveryWarning {
  message: string;
}

/**
 * Compare the requested scopes against what the provider advertises.
 *
 * A warning rather than a failure, on purpose: scopes_supported is optional in
 * the spec and several providers under-report it, so treating a mismatch as
 * fatal would refuse working configurations. Saying nothing, though, means an
 * operator discovers a missing `groups` scope when a claim they expected turns
 * out to be absent.
 */
export function scopeWarnings(doc: DiscoveryDocument, requested: string[]): DiscoveryWarning[] {
  if (!doc.scopesSupported) return [];
  const unknown = requested.filter((s) => !doc.scopesSupported!.includes(s));
  if (unknown.length === 0) return [];
  return [
    {
      message:
        `The provider does not list ${unknown.join(', ')} in scopes_supported. ` +
        'That is often under-reported rather than wrong, but if a claim you expect ' +
        'turns out to be missing, this is why.',
    },
  ];
}

/**
 * Warn when PKCE is not advertised.
 *
 * Auth.js sends a code challenge by default. A provider that does not support
 * it generally ignores the extra parameter, so this is a warning and not a
 * refusal — but it is worth knowing which of the two is happening.
 */
export function pkceWarnings(doc: DiscoveryDocument): DiscoveryWarning[] {
  if (!doc.codeChallengeMethodsSupported) return [];
  if (doc.codeChallengeMethodsSupported.includes('S256')) return [];
  return [
    {
      message:
        'The provider does not advertise PKCE with S256. Helm still sends a code ' +
        'challenge; most providers ignore one they do not implement.',
    },
  ];
}
