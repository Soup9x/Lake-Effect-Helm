import { headers } from 'next/headers';

/**
 * The address Helm is reached on, for the OIDC redirect URI and the UniFi
 * webhook callback.
 *
 * AUTH_URL when the deployment sets it; otherwise the request, because the
 * only thing that knows the address a browser or a controller will use is the
 * request, and a stored copy would drift.
 */
export async function requestOrigin(): Promise<string> {
  const head = await headers();
  return process.env.AUTH_URL?.replace(/\/+$/, '')
    ?? `${head.get('x-forwarded-proto') ?? 'https'}://${head.get('x-forwarded-host') ?? head.get('host') ?? 'localhost'}`;
}
