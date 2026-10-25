/**
 * Local servers for the outbound probes, over real sockets.
 *
 * NO NETWORK MOCKING, and no outbound traffic either — both of which matter.
 * CI has no egress, so a test that reached a real registry would be a test that
 * fails for reasons nothing to do with the code; and a mocked `fetch` or a
 * stubbed TLS socket proves only that the stub matches the author's idea of the
 * protocol. tests/support/fake-unifi.ts already settled this question for the
 * UniFi client — a real TLS server with a real self-signed certificate — and
 * these follow it.
 *
 * THE SELF-SIGNED CERTIFICATE IS THE POINT, for the same reason it was there.
 * A self-signed certificate is one the trust store REJECTS, so a probe that
 * returns facts about it is a probe whose rejectUnauthorized:false is really
 * doing the job it claims — reporting what is being served even when the
 * handshake would not verify. That is the same mechanism an expired certificate
 * exercises, which this OpenSSL (3.0.13) cannot easily generate: -not_before
 * and -not_after arrived in 3.2.
 */
import { createServer as createHttpsServer, type Server } from 'node:https';
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import type { AddressInfo } from 'node:net';

interface Material {
  dir: string;
  key: Buffer;
  cert: Buffer;
  sha256: string;
  notAfter: Date;
  notBefore: Date;
}

function certificate(commonName: string, days: number): Material {
  const dir = mkdtempSync(join(tmpdir(), 'helm-ext-'));
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
    '-days', String(days), '-subj', `/CN=${commonName}`,
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { stdio: 'ignore' });

  const cert = readFileSync(join(dir, 'cert.pem'));
  const parsed = new X509Certificate(cert);
  return {
    dir,
    key: readFileSync(join(dir, 'key.pem')),
    cert,
    sha256: parsed.fingerprint256.replace(/:/g, '').toLowerCase(),
    notAfter: new Date(parsed.validTo),
    notBefore: new Date(parsed.validFrom),
  };
}

/**
 * Listen, and REJECT if the bind fails.
 *
 * `new Promise((resolve) => server.listen(port, host, resolve))` is the obvious
 * spelling and it is a trap: a failed bind emits an 'error' event with no
 * listener, which takes the process down and leaves the promise unsettled. In
 * vitest that surfaces as "Test timed out in 30000ms" pointing at the test
 * rather than at the bind — which is exactly how an EACCES on port 443 cost a
 * CI round here, telling me nothing.
 *
 * The remedy is in the message because the remedy is not obvious either: ports
 * below 1024 need a privileged process or a lowered
 * net.ipv4.ip_unprivileged_port_start, and CI sets the latter (see the database
 * job in .github/workflows/ci.yml).
 */
async function listenOrExplain(server: Server | TcpServer, port: number): Promise<AddressInfo> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening);
      reject(new Error(
        `could not bind 127.0.0.1:${port} (${error.code ?? error.message})`
        + (error.code === 'EACCES' && port < 1024
          ? ' — a port below 1024 needs root or a lowered'
            + ' net.ipv4.ip_unprivileged_port_start; see the database job in'
            + ' .github/workflows/ci.yml'
          : ''),
      ));
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
  return server.address() as AddressInfo;
}

/** A TLS listener that serves a known certificate and nothing else. */
export class FakeTlsHost {
  private constructor(
    private readonly server: Server,
    private readonly material: Material,
    readonly host: string,
    readonly port: number,
  ) {}

  get sha256(): string { return this.material.sha256; }
  get notAfter(): Date { return this.material.notAfter; }
  get notBefore(): Date { return this.material.notBefore; }

  static async start(
    options: { commonName?: string; days?: number; port?: number } = {},
  ): Promise<FakeTlsHost> {
    const material = certificate(options.commonName ?? 'probe.test', options.days ?? 90);
    const server = createHttpsServer(
      { key: material.key, cert: material.cert },
      // Nothing is ever requested over this socket — the probe connects, reads
      // the certificate and hangs up — but a handler is needed for the server
      // to be well formed.
      (_req, res) => { res.writeHead(200); res.end('ok'); },
    );
    /*
     * A FIXED PORT IS OFFERED because the production probe connects on 443 and
     * takes no port — a certificate's reachable address is its common name, and
     * inventing a port parameter so a test could pass would be widening the
     * product to suit the test. This container runs as root, so 443 binds.
     */
    const address = await listenOrExplain(server, options.port ?? 0);
    return new FakeTlsHost(server, material, '127.0.0.1', address.port);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    rmSync(this.material.dir, { recursive: true, force: true });
  }
}

