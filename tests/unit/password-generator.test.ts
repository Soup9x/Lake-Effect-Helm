import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PASSWORD_OPTIONS, MAX_LENGTH, MIN_LENGTH, generatePassword, passwordEntropyBits,
  type PasswordOptions,
} from '../../src/lib/ui/password-generator';

const opts = (o: Partial<PasswordOptions> = {}): PasswordOptions => ({ ...DEFAULT_PASSWORD_OPTIONS, ...o });

describe('generatePassword', () => {
  it('is the length asked for, within bounds', () => {
    expect(generatePassword(opts({ length: 24 }))).toHaveLength(24);
    expect(generatePassword(opts({ length: 2 }))).toHaveLength(MIN_LENGTH);
    expect(generatePassword(opts({ length: 10_000 }))).toHaveLength(MAX_LENGTH);
  });

  it('always contains one of every set chosen, even at the minimum length', () => {
    for (let i = 0; i < 200; i += 1) {
      const p = generatePassword(opts({ length: MIN_LENGTH }));
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[0-9]/);
      expect(p).toMatch(/[^A-Za-z0-9]/);
    }
  });

  it('uses only the sets chosen, and leaves out look-alikes when asked', () => {
    const digitsOnly = generatePassword(opts({ upper: false, lower: false, symbols: false, avoidAmbiguous: false, length: 64 }));
    expect(digitsOnly).toMatch(/^[0-9]+$/);
    for (let i = 0; i < 100; i += 1) {
      expect(generatePassword(opts({ length: 64 }))).not.toMatch(/[0Oo1lI|`'"]/);
    }
  });

  it('never uses a space, a backslash or a quote', () => {
    for (let i = 0; i < 100; i += 1) {
      expect(generatePassword(opts({ length: 64, avoidAmbiguous: false }))).not.toMatch(/[\s\\"']/);
    }
  });

  it('falls back to letters and digits rather than an empty password', () => {
    const p = generatePassword(opts({ upper: false, lower: false, digits: false, symbols: false }));
    expect(p).toMatch(/^[A-Za-z0-9]{20}$/);
  });

  it('draws without modulo bias: a byte that would skew the alphabet is rejected', () => {
    // Digits only (10 characters): 256 % 10 = 6, so bytes 250..255 must be thrown away.
    const bytes = [255, 250, 3, 7, 251, 9, 0, 1, 2, 4, 5, 6, 8, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3];
    let i = 0;
    const random = (b: Uint8Array) => { b[0] = bytes[i++ % bytes.length]!; return b; };
    const p = generatePassword(opts({ upper: false, lower: false, symbols: false, avoidAmbiguous: false, length: 8 }), random);
    expect(p).toMatch(/^[0-9]{8}$/);
    // 255 and 250 were skipped; the first draw used 3.
    expect(i).toBeGreaterThan(8);
  });
});

describe('passwordEntropyBits', () => {
  it('grows with the length and the alphabet', () => {
    expect(passwordEntropyBits(opts({ length: 20 }))).toBeGreaterThan(passwordEntropyBits(opts({ length: 12 })));
    expect(passwordEntropyBits(opts({ symbols: false }))).toBeLessThan(passwordEntropyBits(opts()));
  });
});
