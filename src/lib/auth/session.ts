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

export function useSessionResolver(next: SessionResolver): void {
  resolver = next;
}

export function getSessionUser(): Promise<SessionUser | null> {
  return resolver();
}
