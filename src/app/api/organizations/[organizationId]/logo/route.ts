import { z } from 'zod';
import { ApiError } from '@/lib/api/errors';
import { serviceRoute } from '@/lib/api/handler';
import { readFormDataBounded } from '@/lib/api/body';
import {
  getLogoService, LogoError, LOGO_CONTENT_TYPES, MAX_LOGO_BYTES,
} from '@/lib/logos/service';

/**
 * A client's logo.
 *
 * GET IS NOT GATED beyond RLS, because an <img> tag cannot send a permission
 * and the policy on organization_logo already answers the only question that
 * matters: is this organisation in the reader's scope. A client user sees their
 * own logo; a reader who cannot see the client gets 404, the same answer as a
 * client with no logo — distinguishing the two would tell an outsider which
 * organisation ids exist.
 *
 * POST AND DELETE ARE GATED ON organization:write, the permission the PATCH
 * route on the organisation already names and the one the RLS policies name, so
 * the route and the database cannot come to disagree about who may change how a
 * client looks.
 *
 * THE RESPONSE IS CACHED PRIVATELY AND VALIDATED BY ETAG. The ETag is the
 * sha256 of the plaintext, so a browser re-fetches exactly when the bytes
 * change and never otherwise — which matters because the clients list renders
 * one of these per row. `private` because the bytes are behind a session: a
 * shared cache holding them would serve one tenant's client logo to another
 * tenant's reader, which is a cross-tenant disclosure arranged by a cache
 * header.
 *
 * `no-transform` because a proxy that re-compresses an image would invalidate
 * the ETag it is caching under.
 *
 * X-Content-Type-Options: nosniff, with the type SNIFFED from the bytes rather
 * than taken from the upload. Together those mean a browser renders this as the
 * image format it actually is, or not at all — the one thing that must not
 * happen is a file being treated as something executable because of a
 * Content-Type somebody claimed.
 */
export const GET = serviceRoute(async ({ params, request, actor }) => {
  const organizationId = organizationIdOf(params);

  const found = await getLogoService().open(
    actor,
    organizationId,
  );
  if (!found) throw ApiError.notFound('this client has no logo');

  const etag = `"${found.sha256}"`;
  // Answered before the bytes go on the wire. A 304 is the common case on any
  // page that lists clients, and it costs one header comparison.
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
      // Belt and braces for the one format that is refused anyway: if an SVG
      // ever reached this response, a restrictive CSP stops it executing.
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
});

/*
 * must-revalidate rather than a max-age, deliberately. A max-age avoids the
 * conditional request but leaves a client's logo in the browser's disk cache
 * after the reader signs out; revalidating costs one 304 per logo per page
 * load, which is a header comparison on the server and no bytes on the wire.
 * The clients list renders one of these per row, so that was worth measuring
 * rather than assuming — see docs/itg-parity.md.
 */

export const POST = serviceRoute(
  async ({ request, params, actor }) => {
    const organizationId = organizationIdOf(params);

    // Before the body is read, from a header that is a claim; the real check is
    // on the buffer below. Same two-step the document upload route uses, for
    // the same reason.
    const declared = Number(request.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > MAX_LOGO_BYTES + 64 * 1024) {
      throw ApiError.invalid(
        `a logo must be ${Math.floor(MAX_LOGO_BYTES / 1024)} KB or smaller`,
      );
    }

    let form: FormData;
    try {
      // Bounded while reading: the Content-Length check above is skipped by a
      // chunked upload, and formData() buffers whatever arrives.
      const bounded = await readFormDataBounded(request, MAX_LOGO_BYTES + 64 * 1024);
      if (!bounded) {
        throw ApiError.invalid('that upload is larger than the limit');
      }
      form = bounded;
    } catch (cause) {
      if (cause instanceof ApiError) throw cause;
      throw ApiError.invalid('expected a multipart/form-data upload', {
        issues: [{ path: 'body', message: String((cause as Error).message).slice(0, 200) }],
      });
    }

    const file = form.get('file');
    if (!(file instanceof File)) {
      throw ApiError.invalid('no file was attached', {
        issues: [{ path: 'file', message: 'required' }],
      });
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    try {
      const stored = await getLogoService().put(
        actor,
        { organizationId, contentType: file.type, bytes },
      );
      return { logo: stored };
    } catch (cause) {
      throw translate(cause);
    } finally {
      bytes.fill(0);
    }
  },
  { permissions: ['organization:write'] },
);

export const DELETE = serviceRoute(
  async ({ params, actor }) => {
    const organizationId = organizationIdOf(params);
    const removed = await getLogoService().remove(
      actor,
      organizationId,
    );
    // Idempotent: "there is no logo" is the state the caller asked for, and a
    // 404 here would make a double-click look like a failure.
    return { removed };
  },
  { permissions: ['organization:write'] },
);

/**
 * Validated before it reaches a `::uuid` cast, where a malformed id was a
 * Postgres syntax error and therefore a 500 rather than a 404.
 */
function organizationIdOf(params: Record<string, string>): string {
  const parsed = z.guid().safeParse(params.organizationId);
  if (!parsed.success) throw ApiError.notFound('no such client');
  return parsed.data;
}

function translate(cause: unknown): unknown {
  if (cause instanceof LogoError) {
    if (cause.code === 'too_large' || cause.code === 'empty') {
      return ApiError.invalid(cause.message, { issues: [{ path: 'file', message: cause.code }] });
    }
    if (cause.code === 'unsupported_type') {
      return ApiError.invalid(cause.message, {
        issues: [{ path: 'file', message: `accepted: ${LOGO_CONTENT_TYPES.join(', ')}` }],
      });
    }
    if (cause.code === 'refused') return ApiError.forbidden(cause.message);
    return ApiError.notFound(cause.message);
  }
  return cause;
}

export const dynamic = 'force-dynamic';
