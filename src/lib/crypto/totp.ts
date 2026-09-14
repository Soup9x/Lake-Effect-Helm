/**
 * Time-based one-time passwords (RFC 6238, over HOTP from RFC 4226).
 *
 * MSPs accumulate MFA seeds for shared accounts — a client's registrar login,
 * a vendor portal with one licence, a break-glass admin. Those seeds have to
 * live somewhere, and "in the senior tech's personal authenticator app" is how
 * an MSP loses access to a client's domain when that tech leaves.
 *
 * Implemented here rather than pulled from a dependency for a specific reason:
 * the seed is a secret, and every dependency in the path between the vault and
 * the generated code is supply-chain surface on the most sensitive data in the
 * product. This is ~100 lines of well-specified arithmetic against published
 * test vectors.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

export interface TotpConfig {
  /**
   * SHA1 by default, because that is what RFC 6238 specifies and what every
   * authenticator app and nearly every service actually implements. It is not
   * a security weakness here: HMAC-SHA1 remains sound, and collision attacks on
   * SHA-1 do not apply to HMAC.
   */
  algorithm?: TotpAlgorithm;
  digits?: 6 | 7 | 8;
  periodSeconds?: number;
}

export interface TotpCode {
  code: string;
  /** Seconds until this code stops being the current one. Drives the UI ring. */
  secondsRemaining: number;
  /** The counter this code was generated for, for diagnostics. */
  counter: number;
}

const DEFAULTS = {
  algorithm: 'SHA1' as TotpAlgorithm,
  digits: 6 as const,
  periodSeconds: 30,
};

// ---------------------------------------------------------------------------
// Base32 (RFC 4648, no padding required)
// ---------------------------------------------------------------------------

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Decode a base32 seed.
 *
 * Tolerant on input because real-world seeds are pasted from every imaginable
 * source: lowercase, padded with '=', broken into space-separated groups of
 * four the way Microsoft and Google both display them. Rejecting those would
 * mean technicians hand-editing secrets, which is worse than being lenient.
 *
 * Strict on the alphabet itself: anything outside RFC 4648 is an error, not
 * something to silently skip, because a silently-skipped character produces a
 * seed that decodes cleanly and generates wrong codes forever.
 */
export function base32Decode(input: string): Buffer {
  const normalised = input.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();

  if (normalised.length === 0) {
    throw new Error('TOTP seed is empty');
  }

  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (const char of normalised) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error(`invalid base32 character in TOTP seed: ${JSON.stringify(char)}`);
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((value >>> bits) & 0xff);
    }
  }

  if (output.length === 0) {
    throw new Error('TOTP seed decoded to zero bytes');
  }
  return Buffer.from(output);
}

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return output;
}

// ---------------------------------------------------------------------------
// HOTP / TOTP
// ---------------------------------------------------------------------------

