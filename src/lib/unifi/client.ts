/**
 * A client for the UniFi Network Integration API.
 *
 * WHICH API, AND WHY NOT THE OTHERS
 *
 *   Integration API (this one)  https://{host}/proxy/network/integration/v1
 *                               X-API-KEY header
 *                               UniFi Network 9.x+ on UniFi OS 9.3.43+
 *
 *   Classic controller API      /api/s/{site}/stat/device, /stat/sta
 *                               NOT USED. An API key does not authenticate it
 *                               at all — it wants a cookie session and a CSRF
 *                               header — so a design that stored a key and
 *                               called these would 401 on every poll.
 *
 *   Site Manager (api.ui.com)   NOT USED. Helm is an on-premises product;
 *                               routing a client's inventory through Ubiquiti's
 *                               cloud to read a controller on the same LAN is a
 *                               dependency nobody asked for.
 *
 * The version floor is a real deployment requirement. A controller below it
 * answers 404 on every path here, which is why testConnection() names the
 * requirement instead of reporting "not found".
 *
 * WHY node:https AND NOT fetch
 *
 * Certificate pinning. Node's fetch gives no hook that runs BEFORE the request
 * is written to the socket, and this request carries an API key in a header. A
 * custom agent below refuses to hand the socket to the HTTP layer at all until
 * the certificate matches, so the key cannot reach a connection we have not
 * authenticated. That ordering is the whole point and it is not expressible
 * with fetch.
 */
import { Agent, request as httpsRequest, type RequestOptions } from 'node:https';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import type { Socket } from 'node:net';

/** Where the Integration API lives under a controller's origin. */
const INTEGRATION_PREFIX = '/proxy/network/integration/v1';

/** The controller's own ceiling. Asking for more is a 400. */
const MAX_PAGE = 200;

/** Stop a runaway pagination loop from walking a hostile or broken controller forever. */
const MAX_PAGES = 200;

export class UnifiError extends Error {
  constructor(
    message: string,
    readonly kind:
      | 'unreachable'
      | 'tls_untrusted'
      | 'tls_pin_mismatch'
      | 'unauthorized'
      | 'not_found'
      | 'version_too_old'
      | 'malformed'
      | 'http_error',
    /** What an operator should change. Rendered next to the failure. */
    readonly remedy?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'UnifiError';
  }
}

export interface UnifiTarget {
  /** Origin only: https://host[:port], no path, no trailing slash. */
  readonly controllerUrl: string;
  readonly apiKey: string;
  /**
   * The one certificate this mapping accepts, as lowercase hex sha256.
   *
   * Null means ordinary chain verification. A value means the controller
   * presents a self-signed certificate an administrator has explicitly
   * accepted, and ONLY that certificate will be talked to — which still
   * detects interception, where disabling verification would not.
   */
  readonly pinnedSha256: string | null;
  readonly timeoutMs?: number;
}

/** sha256 of a certificate, as Node reports it, normalised to lowercase hex. */
function normaliseFingerprint(raw: string): string {
  return raw.replace(/:/g, '').toLowerCase();
}

/**
 * SNI, but only when the host is a name.
 *
 * RFC 6066 forbids an IP literal in Server Name Indication, Node warns about it
 * and a future version will drop it silently. A controller reached by address
 * rather than by name is an ordinary on-premises case, so this returns
 * undefined there instead of sending something the peer is entitled to reject.
 */
function sniFor(host: string | undefined): string | undefined {
  if (!host) return undefined;
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  const isIpv6 = host.includes(':');
  return isIpv4 || isIpv6 ? undefined : host;
}

/**
 * An agent that will not surrender a socket until the certificate matches.
 *
 * For a pinned target we must disable Node's chain verification — a self-signed
 * certificate can never satisfy it — and substitute an exact-certificate check,
 * which is strictly stronger for this case: a chain check accepts any
 * certificate from any trusted CA, a pin accepts one certificate.
 *
 * THE ORDERING IS THE SECURITY PROPERTY. The check happens inside
 * createConnection, before the socket is returned, so the HTTP layer never
 * writes the API key to a connection whose certificate we have not matched.
 * Checking on a 'secureConnect' listener after the request was created would
 * race the request body.
 */
