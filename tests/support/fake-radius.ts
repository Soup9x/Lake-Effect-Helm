/**
 * A real RADIUS server, in about eighty lines.
 *
 * Not a mock. It decodes the User-Password with the shared secret, decides, and
 * signs its reply with a Response Authenticator exactly as RFC 2865 says to —
 * which matters because the two things most worth testing in the client are the
 * password stream cipher and the reply signature, and those are precisely what
 * a mocked socket would fake.
 *
 * Shared by the protocol unit tests and the configuration integration tests, so
 * both drive the same server rather than two that might drift.
 */
import { createHash, createHmac } from 'node:crypto';
import { createSocket, type Socket } from 'node:dgram';
import { parseAttributes } from '../../src/lib/auth/radius';

/** Long enough to satisfy validateServer(), which refuses anything shorter. */
export const DEFAULT_SECRET = 'a-shared-secret-of-adequate-length';

export interface FakeOptions {
  /** Accept when the decoded password matches this. */
  password?: string;
  /** Sign the reply with this instead, to imitate a mismatched secret. */
  signWith?: string;
  /** Say nothing at all, to imitate a dropped datagram or a filtered port. */
  silent?: boolean;
  /** Reply with this code regardless of the password. */
  forceCode?: number;
  /** Include a Message-Authenticator in the reply. */
  withMessageAuthenticator?: boolean;
  /** Reply to a different identifier, to imitate a stale datagram. */
  identifierOffset?: number;
}

/** RFC 2865 §5.2, run backwards — what a server does to read User-Password. */
export function decodePassword(cipher: Buffer, secret: string, requestAuth: Buffer): string {
  const out = Buffer.alloc(cipher.length);
  let previous = requestAuth;
  for (let offset = 0; offset < cipher.length; offset += 16) {
    const b = createHash('md5').update(Buffer.from(secret, 'utf8')).update(previous).digest();
    for (let i = 0; i < 16; i += 1) out[offset + i] = cipher[offset + i]! ^ b[i]!;
    previous = cipher.subarray(offset, offset + 16);
  }
  // Strip the null padding the client added.
  const end = out.indexOf(0);
  return out.subarray(0, end === -1 ? out.length : end).toString('utf8');
}

export class FakeRadius {
  readonly socket: Socket;
  port = 0;
  /** Every username the server was asked about, in order. */
  readonly seen: string[] = [];

  private constructor(socket: Socket, options: FakeOptions, readonly secret: string) {
    this.socket = socket;
    socket.on('message', (packet, rinfo) => {
      if (options.silent) return;

      const identifier = packet.readUInt8(1);
      const requestAuth = packet.subarray(4, 20);
      const attributes = parseAttributes(packet);

      const user = attributes.find((a) => a.type === 1)?.value.toString('utf8') ?? '';
      const cipher = attributes.find((a) => a.type === 2)?.value ?? Buffer.alloc(0);
      this.seen.push(user);

      const given = decodePassword(cipher, this.secret, requestAuth);
      const code =
        options.forceCode ?? (options.password !== undefined && given === options.password ? 2 : 3);

      const replyAttrs = options.withMessageAuthenticator
        ? Buffer.concat([Buffer.from([80, 18]), Buffer.alloc(16)])
        : Buffer.alloc(0);

      const length = 20 + replyAttrs.length;
      const reply = Buffer.alloc(length);
      reply.writeUInt8(code, 0);
      reply.writeUInt8((identifier + (options.identifierOffset ?? 0)) & 0xff, 1);
      reply.writeUInt16BE(length, 2);
      replyAttrs.copy(reply, 20);

      const signingSecret = options.signWith ?? this.secret;

      if (options.withMessageAuthenticator) {
        // RFC 3579: computed with the REQUEST authenticator in the header and
        // the Message-Authenticator itself zeroed.
        requestAuth.copy(reply, 4);
        const mac = createHmac('md5', signingSecret).update(reply).digest();
        mac.copy(reply, length - 16);
      }

      // MD5(Code | ID | Length | RequestAuth | Attributes | Secret)
      const responseAuth = createHash('md5')
        .update(reply.subarray(0, 4))
        .update(requestAuth)
        .update(reply.subarray(20, length))
        .update(Buffer.from(signingSecret, 'utf8'))
        .digest();
      responseAuth.copy(reply, 4);

      this.socket.send(reply, rinfo.port, rinfo.address);
    });
  }

  static async start(options: FakeOptions = {}, secret = DEFAULT_SECRET): Promise<FakeRadius> {
    const socket = createSocket('udp4');
    const server = new FakeRadius(socket, options, secret);
    await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
    server.port = socket.address().port;
    return server;
  }

  stop(): void {
    this.socket.removeAllListeners();
    this.socket.close();
  }
}

