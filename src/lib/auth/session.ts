/**
 * Session lookup, behind an indirection.
 *
 * `auth()` from next-auth reaches into Next's request context, which makes any
 * code that calls it directly untestable outside a running server and welds the
 * whole API layer to one auth library's beta API.
 *
 * So the rest of Helm calls `getSessionUser()`, and the binding to next-auth
 * happens in exactly one place (auth/config.ts, via `useSessionResolver`). Tests
 * substitute a resolver; swapping Auth.js for WorkOS later touches one file.
 *
 * WHY THE STATE LIVES ON globalThis.
 *
 * A module-level `let` is not a singleton in a Next.js production build. The
 * bundler emits separate module graphs for the RSC layer, the SSR layer and
 * route handlers, and this file appears in all of them — 42 copies in Helm's
 * current build. Registering a resolver in one instance and calling
 * getSessionUser() from another produces "no session resolver registered" on a
 * request that is, as far as anybody reading the code can tell, correctly wired.
 *
 * That is exactly what happened: a successful local sign-in set a valid cookie
 * and then rendered a 500, because the layout installed the resolver in the RSC
 * copy and the render read it from the SSR copy. `Symbol.for` puts the slot in
 * the process-wide registry, which is the one thing every copy shares.
 */

export interface SessionUser {
  id: string;
  email: string;
  name?: string | undefined;
}

export type SessionResolver = () => Promise<SessionUser | null>;

interface ResolverSlot {
  resolver: SessionResolver;
  registered: boolean;
}

const SLOT_KEY = Symbol.for('helm.auth.session-resolver');

function slot(): ResolverSlot {
  const host = globalThis as typeof globalThis & { [SLOT_KEY]?: ResolverSlot };

  host[SLOT_KEY] ??= {
    registered: false,
    resolver: async () => {
      throw new Error(
        'no session resolver registered: import the auth config at application start, ' +
          'or call useSessionResolver() in tests',
      );
    },
  };

  return host[SLOT_KEY];
}

export function useSessionResolver(next: SessionResolver): void {
  const current = slot();
  current.resolver = next;
  current.registered = true;
}

/**
 * Whether anything has claimed the resolver slot.
 *
 * Exists so auto-installation (auth/bootstrap.ts) can stand down when a caller
 * has already chosen one — a test with a fake identity, or a deployment that
 * wires its own. Auto-installing over a deliberate choice would make the
 * bootstrap the last writer to win, which is the opposite of what an explicit
 * call means.
 */
export function hasSessionResolver(): boolean {
  return slot().registered;
}

/** Drop any registered resolver. For tests that need a clean slate. */
export function clearSessionResolver(): void {
  const host = globalThis as typeof globalThis & { [SLOT_KEY]?: ResolverSlot };
  delete host[SLOT_KEY];
}

export function getSessionUser(): Promise<SessionUser | null> {
  return slot().resolver();
}
