/**
 * Crypto failures are security events, not ordinary errors.
 *
 * They carry a stable `code` so call sites can branch without string matching,
 * and deliberately carry NO plaintext, key material, or ciphertext in their
 * messages — an error message ends up in logs, in Sentry, and in a support
 * ticket screenshot.
 */

export type CryptoErrorCode =
  | 'kek_unavailable'
  | 'dek_unwrap_failed'
  | 'decrypt_failed'
  | 'invalid_envelope'
  | 'nonce_exhausted'
  | 'key_retired'
  | 'blind_index_unavailable';

export class HelmCryptoError extends Error {
  readonly code: CryptoErrorCode;

  constructor(code: CryptoErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HelmCryptoError';
    this.code = code;
  }

  /**
   * Authentication failure is indistinguishable from "wrong key", "tampered
   * ciphertext" and "wrong bound context" — by design, and we must not help an
   * attacker tell them apart. One message for all three.
   */
  static authenticationFailed(cause?: unknown): HelmCryptoError {
    return new HelmCryptoError(
      'decrypt_failed',
      'secret could not be authenticated: ciphertext, key, or bound context does not match',
      { cause },
    );
  }
}
