import { z } from 'zod';
import { tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { getDocumentService } from '@/lib/services';
import { DocumentError } from '@/lib/documents/service';
import { checkUpload, maxUploadBytes } from '@/lib/documents/limits';

/**
 * POST /api/documents — put a file in a client's document tree.
 *
 * multipart/form-data, because this is a file upload and a base64 JSON body
 * would inflate a 50 MB document to 67 MB in memory on both ends.
 *
 * THE SIZE CAP IS CHECKED TWICE, and the first check is the one that matters.
 * Content-Length is read before the body is touched, so an oversized upload is
 * refused without buffering it; the second check is after parsing, because
 * Content-Length is a claim by the client and a chunked request may not carry
 * one at all. Neither is a security boundary — a determined caller can stream
 * bytes at this endpoint either way — but together they stop the ordinary case
 * where somebody drags in a disk image.
 *
 * WHAT IS NOT CHECKED: the content type the browser sent. It is stored as
 * metadata and never trusted; the download route decides what a browser is
 * allowed to do with the bytes. See src/lib/documents/limits.ts.
 */
const uploadSchema = z.object({
  organizationId: z.guid('organizationId must be a UUID'),
  folderId: z.guid().nullable().default(null),
  isInternalOnly: z.boolean().default(false),
});

export const POST = tenantRoute(
  async ({ request, identity }) => {
    const limit = maxUploadBytes();

    // Before the body is read at all.
    const declared = Number(request.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > limit + 64 * 1024) {
      throw ApiError.invalid(
        `that upload is larger than the ${Math.floor(limit / (1024 * 1024))} MB limit`,
      );
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch (cause) {
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

    const parsed = uploadSchema.safeParse({
      organizationId: form.get('organizationId'),
      folderId: emptyToNull(form.get('folderId')),
      isInternalOnly: form.get('isInternalOnly') === 'true',
    });
    if (!parsed.success) {
      throw ApiError.invalid('invalid upload', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }

    const check = checkUpload({ filename: file.name, byteSize: file.size, maxBytes: limit });
    if (!check.ok) {
      throw ApiError.invalid(check.refusal.message, {
        issues: [{ path: 'file', message: check.refusal.code }],
      });
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    // Again, on what actually arrived. `file.size` is what the parser recorded,
    // and a truncated or mis-declared part would have been caught above; this
    // is the one measured from the buffer that is about to be encrypted.
    if (bytes.length > limit) {
      throw ApiError.invalid(
        `that upload is larger than the ${Math.floor(limit / (1024 * 1024))} MB limit`,
      );
    }

    try {
      const stored = await getDocumentService().upload(
        { tenantId: identity.tenantId, actorId: identity.actorId, actorType: identity.actorType },
        {
          organizationId: parsed.data.organizationId,
          folderId: parsed.data.folderId,
          filename: check.filename,
          contentType: file.type || 'application/octet-stream',
          isInternalOnly: parsed.data.isInternalOnly,
          bytes,
        },
      );
      return { document: stored };
    } catch (cause) {
      throw translate(cause);
    } finally {
      bytes.fill(0);
    }
  },
  { permissions: ['asset:write'] },
);

function emptyToNull(value: FormDataEntryValue | null): string | null {
  if (typeof value !== 'string') return null;
  return value.trim() === '' ? null : value;
}

export function translate(cause: unknown): unknown {
  if (cause instanceof DocumentError) {
    if (cause.code === 'name_taken') return ApiError.conflict(cause.message);
    if (cause.code === 'no_such_folder') return ApiError.invalid(cause.message);
    if (cause.code === 'not_found') return ApiError.notFound(cause.message);
  }
  return cause;
}

export const dynamic = 'force-dynamic';
