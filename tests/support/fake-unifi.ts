/**
 * A stub UniFi controller, over real TLS with a self-signed certificate.
 *
 * Self-signed on purpose: that is the normal state of a local UniFi console,
 * and it is the case the pinning code exists for. A stub with a trusted
 * certificate would exercise the easy path and leave the interesting one
 * untested.
 *
 * The certificate is generated per instance at start-up, so the test can pin a
 * fingerprint it computed itself and a second instance is genuinely a different
 * certificate — which is what makes the pin-mismatch case real rather than
 * simulated.
 */
import { createServer, type Server } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { X509Certificate } from 'node:crypto';

export type FakeUnifiMode =
  | 'ok'
  /** The controller answers, but rejects the key. */
  | 'unauthorized'
  /** No Integration API at all — a controller below the version floor. */
  | 'too-old'
  /** Answers with something that is not JSON, like a proxy's login page. */
  | 'not-json'
  /** Never responds. */
  | 'hang';

export interface FakeUnifiOptions {
  mode?: FakeUnifiMode;
  devices?: Record<string, unknown>[];
  clients?: Record<string, unknown>[];
  /** Force pagination, to exercise the offset loop. */
  pageSize?: number;
}

export class FakeUnifi {
  private constructor(
    private readonly server: Server,
    private readonly dir: string,
    readonly url: string,
    readonly sha256: string,
    /** Every path requested, with its query. */
    readonly requests: string[],
    /** Every X-API-KEY header received. */
    readonly keys: string[],
  ) {}

  static async start(options: FakeUnifiOptions = {}): Promise<FakeUnifi> {
    const mode = options.mode ?? 'ok';
    const devices = options.devices ?? [];
    const clients = options.clients ?? [];
    const pageSize = options.pageSize ?? 200;

    const dir = mkdtempSync(join(tmpdir(), 'helm-unifi-'));
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
      '-days', '1', '-subj', '/CN=unifi.test',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ], { stdio: 'ignore' });

    const certPem = readFileSync(join(dir, 'cert.pem'));
    const sha256 = new X509Certificate(certPem).fingerprint256.replace(/:/g, '').toLowerCase();

    const requests: string[] = [];
    const keys: string[] = [];

    const server = createServer(
      { cert: certPem, key: readFileSync(join(dir, 'key.pem')) },
      (req, res) => {
        requests.push(req.url ?? '');
        const key = req.headers['x-api-key'];
        if (typeof key === 'string') keys.push(key);

        if (mode === 'hang') return;

        if (mode === 'unauthorized') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: 'Unauthorized' }));
          return;
        }

        if (mode === 'too-old') {
          // What a pre-9.x controller does: the whole prefix is absent.
          res.writeHead(404, { 'content-type': 'text/html' });
          res.end('<html>404</html>');
          return;
        }

        if (mode === 'not-json') {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<!doctype html><title>Sign in</title>');
          return;
        }

        const url = new URL(req.url ?? '/', 'https://unifi.test');
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 200), pageSize);

        const page = <T>(all: T[]) => {
          const slice = all.slice(offset, offset + limit);
          return {
            data: slice,
            offset,
            limit,
            count: slice.length,
            totalCount: all.length,
          };
        };

        let body: unknown;
        if (url.pathname === '/proxy/network/integration/v1/sites') {
          body = page([{ id: 'site-1', name: 'Default' }]);
        } else if (url.pathname.endsWith('/devices')) {
          body = page(devices);
        } else if (url.pathname.endsWith('/clients')) {
          body = page(clients);
        } else {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: 'not found' }));
          return;
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      },
    );

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    return new FakeUnifi(server, dir, `https://127.0.0.1:${port}`, sha256, requests, keys);
  }

  /** A fingerprint that is valid in shape but belongs to no certificate. */
  static wrongFingerprint(): string {
    return createHash('sha256').update('not this certificate').digest('hex');
  }

  stop(): void {
    this.server.closeAllConnections?.();
    this.server.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}
