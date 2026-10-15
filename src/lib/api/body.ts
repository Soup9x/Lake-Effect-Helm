/**
 * Read a request body, but never more than `maxBytes` of it.
 *
 * `request.text()` and `request.json()` buffer the whole body before anybody
 * can look at its size, so a size check after them limits nothing: on a public
 * route a caller can send a gigabyte and the process holds it. This refuses on
 * the declared Content-Length when there is one, and otherwise counts bytes as
 * they stream and cancels the moment the limit is passed — which also covers a
 * chunked upload that declares nothing.
 *
 * Returns null when the body is too large.
 */
export async function readBodyBounded(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** The same, decoded as UTF-8 text. */
export async function readTextBounded(request: Request, maxBytes: number): Promise<string | null> {
  const bytes = await readBodyBounded(request, maxBytes);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

/** Enough for any form these routes accept; small enough to refuse a flood. */
export const AUTH_BODY_MAX_BYTES = 64 * 1024;

/**
 * For the unauthenticated auth routes: the parsed JSON object, or `{}` when the
 * body is missing, malformed or larger than `maxBytes` — each route then
 * answers its usual "invalid request". Replaces `request.json().catch(() => ({}))`,
 * which buffered a body of any size from anybody.
 */
export async function readJsonObjectOrEmpty(
  request: Request,
  maxBytes = AUTH_BODY_MAX_BYTES,
): Promise<Record<string, unknown>> {
  const text = await readTextBounded(request, maxBytes);
  if (text === null) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * A multipart body, read with the same bound. The upload routes' Content-Length
 * pre-check is skipped by chunked transfer encoding; this is not.
 */
export async function readFormDataBounded(
  request: Request,
  maxBytes: number,
): Promise<FormData | null> {
  const bytes = await readBodyBounded(request, maxBytes);
  if (bytes === null) return null;
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: bytes,
  }).formData();
}
