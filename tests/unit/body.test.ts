/**
 * Bounded request bodies (lib/api/body.ts).
 *
 * request.text(), .json() and .formData() buffer the whole body before anybody
 * can check its size. On the public routes — the UniFi webhook, login, reset —
 * that let any caller make the process hold as much as it liked.
 */
import { describe, expect, it } from 'vitest';
import {
  readBodyBounded,
  readFormDataBounded,
  readJsonObjectOrEmpty,
} from '../../src/lib/api/body';

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request('http://helm.test/x', { method: 'POST', body, headers, duplex: 'half' } as RequestInit);

/** A body that declares no length and arrives in pieces, as a chunked upload does. */
function chunked(pieces: number, size: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent === pieces) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(new Uint8Array(size).fill(97));
    },
  });
}

describe('readBodyBounded', () => {
  it('returns a body within the limit, byte for byte', async () => {
    const bytes = await readBodyBounded(post('hello'), 10);
    expect(new TextDecoder().decode(bytes!)).toBe('hello');
  });

  it('refuses on the declared length without reading', async () => {
    expect(await readBodyBounded(post('x', { 'content-length': '5000000' }), 1000)).toBeNull();
  });

  it('refuses a chunked body that declares nothing, once it passes the limit', async () => {
    expect(await readBodyBounded(post(chunked(100, 1024)), 10 * 1024)).toBeNull();
    expect(await readBodyBounded(post(chunked(5, 1024)), 10 * 1024)).toHaveLength(5 * 1024);
  });
});

describe('readJsonObjectOrEmpty', () => {
  it('parses an object', async () => {
    expect(await readJsonObjectOrEmpty(post('{"email":"a@b.test"}'))).toEqual({ email: 'a@b.test' });
  });

  it('answers {} for malformed, non-object and oversized bodies alike', async () => {
    expect(await readJsonObjectOrEmpty(post('not json'))).toEqual({});
    expect(await readJsonObjectOrEmpty(post('[1,2]'))).toEqual({});
    expect(await readJsonObjectOrEmpty(post(JSON.stringify({ pad: 'x'.repeat(100_000) })))).toEqual({});
  });
});

describe('readFormDataBounded', () => {
  it('parses a form within the limit', async () => {
    const form = new FormData();
    form.set('organizationId', 'abc');
    const parsed = await readFormDataBounded(new Request('http://helm.test/x', { method: 'POST', body: form }), 10_000);
    expect(parsed?.get('organizationId')).toBe('abc');
  });

  it('refuses one over it', async () => {
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(50_000)]), 'big.bin');
    expect(await readFormDataBounded(new Request('http://helm.test/x', { method: 'POST', body: form }), 10_000)).toBeNull();
  });
});
