import { z } from 'zod';
import { tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { getExportService } from '@/lib/exports/service';

const idSchema = z.guid();

/**
 * GET /api/exports/:id/download — the bytes.
 *
 * Authorisation, the export_download row and the audit event all happen in one
 * database transaction before a single byte is read from storage. Same
 * principle as revealing a secret: the artefact and the record of who took it
 * are inseparable.
 *
 * Returns the raw response rather than the handler's JSON envelope, and pins
 * Content-Disposition to an attachment with no-store — a credential bundle
 * rendered inline in a browser tab ends up in the cache and the session
 * restore.
 */
export const GET = tenantRoute(
  async ({ identity, params, request }) => {
    const exportJobId = idSchema.safeParse(params.exportJobId);
    if (!exportJobId.success) throw ApiError.invalid('invalid export id');

    const result = await getExportService().download(
      { tenantId: identity.tenantId, actorId: identity.actorId, actorType: identity.actorType },
      exportJobId.data,
      {
        ...(identity.ip ? { ip: identity.ip } : {}),
        ...(request.headers.get('user-agent') ? { userAgent: request.headers.get('user-agent')! } : {}),
      },
    );

    return new Response(new Uint8Array(result.bytes), {
      status: 200,
      headers: {
        'content-type': result.contentType,
        'content-length': String(result.bytes.length),
        'content-disposition': `attachment; filename="${result.filename}"`,
        // Lets the recipient verify the file survived the transfer without
        // needing the passphrase.
        'x-helm-content-sha256': result.sha256,
        'x-helm-encrypted': result.encrypted ? 'aes-256-gcm' : 'none',
        'cache-control': 'no-store, max-age=0',
      },
    });
  },
  { permissions: ['export:create'] },
);

export const dynamic = 'force-dynamic';
