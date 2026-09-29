/**
 * Turning what a technician pasted into a TOTP enrolment.
 *
 * A seed arrives in exactly two shapes, and which one you get depends on how
 * cooperative the vendor was:
 *
 *   otpauth://totp/Acme:admin@acme.test?secret=...&digits=8&algorithm=SHA256
 *   JBSWY3DPEHPK3PXP
 *
 * The URI is the better one and not because it is tidier: it carries the
 * algorithm, digit count and period. A vendor using 8 digits or SHA256 is
 * uncommon but not rare, and the failure mode of assuming the defaults is not
 * an error — it is six plausible digits that the vendor rejects forever, found
 * out at 2am by somebody who cannot get into a client's registrar.
 *
 * So: if the paste is a URI, believe its parameters. If it is a bare seed,
 * apply RFC 6238's defaults and let the caller override them explicitly.
 *
 * WHY THIS IS A MODULE AND NOT INLINE IN THE ROUTE. Three write paths need it —
 * creating a credential with a seed, attaching one later, replacing one — and a
 * second implementation that accepted a slightly different set of inputs would
 * mean a seed that stores from one form and is rejected by another.
 */
import {
  base32Decode,
  base32Encode,
  parseOtpAuthUri,
  type TotpAlgorithm,
} from '../crypto/totp';

export interface TotpEnrolment {
  /**
   * The seed, canonicalised to unpadded upper-case base32.
   *
   * Canonical rather than as-pasted: this string is what gets encrypted, and
   * storing "jbsw y3dp" verbatim would mean the stored form differs between two
   * technicians who enrolled the same seed from two different vendor pages.
   * base32Decode is lenient, so both would work — but a stored secret that is
   * not byte-identical for identical input makes every comparison and every
   * support conversation harder than it needs to be.
   */
  seed: string;
  algorithm: TotpAlgorithm;
  digits: 6 | 7 | 8;
  periodSeconds: number;
  issuer: string | null;
  account: string | null;
}

/** What a caller may state explicitly, overriding anything a URI carried. */
export interface TotpEnrolmentOverrides {
  algorithm?: TotpAlgorithm;
  digits?: 6 | 7 | 8;
  periodSeconds?: number;
  issuer?: string | null;
  account?: string | null;
}

export class TotpEnrolmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TotpEnrolmentError';
  }
}

/**
 * The period a stored enrolment may use.
 *
 * Matches credential_totp_period_range in 0070. Checked here as well as there
 * so a bad period is a 400 naming the field rather than a constraint violation
 * surfacing as a 500 three statements later.
 */
const PERIOD_MIN = 15;
const PERIOD_MAX = 120;

export function parseTotpEnrolment(
  input: string,
  overrides: TotpEnrolmentOverrides = {},
): TotpEnrolment {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new TotpEnrolmentError('a TOTP seed is required');

  let base: {
    secret: string;
    algorithm: TotpAlgorithm;
    digits: 6 | 7 | 8;
    periodSeconds: number;
    issuer: string | null;
    account: string | null;
  };

  // Case-insensitive on the scheme: a URI pasted from a page that upper-cased
  // it is still a URI, and treating it as a bare seed would fail on the colon
  // rather than saying what was wrong.
  if (/^otpauth:/i.test(trimmed)) {
    let parsed;
    try {
      parsed = parseOtpAuthUri(trimmed);
    } catch (cause) {
      throw new TotpEnrolmentError(
        `that otpauth:// URI could not be read: ${(cause as Error).message}`,
      );
    }
    base = {
      secret: parsed.secret,
      algorithm: parsed.algorithm,
      digits: parsed.digits,
      periodSeconds: parsed.periodSeconds,
      issuer: parsed.issuer ?? null,
      account: parsed.account ?? null,
    };
  } else {
    base = {
      secret: trimmed,
      algorithm: 'SHA1',
      digits: 6,
      periodSeconds: 30,
      issuer: null,
      account: null,
    };
  }

  /*
   * Decode to canonicalise AND to validate.
   *
   * A seed that does not decode is rejected here rather than stored. The
   * alternative — store it and find out at the first code generation — means
   * the credential looks captured and is not, which is the failure this whole
   * module exists to avoid.
   */
  let seed: string;
  let decoded: Buffer;
  try {
    decoded = base32Decode(base.secret);
  } catch (cause) {
    throw new TotpEnrolmentError(
      `that does not look like a base32 TOTP seed: ${(cause as Error).message}`,
    );
  }
  try {
    seed = base32Encode(decoded);
  } finally {
    decoded.fill(0);
  }

  const periodSeconds = overrides.periodSeconds ?? base.periodSeconds;
  if (!Number.isInteger(periodSeconds) || periodSeconds < PERIOD_MIN || periodSeconds > PERIOD_MAX) {
    throw new TotpEnrolmentError(
      `a TOTP period must be a whole number between ${PERIOD_MIN} and ${PERIOD_MAX} seconds`,
    );
  }

  return {
    seed,
    algorithm: overrides.algorithm ?? base.algorithm,
    digits: overrides.digits ?? base.digits,
    periodSeconds,
    issuer: overrides.issuer !== undefined ? overrides.issuer : base.issuer,
    account: overrides.account !== undefined ? overrides.account : base.account,
  };
}