/** RFC 4226 §5.3: HMAC, dynamic truncation, modulo 10^digits. */
export function hotp(secret: Buffer, counter: number, config: TotpConfig = {}): string {
  const algorithm = config.algorithm ?? DEFAULTS.algorithm;
  const digits = config.digits ?? DEFAULTS.digits;

  // 8-byte big-endian counter. BigInt because counters exceed 2^32 in 2106 and
  // because `<< 32` on a JS number is not what anyone hopes it is.
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac(algorithm.toLowerCase(), secret).update(buffer).digest();

  // Dynamic truncation: low 4 bits of the last byte select the offset.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

export function counterForTime(atMs: number, periodSeconds: number): number {
  return Math.floor(atMs / 1000 / periodSeconds);
}

/** Generate the code current at `atMs` (default: now). */
export function generateTotp(secret: Buffer, config: TotpConfig = {}, atMs = Date.now()): TotpCode {
  const periodSeconds = config.periodSeconds ?? DEFAULTS.periodSeconds;
  const counter = counterForTime(atMs, periodSeconds);
  const elapsed = Math.floor(atMs / 1000) % periodSeconds;

  return {
    code: hotp(secret, counter, config),
    secondsRemaining: periodSeconds - elapsed,
    counter,
  };
}

export interface TotpVerifyOptions extends TotpConfig {
  /**
   * How many periods either side to accept. 1 (±30s) is the usual choice: it
   * absorbs ordinary clock drift and a user typing slowly, without meaningfully
   * widening the window for an attacker replaying an observed code.
   */
  window?: number;
}

export interface TotpVerification {
  valid: boolean;
  /** 0 when the code was the current one, -1 one period late, +1 one early. */
  drift: number | null;
}

/**
 * Verify a submitted code.
 *
 * Comparison is constant-time and the candidate loop always runs to completion,
 * so neither the result nor the drift leaks through timing. That matters more
 * than it looks: a timing oracle on TOTP verification lets an attacker
 * distinguish "right code, wrong window" from "wrong code".
 */
export function verifyTotp(
  secret: Buffer,
  submitted: string,
  options: TotpVerifyOptions = {},
  atMs = Date.now(),
): TotpVerification {
  const window = options.window ?? 1;
  const periodSeconds = options.periodSeconds ?? DEFAULTS.periodSeconds;
  const digits = options.digits ?? DEFAULTS.digits;

  const cleaned = submitted.replace(/\s/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(cleaned)) {
    return { valid: false, drift: null };
  }

  const expectedBuf = Buffer.from(cleaned, 'utf8');
  const base = counterForTime(atMs, periodSeconds);

  let valid = false;
  let drift: number | null = null;

  for (let offset = -window; offset <= window; offset += 1) {
    const candidate = Buffer.from(hotp(secret, base + offset, options), 'utf8');
    // No early exit: running every iteration keeps the work constant.
    if (candidate.length === expectedBuf.length && timingSafeEqual(candidate, expectedBuf)) {
      valid = true;
      drift = offset;
    }
  }

  return { valid, drift };
}

// ---------------------------------------------------------------------------
// otpauth:// URIs
// ---------------------------------------------------------------------------

export interface OtpAuthUri {
  secret: string;
  // Explicitly `| undefined`: under exactOptionalPropertyTypes an optional
  // property cannot be *assigned* undefined, and both of these genuinely are
  // absent for some issuers.
  issuer?: string | undefined;
  account?: string | undefined;
  algorithm: TotpAlgorithm;
  digits: 6 | 7 | 8;
  periodSeconds: number;
}

/**
 * Parse the otpauth:// URI behind an enrolment QR code.
 *
 * This is how a seed actually arrives: a technician scans or pastes the URI
 * from the vendor's MFA setup page. Parsing it server-side means the
 * parameters (algorithm, digits, period) are captured correctly instead of
 * being assumed to be the defaults — a vendor using 8 digits or SHA256 is
 * uncommon but not rare, and the failure is silent wrong codes.
 */
export function parseOtpAuthUri(uri: string): OtpAuthUri {
  const parsed = new URL(uri);
  if (parsed.protocol !== 'otpauth:') {
    throw new Error(`expected an otpauth:// URI, got ${parsed.protocol}//`);
  }
  if (parsed.host.toLowerCase() !== 'totp') {
    throw new Error(`only TOTP is supported, got ${parsed.host}`);
  }

  const secret = parsed.searchParams.get('secret');
  if (!secret) throw new Error('otpauth URI has no secret parameter');
  // Fail here rather than at first code generation.
  base32Decode(secret);

  // Label is "Issuer:account" or just "account"; the issuer parameter wins.
  const label = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  const colon = label.indexOf(':');
  const labelIssuer = colon >= 0 ? label.slice(0, colon) : undefined;
  const account = colon >= 0 ? label.slice(colon + 1).trim() : label || undefined;

  const digits = Number(parsed.searchParams.get('digits') ?? 6);
  if (digits !== 6 && digits !== 7 && digits !== 8) {
    throw new Error(`unsupported TOTP digit count: ${digits}`);
  }

  const algorithm = (parsed.searchParams.get('algorithm') ?? 'SHA1').toUpperCase();
  if (algorithm !== 'SHA1' && algorithm !== 'SHA256' && algorithm !== 'SHA512') {
    throw new Error(`unsupported TOTP algorithm: ${algorithm}`);
  }

  const period = Number(parsed.searchParams.get('period') ?? 30);
  if (!Number.isInteger(period) || period < 15 || period > 120) {
    throw new Error(`unsupported TOTP period: ${period}`);
  }

  return {
    secret,
    issuer: parsed.searchParams.get('issuer') ?? labelIssuer,
    account,
    algorithm,
    digits,
    periodSeconds: period,
  };
}

export function buildOtpAuthUri(config: OtpAuthUri): string {
  const label = config.issuer ? `${config.issuer}:${config.account ?? ''}` : (config.account ?? '');
  const params = new URLSearchParams({
    secret: config.secret,
    algorithm: config.algorithm,
    digits: String(config.digits),
    period: String(config.periodSeconds),
  });
  if (config.issuer) params.set('issuer', config.issuer);
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}
