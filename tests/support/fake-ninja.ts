/**
 * A stub NinjaOne, answering the requests Helm makes.
 *
 * Plain HTTP on loopback, reached through useNinjaTransport(): the request
 * Helm builds still names https://app.ninjarmm.com (which the database insists
 * on), and the transport below delivers it here instead. That keeps the region
 * allow-list real in the tests rather than switched off for them.
 */
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NinjaTransport } from '../../src/lib/ninja/client';

export type FakeNinjaMode = 'ok' | 'bad-credentials' | 'forbidden' | 'down';

export interface FakeNinjaRequest {
  method: string;
  path: string;
  host: string;
  authorization: string | null;
  form: Record<string, string> | null;
}

export class FakeNinja {
  mode: FakeNinjaMode = 'ok';
  organizations: Record<string, unknown>[] = [];
  devices: Record<string, unknown>[] = [];
  locations: Record<string, unknown>[] = [];
  antivirus: Record<string, unknown>[] = [];
  patches: Record<string, unknown>[] = [];
  /** Paths answered 403, as an app without the right scope would be. */
  readonly refuse = new Set<string>();
  readonly requests: FakeNinjaRequest[] = [];
  readonly clientSecret: string;

  private constructor(private readonly server: Server, readonly port: number, clientSecret: string) {
    this.clientSecret = clientSecret;
  }

  static async start(clientSecret: string): Promise<FakeNinja> {
    let self: FakeNinja | null = null;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => self!.answer(req.method ?? 'GET', req.url ?? '/', req.headers, Buffer.concat(chunks).toString('utf8'), res));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    self = new FakeNinja(server, (server.address() as AddressInfo).port, clientSecret);
    return self;
  }

  private answer(
    method: string, url: string, headers: Record<string, string | string[] | undefined>, body: string,
    res: import('node:http').ServerResponse,
  ) {
    const parsed = new URL(url, 'http://ninja.test');
    const form = method === 'POST' ? Object.fromEntries(new URLSearchParams(body)) : null;
    this.requests.push({
      method,
      path: parsed.pathname + parsed.search,
      host: String(headers['x-original-host'] ?? ''),
      authorization: typeof headers.authorization === 'string' ? headers.authorization : null,
      form,
    });

    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (this.mode === 'down') {
      res.writeHead(503, { 'content-type': 'text/html' });
      res.end('<html>maintenance</html>');
      return;
    }

    if (parsed.pathname === '/ws/oauth/token') {
      if (this.mode === 'bad-credentials' || form?.client_secret !== this.clientSecret || form?.grant_type !== 'client_credentials') {
        json(401, { error: 'invalid_client' });
        return;
      }
      json(200, { access_token: 'token-123', expires_in: 3600, token_type: 'Bearer' });
      return;
    }

    if (headers.authorization !== 'Bearer token-123') {
      json(401, { error: 'unauthorized' });
      return;
    }
    if (this.mode === 'forbidden') {
      json(403, { error: 'forbidden' });
      return;
    }

    if (this.refuse.has(parsed.pathname)) {
      json(403, { error: 'forbidden' });
      return;
    }

    const byId = (rows: Record<string, unknown>[]) => {
      const pageSize = Number(parsed.searchParams.get('pageSize') ?? 1000);
      const after = parsed.searchParams.get('after');
      const sorted = [...rows].sort((a, b) => Number(a.id) - Number(b.id));
      const start = after === null ? 0 : sorted.findIndex((d) => Number(d.id) > Number(after));
      return start < 0 ? [] : sorted.slice(start, start + pageSize);
    };
    const query = (rows: Record<string, unknown>[]) => {
      const pageSize = Number(parsed.searchParams.get('pageSize') ?? 1000);
      const offset = Number(parsed.searchParams.get('cursor') ?? 0);
      const results = rows.slice(offset, offset + pageSize);
      return { cursor: { name: String(offset + results.length), offset, count: results.length }, results };
    };

    if (parsed.pathname === '/api/v2/locations') {
      json(200, byId(this.locations));
      return;
    }
    if (parsed.pathname === '/api/v2/queries/antivirus-status') {
      json(200, query(this.antivirus));
      return;
    }
    if (parsed.pathname === '/api/v2/queries/os-patches') {
      json(200, query(this.patches));
      return;
    }
    if (parsed.pathname === '/api/v2/organizations') {
      json(200, this.organizations);
      return;
    }
    if (parsed.pathname === '/api/v2/devices-detailed') {
      json(200, byId(this.devices));
      return;
    }
    json(404, { error: 'not found' });
  }

  /** Delivers Helm's https://*.ninjarmm.com requests to this server. */
  transport(): NinjaTransport {
    return (url, request) => new Promise((resolve, reject) => {
      const target = new URL(url);
      const req = httpRequest({
        host: '127.0.0.1',
        port: this.port,
        method: request.method,
        path: target.pathname + target.search,
        headers: { ...request.headers, 'x-original-host': target.host },
        timeout: request.timeoutMs,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      if (request.body !== undefined) req.write(request.body);
      req.end();
    });
  }

  stop(): void {
    this.server.closeAllConnections?.();
    this.server.close();
  }
}
