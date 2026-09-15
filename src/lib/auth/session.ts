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
 */

export interface SessionUser {
  id: string;
  email: string;
  name?: string | undefined;
}

export type SessionResolver = () => Promise<SessionUser | null>;

let resolver: SessionResolver = async () => {
  throw new Error(
    'no session resolver registered: import the auth config at application start, ' +
      'or call useSessionResolver() in tests',
  );
};

let registered = false;

export function useSessionResolver(next: SessionResolver): void {
  resolver = next;
  registered = true;
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
  return registered;
}

export function getSessionUser(): Promise<SessionUser | null> {
  return resolver();
}
