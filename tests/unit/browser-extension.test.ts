/**
 * The browser extension's pure parts (1120): which site a tab is on, what a
 * request signs, how the server checks it, and the Helm address the
 * extension's settings accept. The routes and the database are in
 * tests/integration/browser-extension.test.ts.
 */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { siteOf } from '../../src/lib/extension/site';
import { canonicalRequest, EMPTY_BODY_SHA256 } from '../../src/lib/extension/signature';
import { parseDevicePublicKey, verifyDeviceSignature } from '../../src/lib/auth/device-signature';
import { formatFingerprint } from '../../src/lib/extension/pairing';
import { normaliseServer } from '../../extension/src/server';

describe('working out the site', () => {
  it('normalises the host and finds its registrable domain', () => {
    expect(siteOf('https://Portal.Acme-Corp.test./x?y')).toEqual({ host: 'portal.acme-corp.test', registrableDomain: 'acme-corp.test' });
    expect(siteOf('https://admin.example.co.uk/')).toEqual({ host: 'admin.example.co.uk', registrableDomain: 'example.co.uk' });
    // The private section of the list: one person's GitHub Pages site is not another's.
    expect(siteOf('https://foo.github.io/')).toEqual({ host: 'foo.github.io', registrableDomain: 'foo.github.io' });
  });

  it('matches an IP address or an intranet name exactly, with no site around it', () => {
    expect(siteOf('https://10.0.0.1:4443/')).toEqual({ host: '10.0.0.1', registrableDomain: null });
    expect(siteOf('http://[::1]:8080/')).toEqual({ host: '[::1]', registrableDomain: null });
    expect(siteOf('http://fileserver/')).toEqual({ host: 'fileserver', registrableDomain: null });
  });

  it('turns a Unicode lookalike into punycode, so it never equals the real host', () => {
    expect(siteOf('https://аcme.com/')?.host).toMatch(/^xn--/);
  });

  it('has nothing to say about a page that is not a website', () => {
    expect(siteOf('chrome://settings')).toBeNull();
    expect(siteOf('file:///etc/passwd')).toBeNull();
    expect(siteOf('not a url')).toBeNull();
  });
});

describe('the device signature', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const der = publicKey.export({ format: 'der', type: 'spki' });

  const request = (body: string, timestamp: number, signedBody = body, signedPath = '/api/extension/search') => {
    const data = canonicalRequest({
      method: 'POST',
      pathAndQuery: signedPath,
      timestamp: String(timestamp),
      bodySha256: createHash('sha256').update(signedBody).digest('hex'),
    });
    const signature = sign('sha256', Buffer.from(data), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    return new Request('https://helm.test/api/extension/search', {
      method: 'POST',
      headers: {
        'x-helm-device-timestamp': String(timestamp),
        'x-helm-device-signature': signature.toString('base64url'),
      },
      body,
    });
  };

  it('is one line per part, in a fixed order', () => {
    expect(canonicalRequest({ method: 'get', pathAndQuery: '/a?b=1', timestamp: '5', bodySha256: EMPTY_BODY_SHA256.toUpperCase() }))
      .toBe(`helm-ext-v1\nGET\n/a?b=1\n5\n${EMPTY_BODY_SHA256}`);
    expect(createHash('sha256').update('').digest('hex')).toBe(EMPTY_BODY_SHA256);
  });

  it('verifies, and leaves the body readable for the route', async () => {
    const now = Date.now();
    const r = request('{"q":"acme"}', now);
    expect(await verifyDeviceSignature(r, '/api/extension/search', der, now)).toEqual({ ok: true });
    expect(await r.text()).toBe('{"q":"acme"}');
  });

  it('refuses another body, another path, a stale time and a missing header', async () => {
    const now = Date.now();
    expect(await verifyDeviceSignature(request('{"q":"bank"}', now, '{"q":"acme"}'), '/api/extension/search', der, now))
      .toEqual({ ok: false, reason: 'bad_signature' });
    expect(await verifyDeviceSignature(request('{}', now, '{}', '/api/extension/renew'), '/api/extension/search', der, now))
      .toEqual({ ok: false, reason: 'bad_signature' });
    expect(await verifyDeviceSignature(request('{}', now - 6 * 60 * 1000), '/api/extension/search', der, now))
      .toEqual({ ok: false, reason: 'stale' });
    const bare = new Request('https://helm.test/x', { method: 'POST', body: '{}' });
    expect(await verifyDeviceSignature(bare, '/x', der, now)).toEqual({ ok: false, reason: 'missing' });
  });

  it('accepts only a P-256 key', () => {
    expect(parseDevicePublicKey(der)).not.toBeNull();
    const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({ format: 'der', type: 'spki' });
    expect(parseDevicePublicKey(p384)).toBeNull();
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' });
    expect(parseDevicePublicKey(rsa)).toBeNull();
    expect(parseDevicePublicKey(Buffer.from('nonsense'))).toBeNull();
  });

  it('shows the fingerprint as four groups of four', () => {
    expect(formatFingerprint('5d95abda123f1e7dffffffff')).toBe('5D95 ABDA 123F 1E7D');
  });
});

describe('the Helm address the extension accepts', () => {
  it('takes a bare host or a URL, and keeps only the origin', () => {
    expect(normaliseServer('helm.example.com')).toBe('https://helm.example.com');
    expect(normaliseServer(' https://helm.example.com/dashboard ')).toBe('https://helm.example.com');
    expect(normaliseServer('https://helm.example.com:8443')).toBe('https://helm.example.com:8443');
  });

  it('refuses plain http except on this machine', () => {
    expect(normaliseServer('http://helm.example.com')).toBeNull();
    expect(normaliseServer('http://localhost:3000')).toBe('http://localhost:3000');
    expect(normaliseServer('')).toBeNull();
  });
});
