/**
 * A webhook receiver that records what it was actually sent.
 *
 * Exists because the interesting failures are on the wire, not in the
 * formatter. Discord refuses a bare `text` with a 400 and Teams wants an
 * Adaptive Card inside an attachment envelope — a test that only inspects the
 * object a function returned proves neither the headers nor the body a platform
 * would see.
 *
 * Plain HTTP. The https requirement belongs to the stored configuration and is
 * enforced by zod and by isDeliverable(), both tested directly; making this TLS
 * would test Node's trust store rather than Helm's delivery.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ReceivedRequest {
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly raw: string;
}

export type FakeWebhookMode =
  /** 204, like Discord. */
  | 'ok'
  /** 400 with a body naming the problem, like Discord refusing a payload. */
  | 'bad-request'
  /** 500, so the retry path is exercised. */
  | 'server-error'
  /** Never responds; the caller's timeout ends it. */
  | 'hang';

export class FakeWebhook {
  private constructor(
    private readonly server: Server,
    readonly url: string,
    readonly received: ReceivedRequest[],
  ) {}

  static async start(mode: FakeWebhookMode = 'ok'): Promise<FakeWebhook> {
    const received: ReceivedRequest[] = [];

    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: unknown = null;
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
        received.push({
          headers: Object.fromEntries(
            Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v ?? '')]),
          ),
          body,
          raw,
        });

        if (mode === 'hang') return;
        if (mode === 'bad-request') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: 'Cannot send an empty message', code: 50006 }));
          return;
        }
        if (mode === 'server-error') {
          res.writeHead(500);
          res.end('upstream on fire');
          return;
        }
        res.writeHead(204);
        res.end();
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return new FakeWebhook(server, `http://127.0.0.1:${port}/hook`, received);
  }

  stop(): void {
    this.server.closeAllConnections?.();
    this.server.close();
  }
}
