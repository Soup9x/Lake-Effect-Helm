/**
 * What a server's certificate actually says, read without trusting it.
 *
 * PRIOR ART, DELIBERATELY NOT SHARED. src/lib/unifi/client.ts has
 * inspectCertificate(), which does the same socket dance for the connection
 * test, and its central reasoning is reused here verbatim in spirit: reading a
 * certificate is not trusting it, nothing is written to the socket, so an
 * unverified peer learns only that somebody connected.
 *
 * It is not imported, for two reasons that are about the contract rather than
 * about taste. It throws UnifiError, which a domain-refresh worker has no
 * business catching; and it returns `validTo` as the OpenSSL-format string
 * Node hands over, where this needs real Dates — both ends of the validity
 * window — to write a timestamptz. Changing its return shape would alter a
 * shipped module that has a real-TLS test suite of its own, mid-group, to save
 * fifteen lines of socket setup. Extracting the common core into a neutral
 * module is the right end state and is recorded as a follow-up rather than done
 * here.
 *
 * rejectUnauthorized IS FALSE ON PURPOSE, and it is not a weakening. The job of
 * this probe is to report what is being served — including an expired
 * certificate, which is the single most interesting case and the one a
 * verifying connection refuses to tell you about. A probe that only works while
 * everything is fine is a probe that goes quiet exactly when it matters.
 */
import { connect as tlsConnect } from 'node:tls';

export interface ObservedCertificate {
  /** Lower-case hex, no colons, so it compares against a stored value. */
  fingerprintSha256: string;
  subject: string;
  issuer: string;
  notBefore: Date;
  notAfter: Date;
  /** Whether it verifies against this host's trust store as it stands. */
  trusted: boolean;
  selfSigned: boolean;
}

/** A probe that could not answer. Carries no stack worth logging. */
export class CertificateProbeError extends Error {
  readonly reason: 'unreachable' | 'no_certificate' | 'unreadable';

  constructor(message: string, reason: CertificateProbeError['reason']) {
    super(message);
    this.name = 'CertificateProbeError';
    this.reason = reason;
  }
}

/**
 * RFC 6066 forbids an IP literal in SNI, Node warns about it, and a future
 * version drops it silently. A certificate installed on an address rather than
 * a name is an ordinary on-premises case, so send no SNI there instead of
 * something the peer may reject. Same rule as the UniFi client's sniFor().
 */
function sniFor(host: string): string | undefined {
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  const isIpv6 = host.includes(':');
  return isIpv4 || isIpv6 ? undefined : host;
}

/**
 * Node gives `valid_from`/`valid_to` in OpenSSL's format — "Oct 14 20:00:00
 * 2026 GMT" — which Date.parse handles, but a parse that silently yields
 * Invalid Date would write a null expiry and read as "checked, no expiry".
 * So an unparseable date is an error with the text in it.
 */
function parseCertDate(raw: string | undefined, which: string): Date {
  const parsed = raw === undefined ? Number.NaN : Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new CertificateProbeError(
      `could not read the certificate's ${which} date (${raw ?? 'absent'})`,
      'unreadable',
    );
  }
  return new Date(parsed);
}

export async function observeCertificate(
  host: string,
  options: { port?: number; timeoutMs?: number; servername?: string } = {},
): Promise<ObservedCertificate> {
  const port = options.port ?? 443;
  const timeoutMs = options.timeoutMs ?? 10_000;

  return new Promise<ObservedCertificate>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const socket = tlsConnect(
      {
        host,
        port,
        servername: options.servername ?? sniFor(host),
        rejectUnauthorized: false,
        timeout: timeoutMs,
      },
      () => {
        const cert = socket.getPeerCertificate();
        const authorized = socket.authorized;
        socket.end();

        if (!cert?.fingerprint256) {
          finish(() => reject(new CertificateProbeError(
            `${host}:${port} presented no certificate`, 'no_certificate',
          )));
          return;
        }

        // CN is `string | string[]` in the type and genuinely an array on a
        // certificate carrying several, so join rather than index — otherwise a
        // multi-CN certificate silently reads as its first name only.
        const nameOf = (field: string | string[] | undefined): string =>
          (Array.isArray(field) ? field.join(', ') : field) ?? '';
        const subject = nameOf(cert.subject?.CN);
        const issuer = nameOf(cert.issuer?.CN);

        try {
          finish(() => resolve({
            fingerprintSha256: cert.fingerprint256.replace(/:/g, '').toLowerCase(),
            subject,
            issuer,
            notBefore: parseCertDate(cert.valid_from, 'valid from'),
            notAfter: parseCertDate(cert.valid_to, 'valid to'),
            trusted: authorized,
            // Equal and non-empty: two certificates with no CN at all are not
            // evidence of self-signing, and '' === '' would say they were.
            selfSigned: subject !== '' && subject === issuer,
          }));
        } catch (error) {
          finish(() => reject(error));
        }
      },
    );

    socket.on('timeout', () => {
      socket.destroy();
      finish(() => reject(new CertificateProbeError(
        `no TLS response from ${host}:${port} within ${Math.round(timeoutMs / 1000)}s`,
        'unreachable',
      )));
    });

    socket.on('error', (error: Error) => {
      finish(() => reject(new CertificateProbeError(
        `could not reach ${host}:${port}: ${error.message}`, 'unreachable',
      )));
    });
  });
}
