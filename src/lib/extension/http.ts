import { ApiError } from '../api/errors';
import type { RequestIdentity } from '../auth/identity';
import type { ResolvedSessionContext } from '../db/context';

/**
 * Who the extension's routes answer: MSP staff, from a browser session or
 * their own extension, and nobody holding a personal or service token. The
 * pairing already required a tenant-wide role; this repeats it on every
 * request, so somebody moved to a client-side role since stops at once.
 */
export function requireExtensionCaller(identity: RequestIdentity, session: ResolvedSessionContext): void {
  if (identity.actorType !== 'user') {
    throw ApiError.forbidden('the browser extension belongs to a person');
  }
  if (identity.method === 'api_token' && identity.tokenType !== 'browser_extension') {
    throw ApiError.forbidden('this is for the Helm browser extension');
  }
  if (session.orgScope !== '*') {
    throw ApiError.forbidden('the browser extension is for MSP staff');
  }
}

/** The extension's own token, and nothing else. */
export function requireExtensionToken(identity: RequestIdentity): void {
  if (identity.method !== 'api_token' || identity.tokenType !== 'browser_extension') {
    throw ApiError.forbidden('only the Helm browser extension can do this');
  }
}
