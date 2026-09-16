/**
 * Where export bytes live.
 *
 * On-premises the default is the filesystem, because that is what an
 * on-premises deployment has and because adding an object store to run a
 * documentation platform is a cost the customer did not ask for. The interface
 * exists so that an MSP with MinIO or S3 can point Helm at it without touching
 * the render path.
 *
 * Two properties every implementation must hold:
 *
 *   A storage key is opaque and unguessable. It is not a filename derived from
 *   the client's name: a predictable key plus a misconfigured web server is how
 *   an export directory becomes a public listing.
 *
 *   Deletion is real. `expire()` must remove the bytes, not tombstone them. An
 *   expired handover archive still sitting on disk is exactly the breach the
 *   TTL exists to prevent.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

export interface ExportStorage {
  readonly name: string;
  put(bytes: Buffer): Promise<string>;
  get(storageKey: string): Promise<Buffer>;
  remove(storageKey: string): Promise<void>;
}

export class FilesystemExportStorage implements ExportStorage {
  readonly name = 'filesystem';
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async put(bytes: Buffer): Promise<string> {
    // 24 random bytes, sharded two levels so a busy tenant does not end up with
    // 100,000 files in one directory.
    const id = randomBytes(24).toString('base64url');
    const key = `${id.slice(0, 2)}/${id.slice(2, 4)}/${id}`;
    const path = this.#resolve(key);

    await mkdir(dirname(path), { recursive: true });
    // 0600: the bundle may hold credentials, and an 0644 file survives in every
    // backup of this host.
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
    return key;
  }

  async get(storageKey: string): Promise<Buffer> {
    return readFile(this.#resolve(storageKey));
  }

  async remove(storageKey: string): Promise<void> {
    await rm(this.#resolve(storageKey), { force: true });
  }

  /**
   * Refuse any key that escapes the root.
   *
   * The key comes from export_job.storage_key, which this class wrote — but
   * "it came from our own database" is exactly the assumption that turns a SQL
   * injection into arbitrary file read, so the check is here rather than
   * assumed upstream.
   */
  #resolve(storageKey: string): string {
    const path = resolve(join(this.#root, storageKey));
    if (path !== this.#root && !path.startsWith(this.#root + sep)) {
      throw new Error('export storage key escapes the storage root');
    }
    return path;
  }
}

let storage: ExportStorage | null = null;

export function getExportStorage(): ExportStorage {
  if (storage) return storage;
  const root = process.env.HELM_EXPORT_DIR?.trim();
  if (!root) {
    throw new Error(
      'HELM_EXPORT_DIR is not set; exports need somewhere to write bundles ' +
        '(use a directory on encrypted storage, excluded from general backups)',
    );
  }
  storage = new FilesystemExportStorage(root);
  return storage;
}

export function setExportStorage(next: ExportStorage | null): void {
  storage = next;
}
