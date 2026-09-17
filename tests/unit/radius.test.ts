/**
 * The RADIUS client, against a real RADIUS server.
 *
 * Not a mocked socket. tests/support/fake-radius.ts is a genuine RFC 2865
 * responder on a loopback UDP port: it decodes the User-Password with the
 * shared secret, decides, and signs its reply with a Response Authenticator.
 * That matters because the two things most worth testing here — the password
 * stream cipher and the reply signature — are exactly what a mock would fake.
 *
 * The forgery tests are the point of the file. A RADIUS client that accepts an
 * unsigned or wrongly-signed Access-Accept is not authentication at all: UDP is
 * trivially spoofable, so anybody who can get a datagram to the app before the
 * real server does would be able to sign in as anyone.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  decodePassword,
  DEFAULT_SECRET,
  FakeRadius,
  type FakeOptions,
} from '../support/fake-radius';
import {
  authenticate,
  buildAccessRequest,
  encodeUserPassword,
  parseAttributes,
  validateServer,
  verifyResponse,
  RadiusAuthenticatorMismatch,
  RadiusConfigurationError,
  RadiusProtocolError,
  type RadiusServer,
} from '../../src/lib/auth/radius';

const SECRET = DEFAULT_SECRET;

const running: FakeRadius[] = [];
afterEach(() => {
  while (running.length) running.pop()!.stop();
});

async function server(options: FakeOptions = {}): Promise<RadiusServer> {
  const fake = await FakeRadius.start(options);
  running.push(fake);
  return {
    host: '127.0.0.1',
    port: fake.port,
    secret: SECRET,
    timeoutMs: 1500,
    retries: 1,
    nasIdentifier: 'helm-test',
  };
}

// ---------------------------------------------------------------------------

describe('the User-Password stream cipher', () => {
  it('round-trips through the server side of RFC 2865 §5.2', () => {
    const auth = randomBytes(16);
    const encoded = encodeUserPassword('correct horse battery', SECRET, auth);
    expect(decodePassword(encoded, SECRET, auth)).toBe('correct horse battery');
  });

  it('pads to a multiple of 16, so the length leaks only coarsely', () => {
    const auth = randomBytes(16);
    expect(encodeUserPassword('a', SECRET, auth)).toHaveLength(16);
    expect(encodeUserPassword('x'.repeat(16), SECRET, auth)).toHaveLength(16);
    expect(encodeUserPassword('x'.repeat(17), SECRET, auth)).toHaveLength(32);
  });

  it('produces different ciphertext for the same password each time', () => {
    // The Request Authenticator is the nonce. Identical output across two
    // requests would mean the keystream had been reused, which under a stream
    // cipher leaks the XOR of the two plaintexts.
    const a = encodeUserPassword('same', SECRET, randomBytes(16));
    const b = encodeUserPassword('same', SECRET, randomBytes(16));
    expect(a.equals(b)).toBe(false);
  });

  it('refuses a password longer than the protocol allows', () => {
    expect(() => encodeUserPassword('x'.repeat(129), SECRET, randomBytes(16))).toThrow(
      RadiusConfigurationError,
    );
  });
});

describe('the Access-Request packet', () => {
  it('is a well-formed Access-Request carrying what the server needs', () => {
    const { packet } = buildAccessRequest('tech@example.test', 'pw', {
      secret: SECRET,
      nasIdentifier: 'helm-test',
    });

    expect(packet.readUInt8(0)).toBe(1); // Access-Request
    expect(packet.readUInt16BE(2)).toBe(packet.length);

    const types = parseAttributes(packet).map((a) => a.type);
    expect(types).toContain(1); // User-Name
    expect(types).toContain(2); // User-Password
    expect(types).toContain(32); // NAS-Identifier
    expect(types).toContain(80); // Message-Authenticator
  });

  it('signs the Message-Authenticator over the packet with the field zeroed', () => {
    const { packet } = buildAccessRequest('tech', 'pw', {
      secret: SECRET,
      nasIdentifier: 'helm-test',
    });

    const mac = parseAttributes(packet).find((a) => a.type === 80)!.value;
    const scratch = Buffer.from(packet);
    scratch.fill(0, packet.length - 16);
    expect(createHmac('md5', SECRET).update(scratch).digest().equals(mac)).toBe(true);
  });

  it('uses a fresh identifier and authenticator per packet', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      const { authenticator } = buildAccessRequest('tech', 'pw', {
        secret: SECRET,
        nasIdentifier: 'helm-test',
      });
      seen.add(authenticator.toString('hex'));
    }
    expect(seen.size).toBe(20);
  });
});

describe('parsing a reply', () => {
  it('refuses an attribute whose length runs past the packet', () => {
    const packet = Buffer.alloc(24);
    packet.writeUInt8(2, 0);
    packet.writeUInt16BE(24, 2);
    packet.writeUInt8(18, 20); // Reply-Message
    packet.writeUInt8(200, 21); // ...claiming 200 bytes
    expect(() => parseAttributes(packet)).toThrow(RadiusProtocolError);
  });

  it('refuses a zero-length attribute rather than looping forever', () => {
    // A length below 2 does not advance the cursor. Left unchecked this is an
    // infinite loop on the sign-in path, reachable by anybody who can send a
    // UDP packet.
    const packet = Buffer.alloc(24);
    packet.writeUInt8(2, 0);
    packet.writeUInt16BE(24, 2);
    packet.writeUInt8(18, 20);
    packet.writeUInt8(0, 21);
    expect(() => parseAttributes(packet)).toThrow(RadiusProtocolError);
  });
});

describe('verifying that a reply came from the real server', () => {
  const request = () =>
    buildAccessRequest('tech', 'pw', { secret: SECRET, nasIdentifier: 'helm-test' });

  function reply(code: number, req: ReturnType<typeof request>, secret: string): Buffer {
    const packet = Buffer.alloc(20);
    packet.writeUInt8(code, 0);
    packet.writeUInt8(req.identifier, 1);
    packet.writeUInt16BE(20, 2);
    const auth = createHash('md5')
      .update(packet.subarray(0, 4))
      .update(req.authenticator)
      .update(Buffer.alloc(0))
      .update(Buffer.from(secret, 'utf8'))
      .digest();
    auth.copy(packet, 4);
    return packet;
  }

  it('accepts a correctly signed reply', () => {
    const req = request();
    expect(verifyResponse(reply(2, req, SECRET), req, SECRET).code).toBe(2);
  });

  it('REFUSES an Access-Accept signed with the wrong secret', () => {
    const req = request();
    expect(() => verifyResponse(reply(2, req, 'a-different-shared-secret'), req, SECRET)).toThrow(
      RadiusAuthenticatorMismatch,
    );
  });

  it('REFUSES an Access-Accept with no signature at all', () => {
    // The shape a naive spoofer sends: right code, right identifier, zeros
    // where the authenticator should be.
    const req = request();
    const forged = Buffer.alloc(20);
    forged.writeUInt8(2, 0);
    forged.writeUInt8(req.identifier, 1);
    forged.writeUInt16BE(20, 2);
    expect(() => verifyResponse(forged, req, SECRET)).toThrow(RadiusAuthenticatorMismatch);
  });

  it('refuses a reply shorter than a header', () => {
    expect(() => verifyResponse(Buffer.alloc(8), request(), SECRET)).toThrow(RadiusProtocolError);
  });

  it('refuses a length field that disagrees with the datagram', () => {
    const req = request();
    const packet = reply(2, req, SECRET);
    packet.writeUInt16BE(4096, 2);
    expect(() => verifyResponse(packet, req, SECRET)).toThrow(RadiusProtocolError);
  });
});

describe('a full exchange', () => {
  it('accepts the right password', async () => {
    const config = await server({ password: 'hunter2' });
    const result = await authenticate(config, 'tech@example.test', 'hunter2');
    expect(result.outcome).toBe('accept');
  });

  it('rejects the wrong password', async () => {
    const config = await server({ password: 'hunter2' });
    expect((await authenticate(config, 'tech@example.test', 'wrong')).outcome).toBe('reject');
  });

  it('sends the username the caller gave it', async () => {
    const config = await server({ password: 'hunter2' });
    await authenticate(config, 'tech@example.test', 'hunter2');
    expect(running[0]!.seen).toEqual(['tech@example.test']);
  });

  it('reports a mismatched shared secret as exactly that', async () => {
    // The server answers; its signature does not verify. Distinguishing this
    // from silence is what turns "it does not work" into "check the secret".
    const config = await server({ password: 'hunter2', signWith: 'some-other-shared-secret' });
    const result = await authenticate(config, 'tech', 'hunter2');
    expect(result.outcome).toBe('bad_secret');
  });

  it('verifies a Message-Authenticator when the server sends one', async () => {
    const config = await server({ password: 'hunter2', withMessageAuthenticator: true });
    expect((await authenticate(config, 'tech', 'hunter2')).outcome).toBe('accept');
  });

  it('times out when nothing answers, having retried', async () => {
    const config = { ...(await server({ silent: true })), timeoutMs: 500, retries: 1 };
    const started = Date.now();
    const result = await authenticate(config, 'tech', 'pw');
    expect(result.outcome).toBe('timeout');
    // Two attempts at 500ms. Proves the retry happened rather than the first
    // timeout being reported as final.
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('ignores a reply carrying somebody else\'s identifier', async () => {
    const config = { ...(await server({ password: 'pw', identifierOffset: 7 })), timeoutMs: 500, retries: 0 };
    expect((await authenticate(config, 'tech', 'pw')).outcome).toBe('timeout');
  });

  it('reports an unexpected response code rather than guessing', async () => {
    const config = await server({ forceCode: 99 });
    const result = await authenticate(config, 'tech', 'pw');
    expect(result.outcome).toBe('error');
  });

  it('surfaces an Access-Challenge instead of treating it as a yes', async () => {
    const config = await server({ forceCode: 11 });
    expect((await authenticate(config, 'tech', 'pw')).outcome).toBe('challenge');
  });

  it('does not retry a rejection', async () => {
    const config = await server({ password: 'hunter2' });
    await authenticate(config, 'tech', 'wrong');
    // One attempt only: re-sending a password the server already refused looks
    // like an attack and cannot succeed.
    expect(running[0]!.seen).toHaveLength(1);
  });

  it('reports an unreachable host without throwing', async () => {
    const result = await authenticate(
      { host: '127.0.0.1', port: 1, secret: SECRET, timeoutMs: 500, retries: 0, nasIdentifier: 'h' },
      'tech',
      'pw',
    );
    expect(['error', 'timeout']).toContain(result.outcome);
  });
});

describe('configuration refusals', () => {
  const base: RadiusServer = {
    host: '127.0.0.1',
    port: 1812,
    secret: SECRET,
    timeoutMs: 5000,
    retries: 2,
    nasIdentifier: 'helm',
  };

  it('refuses a shared secret short enough to be guessed', () => {
    // RFC 2865 §3 asks for 16 characters and more. The secret is the only thing
    // authenticating the server to Helm, so this is refused at configuration
    // time rather than discovered during an incident.
    expect(() => validateServer({ ...base, secret: 'short-secret' })).toThrow(
      RadiusConfigurationError,
    );
  });

  it('accepts one of exactly sixteen characters', () => {
    expect(() => validateServer({ ...base, secret: 'x'.repeat(16) })).not.toThrow();
  });

  it('refuses a nonsense port, timeout or retry count', () => {
    expect(() => validateServer({ ...base, port: 0 })).toThrow(RadiusConfigurationError);
    expect(() => validateServer({ ...base, timeoutMs: 100 })).toThrow(RadiusConfigurationError);
    expect(() => validateServer({ ...base, retries: 99 })).toThrow(RadiusConfigurationError);
  });

  it('returns a configuration error rather than throwing out of authenticate()', async () => {
    const result = await authenticate({ ...base, secret: 'tooshort' }, 'tech', 'pw');
    expect(result.outcome).toBe('error');
  });
});
