/**
 * A real SMTP server, over a real socket, speaking the real protocol.
 *
 * NOT A nodemailer STUB, and that is the point. What is being tested is not
 * "did we call sendMail" — it is that a message leaves this process, crosses a
 * socket, survives STARTTLS, authenticates, and arrives with its headers and
 * body intact. A mock transport proves none of that, and the failures worth
 * catching all live in the parts a mock skips: a relay that does not offer
 * STARTTLS, a certificate that is not the pinned one, a body line beginning
 * with a period.
 *
 * It implements the subset Helm's sender uses and refuses the rest, so a change
 * that starts relying on PIPELINING or 8BITMIME fails here rather than against
 * somebody's production relay.
 *
 * THE CERTIFICATE IS SELF-SIGNED AND GENERATED PER INSTANCE, so a test can pin
 * a fingerprint it computed itself and a second instance is genuinely a
 * different certificate — which is what makes the pin-mismatch case real rather
 * than simulated. Same construction as tests/support/fake-unifi.ts.
 */
import { createServer as createTcpServer, type Server, type Socket } from 'node:net';
import { TLSSocket, createSecureContext } from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import type { AddressInfo } from 'node:net';

export interface ReceivedMail {
  from: string;
  to: string[];
  /** The whole DATA block, headers and body, as it arrived. */
  raw: string;
  /** Whether the connection had negotiated TLS by the time DATA was sent. */
  encrypted: boolean;
  /** The AUTH credentials the client offered, if any. */
  auth: { user: string; pass: string } | null;
}

export type FakeSmtpMode =
  | 'ok'
  /** Advertises no STARTTLS, which a `requireTLS` client must refuse. */
  | 'no-starttls'
  /** Rejects AUTH with 535. */
  | 'bad-credentials'
  /** Accepts the envelope and rejects the message body with 554. */
  | 'reject-data'
  /** Accepts the connection and never speaks, to exercise a timeout. */
  | 'silent';

export interface FakeSmtpOptions {
  mode?: FakeSmtpMode;
  /** Require AUTH before MAIL FROM. */
  requireAuth?: boolean;
  /** Serve implicit TLS from the first byte, for the 'tls' security mode. */
  implicitTls?: boolean;
}

export class FakeSmtp {
  private constructor(
    private readonly server: Server,
    private readonly dir: string,
    private readonly sockets: Socket[],
    readonly host: string,
    readonly port: number,
    /** Lower-case hex, no colons. For display assertions. */
    readonly sha256: string,
    /** The certificate in PEM, which is what a pin actually stores. */
    readonly certificatePem: string,
    readonly received: ReceivedMail[],
    /** Every command line the server was sent, for asserting the dialogue. */
    readonly commands: string[],
  ) {}

  static async start(options: FakeSmtpOptions = {}): Promise<FakeSmtp> {
    const mode = options.mode ?? 'ok';
    const requireAuth = options.requireAuth ?? false;
    const implicitTls = options.implicitTls ?? false;

    const dir = mkdtempSync(join(tmpdir(), 'helm-smtp-'));
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
      '-days', '1', '-subj', '/CN=mail.test',
      '-addext', 'subjectAltName=DNS:localhost,DNS:mail.test,IP:127.0.0.1',
    ], { stdio: 'ignore' });

    const cert = readFileSync(join(dir, 'cert.pem'));
    const key = readFileSync(join(dir, 'key.pem'));
    const sha256 = new X509Certificate(cert).fingerprint256.replace(/:/g, '').toLowerCase();

    const received: ReceivedMail[] = [];
    const commands: string[] = [];
    const sockets: Socket[] = [];

    const server = createTcpServer((raw) => {
      sockets.push(raw);
      if (mode === 'silent') return;

      const socket = implicitTls
        ? new TLSSocket(raw, {
            isServer: true,
            secureContext: createSecureContext({ cert, key }),
          })
        : raw;
      if (implicitTls) sockets.push(socket as unknown as Socket);

      session(socket as Socket, { mode, requireAuth, cert, key, received, commands, sockets });
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        reject(new Error(`could not bind 127.0.0.1:0 (${error.code ?? error.message})`));
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, '127.0.0.1');
    });

    const address = server.address() as AddressInfo;
    return new FakeSmtp(
      server, dir, sockets, '127.0.0.1', address.port, sha256,
      cert.toString('utf8'), received, commands,
    );
  }

  /** A fingerprint that is valid in shape and belongs to no certificate. */
  static wrongFingerprint(): string {
    return 'a'.repeat(64);
  }

  /**
   * A syntactically valid certificate that is not any running server's.
   *
   * Generated rather than hard-coded so it is a real certificate OpenSSL will
   * parse — a pin that fails because the PEM was malformed would pass a
   * mismatch test for the wrong reason.
   */
  static otherCertificate(): string {
    const dir = mkdtempSync(join(tmpdir(), 'helm-smtp-other-'));
    try {
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'),
        '-days', '1', '-subj', '/CN=somewhere.else',
      ], { stdio: 'ignore' });
      return readFileSync(join(dir, 'c.pem'), 'utf8');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async stop(): Promise<void> {
    // Destroy held sockets BEFORE close, because close() waits for them —
    // group H lost a round to exactly that, where a 400 ms probe timeout became
    // a 30-second test timeout.
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    rmSync(this.dir, { recursive: true, force: true });
  }
}

