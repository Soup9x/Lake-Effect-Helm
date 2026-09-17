/**
 * A RADIUS client, RFC 2865 with the RFC 3579 Message-Authenticator.
 *
 * Written rather than depended on. The packet format is a hundred lines, the
 * npm options are unmaintained or unaudited, and this code sits directly on the
 * authentication path of a credential vault — which is the last place to accept
 * a transitive dependency nobody has read.
 *
 * THE RESPONSE AUTHENTICATOR IS THE WHOLE SECURITY MODEL.
 *
 * RADIUS runs over UDP, which anybody on the path can forge. What stops a
 * spoofed Access-Accept is that the server signs its reply:
 *
 *   ResponseAuth = MD5(Code | ID | Length | RequestAuth | Attributes | Secret)
 *
 * Only the holder of the shared secret can produce that. A client that skips
 * the check — and there are several on npm that do, or that check it only on
 * Access-Reject — will accept an authentication from any host that can get a
 * datagram to it first. verifyResponse() below is therefore not optional
 * hardening; it is the reason this is authentication at all.
 *
 * MD5 is not a choice here. RFC 2865 specifies it for the authenticators and
 * for the password stream cipher, so the protocol is only as strong as the
 * shared secret and the network it runs on. That is why RADIUS belongs on a
 * management VLAN, and why this module refuses a trivially short secret.
 */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { isIP } from 'node:net';

const CODE_ACCESS_REQUEST = 1;
const CODE_ACCESS_ACCEPT = 2;
const CODE_ACCESS_REJECT = 3;
const CODE_ACCESS_CHALLENGE = 11;

const ATTR_USER_NAME = 1;
const ATTR_USER_PASSWORD = 2;
const ATTR_REPLY_MESSAGE = 18;
const ATTR_SERVICE_TYPE = 6;
const ATTR_NAS_IDENTIFIER = 32;
const ATTR_NAS_PORT_TYPE = 61;
const ATTR_MESSAGE_AUTHENTICATOR = 80;

/** Service-Type 8: "just tell me yes or no", which is all Helm wants. */
const SERVICE_TYPE_AUTHENTICATE_ONLY = 8;
/** NAS-Port-Type 5: Virtual. Helm is not a dial-up concentrator. */
const NAS_PORT_TYPE_VIRTUAL = 5;

const HEADER_BYTES = 20;
const AUTHENTICATOR_BYTES = 16;
const MAX_PACKET_BYTES = 4096;
/** RFC 2865 §5.2: User-Password is at most 128 octets before padding. */
const MAX_PASSWORD_BYTES = 128;
const MAX_USERNAME_BYTES = 253;

export interface RadiusServer {
  host: string;
  port: number;
  secret: string;
  timeoutMs: number;
  /** Extra attempts after the first. UDP drops datagrams without telling anyone. */
  retries: number;
  nasIdentifier: string;
}

export type RadiusOutcome =
  /** The server said yes. */
  | { outcome: 'accept'; replyMessage?: string | undefined }
  /** The server said no — wrong password, unknown user, policy. */
  | { outcome: 'reject'; replyMessage?: string | undefined }
  /**
   * The server wants another round (typically an MFA prompt). Helm's sign-in
   * form has one step, so this is reported rather than continued.
   */
  | { outcome: 'challenge'; replyMessage?: string | undefined }
  /** No usable reply within the timeout, across every attempt. */
  | { outcome: 'timeout'; message: string }
  /**
   * Something answered but it was not this server: a reply whose authenticator
   * does not verify. Almost always a wrong shared secret.
   */
  | { outcome: 'bad_secret'; message: string }
  /** DNS, a closed port, a malformed reply, a bad configuration. */
  | { outcome: 'error'; message: string };

// ---------------------------------------------------------------------------
// Packet construction
// ---------------------------------------------------------------------------

/**
 * RFC 2865 §5.2 — the User-Password stream cipher.
 *
 *   b1 = MD5(S + RequestAuth)   c1 = p1 XOR b1
 *   bn = MD5(S + c(n-1))        cn = pn XOR bn
 *
 * The plaintext is null-padded to a multiple of 16. That padding is why a
 * server cannot tell a 14-character password from a 16-character one, and why
 * the ciphertext length leaks the password length only to the nearest 16 bytes.
 */
