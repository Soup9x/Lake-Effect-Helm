import { type NextRequest, NextResponse } from 'next/server';
import { contentSecurityPolicy, NONCE_HEADER } from '@/lib/ui/csp';

/**
 * Gives every page a Content Security Policy with a fresh nonce. The policy
 * and the reasons for each line of it are in lib/ui/csp.ts.
 *
 * The header goes on the REQUEST as well as the response: Next.js reads the
 * nonce from the request's Content-Security-Policy while it renders, which is
 * how its own scripts come to carry it.
 *
 * This does nothing else, and must not grow an authentication check: every
 * page and route authenticates itself, against the database, and a second
 * opinion here would be the one that drifts.
 */
export function proxy(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString('base64');
  const policy = contentSecurityPolicy(nonce, process.env.NODE_ENV === 'development');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(NONCE_HEADER, nonce);
  requestHeaders.set('content-security-policy', policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', policy);
  return response;
}

export const config = {
  matcher: [
    {
      /*
       * Pages only. Not the API (JSON, and files with their own policies), not
       * /embed/ (the Homarr page sets a stricter one naming who may frame it),
       * not Next.js's static files or the icons.
       */
      source: '/((?!api/|embed/|_next/static|_next/image|favicon.ico|.*\\.(?:png|svg|ico|webmanifest)$).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
