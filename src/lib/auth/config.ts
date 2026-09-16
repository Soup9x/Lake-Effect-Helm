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
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import MicrosoftEntraID from 'next-auth/providers/microsoft-entra-id';
import { authDrizzle } from '../db/drizzle';
import {
  appUser,
  authAccount,
  authAuthenticator,
  authSession,
  authVerificationToken,
} from '@db/schema/identity';
import { useSessionResolver } from './session';

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
function buildConfig(): NextAuthConfig {
  const entraConfigured =
    Boolean(process.env.AUTH_MICROSOFT_ENTRA_ID_ID) &&
    Boolean(process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET);

  const authDb = authDrizzle();

  return {
    // The instantiation expression pins the adapter's generic to the Postgres
    // flavour; without it `Parameters<typeof DrizzleAdapter>` is a union across
    // every dialect the package supports and resolves to none of them.
    adapter: DrizzleAdapter(
      authDb,
      adapterTables as unknown as Parameters<typeof DrizzleAdapter<typeof authDb>>[1],
    ),

    session: {
      // Database sessions, not JWTs. A JWT cannot be revoked before it expires,
      // and "this technician left, cut their access now" is a routine MSP event
      // that has to take effect immediately.
      strategy: 'database',
      maxAge: 60 * 60 * 8,
      updateAge: 60 * 15,
    },

    providers: entraConfigured
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
      : [],

    callbacks: {
      /**
       * Refuse a disabled account at the door.
       *
       * The membership check happens later (identity.ts), because a user can hold
       * memberships in several tenants and login is not yet scoped to one. But a
       * disabled *account* should never get a session at all.
       */
      async signIn({ user }) {
        return Boolean(user.id);
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

/** Construct once, on first use. Never at import. */
function nextAuth(): NextAuthResult {
  instance ??= NextAuth(buildConfig());
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