export function encodeUserPassword(
  password: string,
  secret: string,
  requestAuthenticator: Buffer,
): Buffer {
  const plaintext = Buffer.from(password, 'utf8');
  if (plaintext.length > MAX_PASSWORD_BYTES) {
    throw new RadiusConfigurationError(
      `password is ${plaintext.length} bytes; RFC 2865 allows at most ${MAX_PASSWORD_BYTES}`,
    );
  }

  const padded = Buffer.alloc(Math.max(16, Math.ceil(plaintext.length / 16) * 16));
  plaintext.copy(padded);
  plaintext.fill(0);

  const secretBytes = Buffer.from(secret, 'utf8');
  const out = Buffer.alloc(padded.length);
  let previous = requestAuthenticator;

  for (let offset = 0; offset < padded.length; offset += 16) {
    const b = createHash('md5').update(secretBytes).update(previous).digest();
    for (let i = 0; i < 16; i += 1) {
      out[offset + i] = padded[offset + i]! ^ b[i]!;
    }
    previous = out.subarray(offset, offset + 16);
  }

  padded.fill(0);
  return out;
}

function attribute(type: number, value: Buffer): Buffer {
  if (value.length > 253) {
    throw new RadiusConfigurationError(`attribute ${type} is ${value.length} bytes; max is 253`);
  }
  return Buffer.concat([Buffer.from([type, value.length + 2]), value]);
}

function integerAttribute(type: number, value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value);
  return attribute(type, buf);
}

export interface AccessRequest {
  packet: Buffer;
  identifier: number;
  authenticator: Buffer;
}

/**
 * Build an Access-Request.
 *
 * The Message-Authenticator (RFC 3579 §3.2) goes in last and covers the whole
 * packet with its own value zeroed. It is included on every request, not only
 * where a server demands it: without it, an attacker who can inject packets can
 * tamper with attributes in flight, and modern servers — FreeRADIUS since 3.0,
 * NPS with the 2024 hardening — increasingly refuse requests that omit it.
 */
export function buildAccessRequest(
  username: string,
  password: string,
  server: Pick<RadiusServer, 'secret' | 'nasIdentifier'>,
): AccessRequest {
  const user = Buffer.from(username, 'utf8');
  if (user.length === 0 || user.length > MAX_USERNAME_BYTES) {
    throw new RadiusConfigurationError(
      `username must be 1..${MAX_USERNAME_BYTES} bytes, got ${user.length}`,
    );
  }

  const identifier = randomInt(0, 256);
  const authenticator = randomBytes(AUTHENTICATOR_BYTES);

  const attributes = Buffer.concat([
    attribute(ATTR_USER_NAME, user),
    attribute(ATTR_USER_PASSWORD, encodeUserPassword(password, server.secret, authenticator)),
    attribute(ATTR_NAS_IDENTIFIER, Buffer.from(server.nasIdentifier, 'utf8')),
    integerAttribute(ATTR_NAS_PORT_TYPE, NAS_PORT_TYPE_VIRTUAL),
    integerAttribute(ATTR_SERVICE_TYPE, SERVICE_TYPE_AUTHENTICATE_ONLY),
    // Placeholder: zeroed while the HMAC over the packet is computed.
    attribute(ATTR_MESSAGE_AUTHENTICATOR, Buffer.alloc(16)),
  ]);

  const length = HEADER_BYTES + attributes.length;
  if (length > MAX_PACKET_BYTES) {
    throw new RadiusConfigurationError(`Access-Request is ${length} bytes; max is ${MAX_PACKET_BYTES}`);
  }

  const packet = Buffer.alloc(length);
  packet.writeUInt8(CODE_ACCESS_REQUEST, 0);
  packet.writeUInt8(identifier, 1);
  packet.writeUInt16BE(length, 2);
  authenticator.copy(packet, 4);
  attributes.copy(packet, HEADER_BYTES);

  // The placeholder is the last attribute, so its value starts 16 bytes from
  // the end. Computed over the packet as it stands, zeros included.
  const digestOffset = length - 16;
  const mac = createHmac('md5', server.secret).update(packet).digest();
  mac.copy(packet, digestOffset);

  return { packet, identifier, authenticator };
}

// ---------------------------------------------------------------------------
// Response verification
// ---------------------------------------------------------------------------

export interface ParsedResponse {
  code: number;
  identifier: number;
  attributes: Array<{ type: number; value: Buffer }>;
}

/** Walk the attribute list, refusing the malformed lengths that hide overflows. */
export function parseAttributes(packet: Buffer): Array<{ type: number; value: Buffer }> {
  const attributes: Array<{ type: number; value: Buffer }> = [];
  let offset = HEADER_BYTES;
  const end = packet.readUInt16BE(2);

  while (offset + 2 <= end) {
    const type = packet.readUInt8(offset);
    const length = packet.readUInt8(offset + 1);
    // A length below 2 would not advance the cursor: a packet that loops this
    // parser forever is a denial of service on the sign-in path.
    if (length < 2 || offset + length > end) {
      throw new RadiusProtocolError('attribute length is outside the packet');
    }
    attributes.push({ type, value: packet.subarray(offset + 2, offset + length) });
    offset += length;
  }

  return attributes;
}

