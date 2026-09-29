import { describe, expect, it } from 'vitest';
import { parseTotpEnrolment, TotpEnrolmentError } from '../../src/lib/secrets/totp-enrolment';
import { generateTotp, base32Decode } from '../../src/lib/crypto/totp';

/**
 * What a technician actually pastes.
 *
 * The interesting failures here are silent: a seed that stores cleanly and
 * generates codes the vendor rejects. Every case below is a shape that has to
 * either work or be refused outright — never stored and wrong.
 */
describe('a bare base32 seed', () => {
  it('takes RFC 6238 defaults', () => {
    const e = parseTotpEnrolment('JBSWY3DPEHPK3PXP');
    expect(e).toEqual({
      seed: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1',
      digits: 6,
      periodSeconds: 30,
      issuer: null,
      account: null,
    });
  });

  /*
   * Canonicalised, not stored as pasted. Google and Microsoft both display seeds
   * in space-separated groups of four and plenty of pages lowercase them; all of
   * those are the same seed and must store identically.
   */
  it('canonicalises the shapes vendors display', () => {
    const canonical = parseTotpEnrolment('JBSWY3DPEHPK3PXP').seed;
    for (const variant of [
      'jbswy3dpehpk3pxp',
      'JBSW Y3DP EHPK 3PXP',
      'JBSW-Y3DP-EHPK-3PXP',
      '  JBSWY3DPEHPK3PXP  ',
      'JBSWY3DPEHPK3PXP======',
    ]) {
      expect(parseTotpEnrolment(variant).seed).toBe(canonical);
    }
  });

  it('refuses something that is not base32 rather than storing it', () => {
    // 0 and 1 are not in the RFC 4648 alphabet. Skipping them silently would
    // decode cleanly to the wrong bytes and generate wrong codes forever.
    expect(() => parseTotpEnrolment('JBSWY3DP0HPK3PXP')).toThrow(TotpEnrolmentError);
    expect(() => parseTotpEnrolment('not a seed!')).toThrow(/base32/);
  });

  it('refuses an empty paste', () => {
    expect(() => parseTotpEnrolment('   ')).toThrow(TotpEnrolmentError);
  });

  it('survives a round trip to a working code', () => {
    const e = parseTotpEnrolment('JBSW Y3DP EHPK 3PXP');
    const seed = base32Decode(e.seed);
    const { code } = generateTotp(seed, {
      algorithm: e.algorithm,
      digits: e.digits,
      periodSeconds: e.periodSeconds,
    });
    expect(code).toMatch(/^\d{6}$/);
  });
});

describe('an otpauth:// URI', () => {
  it('is believed over the defaults', () => {
    const e = parseTotpEnrolment(
      'otpauth://totp/Acme%20Registrar:admin@acme.test' +
        '?secret=JBSWY3DPEHPK3PXP&issuer=Acme%20Registrar&algorithm=SHA256&digits=8&period=60',
    );
    expect(e).toEqual({
      seed: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA256',
      digits: 8,
      periodSeconds: 60,
      issuer: 'Acme Registrar',
      account: 'admin@acme.test',
    });
  });

  it('falls back to the defaults for parameters it omits', () => {
    const e = parseTotpEnrolment('otpauth://totp/admin@acme.test?secret=JBSWY3DPEHPK3PXP');
    expect(e.algorithm).toBe('SHA1');
    expect(e.digits).toBe(6);
    expect(e.periodSeconds).toBe(30);
  });

  it('is recognised whatever the case of the scheme', () => {
    expect(parseTotpEnrolment('OTPAUTH://totp/x?secret=JBSWY3DPEHPK3PXP').seed)
      .toBe('JBSWY3DPEHPK3PXP');
  });

  it('is refused, not treated as a bare seed, when it is malformed', () => {
    expect(() => parseTotpEnrolment('otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=1'))
      .toThrow(TotpEnrolmentError);
    expect(() => parseTotpEnrolment('otpauth://totp/x?secret=NOT!BASE32'))
      .toThrow(TotpEnrolmentError);
  });
});

describe('explicit overrides', () => {
  it('beat what the URI said, because a caller who states one means it', () => {
    const e = parseTotpEnrolment(
      'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=8&period=60&algorithm=SHA256',
      { digits: 6, periodSeconds: 30, algorithm: 'SHA1' },
    );
    expect(e).toMatchObject({ digits: 6, periodSeconds: 30, algorithm: 'SHA1' });
  });

  it('can null an issuer the URI carried', () => {
    const e = parseTotpEnrolment('otpauth://totp/a@b?secret=JBSWY3DPEHPK3PXP&issuer=Vendor', {
      issuer: null,
    });
    expect(e.issuer).toBeNull();
    // Absent, not null: an override that was not passed leaves the URI's value.
    expect(e.account).toBe('a@b');
  });

  /*
   * The bound matches credential_totp_period_range in 0070. Checked here so the
   * refusal names the field instead of surfacing as a constraint violation from
   * three statements later.
   */
  it('refuses a period the schema would reject anyway', () => {
    expect(() => parseTotpEnrolment('JBSWY3DPEHPK3PXP', { periodSeconds: 5 })).toThrow(/between/);
    expect(() => parseTotpEnrolment('JBSWY3DPEHPK3PXP', { periodSeconds: 300 })).toThrow(/between/);
    expect(parseTotpEnrolment('JBSWY3DPEHPK3PXP', { periodSeconds: 15 }).periodSeconds).toBe(15);
    expect(parseTotpEnrolment('JBSWY3DPEHPK3PXP', { periodSeconds: 120 }).periodSeconds).toBe(120);
  });
});
