/**
 * Opening a connection to the tenant's relay.
 *
 * NODEMAILER, AND WHY THIS ONE DEPENDENCY. Helm hand-writes protocol clients
 * where the npm options are unmaintained and the code sits on the
 * authentication path — §4 of docs/architecture/08-radius-authentication.md
 * makes that argument for RFC 2865. Neither half holds here: nodemailer is the
 * audited standard rather than an abandoned package, and sending a notification
 * is not authenticating anybody. What it gets right is the quiet part: RFC 2047
 * header encoding, so a client called "Hôtel Beaumont" does not arrive as
 * mojibake or get the message rejected; dot-stuffing, so a body line beginning
 * with a period does not truncate the message; CRLF discipline; line-length
 * limits; AUTH negotiation. Each of those failures loses a notification
 * silently, and 0400's bargain was that detection replaces prevention — a
 * channel that drops messages is the control being gone.
 *
 * THE RELAY'S PASSWORD NEVER PASSES THROUGH helm_app. 0690 grants the six
 * envelope columns to helm_worker alone, per column, and the only way to them
 * is helm.smtp_transport(). The plaintext exists for the length of one
 * connection, in the worker process, and is written nowhere.
 *
 * THREE SECURITY MODES, and the middle one is the interesting case:
 *
 *   tls        implicit TLS, port 465. The connection is encrypted before any
 *              SMTP verb is spoken.
 *   starttls   port 587. The default, and REQUIRED rather than opportunistic:
 *              `requireTLS` makes nodemailer abort if the relay does not offer
 *              STARTTLS, instead of carrying on in the clear. Opportunistic
 *              STARTTLS is the failure mode where a password crosses the
 *              network and nothing says so.
 *   plaintext  only when an administrator has signed for it, which 0690
 *              enforces with a CHECK requiring a timestamp and an actor.
 *
 * A SELF-SIGNED RELAY IS PINNED BY ITS CERTIFICATE, and the first version of
 * this file got it wrong in a way worth recording. It stored a fingerprint and
 * compared it in `checkServerIdentity`. Measured:
 *
 *   rejectUnauthorized=false  → checkServerIdentity is NEVER CALLED; the
 *                               connection succeeds whatever the pin says.
 *   rejectUnauthorized=true   → a self-signed chain is refused BEFORE
 *                               checkServerIdentity runs.
 *
 * So the hook is dead code in both directions. The pin was stored, a unit test
 * of the comparison function passed in isolation, and the real check accepted
 * any certificate at all — caught by a test that sent through a second fake
 * relay and watched the message arrive.
 *
 * 0430's UniFi client avoids this by taking over socket creation and comparing
 * the fingerprint before returning the socket; that is available there because
 * it owns the HTTP agent, and not here because nodemailer performs the STARTTLS
 * upgrade itself.
 *
 * What works is stronger anyway: hand Node the pinned CERTIFICATE as the only
 * acceptable CA. OpenSSL then does the verifying, `socket.authorized` is
 * genuinely true, it covers implicit TLS and STARTTLS alike because nodemailer
 * passes these options into the upgrade, and a different certificate is refused
 * by the TLS stack rather than by an `if` somebody can delete.
 */
import { createTransport, type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import type { PeerCertificate } from 'node:tls';
import { X509Certificate } from 'node:crypto';

export type SmtpSecurity = 'starttls' | 'tls' | 'plaintext';

/** Exactly what helm.smtp_transport() returns, plus the opened password. */
export interface RelayConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  tlsVerify: boolean;
  /** The relay's certificate, in PEM, when one is pinned. */
  tlsPinnedCertificate: string | null;
  username: string | null;
  /** Plaintext, opened from the envelope. Held for one connection. */
  password: string | null;
  fromAddress: string;
  fromName: string | null;
}

export class EmailTransportError extends Error {
  readonly reason: 'unreachable' | 'rejected' | 'tls' | 'misconfigured';

  constructor(message: string, reason: EmailTransportError['reason']) {
    super(message);
    this.name = 'EmailTransportError';
    this.reason = reason;
  }
}

/**
 * Lower-case hex of a certificate's SHA-256, with no colons.
 *
 * Node reports `fingerprint256` as `AB:CD:…`; this is the spelling 0430's UniFi
 * client and 0670's certificate probe both use, so a fingerprint shown on one
 * screen can be compared with one shown on another.
 */