interface SessionState {
  mode: FakeSmtpMode;
  requireAuth: boolean;
  cert: Buffer;
  key: Buffer;
  received: ReceivedMail[];
  commands: string[];
  sockets: Socket[];
}

/**
 * One connection's dialogue.
 *
 * Written as a line reader with an explicit DATA mode rather than a state
 * machine object, because the protocol is genuinely this small and a reader can
 * check it against RFC 5321 in one pass.
 */
function session(socket: Socket, state: SessionState, greet = true): void {
  let buffer = '';
  let inData = false;
  let dataLines: string[] = [];
  let from = '';
  let to: string[] = [];
  let encrypted = socket instanceof TLSSocket;
  let auth: { user: string; pass: string } | null = null;
  let authStage: 'none' | 'awaiting-plain' = 'none';

  const write = (line: string) => {
    if (!socket.destroyed) socket.write(`${line}\r\n`);
  };

  /*
   * NO GREETING AFTER AN UPGRADE. A 220 is sent once, when the connection
   * opens; after STARTTLS the client sends EHLO again and expects the EHLO
   * response, so a second greeting desynchronises the whole dialogue by one
   * reply. That is what the first version of this file did, and it surfaced as
   * "Message failed: 354" — nodemailer reading the DATA response where it
   * expected the queue confirmation, eight tests down the line from the
   * actual mistake.
   */
  if (greet) write('220 mail.test ESMTP FakeSmtp');

  socket.on('error', () => { /* a client hanging up mid-dialogue is ordinary */ });

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');

    for (;;) {
      const index = buffer.indexOf('\r\n');
      if (index === -1) break;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);

      if (inData) {
        if (line === '.') {
          inData = false;
          if (state.mode === 'reject-data') {
            write('554 message refused for testing');
          } else {
            state.received.push({
              from,
              to: [...to],
              // Dot-stuffing is UNDONE here, exactly as a real server does:
              // a line the client sent as '..foo' was '.foo' in the message.
              // Without this the test could not tell correct stuffing from a
              // body that genuinely began with two dots.
              raw: dataLines.map((l) => (l.startsWith('..') ? l.slice(1) : l)).join('\n'),
              encrypted,
              auth,
            });
            write('250 2.0.0 Ok: queued');
          }
          dataLines = [];
          continue;
        }
        dataLines.push(line);
        continue;
      }

      state.commands.push(line);
      const upper = line.toUpperCase();

      if (authStage === 'awaiting-plain') {
        authStage = 'none';
        // AUTH PLAIN is base64 of \0user\0pass.
        const decoded = Buffer.from(line, 'base64').toString('utf8').split('\0');
        auth = { user: decoded[1] ?? '', pass: decoded[2] ?? '' };
        write(state.mode === 'bad-credentials'
          ? '535 5.7.8 Authentication credentials invalid'
          : '235 2.7.0 Authentication successful');
        continue;
      }

      if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
        const lines = ['250-mail.test greets you'];
        if (state.mode !== 'no-starttls' && !encrypted) lines.push('250-STARTTLS');
        lines.push('250-AUTH PLAIN LOGIN');
        lines.push('250 SIZE 10485760');
        for (const l of lines) write(l);
        continue;
      }

      if (upper === 'STARTTLS') {
        if (state.mode === 'no-starttls') {
          write('502 5.5.1 Command not implemented');
          continue;
        }
        write('220 2.0.0 Ready to start TLS');
        // Hand the same socket to TLS, which is what STARTTLS is.
        const secure = new TLSSocket(socket, {
          isServer: true,
          secureContext: createSecureContext({ cert: state.cert, key: state.key }),
        });
        state.sockets.push(secure as unknown as Socket);
        encrypted = true;
        session(secure as unknown as Socket, state, false);
        // This reader stops: the TLS socket has its own.
        socket.removeAllListeners('data');
        return;
      }

      if (upper.startsWith('AUTH PLAIN')) {
        const inline = line.slice('AUTH PLAIN'.length).trim();
        if (inline) {
          const decoded = Buffer.from(inline, 'base64').toString('utf8').split('\0');
          auth = { user: decoded[1] ?? '', pass: decoded[2] ?? '' };
          write(state.mode === 'bad-credentials'
            ? '535 5.7.8 Authentication credentials invalid'
            : '235 2.7.0 Authentication successful');
        } else {
          authStage = 'awaiting-plain';
          write('334 ');
        }
        continue;
      }

      if (upper.startsWith('MAIL FROM')) {
        if (state.requireAuth && auth === null) {
          write('530 5.7.0 Authentication required');
          continue;
        }
        from = line.replace(/^.*<([^>]*)>.*$/i, '$1');
        write('250 2.1.0 Ok');
        continue;
      }

      if (upper.startsWith('RCPT TO')) {
        to.push(line.replace(/^.*<([^>]*)>.*$/i, '$1'));
        write('250 2.1.5 Ok');
        continue;
      }

      if (upper === 'DATA') {
        inData = true;
        write('354 End data with <CR><LF>.<CR><LF>');
        continue;
      }

      if (upper === 'RSET') {
        from = '';
        to = [];
        write('250 2.0.0 Ok');
        continue;
      }

      if (upper === 'QUIT') {
        write('221 2.0.0 Bye');
        socket.end();
        return;
      }

      // Everything else is refused rather than tolerated, so a sender that
      // starts using a verb Helm has not thought about fails here.
      write(`502 5.5.1 Command not implemented: ${line.split(' ')[0]}`);
    }
  });
}

