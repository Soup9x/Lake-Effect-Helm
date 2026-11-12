import { headers } from 'next/headers';
import { NONCE_HEADER } from './csp';

/**
 * This response's script nonce, for the inline scripts Helm writes itself.
 * Undefined where the proxy did not run (a test render), which leaves the
 * attribute off rather than writing an empty one.
 */
export async function cspNonce(): Promise<string | undefined> {
  return (await headers()).get(NONCE_HEADER) ?? undefined;
}