function agentFor(target: UnifiTarget): Agent {
  if (!target.pinnedSha256) {
    // The ordinary path: a controller with a certificate that chains to a CA
    // this host trusts, whether public or added through NODE_EXTRA_CA_CERTS.
    return new Agent({ rejectUnauthorized: true, keepAlive: false });
  }

  const pinned = target.pinnedSha256.toLowerCase();

  const agent = new Agent({ keepAlive: false });
  // @ts-expect-error -- createConnection is a documented Agent hook that the
  // bundled types do not describe. Assigning it is the supported way to control
  // how an https.Agent establishes its TLS socket.
  agent.createConnection = (
    options: RequestOptions,
    callback: (error: Error | null, socket?: Socket) => void,
  ): void => {
    // Built explicitly rather than spread from `options`: an https.Agent's
    // connection options carry HTTP-layer members that mean nothing to
    // tls.connect, and spreading them in has no upside beyond looking tidy.
    const host = typeof options.host === 'string' ? options.host : undefined;

    const socket: TLSSocket = tlsConnect(
      {
        host,
        port: Number(options.port ?? 443),
        servername: sniFor(host),
        // We verify the certificate ourselves, below, against a pin. This is
        // not "trust anything": nothing is trusted until the fingerprint
        // matches, and the socket is destroyed if it does not.
        rejectUnauthorized: false,
      },
      () => {
        const cert = socket.getPeerCertificate();
        const actual = cert?.fingerprint256 ? normaliseFingerprint(cert.fingerprint256) : null;

        if (!actual) {
          socket.destroy();
          callback(
            new UnifiError(
              'the controller presented no certificate',
              'tls_untrusted',
            ),
          );
          return;
        }

        if (actual !== pinned) {
          socket.destroy();
          callback(
            new UnifiError(
              `the controller's certificate does not match the pin for this mapping ` +
                `(expected ${pinned.slice(0, 16)}…, got ${actual.slice(0, 16)}…)`,
              'tls_pin_mismatch',
              'The certificate changed. If the controller was legitimately ' +
                'rebuilt or renewed, re-run the connection test and accept the ' +
                'new fingerprint. If it did not change on purpose, stop and ' +
                'find out why.',
            ),
          );
          return;
        }

        callback(null, socket);
      },
    );

    socket.on('error', (error) => callback(error));
  };

  return agent;
}

interface PaginatedResponse<T> {
  data: T[];
  offset: number;
  limit: number;
  count: number;
  totalCount: number;
}

/**
 * One GET against the Integration API.
 *
 * Wraps node:https in a promise. The API key travels as a header, never in a
 * query string, so it does not land in the controller's access log.
 */
async function get<T>(target: UnifiTarget, path: string): Promise<T> {
  let origin: URL;
  try {
    origin = new URL(target.controllerUrl);
  } catch {
    throw new UnifiError(`${target.controllerUrl} is not a URL`, 'malformed');
  }

  const agent = agentFor(target);
  const timeoutMs = target.timeoutMs ?? 15_000;

  return new Promise<T>((resolve, reject) => {
    const req = httpsRequest(
      {
        protocol: 'https:',
        hostname: origin.hostname,
        port: origin.port || 443,
        path: `${INTEGRATION_PREFIX}${path}`,
        method: 'GET',
        agent,
        headers: {
          'X-API-KEY': target.apiKey,
          accept: 'application/json',
          'user-agent': 'lake-effect-helm/1 (+network-inventory)',
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;

          if (status === 401 || status === 403) {
            reject(
              new UnifiError(
                `the controller rejected the API key (${status})`,
                'unauthorized',
                'Check the key in the console under Settings → Control Plane → ' +
                  'Integrations → API Keys. A key from the Site Manager does not ' +
                  'authenticate a local controller.',
                status,
              ),
            );
            return;
          }

          if (status === 404) {
            // The single most likely cause, and it is a version problem rather
            // than a typo: the whole prefix is absent below the floor.
            reject(
              new UnifiError(
                `the controller has no Integration API at ${INTEGRATION_PREFIX}`,
                'version_too_old',
                'The Integration API needs UniFi Network 9.x or later on ' +
                  'UniFi OS 9.3.43 or later. Older controllers only expose the ' +
                  'classic API, which an API key cannot authenticate.',
                status,
              ),
            );
            return;
          }

          if (status < 200 || status >= 300) {
            reject(
              new UnifiError(
                `the controller answered ${status}${body ? `: ${body.slice(0, 200)}` : ''}`,
                'http_error',
                undefined,
                status,
              ),
            );
            return;
          }

          try {
            resolve(JSON.parse(body) as T);
          } catch {
            reject(
              new UnifiError(
                `the controller returned something that is not JSON`,
                'malformed',
                'Something other than the controller may be answering on that ' +
                  'address — a reverse proxy or a captive portal, typically.',
              ),
            );
          }
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(
        new UnifiError(
          `no response within ${timeoutMs / 1000}s`,
          'unreachable',
          'Check that this server can reach the controller. On-premises ' +
            'deployments often have egress rules that do not include it.',
        ),
      );
    });

    req.on('error', (error) => {
      if (error instanceof UnifiError) {
        reject(error);
        return;
      }
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (/^(DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_)/.test(code)) {
        reject(
          new UnifiError(
            `the controller's certificate is not trusted by this server (${code})`,
            'tls_untrusted',
            'A local UniFi console ships a self-signed certificate. Run the ' +
              'connection test and accept the fingerprint to pin it for this ' +
              'mapping, or install a certificate that chains to a CA this ' +
              'server trusts.',
          ),
        );
        return;
      }
      reject(new UnifiError(`could not reach the controller: ${error.message}`, 'unreachable'));
    });

    req.end();
  });
}

/**
 * Walk every page of a list endpoint.
 *
 * The controller caps a page at 200 and reports totalCount, so the loop ends on
 * the count rather than on an empty page — a controller that returns fewer rows
 * than it promised should not spin forever. MAX_PAGES is the backstop for one
 * that misreports totalCount entirely.
 */
async function getAll<T>(target: UnifiTarget, path: string): Promise<T[]> {
  const out: T[] = [];
  let offset = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const sep = path.includes('?') ? '&' : '?';
    const body = await get<PaginatedResponse<T>>(
      target,
      `${path}${sep}offset=${offset}&limit=${MAX_PAGE}`,
    );

    if (!Array.isArray(body?.data)) {
      throw new UnifiError(`${path} did not return a data array`, 'malformed');
    }

    out.push(...body.data);

    const total = Number(body.totalCount ?? out.length);
    offset += body.data.length;
    if (body.data.length === 0 || out.length >= total) break;
  }

  return out;
}

