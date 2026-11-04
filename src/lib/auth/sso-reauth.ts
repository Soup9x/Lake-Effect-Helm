/**
 * "Confirm it is you" through the identity provider, for people with no Helm
 * password (1270).
 *
 * WHY NOT signIn() AGAIN. Auth.js would treat a second sign-in as a new
 * session: a fresh cookie, a new auth_session row without the Field view flag,
 * another line on the account page. A re-authentication must prove the person
 * is at the keyboard and change nothing else, so this is a small, separate
 * authorization-code round trip that ends in a step-up row instead of a
 * session.
 *
 * THE SAME REDIRECT URI AS SIGN-IN. The provider sends the person back to
 * /api/auth/callback/<slug>, which is already registered, so nobody has to add
 * a second URI in Entra. The catch-all route asks finishSsoReauth() first: it
 * claims the request only when the encrypted cookie set at the start is present
 * AND the `state` in the URL is the one in that cookie. An ordinary sign-in
 * carries Auth.js's own state and falls straight through.
 *
 * WHAT IS CHECKED, in order: the session is still the person who started it;
 * the provider returned a code for our state; the token endpoint swaps it (with
 * the PKCE verifier and the client secret) for an id_token; the id_token's
 * signature verifies against the provider's published keys, and its issuer,
 * audience, expiry and nonce are ours; its subject is an account already linked
 * to this Helm user; and it records a sign-in that happened after the button
 * was pressed (prompt=login, max_age=0). Only then is a step-up written.
 */
import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  hkdfSync,
  randomBytes,
  verify as verifySignature,
  type JsonWebKeyInput,
} from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { ApiError } from '../api/errors';
import { db, withTenant } from '../db/client';
import { installSessionResolver } from './bootstrap';
import { resolveIdentity } from './identity';
import { discover, redirectUri } from './oidc';
import { oidcEnabledProviders } from './oidc-config';

/** The cookie that carries a re-authentication across the provider round trip. */
export const REAUTH_COOKIE = 'helm-sso-reauth';
const COOKIE_PATH = '/api/auth/callback';
/** How long the person has to finish at the provider. */
const START_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
/** Clock skew allowed between Helm and the provider. */
const SKEW_S = 120;

export const TICKET = /^[A-Za-z0-9-]{16,64}$/;

const ENTRA_ENV_SLUG = 'microsoft-entra-id';

export interface ReauthProvider {
  slug: string;
  displayName: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
}

/**
 * The provider this person can re-authenticate with: an enabled one their
 * account is already linked to. Null when there is none, which is what decides
 * whether the dialogs offer the button at all.
 */
export async function reauthProviderFor(userId: string): Promise<ReauthProvider | null> {
  const linked = await db('auth')<{ provider: string }[]>`
    SELECT DISTINCT provider FROM auth_account WHERE user_id = ${userId}::uuid
  `;
  const slugs = new Set(linked.map((r) => r.provider));
  if (slugs.size === 0) return null;

  // Entra from the environment, when it names one tenant. The multi-tenant
  // `common` issuer has no single issuer to check an id_token against.
  const envIssuer = process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER?.replace(/\/+$/, '');
  if (
    slugs.has(ENTRA_ENV_SLUG) &&
    process.env.AUTH_MICROSOFT_ENTRA_ID_ID &&
    process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET &&
    envIssuer &&
    !/\/(common|organizations|consumers)\//.test(`${envIssuer}/`)
  ) {
    return {
      slug: ENTRA_ENV_SLUG,
      displayName: 'Microsoft',
      issuer: envIssuer,
      clientId: process.env.AUTH_MICROSOFT_ENTRA_ID_ID,
      clientSecret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
      scopes: ['openid', 'profile', 'email'],
    };
  }

  let enabled;
  try {
    enabled = await oidcEnabledProviders();
  } catch (error) {
    console.error('helm: could not resolve OIDC providers for re-authentication', error);
    return null;
  }
  const match = enabled.find((p) => slugs.has(p.slug));
  return match
    ? {
        slug: match.slug,
        displayName: match.displayName,
        issuer: match.issuer,
        clientId: match.clientId,
        clientSecret: match.clientSecret,
        scopes: match.scopes,
      }
    : null;
}

// ---------------------------------------------------------------------------
// The cookie: AES-256-GCM under a key derived from AUTH_SECRET, so the PKCE
// verifier and nonce never travel readable, and a forged cookie cannot name
// somebody else's ticket.
// ---------------------------------------------------------------------------