/**
 * Verify a reply really came from the server holding the shared secret.
 *
 * Two independent checks, both required:
 *
 *   * The Response Authenticator, which every RADIUS server sets.
 *   * The Message-Authenticator, when present — an attacker cannot strip it
 *     without breaking the Response Authenticator that covers it.
 *
 * Returns the parsed packet, or throws. Throwing rather than returning a flag
 * is deliberate: there is no sensible way to "continue anyway" from here, and a
 * boolean invites a caller that forgets to look at it.
 */
export function verifyResponse(
  packet: Buffer,
  request: AccessRequest,
  secret: string,
): ParsedResponse {
  if (packet.length < HEADER_BYTES) {
    throw new RadiusProtocolError('reply is shorter than a RADIUS header');
  }

  const declared = packet.readUInt16BE(2);
  if (declared < HEADER_BYTES || declared > packet.length) {
    throw new RadiusProtocolError('reply length field disagrees with the datagram');
  }

  const identifier = packet.readUInt8(1);
  if (identifier !== request.identifier) {
    // Not an error about this exchange: a late reply to an earlier attempt, or
    // somebody else's traffic. The caller keeps waiting.
    throw new RadiusIdentifierMismatch(identifier, request.identifier);
  }

  // MD5(Code | ID | Length | RequestAuth | Attributes | Secret)
  const expected = createHash('md5')
    .update(packet.subarray(0, 4))
    .update(request.authenticator)
    .update(packet.subarray(HEADER_BYTES, declared))
    .update(Buffer.from(secret, 'utf8'))
    .digest();

  const actual = packet.subarray(4, 4 + AUTHENTICATOR_BYTES);
  if (!timingSafeEqual(expected, actual)) {
    throw new RadiusAuthenticatorMismatch();
  }

  const attributes = parseAttributes(packet.subarray(0, declared));

  const mac = attributes.find((a) => a.type === ATTR_MESSAGE_AUTHENTICATOR);
  if (mac) {
    if (mac.value.length !== 16) {
      throw new RadiusProtocolError('Message-Authenticator is not 16 bytes');
    }
    // Recompute over the packet with the request's authenticator in place and
    // the Message-Authenticator zeroed, per RFC 3579 §3.2.
    const scratch = Buffer.from(packet.subarray(0, declared));
    request.authenticator.copy(scratch, 4);
    const at = scratch.indexOf(mac.value, HEADER_BYTES);
    if (at >= 0) {
      scratch.fill(0, at, at + 16);
      const expectedMac = createHmac('md5', secret).update(scratch).digest();
      if (!timingSafeEqual(expectedMac, mac.value)) {
        throw new RadiusAuthenticatorMismatch('Message-Authenticator does not verify');
      }
    }
  }

  return { code: packet.readUInt8(0), identifier, attributes };
}

function replyMessage(attributes: Array<{ type: number; value: Buffer }>): string | undefined {
  const parts = attributes
    .filter((a) => a.type === ATTR_REPLY_MESSAGE)
    .map((a) => a.value.toString('utf8'));
  if (parts.length === 0) return undefined;
  // Server-controlled text. Trimmed and capped here so it cannot be used to
  // push a wall of content into an error box, and it is rendered as text.
  return parts.join(' ').replace(/[\r\n]+/g, ' ').trim().slice(0, 200) || undefined;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class RadiusConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RadiusConfigurationError';
  }
}

export class RadiusProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RadiusProtocolError';
  }
}

export class RadiusIdentifierMismatch extends Error {
  constructor(got: number, want: number) {
    super(`reply identifier ${got} does not match request ${want}`);
    this.name = 'RadiusIdentifierMismatch';
  }
}

export class RadiusAuthenticatorMismatch extends Error {
  constructor(message = 'Response Authenticator does not verify') {
    super(message);
    this.name = 'RadiusAuthenticatorMismatch';
  }
}

// ---------------------------------------------------------------------------
// The exchange
// ---------------------------------------------------------------------------

/**
 * Reject a configuration that cannot be secure before putting it on the wire.
 *
 * A short shared secret is the classic RADIUS deployment failure: the secret is
 * the only thing standing between the network and an Access-Accept, and eight
 * characters of it is a dictionary away. RFC 2865 §3 asks for at least 16
 * characters and says more; this refuses fewer than 16 at configuration time
 * rather than letting somebody discover it during an incident.
 */
