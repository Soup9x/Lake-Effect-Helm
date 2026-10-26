/**
 * HTTPS to a self-hosted service whose certificate may be self-signed (1110).
 *
 * The same shape as UniFi's client (src/lib/unifi/client.ts), without its
 * controller-specific messages, for any integration that talks to a box on a
 * client's or the MSP's own network:
 *
 *   No pin      ordinary chain verification against this host's trust store.
 *   A pin       exactly one certificate is accepted, by its sha256. A
 *               self-signed certificate can then be used without turning
 *               verification off, and interception is still detected.
 *
 * THE ORDERING IS THE SECURITY PROPERTY. For a pinned target the certificate
 * is matched inside the agent's createConnection, before the socket is handed
 * to the HTTP layer, so a request carrying a credential is never written to a
 * connection whose certificate has not matched.
 */
import { Agent, request as httpsRequest, type RequestOptions } from 'node:https';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import type { Socket } from 'node:net';

export class PinnedHttpsError extends Error {
  constructor(
    message: string,
    readonly kind: 'unreachable' | 'tls_untrusted' | 'tls_pin_mismatch' | 'too_large',
  ) {
    super(message);
    this.name = 'PinnedHttpsError';
  }
}

/** sha256 hex, lowercase, from any of the spellings people paste (colons, spaces, case). */
export function normaliseFingerprint(raw: string): string {
  return raw.replace(/[\s:]/g, '').toLowerCase();
}

export const FINGERPRINT = /^[0-9a-f]{64}$/;

/** SNI only for a name: RFC 6066 forbids an address there. */
function sniFor(host: string | undefined): string | undefined {
  if (!host) return undefined;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') ? undefined : host;
}

/** URL.hostname keeps an IPv6 literal's brackets; sockets want it without. */
function bareHost(hostname: string): string {
  return hostname.replace(/^\[(.*)\]$/, '$1');
}

function agentFor(pinnedSha256: string | null, handshakeTimeoutMs: number): Agent {
  if (!pinnedSha256) return new Agent({ rejectUnauthorized: true, keepAlive: false });

  const pinned = normaliseFingerprint(pinnedSha256);
  const agent = new Agent({ keepAlive: false });
  // @ts-expect-error -- createConnection is a documented Agent hook the bundled types do not describe.
  agent.createConnection = (
    options: RequestOptions,
    callback: (error: Error | null, socket?: Socket) => void,
  ): void => {
    const host = typeof options.host === 'string' ? options.host : undefined;
    const socket: TLSSocket = tlsConnect(
      {
        host,
        port: Number(options.port ?? 443),
        servername: sniFor(host),
        // Checked against the pin below; nothing is sent until it matches.
        rejectUnauthorized: false,
      },
      () => {
        clearTimeout(handshake);
        const cert = socket.getPeerCertificate();
        const actual = cert?.fingerprint256 ? normaliseFingerprint(cert.fingerprint256) : null;
        if (!actual) {
          socket.destroy();
          callback(new PinnedHttpsError('the server presented no certificate', 'tls_untrusted'));
          return;
        }
        if (actual !== pinned) {
          socket.destroy();
          callback(new PinnedHttpsError(
            `the server's certificate does not match the one this connection trusts ` +
              `(expected ${pinned.slice(0, 16)}…, got ${actual.slice(0, 16)}…)`,
            'tls_pin_mismatch',
          ));
          return;
        }
        callback(null, socket);
      },
    );
    // The request's own timeout starts after the handshake; this covers a
    // server that accepts TCP and never finishes TLS.
    const handshake = setTimeout(() => {
      socket.destroy(new PinnedHttpsError(`no TLS handshake within ${handshakeTimeoutMs / 1000}s`, 'unreachable'));
    }, handshakeTimeoutMs);
    socket.on('error', (error) => {
      clearTimeout(handshake);
      callback(error);
    });
  };
  return agent;
}

