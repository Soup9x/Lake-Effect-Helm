/**
 * The one place a browser response becomes a result.
 *
 * Every write in the interface goes through apiFetch now, so the branches here
 * are the branches every form has: a refusal with the server's sentence, a
 * response that is not Helm's at all, a 204, and nothing answering.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, NETWORK_FAILURE, toApiResult } from '../../src/lib/ui/api';

const envelope = (code: string, message: string, details?: Record<string, unknown>) => ({
  error: { code, message, ...(details ? { details } : {}), requestId: 'req-1' },
});

describe('toApiResult', () => {
  it("carries the server's code, message and audit event through", () => {
    const result = toApiResult(false, 403, envelope('step_up_required', 'nope', { auditEventUid: 'abc' }));
    expect(result).toEqual({
      ok: false,
      status: 403,
      code: 'step_up_required',
      message: 'nope',
      details: { auditEventUid: 'abc' },
      auditEventUid: 'abc',
      requestId: 'req-1',
    });
  });

  it('falls back to a usable failure when the body is not an envelope', () => {
    // A proxy's HTML error page, or a route that threw before the handler.
    // Without this the code is undefined and a step-up prompt never opens.
    expect(toApiResult(false, 502, null)).toEqual({
      ok: false,
      status: 502,
      code: 'http',
      message: 'The request failed (502).',
    });
    expect(toApiResult(false, 400, { error: 'a string, not an object' })).toMatchObject({
      code: 'http',
      message: 'The request failed (400).',
    });
  });

  it('hands a success body back untouched and a 204 back as undefined', () => {
    expect(toApiResult<{ id: string }>(true, 200, { id: 'x' })).toEqual({ ok: true, status: 200, value: { id: 'x' } });
    expect(toApiResult(true, 204, null)).toEqual({ ok: true, status: 204, value: undefined });
  });
});

describe('apiFetch', () => {
  afterEach(() => vi.unstubAllGlobals());

  const respond = (status: number, body: unknown, type = 'application/json; charset=utf-8') =>
    new Response(body === null ? null : JSON.stringify(body), {
      status,
      headers: body === null ? {} : { 'content-type': type },
    });

  it('sends JSON with the content type and defaults the method from the body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(200, { ok: 1 }));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/api/x', { json: { a: 1 } });
    await apiFetch('/api/y');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/x');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');

    expect((fetchMock.mock.calls[1] as [string, RequestInit])[1].method).toBe('GET');
  });

  it('leaves a FormData body alone so the browser sets the multipart boundary', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(200, {}));
    vi.stubGlobal('fetch', fetchMock);
    const form = new FormData();

    await apiFetch('/api/upload', { method: 'POST', body: form });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe(form);
    expect((init.headers as Record<string, string>)['content-type']).toBeUndefined();
  });

  it('returns the network sentence instead of throwing when nothing answers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const result = await apiFetch('/api/x', { json: {} });

    expect(result).toEqual({ ok: false, status: 0, code: 'network', message: NETWORK_FAILURE });
  });

  it('reads an envelope on failure and ignores a non-JSON body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(409, envelope('conflict', 'that already exists'))));
    expect(await apiFetch('/api/x', { json: {} })).toMatchObject({ ok: false, status: 409, code: 'conflict' });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } })),
    );
    expect(await apiFetch('/api/x', { json: {} })).toMatchObject({ ok: false, status: 502, code: 'http' });
  });

  it('treats a 204 as success with no value', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(204, null)));
    expect(await apiFetch('/api/x', { method: 'DELETE' })).toEqual({ ok: true, status: 204, value: undefined });
  });
});