interface Pending {
  /** The browser's ticket: what the waiting dialog polls for. */
  t: string;
  /** state, nonce, PKCE verifier. */
  s: string;
  n: string;
  v: string;
  /** Helm user who started it. */
  u: string;
  /** Provider slug, and the redirect URI used (origin included). */
  p: string;
  r: string;
  /** Started, ms since epoch. */
  at: number;
}

function cookieKey(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error('AUTH_SECRET is not set');
  return Buffer.from(hkdfSync('sha256', secret, 'helm', 'helm-sso-reauth-cookie-v1', 32));
}

function seal(value: Pending): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cookieKey(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

function unseal(raw: string): Pending | null {
  try {
    const buf = Buffer.from(raw, 'base64url');
    if (buf.length < 29) return null;
    const decipher = createDecipheriv('aes-256-gcm', cookieKey(), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    const text = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
    const value = JSON.parse(text) as Pending;
    return typeof value.s === 'string' && typeof value.t === 'string' ? value : null;
  } catch {
    return null;
  }
}

const b64url = (buf: Buffer) => buf.toString('base64url');

// ---------------------------------------------------------------------------
// Start.
// ---------------------------------------------------------------------------

export interface StartedReauth {
  location: string;
  cookie: { name: string; value: string; path: string; maxAge: number; secure: boolean };
}

export async function startSsoReauth(input: {
  userId: string;
  email: string;
  ticket: string;
  origin: string;
}): Promise<StartedReauth> {
  const provider = await reauthProviderFor(input.userId);
  if (!provider) {
    throw ApiError.forbidden('Your account is not linked to a single sign-on provider, so confirm with your password instead.');
  }
  const doc = await discover(provider.issuer);

  const state = b64url(randomBytes(24));
  const nonce = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const redirect = redirectUri(input.origin, provider.slug);

  const scopes = Array.from(new Set(['openid', ...provider.scopes]));
  const url = new URL(doc.authorizationEndpoint);
  url.searchParams.set('client_id', provider.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('redirect_uri', redirect);
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // Ask for the credentials again, not a silent single sign-on.
  url.searchParams.set('prompt', 'login');
  url.searchParams.set('max_age', '0');
  url.searchParams.set('login_hint', input.email);

  const pending: Pending = {
    t: input.ticket,
    s: state,
    n: nonce,
    v: verifier,
    u: input.userId,
    p: provider.slug,
    r: redirect,
    at: Date.now(),
  };

  return {
    location: url.toString(),
    cookie: {
      name: REAUTH_COOKIE,
      value: seal(pending),
      path: COOKIE_PATH,
      maxAge: START_TTL_MS / 1000,
      secure: redirect.startsWith('https:'),
    },
  };
}

// ---------------------------------------------------------------------------
// Finish: called by the Auth.js catch-all before Auth.js sees the request.
// ---------------------------------------------------------------------------

/**
 * Handle the callback when it is ours; null when it is an ordinary sign-in.
 */
export async function finishSsoReauth(request: NextRequest): Promise<Response | null> {
  const url = new URL(request.url);
  const match = /^\/api\/auth\/callback\/([^/?#]+)\/?$/.exec(url.pathname);
  if (!match) return null;

  const raw = request.cookies.get(REAUTH_COOKIE)?.value;
  if (!raw) return null;
  const pending = unseal(raw);
  const state = url.searchParams.get('state');
  if (!pending || !state || state !== pending.s) return null;
  if (decodeURIComponent(match[1] ?? '') !== pending.p) return null;

  // From here the request is ours, whatever happens.
  const doneUrl = new URL('/reauth/done', new URL(pending.r).origin);
  doneUrl.searchParams.set('t', pending.t);
  const finish = (error?: string) => {
    if (error) doneUrl.searchParams.set('error', error);
    else doneUrl.searchParams.set('ok', '1');
    const response = NextResponse.redirect(doneUrl, 303);
    response.cookies.set(REAUTH_COOKIE, '', { path: COOKIE_PATH, maxAge: 0 });
    return response;
  };

  try {
    if (Date.now() - pending.at > START_TTL_MS) {
      return finish('That took too long. Close this window and try again.');
    }

    const providerError = url.searchParams.get('error');
    if (providerError) {
      const description = url.searchParams.get('error_description')?.split('\n')[0]?.slice(0, 300);
      return finish(description || `The sign-in provider answered "${providerError}".`);
    }
    const code = url.searchParams.get('code');
    if (!code) return finish('The sign-in provider sent no authorization code.');

    await installSessionResolver();
    let identity;
    try {
      identity = await resolveIdentity(request);
    } catch {
      return finish('Your Helm session ended. Sign in to Helm again, then retry.');
    }
    if (identity.method !== 'session' || identity.actorId !== pending.u) {
      return finish('This browser is signed in to Helm as somebody else now.');
    }

    const provider = await reauthProviderFor(pending.u);
    if (!provider || provider.slug !== pending.p) {
      return finish('That sign-in provider is no longer available for your account.');
    }

    const doc = await discover(provider.issuer);
    const idToken = await exchangeCode({
      tokenEndpoint: doc.tokenEndpoint,
      authMethods: doc.tokenEndpointAuthMethods,
      clientId: provider.clientId,
      clientSecret: provider.clientSecret,
      code,
      redirectUri: pending.r,
      verifier: pending.v,
    });
    const claims = await verifyIdToken(idToken, {
      issuer: doc.issuer,
      jwksUri: doc.jwksUri,
      clientId: provider.clientId,
      nonce: pending.n,
    });

    const linked = await db('auth')<{ provider_account_id: string }[]>`
      SELECT provider_account_id FROM auth_account
      WHERE user_id = ${pending.u}::uuid AND provider = ${provider.slug}
    `;
    if (!linked.some((r) => r.provider_account_id === claims.sub)) {
      return finish(
        `You signed in to ${provider.displayName} as a different account from the one linked to your Helm sign-in.`,
      );
    }

    const authenticatedAt = typeof claims.auth_time === 'number' ? claims.auth_time : claims.iat;
    if (typeof authenticatedAt !== 'number' || authenticatedAt < pending.at / 1000 - SKEW_S) {
      return finish(`${provider.displayName} did not ask for your sign-in again, so this cannot count as a confirmation.`);
    }

    await withTenant(
      {
        tenantId: identity.tenantId,
        actorId: identity.actorId,
        actorType: identity.actorType,
        ...(identity.ip ? { ip: identity.ip } : {}),
        ...(identity.userAgent ? { userAgent: identity.userAgent } : {}),
      },
      async (tx) => {
        await tx`
          SELECT helm.record_sso_reauth(
            ${pending.t},
            (SELECT step_up_minutes FROM helm.session_policy()),
            ${identity.ip ?? null}::inet)
        `;
      },
    );
    return finish();
  } catch (error) {
    console.error('helm: single sign-on re-authentication failed', error);
    const message = error instanceof ReauthError ? error.message : 'Something went wrong confirming your sign-in. Try again.';
    return finish(message);
  }
}

class ReauthError extends Error {}

async function timedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}

async function exchangeCode(input: {
  tokenEndpoint: string;
  authMethods: string[] | null;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  verifier: string;
}): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier,
  });
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  // client_secret_basic, as Auth.js uses for sign-in, unless the provider
  // advertises methods and basic is not among them.
  if (!input.authMethods || input.authMethods.includes('client_secret_basic')) {
    const id = encodeURIComponent(input.clientId);
    const secret = encodeURIComponent(input.clientSecret);
    headers.authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
  } else {
    body.set('client_id', input.clientId);
    body.set('client_secret', input.clientSecret);
  }

  const response = await timedFetch(input.tokenEndpoint, { method: 'POST', headers, body });
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || !json) {
    const detail = typeof json?.error_description === 'string' ? json.error_description.split('\n')[0] : null;
    throw new ReauthError(
      detail ? `The sign-in provider refused the confirmation: ${detail}` : 'The sign-in provider refused the confirmation.',
    );
  }
  if (typeof json.id_token !== 'string') throw new ReauthError('The sign-in provider returned no id_token.');
  return json.id_token;
}

