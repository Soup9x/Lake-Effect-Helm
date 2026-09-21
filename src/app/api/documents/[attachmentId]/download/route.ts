import { z } from 'zod';
import { tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { getDocumentService } from '@/lib/services';
import { DocumentError } from '@/lib/documents/service';
import { safeContentType } from '@/lib/documents/limits';

/**
 * GET /api/documents/:id/download — the bytes, decrypted, once.
 *
 * THIS IS WHERE UPLOAD SAFETY IS ACTUALLY ENFORCED. The extension block list on
 * the way in stops the obvious case and nothing more — rename malware.exe to
 * malware.txt and it uploads. What makes a stored file harmless is how it comes
 * back out, and every header below is doing a specific job:
 *
 *   Content-Disposition: attachment   nothing renders in the tab. A client's
 *                                     .html or .svg cannot become stored XSS on
 *                                     Helm's own origin, where the session
 *                                     cookie is.
 *   X-Content-Type-Options: nosniff   the browser does not second-guess the type
 *                                     and decide the octet-stream is really
 *                                     script.
 *   safeContentType()                 anything not on a short render-safe list
 *                                     is served as application/octet-stream, so
 *                                     the type we send is never one that invites
 *                                     execution.
 *   Content-Security-Policy           belt and braces for the case where a
 *                                     future change loses the disposition
 *                                     header: sandbox with no allowances.
 *   Cache-Control: no-store           a client's contract is not something to
 *                                     leave in a shared browser's disk cache.
 *
 * The audit row is written inside helm.open_document(), in the same transaction
 * that reads and decrypts the file — so a download that fails to open rolls the
 * event back rather than leaving a trail saying somebody received something
 * they did not.
 */
export const GET = tenantRoute(
  async ({ params, identity }) => {
    const parsed = z.guid().safeParse(params.attachmentId);
    if (!parsed.success) throw ApiError.invalid('invalid document id');

    let opened;
    try {
      opened = await getDocumentService().download(
        { tenantId: identity.tenantId, actorId: identity.actorId, actorType: identity.actorType },
        parsed.data,
      );
    } catch (cause) {
      // helm.open_document() answers out of scope, internal-only to a client
      // actor and simply absent identically — one answer on purpose — and it
      // records the refusal before returning it.
      if (cause instanceof DocumentError) throw ApiError.notFound('no such document');
      throw cause;
    }

    try {
      return new Response(new Uint8Array(opened.bytes), {
        status: 200,
        headers: {
          'content-type': safeContentType(opened.contentType),
          'content-length': String(opened.bytes.length),
          'content-disposition': contentDisposition(opened.filename),
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox",
          'cache-control': 'no-store, max-age=0',
          'x-helm-audit-event': opened.auditEventUid,
        },
      });
    } finally {
      // The Response has already copied the bytes into its own buffer, so this
      // clears the plaintext this process was holding rather than the body.
      opened.bytes.fill(0);
    }
  },
  { permissions: ['asset:read'] },
);

/**
 * A Content-Disposition a filename cannot break out of.
 *
 * The quoted form is not safe with an arbitrary name: a quote ends the value
 * early and a CR or LF splits the header, which is how a filename becomes a
 * response-splitting bug. So the quoted parameter carries an ASCII-only
 * sanitised version for old clients, and RFC 5987's filename* carries the real
 * one percent-encoded, which every current browser prefers.
 */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export const dynamic = 'force-dynamic';
