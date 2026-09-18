/**
 * The UniFi client, against a real TLS server with a real self-signed
 * certificate.
 *
 * The certificate is the point. A local UniFi console ships self-signed, every
 * community client answers that with a global --insecure, and this integration
 * answers it with a per-mapping PIN instead. That difference only means
 * something if the pin is actually enforced, so these tests generate a
 * certificate, pin its fingerprint, and then check that a DIFFERENT certificate
 * is refused — which needs two genuinely different certificates rather than a
 * mock.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  UnifiError,
  inspectCertificate,
  listClients,
  listDevices,
  listSites,
} from '../../src/lib/unifi/client';
import { FakeUnifi } from '../support/fake-unifi';

const running: FakeUnifi[] = [];
async function controller(options?: Parameters<typeof FakeUnifi.start>[0]): Promise<FakeUnifi> {
  const c = await FakeUnifi.start(options);
  running.push(c);
  return c;
}

afterEach(() => {
  while (running.length) running.pop()!.stop();
});

const KEY = 'an-api-key-that-must-not-leak';

describe('certificate pinning', () => {
  it('refuses an untrusted certificate when nothing is pinned', async () => {
    // The default. A self-signed console fails closed rather than being
    // silently accepted.
    const c = await controller();
    await expect(
      listSites({ controllerUrl: c.url, apiKey: KEY, pinnedSha256: null }),
    ).rejects.toMatchObject({ kind: 'tls_untrusted' });
  });

  it('names the remedy rather than just failing', async () => {
    const c = await controller();
    await expect(
      listSites({ controllerUrl: c.url, apiKey: KEY, pinnedSha256: null }),
    ).rejects.toMatchObject({ remedy: expect.stringContaining('accept the fingerprint') });
  });

  it('connects when the presented certificate matches the pin', async () => {
    const c = await controller();
    const sites = await listSites({ controllerUrl: c.url, apiKey: KEY, pinnedSha256: c.sha256 });
    expect(sites).toEqual([{ id: 'site-1', name: 'Default' }]);
  });

  it('refuses a certificate that does not match the pin', async () => {
    const c = await controller();
    await expect(
      listSites({ controllerUrl: c.url, apiKey: KEY, pinnedSha256: FakeUnifi.wrongFingerprint() }),
    ).rejects.toMatchObject({ kind: 'tls_pin_mismatch' });
  });

  it('NEVER sends the API key to a certificate it did not match', async () => {
    // THE ORDERING PROPERTY. The pin is checked inside createConnection, before
    // the socket reaches the HTTP layer, so a mismatched controller sees a TLS
    // handshake and nothing else. Checked by asking the server what it got.
    const c = await controller();
    await expect(
      listSites({ controllerUrl: c.url, apiKey: KEY, pinnedSha256: FakeUnifi.wrongFingerprint() }),
    ).rejects.toThrow();

    expect(c.keys).toEqual([]);
    expect(c.requests).toEqual([]);
  });

  it('does not send the key to an untrusted certificate either', async () => {
    const c = await controller();
    await expect(
      listSites({ controllerUrl: c.url, apiKey: KEY, pinnedSha256: null }),
    ).rejects.toThrow();
    expect(c.keys).toEqual([]);
  });
});

describe('reading a certificate without trusting it', () => {
  it('reports the fingerprint an administrator would pin', async () => {
    const c = await controller();
    const info = await inspectCertificate(c.url);
    expect(info.sha256).toBe(c.sha256);
    expect(info.selfSigned).toBe(true);
    expect(info.trusted).toBe(false);
  });

  it('sends nothing on that connection', async () => {
    // Reading a certificate is not trusting it, and the test button runs this
    // BEFORE an administrator has accepted anything — so no credential may be
    // exposed to a certificate nobody has approved yet.
    const c = await controller();
    await inspectCertificate(c.url);
    expect(c.requests).toEqual([]);
    expect(c.keys).toEqual([]);
  });

  it('reports an unreachable host rather than hanging', async () => {
    await expect(inspectCertificate('https://127.0.0.1:1', 1000)).rejects.toMatchObject({
      kind: 'unreachable',
    });
  });
});

describe('talking to the Integration API', () => {
  const pinned = (c: FakeUnifi) => ({ controllerUrl: c.url, apiKey: KEY, pinnedSha256: c.sha256 });

  it('sends the key as a header, never in the query string', async () => {
    // A key in a query string lands in the controller's access log.
    const c = await controller();
    await listSites(pinned(c));
    expect(c.keys).toEqual([KEY]);
    expect(c.requests.join(' ')).not.toContain(KEY);
  });

  it('calls the Integration API paths, not the classic ones', async () => {
    // An API key does not authenticate /api/s/{site}/stat/device at all, so
    // calling it would 401 on every poll.
    const c = await controller({ devices: [{ id: 'd1' }] });
    await listDevices(pinned(c), 'site-1');
    expect(c.requests[0]).toContain('/proxy/network/integration/v1/sites/site-1/devices');
    expect(c.requests.join(' ')).not.toContain('/api/s/');
  });

  it('walks every page', async () => {
    const devices = Array.from({ length: 450 }, (_, i) => ({ id: `d${i}` }));
    const c = await controller({ devices, pageSize: 200 });

    const all = await listDevices(pinned(c), 'site-1');
    expect(all).toHaveLength(450);
    expect(new Set(all.map((d) => d.id)).size).toBe(450);
    // 200 + 200 + 50.
    expect(c.requests.filter((r) => r.includes('/devices'))).toHaveLength(3);
  });

  it('asks for at most the controller’s own page ceiling', async () => {
    // Above 200 the controller answers 400.
    const c = await controller({ devices: [{ id: 'd1' }] });
    await listDevices(pinned(c), 'site-1');
    expect(c.requests[0]).toContain('limit=200');
  });

  it('escapes a site id rather than pasting it into a path', async () => {
    const c = await controller();
    await listClients(pinned(c), 'site/../../evil');
    expect(c.requests[0]).not.toContain('/../');
  });

  it('reads a version-too-old controller as a version problem', async () => {
    // A 404 on the whole prefix means the Integration API is absent, which is
    // a version floor and not a typo — and saying "not found" would send an
    // operator looking for the wrong thing.
    const c = await controller({ mode: 'too-old' });
    await expect(listSites(pinned(c))).rejects.toMatchObject({
      kind: 'version_too_old',
      remedy: expect.stringContaining('9.3.43'),
    });
  });

  it('reads a rejected key as a key problem, with where to fix it', async () => {
    const c = await controller({ mode: 'unauthorized' });
    await expect(listSites(pinned(c))).rejects.toMatchObject({
      kind: 'unauthorized',
      remedy: expect.stringContaining('Control Plane'),
    });
  });

  it('reports a proxy login page as malformed rather than crashing', async () => {
    const c = await controller({ mode: 'not-json' });
    await expect(listSites(pinned(c))).rejects.toMatchObject({ kind: 'malformed' });
  });

  it('gives up on a controller that never answers', async () => {
    const c = await controller({ mode: 'hang' });
    await expect(
      listSites({ ...pinned(c), timeoutMs: 1200 }),
    ).rejects.toMatchObject({ kind: 'unreachable' });
  }, 15_000);

  it('refuses a URL that is not one', async () => {
    await expect(
      listSites({ controllerUrl: 'not a url', apiKey: KEY, pinnedSha256: null }),
    ).rejects.toBeInstanceOf(UnifiError);
  });
});
