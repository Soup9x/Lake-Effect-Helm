/**
 * A stub Proxmox VE, over real TLS with a self-signed certificate — Proxmox's
 * own default, and the case certificate pinning exists for. The certificate is
 * generated per instance, so a second instance is genuinely a different one.
 */
import { createServer, type Server } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import type { AddressInfo } from 'node:net';

export class FakeProxmox {
  /** Path -> data, answered as { data }. */
  readonly routes = new Map<string, unknown>();
  /** Paths answered 403, as a token without the privilege would be. */
  readonly refuse = new Set<string>();
  /** Every path requested. */
  readonly requests: string[] = [];
  /** Every Authorization header received. */
  readonly authorizations: string[] = [];

  private constructor(
    private readonly server: Server,
    private readonly dir: string,
    readonly url: string,
    readonly sha256: string,
    readonly tokenHeader: string,
  ) {}

  static async start(tokenId: string, tokenSecret: string): Promise<FakeProxmox> {
    const dir = mkdtempSync(join(tmpdir(), 'helm-pve-'));
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
      '-days', '1', '-subj', '/CN=pve1.test',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ], { stdio: 'ignore' });
    const certPem = readFileSync(join(dir, 'cert.pem'));
    const sha256 = new X509Certificate(certPem).fingerprint256.replace(/:/g, '').toLowerCase();

    let self: FakeProxmox | null = null;
    const server = createServer({ cert: certPem, key: readFileSync(join(dir, 'key.pem')) }, (req, res) => {
      const fake = self!;
      const path = (req.url ?? '/').replace(/^\/api2\/json/, '');
      fake.requests.push(path);
      const auth = req.headers.authorization;
      if (typeof auth === 'string') fake.authorizations.push(auth);
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (auth !== fake.tokenHeader) return send(401, { data: null });
      if (fake.refuse.has(path)) return send(403, { data: null });
      if (!fake.routes.has(path)) {
        // What Proxmox answers for an agent that is not running.
        if (path.includes('/agent/')) return send(500, { data: null, message: 'QEMU guest agent is not running' });
        return send(404, { data: null });
      }
      send(200, { data: fake.routes.get(path) });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    self = new FakeProxmox(server, dir, `https://127.0.0.1:${port}`, sha256, `PVEAPIToken=${tokenId}=${tokenSecret}`);
    return self;
  }

  reset(): void {
    this.routes.clear();
    this.refuse.clear();
    this.requests.length = 0;
    this.authorizations.length = 0;
  }

  stop(): void {
    this.server.closeAllConnections?.();
    this.server.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}
