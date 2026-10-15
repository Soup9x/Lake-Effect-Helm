/**
 * POST /api/network/webhook/{mappingId} — a UniFi console posts events here.
 *
 * ON THE PATH: the brief named src/routes/api/integrations/unifi/webhook.ts.
 * This project is Next.js App Router, where a route IS its directory path and
 * handlers must be `route.ts`, so the file lives where the framework requires
 * and under the /api/network prefix part 1 established for this integration.
 *
 * The mapping id is in the URL because an unauthenticated request has to say
 * which mapping it is for before anything can be looked up, and a uuid in a
 * path is the smallest thing that can carry that. It is not a secret and is not
 * treated as one: the signature is what authenticates the request.
 *
 * publicRoute, not tenantRoute, and deliberately: there is no session to resolve
 * and no tenant to open until the signature has been checked. All of that lives
 * in src/lib/unifi/webhook.ts, following the same shape as the local-auth routes
 * — a thin public handler over a module that reaches the database itself.
 */
import { NextResponse } from 'next/server';
import { publicRoute } from '@/lib/api/handler';
import { MAX_WEBHOOK_BODY_BYTES, receiveWebhook } from '@/lib/unifi/webhook';
import { readTextBounded } from '@/lib/api/body';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST = publicRoute(async (request, requestId) => {
  // The id is taken from the URL rather than from a params argument because
  // publicRoute hands the handler only the request — which is the right shape
  // for a route that must not have a tenant context.
  const mappingId = new URL(request.url).pathname.split('/').filter(Boolean).pop() ?? '';

  if (!UUID.test(mappingId)) {
    // Same answer an unknown mapping gets. A malformed id must not be
    // distinguishable from a well-formed one that does not exist.
    return NextResponse.json(
      { accepted: false, reason: 'unknown or not listening' },
      { status: 202, headers: { 'x-request-id': requestId } },
    );
  }

  /*
   * THE RAW BODY, AS SENT.
   *
   * request.text() and not request.json(): the signature covers the exact bytes
   * the controller transmitted, and parsing then re-serialising does not
   * reproduce them — key order, whitespace and number formatting all move. A
   * receiver that verifies a round-tripped body verifies something the sender
   * never signed.
   */
  // Bounded while reading: this route is public, and request.text() would
  // buffer any size of body before the receiver's own check could refuse it.
  const rawBody = await readTextBounded(request, MAX_WEBHOOK_BODY_BYTES);
  if (rawBody === null) {
    return NextResponse.json(
      { accepted: false, reason: 'body too large' },
      { status: 413, headers: { 'x-request-id': requestId, 'cache-control': 'no-store' } },
    );
  }

  const outcome = await receiveWebhook(mappingId, rawBody, request.headers);

  return NextResponse.json(outcome.body, {
    status: outcome.status,
    headers: { 'x-request-id': requestId, 'cache-control': 'no-store' },
  });
});

export const dynamic = 'force-dynamic';