/**
 * The subject line out of a received message, unfolded and decoded.
 *
 * TWO THINGS THE FIRST VERSION GOT WRONG, both of which made a correctly
 * encoded header look mangled and nearly sent me looking for a bug in the
 * sender:
 *
 *   FOLDING. RFC 5322 limits a line to 998 characters and mailers fold well
 *   before that; a continuation line begins with whitespace. Reading only the
 *   first line truncated the subject mid-word.
 *
 *   CHARSET. Decoding =XX escapes with String.fromCharCode produces one
 *   character per BYTE, which is a latin1 decode — so the three bytes of an
 *   em-dash came out as three accented characters. The bytes have to be
 *   collected and decoded as UTF-8 together.
 *
 * Worth the care: the whole reason for depending on nodemailer rather than
 * hand-writing SMTP was that it gets RFC 2047 right, and a decoder that cannot
 * read its output cannot demonstrate that.
 */
export function subjectOf(mail: ReceivedMail): string {
  const lines = mail.raw.split('\n');
  const start = lines.findIndex((l) => /^subject:/i.test(l));
  if (start === -1) return '';

  let value = lines[start]!.replace(/^subject:\s*/i, '');
  for (let i = start + 1; i < lines.length; i += 1) {
    // A folded continuation, as opposed to the next header or the blank line
    // before the body.
    if (!/^[ \t]/.test(lines[i]!)) break;
    value += lines[i]!.replace(/^[ \t]+/, '');
  }
  value = value.trim();

  // RFC 2047 encoded words, possibly several in a row after unfolding.
  return value.replace(
    /=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi,
    (_, _charset: string, encoding: string, payload: string) => {
      if (encoding.toUpperCase() === 'B') {
        return Buffer.from(payload, 'base64').toString('utf8');
      }
      // Q-encoding: build BYTES, then decode the whole run as UTF-8.
      const bytes: number[] = [];
      for (let i = 0; i < payload.length; i += 1) {
        if (payload[i] === '=' && /[0-9A-F]{2}/i.test(payload.slice(i + 1, i + 3))) {
          bytes.push(parseInt(payload.slice(i + 1, i + 3), 16));
          i += 2;
        } else if (payload[i] === '_') {
          bytes.push(0x20);
        } else {
          bytes.push(payload.charCodeAt(i));
        }
      }
      return Buffer.from(bytes).toString('utf8');
    },
  );
}

/** The body, after the header block. */
export function bodyOf(mail: ReceivedMail): string {
  const blank = mail.raw.indexOf('\n\n');
  return blank === -1 ? '' : mail.raw.slice(blank + 2);
}
