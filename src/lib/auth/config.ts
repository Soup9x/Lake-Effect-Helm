/**
 * Auth.js v5 configuration.
 *
 * Runs on the `helm_auth` pool, which holds the auth_* tables and has no access
 * to tenant data at all (db/sql/0220_grants.sql). Login and documentation are
 * separate blast radii: a bug in the auth adapter cannot read a client's
 * credentials, and a bug in the API cannot read session tokens.
 *
 * Deliberately thin. Everything Helm-specific — which tenant, what role, what
 * scope — is resolved later by helm.set_session_context() from the membership
 * row. Auth.js answers one question: which app_user is this?
 *
 * NOTE: importing this module constructs the auth pool, so DATABASE_URL_AUTH
 * must be set. That is the standard Auth.js shape and fine in a server context.
 * Nothing else in Helm imports it — the API layer goes through
 * `getSessionUser()`, which tests satisfy with `useSessionResolver()`.
 */
import NextAuth, { type NextAuthConfig } from 'next-auth';
import type { Adapter, AdapterSession } from 'next-auth/adapters';
import type { Provider } from 'next-auth/providers';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import MicrosoftEntraID from 'next-auth/providers/microsoft-entra-id';
import { authDrizzle } from '../db/drizzle';
import { db } from '../db/client';
import {
  appUser,
  authAccount,
  authAuthenticator,
  authSession,
  authVerificationToken,
} from '@db/schema/identity';
import { useSessionResolver } from './session';
import {
  oidcBySlug,
  oidcEnabledProviders,
  stampSessionMethod,
  type ResolvedOidc,
} from './oidc-config';

/**
 * The adapter's table types are narrower than Helm's schema on three columns,
 * and in each case Helm is deliberately right and the adapter's constraint is
 * the thing that is wrong:
 *
 *   app_user.email           adapter wants text/varchar; Helm uses citext.
 *                            Case-insensitive uniqueness belongs in the
 *                            database — with plain text, `Alice@acme.test` and
 *                            `alice@acme.test` become two accounts, which for a
 *                            credential vault is an account-takeover primitive,
 *                            not a cosmetic issue.
 *
 *   auth_account.expires_at  adapter wants integer; Helm uses bigint. It holds
 *                            a Unix timestamp in seconds, and a signed 32-bit
 *                            integer overflows in January 2038.
 *
 *   auth_authenticator.counter  adapter wants integer; Helm uses bigint. The
 *                            WebAuthn signature counter is unsigned 32-bit per
 *                            spec, so it exceeds a signed integer's range.
 *
 * All three are runtime-compatible — the adapter reads and writes values that
 * fit — so the cast is a type-level accommodation, not a behavioural one. It is
 * scoped to this object so nothing else in the codebase inherits the looseness.
 */
const adapterTables = {
  usersTable: appUser,
  accountsTable: authAccount,
  sessionsTable: authSession,
  verificationTokensTable: authVerificationToken,
  authenticatorsTable: authAuthenticator,
};

/**
 * Which OIDC providers this request needs built, and how to find them.
 *
 * THREE CASES, and getting this wrong is what made the first attempt fail:
 *
 *   /api/auth/signin/<slug>     one provider, named in the path
 *   /api/auth/callback/<slug>   the same, coming back
 *   /api/auth/providers         ALL of them — no slug anywhere
 *   /api/auth/signin            ALL of them, same reason
 *
 * The first version handled only the slug cases, reasoning that a session check
 * or a sign-out does not need a provider and should not cost a query. That much
 * was right. What it missed is that `signIn()` in the browser asks
 * /api/auth/providers FIRST and posts only to a provider it finds there — so
 * the button fetched a list the provider was absent from and fell back to
 * reloading the sign-in page. The symptom was identical to the bug being fixed,
 * one layer further down, and only a real browser showed it.
 *
 * Everything else still resolves to nothing, which is what keeps /api/auth/session
 * — called on page loads — from unwrapping a DEK.
 */
