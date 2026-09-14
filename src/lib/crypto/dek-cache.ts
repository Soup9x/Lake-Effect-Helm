/**
 * In-process cache of unwrapped Data Encryption Keys.
 *
 * Without it, every credential reveal costs a KMS round trip: slow, and
 * expensive at MSP volumes where a technician opening a client page may touch
 * a dozen secrets. With it, a DEK is unwrapped once and reused for a bounded
 * window.
 *
 * The window is the whole design question. A longer TTL means fewer KMS calls
 * and a longer period during which a heap dump yields usable key material. Five
 * minutes is the default: long enough that a page load is one unwrap, short
 * enough that a revoked KMS grant takes effect while the incident is still open.
 *
 * ON ZEROING, HONESTLY: `#zero()` overwrites the buffer on eviction, and that is
 * worth doing, but it is best-effort and not a guarantee. V8 may have copied the
 * bytes during GC, the OS may have paged them out, and nothing here survives a
 * core dump taken mid-request. Treat the cache as reducing exposure time, not as
 * making key material unrecoverable.
 */
import type { EncryptionContext, KekProvider } from './kek';

interface CacheEntry {
  dek: Buffer;
  expiresAt: number;
  /** In-flight unwraps share one promise so N concurrent reveals make one KMS call. */
  pending?: Promise<Buffer>;
}

export interface DekCacheOptions {
  ttlMs?: number;
  /** Bounded so a tenant enumeration cannot grow the cache without limit. */
  maxEntries?: number;
  now?: () => number;
}

export interface DekRequest {
  /** tenant_data_key.id — the cache key, since it identifies one exact DEK. */
  dataKeyId: string;
  wrappedDek: Buffer;
  kekId: string;
  context: EncryptionContext;
}

export class DekCache {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #provider: KekProvider;
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;

  #hits = 0;
  #misses = 0;

  constructor(provider: KekProvider, options: DekCacheOptions = {}) {
    this.#provider = provider;
    this.#ttlMs = options.ttlMs ?? Number(process.env.HELM_DEK_CACHE_TTL_SECONDS ?? 300) * 1000;
    this.#maxEntries = options.maxEntries ?? 256;
    this.#now = options.now ?? Date.now;
  }

  get stats(): { hits: number; misses: number; size: number } {
    return { hits: this.#hits, misses: this.#misses, size: this.#entries.size };
  }

  /**
   * Returns the unwrapped DEK, unwrapping via the KEK provider on a miss.
   *
   * The returned Buffer is the cache's own copy. Callers must not mutate it,
   * and must not hold it past the operation that needed it — copying it into a
   * long-lived structure defeats the TTL entirely.
   */
  async get(request: DekRequest): Promise<Buffer> {
    const now = this.#now();
    const existing = this.#entries.get(request.dataKeyId);

    if (existing) {
      if (existing.pending) {
        // Another caller is already unwrapping this exact key. Join them rather
        // than firing a second KMS call for the same answer.
        this.#hits += 1;
        return existing.pending;
      }
      if (existing.expiresAt > now) {
        this.#hits += 1;
        return existing.dek;
      }
      this.#evict(request.dataKeyId);
    }

    this.#misses += 1;

    const pending = this.#provider
      .unwrapDek(request.wrappedDek, request.kekId, request.context)
      .then((dek) => {
        this.#store(request.dataKeyId, dek);
        return dek;
      })
      .catch((err: unknown) => {
        // Never cache a failure: a transient KMS outage must not poison the
        // entry for the rest of the TTL.
        this.#entries.delete(request.dataKeyId);
        throw err;
      });

    this.#entries.set(request.dataKeyId, {
      dek: Buffer.alloc(0),
      expiresAt: now + this.#ttlMs,
      pending,
    });

    return pending;
  }

  /**
   * Drop a single key. Call this when a DEK is retired or a tenant is
   * suspended — the TTL alone would leave it usable for minutes afterwards.
   */
  invalidate(dataKeyId: string): void {
    this.#evict(dataKeyId);
  }

  /** Drop everything. Call on KEK rotation, and on shutdown. */
  clear(): void {
    for (const id of [...this.#entries.keys()]) this.#evict(id);
  }

  #store(dataKeyId: string, dek: Buffer): void {
    if (this.#entries.size >= this.#maxEntries) {
      // Map preserves insertion order, so the first key is the oldest.
      const oldest = this.#entries.keys().next();
      if (!oldest.done) this.#evict(oldest.value);
    }
    this.#entries.set(dataKeyId, { dek, expiresAt: this.#now() + this.#ttlMs });
  }

  #evict(dataKeyId: string): void {
    const entry = this.#entries.get(dataKeyId);
    if (entry) this.#zero(entry.dek);
    this.#entries.delete(dataKeyId);
  }

  /** Best-effort overwrite. See the file header for what this does and does not achieve. */
  #zero(buffer: Buffer): void {
    if (buffer.length > 0) buffer.fill(0);
  }
}