export function validateServer(server: RadiusServer): void {
  if (Buffer.from(server.secret, 'utf8').length < 16) {
    throw new RadiusConfigurationError(
      'the RADIUS shared secret must be at least 16 characters — it is the only thing ' +
        'authenticating the server to Helm',
    );
  }
  if (server.host.trim().length === 0) {
    throw new RadiusConfigurationError('a RADIUS host is required');
  }
  if (!Number.isInteger(server.port) || server.port < 1 || server.port > 65535) {
    throw new RadiusConfigurationError(`port ${server.port} is not a port number`);
  }
  if (!Number.isInteger(server.timeoutMs) || server.timeoutMs < 500 || server.timeoutMs > 30_000) {
    throw new RadiusConfigurationError('timeout must be between 500ms and 30s');
  }
  if (!Number.isInteger(server.retries) || server.retries < 0 || server.retries > 5) {
    throw new RadiusConfigurationError('retries must be between 0 and 5');
  }
}

/**
 * One request/response exchange, retried on silence.
 *
 * Every attempt builds a FRESH packet, which means a fresh Request
 * Authenticator and a fresh identifier. Re-sending the identical datagram would
 * be the obvious optimisation and is wrong: the Request Authenticator is the
 * nonce the password stream cipher is keyed from, so repeating it repeats the
 * keystream, and two passwords encrypted under one keystream leak their XOR.
 *
 * Nothing in here is logged. The password is in scope for the whole function
 * and a well-meant debug line is how it reaches a log file.
 */
export async function authenticate(
  server: RadiusServer,
  username: string,
  password: string,
): Promise<RadiusOutcome> {
  try {
    validateServer(server);
  } catch (error) {
    return { outcome: 'error', message: (error as Error).message };
  }

  let lastFailure: RadiusOutcome = {
    outcome: 'timeout',
    message: `no reply from ${server.host}:${server.port}`,
  };

  for (let attempt = 0; attempt <= server.retries; attempt += 1) {
    let request: AccessRequest;
    try {
      request = buildAccessRequest(username, password, server);
    } catch (error) {
      return { outcome: 'error', message: (error as Error).message };
    }

    const result = await exchange(server, request);
    request.packet.fill(0);

    // A definite answer — accept, reject, challenge, or a reply that failed to
    // verify — ends the loop. Only silence is worth retrying: re-sending
    // against a server that just told us the secret is wrong will not change
    // its mind, and re-sending a rejected password looks like an attack.
    if (result.outcome !== 'timeout') return result;
    lastFailure = result;
  }

  return lastFailure;
}

function exchange(server: RadiusServer, request: AccessRequest): Promise<RadiusOutcome> {
  return new Promise((resolve) => {
    // udp6 only when the host is a literal v6 address. Letting Node pick would
    // make the socket family depend on DNS ordering, which turns a working
    // deployment into an intermittent one the day AAAA records appear.
    const socket = createSocket(isIP(server.host) === 6 ? 'udp6' : 'udp4');
    let settled = false;

    const finish = (outcome: RadiusOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      try {
        socket.close();
      } catch {
        // Already closing. Nothing to do and nothing worth reporting.
      }
      resolve(outcome);
    };

    const timer = setTimeout(
      () => finish({ outcome: 'timeout', message: `no reply from ${server.host}:${server.port}` }),
      server.timeoutMs,
    );

    socket.on('error', (error) => {
      // ECONNREFUSED arrives here on Linux: an ICMP port-unreachable for a UDP
      // datagram surfaces as a socket error rather than a failed send.
      const code = (error as NodeJS.ErrnoException).code;
      finish({
        outcome: 'error',
        message:
          code === 'ECONNREFUSED'
            ? `nothing is listening on ${server.host}:${server.port}`
            : `${server.host}:${server.port} — ${code ?? error.message}`,
      });
    });

    socket.on('message', (reply) => {
      let parsed: ParsedResponse;
      try {
        parsed = verifyResponse(reply, request, server.secret);
      } catch (error) {
        if (error instanceof RadiusIdentifierMismatch) return; // not ours; keep waiting
        if (error instanceof RadiusAuthenticatorMismatch) {
          return finish({
            outcome: 'bad_secret',
            message:
              'the reply did not verify against the configured shared secret — check that ' +
              'Helm and the RADIUS server agree on it',
          });
        }
        return finish({ outcome: 'error', message: (error as Error).message });
      }

      const message = replyMessage(parsed.attributes);
      switch (parsed.code) {
        case CODE_ACCESS_ACCEPT:
          return finish({ outcome: 'accept', replyMessage: message });
        case CODE_ACCESS_REJECT:
          return finish({ outcome: 'reject', replyMessage: message });
        case CODE_ACCESS_CHALLENGE:
          return finish({ outcome: 'challenge', replyMessage: message });
        default:
          return finish({
            outcome: 'error',
            message: `unexpected RADIUS response code ${parsed.code}`,
          });
      }
    });

    socket.send(request.packet, server.port, server.host, (error) => {
      if (error) {
        finish({
          outcome: 'error',
          message: `could not reach ${server.host}:${server.port} — ${
            (error as NodeJS.ErrnoException).code ?? error.message
          }`,
        });
      }
    });
  });
}