type OidcNeed = { kind: 'none' } | { kind: 'slug'; slug: string } | { kind: 'all' };

function oidcNeedFor(request: Request | undefined): OidcNeed {
  if (!request) return { kind: 'none' };
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return { kind: 'none' };
  }

  const slugged = /\/api\/auth\/(?:signin|callback)\/([^/?#]+)\/?$/.exec(pathname);
  if (slugged?.[1]) {
    const slug = decodeURIComponent(slugged[1]);
    // Entra is built from the environment, not the database. Looking it up
    // would be a guaranteed miss on every SSO sign-in.
    return slug === 'microsoft-entra-id' ? { kind: 'none' } : { kind: 'slug', slug };
  }

  if (/\/api\/auth\/(?:providers|signin)\/?$/.test(pathname)) return { kind: 'all' };
  return { kind: 'none' };
}

/**
 * Resolve the providers this request needs.
 *
 * A provider that cannot be resolved must not take the whole auth endpoint
 * down: local passwords and Entra are unaffected by a database the OIDC lookup
 * cannot reach, and the morning that happens is the morning somebody needs the
 * break-glass path.
 */
async function oidcForRequest(request: Request | undefined): Promise<ResolvedOidc[]> {
  const need = oidcNeedFor(request);
  try {
    if (need.kind === 'slug') {
      const one = await oidcBySlug(need.slug);
      return one ? [one] : [];
    }
    if (need.kind === 'all') return await oidcEnabledProviders();
    return [];
  } catch (error) {
    console.error('helm: could not resolve an OIDC provider', error);
    return [];
  }
}

/**
 * Build an Auth.js provider from a stored configuration.
 *
 * `wellKnown` is left unset so that @auth/core performs standard OIDC discovery
 * against the issuer. That is the whole reason this is "OIDC support" and not
 * "Authentik support": endpoints, JWKS and supported features are read from the
 * provider at runtime, so nothing here has to know which product it is talking
 * to.
 */
function genericOidcProvider(oidc: ResolvedOidc): Provider {
  return {
    id: oidc.slug,
    name: oidc.displayName,
    type: 'oidc',
    issuer: oidc.issuer,
    clientId: oidc.clientId,
    clientSecret: oidc.clientSecret,
    authorization: { params: { scope: oidc.scopes.join(' ') } },

    /*
     * Account linking by email address.
     *
     * Auth.js calls this "dangerous" and it is right to: with it on, anybody
     * who can set a user's email in the identity provider can take over the
     * matching Helm account. With it OFF, a pre-provisioned account can never
     * use this door at all — the OIDC identity has nothing to attach to and
     * Auth.js raises OAuthAccountNotLinked.
     *
     * So it is neither safe-by-default nor optional-in-practice; it is a
     * decision about how much the deployment trusts its own directory. It is
     * stored per provider, defaults to off, and the settings page states the
     * consequence rather than labelling it "advanced".
     */
    allowDangerousEmailAccountLinking: oidc.linkByEmail,

    /*
     * Claims → app_user. Deliberately the three standard ones and nothing else.
     *
     * `sub` is the identifier Auth.js stores in auth_account, so an account
     * survives a user renaming themselves in the IdP. Email is the join key for
     * linking and is lowercased here because app_user.email is citext and the
     * comparison should not depend on what the provider felt like sending.
     */
    profile(profile: Record<string, unknown>) {
      const email = typeof profile.email === 'string' ? profile.email.trim().toLowerCase() : null;
      const name =
        (typeof profile.name === 'string' && profile.name) ||
        (typeof profile.preferred_username === 'string' && profile.preferred_username) ||
        email;
      return {
        id: String(profile.sub ?? ''),
        email,
        name: name ?? null,
      } as { id: string; email: string; name: string | null };
    },
  } as Provider;
}

/**
 * Does an account already exist for this address?
 *
 * Used to enforce `allow_signup`. Asked directly rather than inferred from the
 * shape of the `user` object Auth.js hands the signIn callback: on a first
 * sign-in that object is built from the OIDC profile and carries the PROVIDER's
 * subject as its id, so `Boolean(user.id)` is true for a complete stranger.
 */
async function appUserExists(email: string): Promise<boolean> {
  const rows = await db('auth')<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM app_user WHERE email = ${email}::citext AND disabled_at IS NULL
    ) AS exists
  `;
  return rows[0]?.exists === true;
}

/**
 * Wrap the adapter so a session Auth.js creates says which door it came through.
 *
 * auth_session.auth_method defaults to 'sso', which is correct for Entra and
 * wrong for a self-hosted Keycloak — and "which door" is exactly what somebody
 * reading an audit trail during an incident is looking for. The stamp is a
 * separate UPDATE rather than an extra column in the adapter's INSERT because
 * the adapter owns that statement and Helm does not.
 *
 * A failed stamp must never fail the sign-in: the session is already valid and
 * the label is metadata. It is logged and swallowed.
 */
function stampingAdapter(base: Adapter, method: 'sso' | 'oidc', request: Request | undefined): Adapter {
  const createSession = base.createSession?.bind(base);
  if (!createSession) return base;

  return {
    ...base,
    async createSession(session): Promise<AdapterSession> {
      const created = await createSession(session);
      try {
        await stampSessionMethod(
          created.sessionToken,
          method,
          request?.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
          request?.headers.get('user-agent') ?? null,
        );
      } catch (error) {
        console.error('helm: could not label the new session', error);
      }
      return created;
    },
  };
}

/**
 * Everything below is built LAZILY, on the first request that needs it.
 *
 * It used to run at module scope, and that quietly broke the Docker image
 * build. `next build` imports every route module to collect its configuration,
 * which imports this file, which called authDrizzle() — and that calls db('auth'),
 * which throws when DATABASE_URL_AUTH is unset. It is unset during an image
 * build, deliberately: .dockerignore excludes every .env file so no credential
 * can reach an image layer.
 *
 * It passed on a developer's machine only because Next loads .env.local at
 * build time and that file happens to exist there. So the failure appeared
 * exclusively in CI and in `docker compose build` — which is to say, only where
 * it mattered.
 *
 * Reading the environment lazily is also simply more correct for a container:
 * the values are supplied at run time, not at build time.
 */
async function buildConfig(request: Request | undefined): Promise<NextAuthConfig> {
  const entraConfigured =
    Boolean(process.env.AUTH_MICROSOFT_ENTRA_ID_ID) &&
    Boolean(process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET);

  const authDb = authDrizzle();

  /*
   * The generic OIDC provider, resolved PER REQUEST from the database.
   *
   * Everything else here comes from the environment and could be built once.
   * This cannot: an administrator configures it through the settings page while
   * the server is running, and a provider list fixed at first use would mean
   * "restart the container" as a documented step in adding a sign-in method.
   *
   * Scoped to the paths that actually need it — see oidcNeedFor. A session
   * check or a sign-out costs one comparison, not a query; a sign-in, a
   * callback or a provider listing costs a lookup and a DEK unwrap, which is a
   * handful of times per person per day.
   */
  const oidcProviders = await oidcForRequest(request);

  return {
    // The instantiation expression pins the adapter's generic to the Postgres
    // flavour; without it `Parameters<typeof DrizzleAdapter>` is a union across
    // every dialect the package supports and resolves to none of them.
    adapter: stampingAdapter(
      DrizzleAdapter(
        authDb,
        adapterTables as unknown as Parameters<typeof DrizzleAdapter<typeof authDb>>[1],
      ),
      // A session created while an OIDC provider is in play came through that
      // door. Entra and the built-in pages leave this as 'sso'.
      oidcProviders.length > 0 ? 'oidc' : 'sso',
      request,
    ),

    session: {
      // Database sessions, not JWTs. A JWT cannot be revoked before it expires,
      // and "this technician left, cut their access now" is a routine MSP event
      // that has to take effect immediately.
      strategy: 'database',
      maxAge: 60 * 60 * 8,
      updateAge: 60 * 15,
    },

    providers: [
      ...(entraConfigured
        ? [
            MicrosoftEntraID({
              clientId: process.env.AUTH_MICROSOFT_ENTRA_ID_ID!,
              clientSecret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET!,
              // Spread rather than pass undefined: under exactOptionalPropertyTypes
              // an absent issuer and an explicit `undefined` are different things.
              ...(process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER
                ? { issuer: process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER }
                : {}),
            }),
          ]
        : []),
      ...oidcProviders.map(genericOidcProvider),
    ],

    callbacks: {
      /**
       * Refuse a disabled account at the door.
       *
       * The membership check happens later (identity.ts), because a user can hold
       * memberships in several tenants and login is not yet scoped to one. But a
       * disabled *account* should never get a session at all.
       *
       * This callback runs BEFORE the adapter creates anything (@auth/core's
       * handleAuthorized precedes handleLoginOrRegister), which is what makes it
       * the right place to enforce allow_signup: returning false here means no
       * app_user row is written at all, rather than one being created and then
       * tidied up.
       */
      async signIn({ user, account }) {
        if (!user.id) return false;

        const provider = oidcProviders.find((p) => p.slug === account?.provider);
        if (provider) {
          const email = user.email?.trim().toLowerCase();
          // No address means nothing to match an account against, and Helm
          // identifies people by address everywhere else.
          if (!email) return false;

          if (!provider.allowSignup && !(await appUserExists(email))) {
            // An address the deployment has never heard of. Refused rather than
            // given an empty account — note that an account with no membership
            // can see nothing either way, so this is a policy about tidiness
            // and intent as much as about access.
            return false;
          }
        }

        return true;
      },

      async session({ session, user }) {
        if (session.user) session.user.id = user.id;
        return session;
      },
    },

    pages: {
      signIn: '/sign-in',
      error: '/sign-in',
    },

    // Cookies carry a session for a credential vault. Nothing less than the
    // strictest settings the flow tolerates.
    useSecureCookies: process.env.NODE_ENV === 'production',

    trustHost: process.env.AUTH_TRUST_HOST === 'true',
  };
}

type NextAuthResult = ReturnType<typeof NextAuth>;

let instance: NextAuthResult | undefined;

/**
 * Construct once, on first use. Never at import.
 *
 * The CONFIG is now a function of the request rather than a value, because the
 * generic OIDC provider lives in the database and an administrator adds one
 * while the server is running. @auth/core calls it per request, so the single
 * instance here caches no provider list.
 */
function nextAuth(): NextAuthResult {
  instance ??= NextAuth((request) => buildConfig(request));
  return instance;
}

/**
 * Thin wrappers, so that importing this module stays free of side effects.
 *
 * Destructuring `NextAuth(...)` here would put the construction back at module
 * scope and reintroduce the build failure described above.
 */
export const handlers: NextAuthResult['handlers'] = {
  GET: (request) => nextAuth().handlers.GET(request),
  POST: (request) => nextAuth().handlers.POST(request),
};

export const auth: NextAuthResult['auth'] = ((...args: unknown[]) =>
  (nextAuth().auth as (...a: unknown[]) => unknown)(...args)) as NextAuthResult['auth'];

export const signIn: NextAuthResult['signIn'] = ((...args: unknown[]) =>
  (nextAuth().signIn as (...a: unknown[]) => unknown)(...args)) as NextAuthResult['signIn'];

export const signOut: NextAuthResult['signOut'] = ((...args: unknown[]) =>
  (nextAuth().signOut as (...a: unknown[]) => unknown)(...args)) as NextAuthResult['signOut'];

/**
 * Bind the session resolver.
 *
 * Importing this module is what wires Auth.js into the API layer; nothing else
 * in Helm imports next-auth.
 */
useSessionResolver(async () => {
  const session = await auth();
  const user = session?.user;
  if (!user?.id || !user.email) return null;
  return { id: user.id, email: user.email, name: user.name ?? undefined };
});