/**
 * A site as the controller reports it.
 *
 * Only `id` and `name` are relied on. Everything else the controller sends is
 * ignored rather than typed, because a field this integration does not use is
 * one more thing to break when Ubiquiti renames it.
 */
export interface UnifiSite {
  id: string;
  name?: string;
}

/**
 * A device or client, read tolerantly.
 *
 * The Integration API uses camelCase where the classic API used snake_case, and
 * field names have moved between versions. Every accessor below tries the
 * shapes seen in the wild and tolerates absence, because a missing `uptime`
 * should cost one null column rather than the whole poll.
 */
export type UnifiRecord = Record<string, unknown>;

export async function listSites(target: UnifiTarget): Promise<UnifiSite[]> {
  return getAll<UnifiSite>(target, '/sites');
}

export async function listDevices(target: UnifiTarget, siteId: string): Promise<UnifiRecord[]> {
  return getAll<UnifiRecord>(target, `/sites/${encodeURIComponent(siteId)}/devices`);
}

export async function listClients(target: UnifiTarget, siteId: string): Promise<UnifiRecord[]> {
  return getAll<UnifiRecord>(target, `/sites/${encodeURIComponent(siteId)}/clients`);
}

/**
 * What a controller's certificate is, without trusting it.
 *
 * Used by the connection test so an administrator can be SHOWN a fingerprint
 * and decide whether to pin it. Deliberately separate from the request path:
 * this connects, reads the certificate and hangs up without sending anything,
 * so no credential is exposed to a certificate nobody has accepted yet.
 */
export interface CertificateInfo {
  sha256: string;
  subject: string;
  issuer: string;
  validTo: string;
  selfSigned: boolean;
  /** Whether it verifies against this host's trust store as-is. */
  trusted: boolean;
}

export async function inspectCertificate(
  controllerUrl: string,
  timeoutMs = 10_000,
): Promise<CertificateInfo> {
  const origin = new URL(controllerUrl);

  return new Promise<CertificateInfo>((resolve, reject) => {
    const socket = tlsConnect(
      {
        host: origin.hostname,
        port: Number(origin.port || 443),
        servername: sniFor(origin.hostname),
        // Reading a certificate is not trusting it. Nothing is sent on this
        // socket — no API key, no request — so an unverified peer learns
        // nothing beyond the fact that somebody connected.
        rejectUnauthorized: false,
        timeout: timeoutMs,
      },
      () => {
        const cert = socket.getPeerCertificate();
        const authorized = socket.authorized;
        socket.end();

        if (!cert?.fingerprint256) {
          reject(new UnifiError('the controller presented no certificate', 'tls_untrusted'));
          return;
        }

        // CN is `string | string[]` in the type, and genuinely is an array on a
        // certificate carrying several. Joined rather than indexed, so a
        // multi-CN certificate reads as what it is instead of silently
        // showing the first one.
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
      reject(
        new UnifiError(
          `no TLS response from ${origin.host} within ${timeoutMs / 1000}s`,
          'unreachable',
          'Check that this server can reach the controller on that port.',
        ),
      );
    });

    socket.on('error', (error) => {
      reject(new UnifiError(`could not reach ${origin.host}: ${error.message}`, 'unreachable'));
    });
  });
}
