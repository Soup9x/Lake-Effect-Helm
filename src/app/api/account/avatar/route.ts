import { ApiError } from '@/lib/api/errors';
import { serviceRoute } from '@/lib/api/handler';
import { readFormDataBounded } from '@/lib/api/body';
import { AvatarError, getAvatarService } from '@/lib/avatars/service';
import { LOGO_CONTENT_TYPES, MAX_LOGO_BYTES } from '@/lib/logos/limits';

/**
 * Your own profile picture (1040): POST sets or replaces it, DELETE removes it.
 *
 * No permission beyond being yourself, which the policy enforces: a person
 * signed in as themselves writes only their own row, and an API token or a
 * service account writes nothing. The upload is read the way a logo upload is —
 * a header check that is a claim, then a bounded read that is the real limit.
 */
export const POST = serviceRoute(async ({ request, actor }) => {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_LOGO_BYTES + 64 * 1024) {
    throw ApiError.invalid(`a picture must be ${Math.floor(MAX_LOGO_BYTES / 1024)} KB or smaller`);
  }

  let form: FormData;
  try {
    const bounded = await readFormDataBounded(request, MAX_LOGO_BYTES + 64 * 1024);
    if (!bounded) throw ApiError.invalid('that upload is larger than the limit');
    form = bounded;
  } catch (cause) {
    if (cause instanceof ApiError) throw cause;
    throw ApiError.invalid('expected a multipart/form-data upload');
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    throw ApiError.invalid('no file was attached', { issues: [{ path: 'file', message: 'required' }] });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  try {
    return { avatar: await getAvatarService().put(actor, { contentType: file.type, bytes }) };
  } catch (cause) {
    throw translate(cause);
  } finally {
    bytes.fill(0);
  }
});

export const DELETE = serviceRoute(async ({ actor }) => {
  // Idempotent: no picture is the state the caller asked for.
  return { removed: await getAvatarService().remove(actor) };
});

function translate(cause: unknown): unknown {
  if (cause instanceof AvatarError) {
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