// ---------------------------------------------------------------------------
// id_token verification.
// ---------------------------------------------------------------------------

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  auth_time?: number;
  nonce?: string;
  azp?: string;
}

type Alg = { hash: string; kind: 'rsa' | 'pss' | 'ec' };
const ALGS: Record<string, Alg> = {
  RS256: { hash: 'sha256', kind: 'rsa' },
  RS384: { hash: 'sha384', kind: 'rsa' },
  RS512: { hash: 'sha512', kind: 'rsa' },
  PS256: { hash: 'sha256', kind: 'pss' },
  PS384: { hash: 'sha384', kind: 'pss' },
  PS512: { hash: 'sha512', kind: 'pss' },
  ES256: { hash: 'sha256', kind: 'ec' },
  ES384: { hash: 'sha384', kind: 'ec' },
  ES512: { hash: 'sha512', kind: 'ec' },
};

type Jwk = JsonWebKeyInput['key'] & { kid?: string; use?: string; alg?: string };
const jwksCache = new Map<string, { at: number; keys: Jwk[] }>();

async function loadJwks(uri: string, fresh: boolean): Promise<Jwk[]> {
  const cached = jwksCache.get(uri);
  if (!fresh && cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.keys;
  const response = await timedFetch(uri, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new ReauthError(`Could not read the sign-in provider's signing keys (${response.status}).`);
  const json = (await response.json()) as { keys?: Jwk[] };
  const keys = Array.isArray(json.keys) ? json.keys : [];
  jwksCache.set(uri, { at: Date.now(), keys });
  return keys;
}

function decodePart<T>(part: string | undefined): T {
  if (!part) throw new ReauthError('The id_token is malformed.');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T;
}

export async function verifyIdToken(
  token: string,
  expected: { issuer: string; jwksUri: string; clientId: string; nonce: string },
  keys?: Jwk[],
): Promise<IdTokenClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new ReauthError('The id_token is malformed.');
  const [h, p, s] = parts as [string, string, string];
  const header = decodePart<{ alg?: string; kid?: string }>(h);
  const alg = header.alg ? ALGS[header.alg] : undefined;
  if (!alg) throw new ReauthError(`The id_token is signed with an algorithm Helm does not accept (${header.alg ?? 'none'}).`);

  const pick = (set: Jwk[]) =>
    set.find((k) => (header.kid ? k.kid === header.kid : true) && (!k.use || k.use === 'sig'));
  let jwk = pick(keys ?? (await loadJwks(expected.jwksUri, false)));
  if (!jwk && !keys) jwk = pick(await loadJwks(expected.jwksUri, true));
  if (!jwk) throw new ReauthError('The id_token was signed with a key the sign-in provider does not publish.');

  const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
  const data = Buffer.from(`${h}.${p}`);
  const signature = Buffer.from(s, 'base64url');
  const ok =
    alg.kind === 'ec'
      ? verifySignature(alg.hash, data, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature)
      : alg.kind === 'pss'
        ? verifySignature(
            alg.hash,
            data,
            { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST },
            signature,
          )
        : verifySignature(alg.hash, data, publicKey, signature);
  if (!ok) throw new ReauthError('The id_token signature does not verify.');

  const claims = decodePart<IdTokenClaims>(p);
  const now = Date.now() / 1000;
  if (claims.iss !== expected.issuer) throw new ReauthError('The id_token was issued by a different provider.');
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(expected.clientId)) throw new ReauthError('The id_token was issued for a different application.');
  if (audiences.length > 1 && claims.azp !== expected.clientId) {
    throw new ReauthError('The id_token was issued for a different application.');
  }
  if (typeof claims.exp !== 'number' || claims.exp < now - SKEW_S) throw new ReauthError('The id_token has expired.');
  if (claims.nonce !== expected.nonce) throw new ReauthError('The id_token does not belong to this confirmation.');
  if (typeof claims.sub !== 'string' || claims.sub === '') throw new ReauthError('The id_token names no subject.');
  return claims;
}

// ---------------------------------------------------------------------------
// The one-shot side, used by reauthenticate().
// ---------------------------------------------------------------------------

/** Does this person have a Helm authenticator app set up? */
export async function totpEnrolled(userId: string): Promise<boolean> {
  const [row] = await db('auth')<{ enrolled: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM local_totp WHERE user_id = ${userId}::uuid AND confirmed_at IS NOT NULL
    ) AS enrolled
  `;
  return row?.enrolled === true;
}

/** Does this person have a local Helm password? */
export async function hasLocalPassword(userId: string): Promise<boolean> {
  const [row] = await db('auth')<{ present: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM local_credential WHERE user_id = ${userId}::uuid) AS present
  `;
  return row?.present === true;
}