export interface PinnedRequest {
  headers: Record<string, string>;
  pinnedSha256: string | null;
  timeoutMs: number;
  /** Larger answers are refused rather than buffered. */
  maxBytes?: number;
}

/** One GET. Resolves with any status; rejects only when no answer arrived. */
export function pinnedGet(url: string, request: PinnedRequest): Promise<{ status: number; body: string }> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return Promise.reject(new PinnedHttpsError(`${url} is not a URL`, 'unreachable'));
  }
  if (target.protocol !== 'https:') {
    return Promise.reject(new PinnedHttpsError(`${url} is not https`, 'unreachable'));
  }
  const maxBytes = request.maxBytes ?? 20 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        protocol: 'https:',
        hostname: bareHost(target.hostname),
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        agent: agentFor(request.pinnedSha256, request.timeoutMs),
        headers: request.headers,
        timeout: request.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy(new PinnedHttpsError(`the answer was larger than ${maxBytes} bytes`, 'too_large'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );

    req.on('timeout', () => {
      req.destroy(new PinnedHttpsError(`no response within ${request.timeoutMs / 1000}s`, 'unreachable'));
    });
    req.on('error', (error) => {
      if (error instanceof PinnedHttpsError) {
        reject(error);
        return;
      }
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (/^(DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT|CERT_|ERR_TLS_CERT_ALTNAME)/.test(code)) {
        reject(new PinnedHttpsError(`the server's certificate is not trusted by this server (${code})`, 'tls_untrusted'));
        return;
      }
      reject(new PinnedHttpsError(`could not reach ${target.host}: ${error.message}`, 'unreachable'));
    });
    // An absolute bound too: `timeout` is an idle timer, and a trickle never trips it.
    const deadline = setTimeout(() => {
      req.destroy(new PinnedHttpsError(`no complete response within ${(request.timeoutMs * 2) / 1000}s`, 'unreachable'));
    }, request.timeoutMs * 2);
    req.on('close', () => clearTimeout(deadline));
    req.end();
  });
}

export interface CertificateInfo {
  sha256: string;
  subject: string;
  issuer: string;
  validTo: string;
  selfSigned: boolean;
  /** Whether it verifies against this host's trust store as it is. */
  trusted: boolean;
}

/**
 * What a server's certificate is, without trusting it: connect, read it, hang
 * up. Nothing is sent, so no credential reaches a certificate nobody accepted.
 */
export function inspectCertificate(url: string, timeoutMs = 10_000): Promise<CertificateInfo> {
  const origin = new URL(url);
  const host = bareHost(origin.hostname);
  return new Promise((resolve, reject) => {
    const socket = tlsConnect(
      { host, port: Number(origin.port || 443), servername: sniFor(host), rejectUnauthorized: false, timeout: timeoutMs },
      () => {
        const cert = socket.getPeerCertificate();
        const authorized = socket.authorized;
        socket.end();
        if (!cert?.fingerprint256) {
          reject(new PinnedHttpsError('the server presented no certificate', 'tls_untrusted'));
          return;
        }
        const nameOf = (field: string | string[] | undefined, fallback: unknown): string =>
          Array.isArray(field) ? field.join(', ') : (field ?? JSON.stringify(fallback ?? {}));
        const subject = nameOf(cert.subject?.CN, cert.subject);
        const issuer = nameOf(cert.issuer?.CN, cert.issuer);
        resolve({
          sha256: normaliseFingerprint(cert.fingerprint256),
          subject,
          issuer,
          validTo: cert.valid_to ?? 'unknown',
          selfSigned: subject === issuer,
          trusted: authorized,
        });
      },
    );
    socket.on('timeout', () => {
      socket.destroy();
      reject(new PinnedHttpsError(`no TLS response from ${origin.host} within ${timeoutMs / 1000}s`, 'unreachable'));
    });
    socket.on('error', (error) => {
      reject(new PinnedHttpsError(`could not reach ${origin.host}: ${error.message}`, 'unreachable'));
    });
  });
}
