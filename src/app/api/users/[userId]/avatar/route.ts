import { z } from 'zod';
import { ApiError } from '@/lib/api/errors';
import { serviceRoute } from '@/lib/api/handler';
import { getAvatarService } from '@/lib/avatars/service';

/**
 * A member's profile picture (1040).
 *
 * NOT GATED BEYOND RLS, as a client logo is not: an <img> cannot send a
 * permission, and the policy answers the one question that matters — is this
 * person a member of the reader's tenant. No picture and not a member are the
 * same 404, so the route says nothing about who belongs elsewhere.
 *
 * Served as the logo route serves a logo, and for its reasons: private,
 * revalidated by ETag, nosniff with the type sniffed from the bytes on upload,
 * and a sandboxing CSP should anything but a raster image ever get this far.
 */
export const GET = serviceRoute(async ({ params, request, actor }) => {
  const userId = z.guid().safeParse(params.userId);
  if (!userId.success) throw ApiError.notFound('no such person');

  const found = await getAvatarService().open(actor, userId.data);
  if (!found) throw ApiError.notFound('no picture');

  const etag = `"${found.sha256}"`;
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, {
      status: 304,
      headers: { etag, 'cache-control': 'private, max-age=0, must-revalidate' },
    });
  }
  return new Response(new Uint8Array(found.bytes), {
    status: 200,
    headers: {
      'content-type': found.contentType,
      'content-length': String(found.bytes.length),
      etag,
      'cache-control': 'private, max-age=0, must-revalidate, no-transform',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
});

export const dynamic = 'force-dynamic';
