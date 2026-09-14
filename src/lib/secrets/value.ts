/**
 * A decrypted secret, wrapped so it is hard to leak by accident.
 *
 * The realistic way a credential platform leaks passwords is not a broken
 * cipher. It is `logger.info({ credential })` in an error path, a secret landing
 * in a Sentry breadcrumb, or an object spread into an API response by a
 * `...rest`. A bare string offers no defence against any of those.
 *
 * SecretValue makes the accidental paths inert:
 *
 *   String(value)            -> "[helm secret: redacted]"
 *   `${value}`               -> "[helm secret: redacted]"
 *   JSON.stringify(value)    -> "[helm secret: redacted]"
 *   console.log(value)       -> SecretValue [redacted]
 *
 * ...while the deliberate path, `.expose()`, is greppable in review.
 *
 * It is a guard rail, not a sandbox: once a caller has the string, it is an
 * ordinary immutable JS string and nothing can un-leak it. The point is that
 * leaking now requires an explicit act.
 */

const REDACTED = '[helm secret: redacted]';

export class SecretValue {
  #bytes: Buffer | null;
  readonly #label: string;

  constructor(bytes: Buffer, label = 'secret') {
    this.#bytes = bytes;
    this.#label = label;
  }

  static fromString(value: string, label?: string): SecretValue {
    return new SecretValue(Buffer.from(value, 'utf8'), label);
  }

  /** Non-sensitive: safe to log, useful for "which secret was this?". */
  get label(): string {
    return this.#label;
  }

  get byteLength(): number {
    return this.#bytes?.length ?? 0;
  }

  get disposed(): boolean {
    return this.#bytes === null;
  }

  /**
   * Hand over the plaintext. Deliberately verbose at the call site.
   *
   * Note the string returned here cannot be wiped — JS strings are immutable
   * and interned. Prefer `use()` or `exposeBytes()` where the consumer can
   * take bytes.
   */
  expose(): string {
    return this.#requireBytes().toString('utf8');
  }

  /** The raw bytes. The caller must not retain or mutate them past the operation. */
  exposeBytes(): Buffer {
    return this.#requireBytes();
  }

  /**
   * Scoped access: the value is disposed when `fn` returns, even if it throws.
   *
   * This is the shape most call sites should use — it makes the lifetime of the
   * plaintext a block rather than "until garbage collection, whenever that is".
   */
  use<T>(fn: (plaintext: string) => T): T {
    try {
      return fn(this.expose());
    } finally {
      this.dispose();
    }
  }

  async useAsync<T>(fn: (plaintext: string) => Promise<T>): Promise<T> {
    try {
      return await fn(this.expose());
    } finally {
      this.dispose();
    }
  }

  /** Best-effort wipe. Same caveats as everywhere else: shortens exposure, does not eliminate it. */
  dispose(): void {
    if (this.#bytes) {
      this.#bytes.fill(0);
      this.#bytes = null;
    }
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  /** Node's console.log / util.inspect path. */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `SecretValue(${this.#label}) [redacted]`;
  }

  #requireBytes(): Buffer {
    if (!this.#bytes) {
      throw new Error(
        'this SecretValue has been disposed; reveal it again rather than caching plaintext',
      );
    }
    return this.#bytes;
  }
}