export type RdapMode =
  | 'ok'
  /** A valid document whose events array carries no expiration. */
  | 'no-expiry-event'
  /** A valid document with no events at all — some ccTLDs publish none. */
  | 'no-events'
  /** An expiration event whose date is not a date. */
  | 'unreadable-date'
  | 'not-found'
  | 'server-error'
  /** 403 unless the request names itself — what bot filtering in front of rdap.org does. */
  | 'forbidden-anonymous'
  | 'rate-limited'
  | 'not-json'
  /** Redirects once, to itself over https — what a redirector legitimately does. */
  | 'redirect-https'
  /** Redirects to plain http, which the probe must refuse rather than follow. */
  | 'redirect-http';

/** An RDAP service, over real TLS, answering from a canned document. */
export class FakeRdap {
  private constructor(
    private readonly server: Server,
    private readonly material: Material,
    readonly baseUrl: string,
    /** Every path requested, so a test can assert what was asked for. */
    readonly requests: string[],
  ) {}

  static async start(
    options: { mode?: RdapMode; expiresAt?: string } = {},
  ): Promise<FakeRdap> {
    const mode = options.mode ?? 'ok';
    const expiresAt = options.expiresAt ?? '2027-03-01T00:00:00Z';
    const material = certificate('rdap.test', 90);
    const requests: string[] = [];

    const server = createHttpsServer(
      { key: material.key, cert: material.cert },
      (req, res) => {
        requests.push(req.url ?? '');

        if (mode === 'redirect-https' && !req.url?.includes('final')) {
          const port = (server.address() as AddressInfo).port;
          res.writeHead(302, { location: `https://127.0.0.1:${port}/final${req.url}` });
          res.end();
          return;
        }
        if (mode === 'redirect-http') {
          res.writeHead(302, { location: 'http://127.0.0.1:1/domain/anything' });
          res.end();
          return;
        }
        if (mode === 'not-found') { res.writeHead(404); res.end('{}'); return; }
        if (mode === 'forbidden-anonymous'
          && !req.headers['user-agent']?.startsWith('lake-effect-helm/')) {
          res.writeHead(403); res.end('forbidden'); return;
        }
        if (mode === 'rate-limited') { res.writeHead(429); res.end('slow down'); return; }
        if (mode === 'server-error') { res.writeHead(503); res.end('busy'); return; }
        if (mode === 'not-json') {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<html><body>login</body></html>');
          return;
        }

        const document =
          mode === 'no-events' ? { objectClassName: 'domain' }
          : mode === 'no-expiry-event'
            ? { events: [{ eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' }] }
          : mode === 'unreadable-date'
            ? { events: [{ eventAction: 'expiration', eventDate: 'next Tuesday' }] }
          : {
              objectClassName: 'domain',
              events: [
                { eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' },
                // Mixed case on purpose: RFC 9083 says the action is a string
                // from a registry, and registries are not consistent about it.
                { eventAction: 'Expiration', eventDate: expiresAt },
              ],
            };

        res.writeHead(200, { 'content-type': 'application/rdap+json' });
        res.end(JSON.stringify(document));
      },
    );

    const address = await listenOrExplain(server, 0);
    return new FakeRdap(
      server, material, `https://127.0.0.1:${address.port}`, requests,
    );
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    rmSync(this.material.dir, { recursive: true, force: true });
  }
}

/**
 * A TCP port that accepts and then says nothing.
 *
 * The hang an outbound probe has to survive: the job runs every minute, so one
 * unresponsive host must not hold the tick open. Local, because an EXTERNAL
 * address cannot test this from a sandboxed container at all — the egress
 * gateway here intercepts outbound TLS and completes a handshake for any
 * address, presenting its own certificate ("Egress Gateway SDS Issuing CA"),
 * so even RFC 5737 reserved space answers. A test aimed at a reserved address
 * passed for the wrong reason until that was measured.
 */
export class FakeSilentPort {
  private constructor(
    private readonly server: TcpServer,
    private readonly held: Socket[],
    readonly host: string,
    readonly port: number,
  ) {}

  static async start(): Promise<FakeSilentPort> {
    // Accept the socket and hold it: no TLS, no bytes, no close.
    const held: Socket[] = [];
    const server = createTcpServer((socket) => { held.push(socket); });
    const address = await listenOrExplain(server, 0);
    return new FakeSilentPort(server, held, '127.0.0.1', address.port);
  }

  /**
   * THE HELD SOCKETS ARE DESTROYED FIRST, and that is not tidiness.
   * server.close() stops accepting and calls back only once every existing
   * connection has ended — so a server whose whole job is to hold a socket open
   * never finishes closing, and the test hangs in its own cleanup rather than
   * in the code under test. The first version of this did exactly that: a
   * 400ms probe timeout produced a 30-second test timeout, which looked like
   * the probe failing to time out and was not.
   */
  async stop(): Promise<void> {
    for (const socket of this.held) socket.destroy();
    this.held.length = 0;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