export function fingerprintOf(certificate: PeerCertificate): string {
  return (certificate.fingerprint256 ?? '').replace(/:/g, '').toLowerCase();
}

/**
 * The fingerprint of a pinned certificate, for a person to read.
 *
 * DERIVED, never stored. A stored fingerprint beside a stored certificate is
 * two copies of one fact, and the interesting failure is the one where they
 * disagree — so the settings page computes this from the PEM every time it
 * renders.
 */
export function fingerprintOfPem(pem: string): string {
  return new X509Certificate(pem).fingerprint256.replace(/:/g, '').toLowerCase();
}

export function buildTransport(config: RelayConfig, timeoutMs = 20_000): Transporter {
  if (config.security === 'plaintext' && config.tlsPinnedCertificate) {
    // Not a refusal the database can express, and worth saying rather than
    // silently ignoring: a pin on a connection that never negotiates TLS is a
    // configuration somebody believes is protecting them.
    throw new EmailTransportError(
      'a certificate pin is set but the relay is configured for plaintext, so no '
      + 'certificate is ever presented. Choose starttls or tls, or clear the pin.',
      'misconfigured',
    );
  }

  const tls = config.tlsPinnedCertificate
    ? {
        /*
         * The pinned certificate is the ONLY acceptable CA, and verification
         * stays ON. This is real verification rather than our own comparison:
         * a certificate that is not this one is refused by OpenSSL.
         *
         * checkServerIdentity returns undefined, which skips the HOSTNAME
         * check only. A relay's self-signed certificate routinely names
         * something other than the host it is reached at — `mail` rather than
         * `mail.internal.msp.test`, or no SAN at all — and with the chain
         * pinned to one certificate the hostname adds nothing: there is exactly
         * one certificate that can satisfy it.
         */
        ca: [config.tlsPinnedCertificate],
        rejectUnauthorized: true,
        checkServerIdentity: () => undefined,
      }
    : { rejectUnauthorized: config.tlsVerify };

  /*
   * Typed as SMTPTransport.Options explicitly. createTransport is overloaded
   * seven ways and an inline literal lands on the generic overload, which
   * accepts nothing useful — naming the type picks the SMTP one and gets the
   * property names checked, which is the whole reason for passing through a
   * typed object rather than a bag.
   */
  const options: SMTPTransport.Options = {
    host: config.host,
    port: config.port,
    // `secure` is implicit TLS. STARTTLS is secure:false plus requireTLS.
    secure: config.security === 'tls',
    requireTLS: config.security === 'starttls',
    // Refuse to fall back. Without this nodemailer will happily continue
    // unencrypted when a relay does not advertise STARTTLS, which is the one
    // outcome the 'starttls' setting exists to prevent.
    ignoreTLS: config.security === 'plaintext',
    auth: config.username
      ? { user: config.username, pass: config.password ?? '' }
      : undefined,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
    tls,
  };

  // One connection per batch, closed after sending. No pool: a pool would hold
  // a socket — and the opened password — for the life of the worker process.
  return createTransport(options);
}

/** `"Name" <address>`, or the bare address. */
export function fromHeader(config: RelayConfig): string {
  const name = config.fromName?.trim();
  return name ? `"${name.replace(/"/g, '')}" <${config.fromAddress}>` : config.fromAddress;
}

/**
 * Translate whatever the SMTP layer threw into something a settings page can
 * show, because `ECONNREFUSED` on a row in a table is not an answer.
 */
export function describeTransportError(error: unknown): EmailTransportError {
  if (error instanceof EmailTransportError) return error;

  const code = (error as { code?: string } | null)?.code ?? '';
  const message = error instanceof Error ? error.message : String(error);

  if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'EDNS'
      || code === 'ENOTFOUND' || code === 'ESOCKET') {
    return new EmailTransportError(
      `the relay could not be reached (${code || 'no route'})`, 'unreachable',
    );
  }
  if (code === 'EAUTH') {
    return new EmailTransportError(
      'the relay refused the username and password', 'rejected',
    );
  }
  if (/self.signed|certificate|CERT_|DEPTH_ZERO/i.test(message)) {
    return new EmailTransportError(
      `the relay's certificate was not accepted: ${message}`, 'tls',
    );
  }
  return new EmailTransportError(message.slice(0, 300), 'rejected');
}
