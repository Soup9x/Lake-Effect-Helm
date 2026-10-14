/**
 * The TLS probe, against real certificates on real sockets.
 *
 * NO ENV TRICK HERE, unlike the RDAP tests, and the difference is the point:
 * this probe is SUPPOSED to read a certificate the trust store rejects. A
 * self-signed fixture certificate is exactly such a certificate, so it tests
 * the production code path as shipped — no verification is disabled anywhere,
 * because `rejectUnauthorized: false` is the deliberate design rather than a
 * concession.
 *
 * Why it is deliberate: the most interesting certificate on an MSP's estate is
 * the one that is expired or wrongly issued, and a verifying connection refuses
 * to tell you anything about it. A probe that only worked while everything was
 * fine would go quiet exactly when it mattered.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  CertificateProbeError, observeCertificate,
} from '../../src/lib/external/certificate';
import { FakeSilentPort, FakeTlsHost } from '../support/fake-external';

const running: FakeTlsHost[] = [];
async function host(options?: { commonName?: string; days?: number }): Promise<FakeTlsHost> {
  const h = await FakeTlsHost.start(options);
  running.push(h);
  return h;
}
afterEach(async () => {
  while (running.length > 0) await running.pop()!.stop();
});

describe('observing a certificate', () => {
  it('reads one the trust store rejects, which is the whole design', async () => {
    /*
     * A self-signed certificate does not verify. If this resolves at all, then
     * rejectUnauthorized:false is doing its job — and `trusted: false` is the
     * probe reporting that honestly rather than hiding it.
     */
    const server = await host({ commonName: 'probe.test', days: 90 });
    const seen = await observeCertificate(server.host, { port: server.port });

    expect(seen.trusted, 'a self-signed certificate must not be reported as trusted')
      .toBe(false);
    expect(seen.selfSigned).toBe(true);
    expect(seen.subject).toBe('probe.test');
    expect(seen.issuer).toBe('probe.test');
  });

  it('reports the fingerprint in the form a stored value compares against', async () => {
    // Lower-case hex with no colons, because that is what 0670 stores and what
    // a changed-certificate comparison needs. Node hands over colon-separated
    // upper case.
    const server = await host();
    const seen = await observeCertificate(server.host, { port: server.port });

    expect(seen.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(seen.fingerprintSha256, 'it should match the certificate the server was given')
      .toBe(server.sha256);
  });

  it('reads both ends of the validity window as real dates', async () => {
    /*
     * The reason this is not the UniFi client's inspectCertificate: that one
     * returns valid_to as the OpenSSL-format STRING Node gives it, and 0670
     * stores a timestamptz. A string that silently failed to parse would be
     * written as "checked, no expiry", which reads as reassurance.
     */
    const server = await host({ days: 30 });
    const seen = await observeCertificate(server.host, { port: server.port });

    expect(seen.notAfter).toBeInstanceOf(Date);
    expect(Number.isNaN(seen.notAfter.getTime())).toBe(false);
    expect(seen.notBefore.getTime()).toBeLessThan(seen.notAfter.getTime());

    // Within a minute of what the fixture's own X509 parse says, which is a
    // different code path from the probe's.
    expect(Math.abs(seen.notAfter.getTime() - server.notAfter.getTime()))
      .toBeLessThan(60_000);

    // And roughly thirty days out, so the number means something rather than
    // merely being a date.
    const days = (seen.notAfter.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(28);
    expect(days).toBeLessThan(31);
  });

  it('does not send SNI to an address, which RFC 6066 forbids', async () => {
    // The fixture listens on 127.0.0.1, so a probe that sent an IP literal as
    // SNI would be relying on a peer being lenient. It connects and reads,
    // which is the observable half of that rule.
    const server = await host();
    const seen = await observeCertificate('127.0.0.1', { port: server.port });
    expect(seen.fingerprintSha256).toBe(server.sha256);
  });

  it('reports a host that is not listening as unreachable', async () => {
    try {
      await observeCertificate('127.0.0.1', { port: 1, timeoutMs: 500 });
      expect.unreachable('port 1 should not answer');
    } catch (error) {
      expect(error).toBeInstanceOf(CertificateProbeError);
      expect((error as CertificateProbeError).reason).toBe('unreachable');
      expect((error as Error).message).toContain('127.0.0.1:1');
    }
  });

  it('gives up on a silent port rather than holding the worker open', async () => {
    /*
     * The hang an outbound probe has to survive: the job ticks every minute, so
     * one unresponsive host must not hold it. The fixture accepts the TCP
     * connection and then says nothing at all, which is the shape that defeats
     * a connect-timeout and needs a socket timeout.
     *
     * LOCAL, AND THAT IS NOT FASTIDIOUSNESS. The first version of this test
     * aimed at 198.51.100.1 — RFC 5737 reserved space — and PASSED FOR THE
     * WRONG REASON: it resolved. This container's egress gateway intercepts
     * outbound TLS and completes a handshake for any address, presenting its
     * own certificate (issuer "Egress Gateway SDS Issuing CA"), so every
     * external address looks alive. Measured, not assumed.
     */
    const silent = await FakeSilentPort.start();
    try {
      const started = Date.now();
      try {
        await observeCertificate(silent.host, { port: silent.port, timeoutMs: 400 });
        expect.unreachable('a silent port should not complete a handshake');
      } catch (error) {
        expect(error).toBeInstanceOf(CertificateProbeError);
        expect((error as CertificateProbeError).reason).toBe('unreachable');
        expect((error as Error).message).toMatch(/within 0s|within 1s/);
      }
      // Generous bound: the assertion is "it returned at all", not a benchmark.
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await silent.stop();
    }
  });

  it('settles exactly once, however the socket misbehaves', async () => {
    // The promise has a timeout handler, an error handler and a success path,
    // and a socket can fire more than one of them. A second resolve would be
    // silent; a second reject would be an unhandled rejection crashing the
    // worker.
    const server = await host();
    const results = await Promise.allSettled([
      observeCertificate(server.host, { port: server.port }),
      observeCertificate(server.host, { port: server.port }),
      observeCertificate('127.0.0.1', { port: 1, timeoutMs: 300 }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
  });
});
