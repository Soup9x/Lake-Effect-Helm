import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  buildOtpAuthUri,
  generateTotp,
  parseOtpAuthUri,
  verifyTotp,
  type TotpAlgorithm,
} from '../../src/lib/crypto/totp';

/**
 * RFC 6238 Appendix B.
 *
 * These are the only test that actually proves the implementation correct. The
 * failure mode of a home-grown TOTP is not a crash — it is codes that look
 * plausible and are always rejected by the vendor, discovered at 2am by a
 * technician who cannot get into a client's registrar.
 */
describe('RFC 6238 test vectors', () => {
  const seeds: Record<TotpAlgorithm, Buffer> = {
    SHA1: Buffer.from('12345678901234567890', 'ascii'),
    SHA256: Buffer.from('12345678901234567890123456789012', 'ascii'),
    SHA512: Buffer.from(
      '1234567890123456789012345678901234567890123456789012345678901234',
      'ascii',
    ),
  };

  const vectors: ReadonlyArray<readonly [number, string, string, string]> = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    // Past 2^32 seconds: catches a counter written as a 32-bit int.
    [20000000000, '65353130', '77737706', '47863826'],
  ];

  for (const [seconds, sha1, sha256, sha512] of vectors) {
    const expected: Record<TotpAlgorithm, string> = { SHA1: sha1, SHA256: sha256, SHA512: sha512 };
    for (const algorithm of ['SHA1', 'SHA256', 'SHA512'] as const) {
      it(`t=${seconds} ${algorithm}`, () => {
        const { code } = generateTotp(
          seeds[algorithm],
          { algorithm, digits: 8, periodSeconds: 30 },
          seconds * 1000,
        );
        expect(code).toBe(expected[algorithm]);
      });
    }
  }
});

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    const original = Buffer.from('12345678901234567890', 'ascii');
    expect(base32Decode(base32Encode(original))).toEqual(original);
  });

  it('accepts the formats vendors actually display', () => {
    const canonical = base32Decode('GEZDGNBVGY3TQOJQ');
    // Lowercase, spaced into groups of four, and padded — all seen in the wild.
    expect(base32Decode('gezdgnbvgy3tqojq')).toEqual(canonical);
    expect(base32Decode('GEZD GNBV GY3T QOJQ')).toEqual(canonical);
    expect(base32Decode('GEZD-GNBV-GY3T-QOJQ')).toEqual(canonical);
    expect(base32Decode('GEZDGNBVGY3TQOJQ====')).toEqual(canonical);
  });

  it('rejects characters outside the alphabet instead of skipping them', () => {
    // Silently skipping would decode cleanly and generate wrong codes forever.
    expect(() => base32Decode('GEZDGNBV0Y3TQOJQ')).toThrow(/invalid base32/);
    expect(() => base32Decode('GEZDGNBV1Y3TQOJQ')).toThrow(/invalid base32/);
  });

  it('rejects an empty seed', () => {
    expect(() => base32Decode('')).toThrow();
    expect(() => base32Decode('   ')).toThrow();
  });
});

describe('verification window', () => {
  const secret = Buffer.from('12345678901234567890', 'ascii');
  const at = 1111111111 * 1000;

  it('accepts the current code with zero drift', () => {
    const { code } = generateTotp(secret, {}, at);
    expect(verifyTotp(secret, code, {}, at)).toEqual({ valid: true, drift: 0 });
  });

  it('accepts one period late and reports the drift', () => {
    const { code } = generateTotp(secret, {}, at - 30_000);
    expect(verifyTotp(secret, code, { window: 1 }, at)).toEqual({ valid: true, drift: -1 });
  });

  it('accepts one period early', () => {
    const { code } = generateTotp(secret, {}, at + 30_000);
    expect(verifyTotp(secret, code, { window: 1 }, at)).toEqual({ valid: true, drift: 1 });
  });

  it('rejects two periods out with the default window', () => {
    const { code } = generateTotp(secret, {}, at - 90_000);
    expect(verifyTotp(secret, code, { window: 1 }, at).valid).toBe(false);
  });

  it('rejects malformed input without throwing', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56']) {
      expect(verifyTotp(secret, bad, {}, at)).toEqual({ valid: false, drift: null });
    }
  });

  it('tolerates whitespace a user pastes with the code', () => {
    const { code } = generateTotp(secret, {}, at);
    expect(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, {}, at).valid).toBe(true);
  });

  it('reports seconds remaining so the UI can show a countdown', () => {
    // 1111111111 mod 30 == 1, so 29 seconds are left in this period.
    expect(generateTotp(secret, {}, at).secondsRemaining).toBe(29);
  });
});

