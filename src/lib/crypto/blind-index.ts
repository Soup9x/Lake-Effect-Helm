/**
 * Password reuse detection without storing anything crackable.
 *
 * "This domain admin password is also in use at three other clients" is a real
 * and valuable finding for an MSP. Getting it requires comparing plaintexts,
 * which we do not have and do not want.
 *
 * A blind index solves it: HMAC-SHA256 of the plaintext under a key that is
 * held separately from the KEK. Equal plaintexts produce equal HMACs; the HMAC
 * reveals nothing about the plaintext without the key.
 *
 * THE TRADEOFF, STATED PLAINLY: an attacker holding both the reuse_hmac column
 * and this key gains an offline verification oracle — they can test guessed
 * passwords without touching the system. That is strictly worse than not having
 * the column, and it is why:
 *
 *   * the key is separate from the KEK, so one compromise is not both;
 *   * a per-tenant subkey is derived, so a single tenant's index cannot be
 *     used to test candidates against another tenant's secrets;
 *   * the column is nullable and the feature is off unless
 *     HELM_BLIND_INDEX_KEY_B64 is set. Deployments that do not want the oracle
 *     simply get no reuse detection.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { HelmCryptoError } from './errors';

const SUBKEY_INFO = 'helm/blind-index/v1';

export class BlindIndex {
  readonly #rootKey: Buffer;

  constructor(rootKeyBase64: string) {
    const key = Buffer.from(rootKeyBase64, 'base64');
    if (key.length < 32) {
      throw new HelmCryptoError(
        'blind_index_unavailable',
        `blind index key must be at least 32 bytes, got ${key.length}`,
      );
    }
    this.#rootKey = key;
  }

  /**
   * Returns null when the feature is not configured, which callers pass
   * straight through to a NULL reuse_hmac column. Deliberately not an error:
   * reuse detection is optional, and a deployment that declines it should not
   * fail to save passwords.
   */
  static fromEnv(): BlindIndex | null {
    const raw = process.env.HELM_BLIND_INDEX_KEY_B64;
    if (!raw) return null;
    return new BlindIndex(raw);
  }

  /**
   * HMAC of a plaintext, scoped to one tenant.
   *
   * The tenant subkey is what stops an attacker from using tenant A's captured
   * index to test candidate passwords against tenant B's secrets: the same
   * plaintext hashes differently in each tenant.
   */
  compute(tenantId: string, plaintext: Buffer): Buffer {
    return createHmac('sha256', this.#subkey(tenantId)).update(plaintext).digest();
  }

  /** Constant-time comparison, for the rare case of comparing two indexes in app code. */
  matches(a: Buffer, b: Buffer): boolean {
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  #subkey(tenantId: string): Buffer {
    return createHmac('sha256', this.#rootKey).update(`${SUBKEY_INFO}:${tenantId}`).digest();
  }
}

/**
 * A crude strength score, 0-4, matching the range secret_version.strength_score
 * accepts.
 *
 * Deliberately NOT zxcvbn: that is a 400KB dictionary dependency, and this
 * value is only ever used to nudge a technician and to populate a "weak
 * credentials" report. It is metadata about the plaintext, never derived from
 * it in a way that survives — the score is stored, the password is not.
 *
 * Swap in zxcvbn at the composition root if the reporting warrants the weight.
 */
export function scoreStrength(plaintext: string): number {
  const length = plaintext.length;
  if (length === 0) return 0;

  const classes =
    Number(/[a-z]/.test(plaintext)) +
    Number(/[A-Z]/.test(plaintext)) +
    Number(/[0-9]/.test(plaintext)) +
    Number(/[^A-Za-z0-9]/.test(plaintext));

  // Rough entropy estimate: log2(alphabet) * length.
  const alphabet = [0, 26, 52, 62, 95][classes] ?? 95;
  const bits = (Math.log2(alphabet) * length) | 0;

  // Penalise the obvious patterns an entropy estimate happily overrates.
  const repeated = /(.)\1{2,}/.test(plaintext);
  const sequential = /(?:abc|bcd|cde|123|234|345|qwe|asd)/i.test(plaintext);
  const adjusted = bits - (repeated ? 12 : 0) - (sequential ? 12 : 0);

  if (adjusted < 28) return 0;
  if (adjusted < 40) return 1;
  if (adjusted < 60) return 2;
  if (adjusted < 90) return 3;
  return 4;
}
