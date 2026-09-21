/**
 * Where document bytes live.
 *
 * The same answer exports already gave, for the same reason: on-premises, on
 * the filesystem, under /var/lib/helm on a volume the operator already backs
 * up and already knows about. Adding an object store to run a documentation
 * platform is a cost the customer did not ask for.
 *
 * REUSING THE EXPORT STORAGE CLASS RATHER THAN WRITING A SECOND ONE. Its three
 * properties are exactly the ones documents need, and each of them was arrived
 * at for a reason that applies here unchanged:
 *
 *   The key is opaque and unguessable — 24 random bytes, sharded two levels. A
 *   key derived from the client's name plus a misconfigured web server is how a
 *   documents directory becomes a public listing.
 *
 *   Files are written 0600. The bytes are ciphertext, but an 0644 file survives
 *   in every backup of this host and in every container image layer somebody
 *   builds from it by accident.
 *
 *   A key that escapes the root is refused, even though the key came from our
 *   own database — which is precisely the assumption that turns a SQL injection
 *   into arbitrary file read.
 *
 * Only the root and the singleton differ, so only those are here.
 *
 * 0130's comment on `attachment` says the bytes live in "S3-compatible
 * storage". That described an intention this deployment never had and there was
 * never an implementation behind it; this is it, and it is local.
 */
import { FilesystemExportStorage, type ExportStorage } from '../exports/storage';

let storage: ExportStorage | null = null;

export function getDocumentStorage(): ExportStorage {
  if (storage) return storage;
  const root = process.env.HELM_DOCUMENT_DIR?.trim();
  if (!root) {
    throw new Error(
      'HELM_DOCUMENT_DIR is not set; client documents need somewhere to write ' +
        '(a directory on encrypted storage — the bytes are encrypted too, but ' +
        'filenames and sizes are not stored there and the volume still needs backing up)',
    );
  }
  storage = new FilesystemExportStorage(root);
  return storage;
}

/** Override the storage. For tests, and for a deployment that wires its own. */
export function setDocumentStorage(next: ExportStorage | null): void {
  storage = next;
}