describe('otpauth URIs', () => {
  it('parses the common Google/Microsoft form', () => {
    const parsed = parseOtpAuthUri(
      'otpauth://totp/ACME%20Co:alice%40acme.test?secret=GEZDGNBVGY3TQOJQ&issuer=ACME%20Co',
    );
    expect(parsed.secret).toBe('GEZDGNBVGY3TQOJQ');
    expect(parsed.issuer).toBe('ACME Co');
    expect(parsed.account).toBe('alice@acme.test');
    // Unspecified parameters take the RFC defaults.
    expect(parsed.algorithm).toBe('SHA1');
    expect(parsed.digits).toBe(6);
    expect(parsed.periodSeconds).toBe(30);
  });

  it('captures non-default parameters rather than assuming', () => {
    // A vendor using 8 digits and SHA256 is uncommon but not rare, and
    // assuming the defaults produces silently wrong codes.
    const parsed = parseOtpAuthUri(
      'otpauth://totp/Vendor:svc?secret=GEZDGNBVGY3TQOJQ&algorithm=SHA256&digits=8&period=60',
    );
    expect(parsed.algorithm).toBe('SHA256');
    expect(parsed.digits).toBe(8);
    expect(parsed.periodSeconds).toBe(60);
  });

  it('rejects a bad secret at parse time, not at first use', () => {
    expect(() => parseOtpAuthUri('otpauth://totp/x?secret=NOT!BASE32')).toThrow(/base32/);
  });

  it('rejects non-TOTP and non-otpauth URIs', () => {
    expect(() => parseOtpAuthUri('otpauth://hotp/x?secret=GEZDGNBVGY3TQOJQ&counter=1')).toThrow(
      /only TOTP/,
    );
    expect(() => parseOtpAuthUri('https://example.com/?secret=GEZDGNBVGY3TQOJQ')).toThrow(
      /otpauth/,
    );
  });

  it('rejects unsupported parameter values', () => {
    expect(() => parseOtpAuthUri('otpauth://totp/x?secret=GEZDGNBVGY3TQOJQ&digits=9')).toThrow();
    expect(() => parseOtpAuthUri('otpauth://totp/x?secret=GEZDGNBVGY3TQOJQ&period=5')).toThrow();
    expect(() =>
      parseOtpAuthUri('otpauth://totp/x?secret=GEZDGNBVGY3TQOJQ&algorithm=MD5'),
    ).toThrow();
  });

  it('round-trips through build and parse', () => {
    const uri = buildOtpAuthUri({
      secret: 'GEZDGNBVGY3TQOJQ',
      issuer: 'ACME Co',
      account: 'alice@acme.test',
      algorithm: 'SHA512',
      digits: 8,
      periodSeconds: 60,
    });
    const parsed = parseOtpAuthUri(uri);
    expect(parsed.secret).toBe('GEZDGNBVGY3TQOJQ');
    expect(parsed.issuer).toBe('ACME Co');
    expect(parsed.account).toBe('alice@acme.test');
    expect(parsed.algorithm).toBe('SHA512');
    expect(parsed.digits).toBe(8);
    expect(parsed.periodSeconds).toBe(60);
  });
});
