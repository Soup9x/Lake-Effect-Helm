/**
 * Client documents: the bytes, and the row that describes them.
 *
 * Thin on purpose. Everything that can be a database rule is one — visibility
 * is RLS on `attachment` and `document_folder`, the internal-only flag is
 * inherited by trigger, a duplicate name in a folder is a unique index, a
 * document cannot be deleted before it is archived, and a download writes its
 * audit row inside helm.open_document(). What is left here is the part that
 * cannot live in Postgres: AES-256-GCM over a 50 MB file, and a filesystem.
 *
 * ORDER OF OPERATIONS ON UPLOAD, and it is not arbitrary.
 *
 * The AAD binds a ciphertext to the attachment id, so the id has to exist
 * before the bytes are sealed. It is minted here rather than by the column
 * default — the alternative is inserting a row, sealing, then updating it,
 * which leaves a window where the row says a file exists and no file does.
 *
 * The file is written BEFORE the row and removed again if the row is refused.
 * The other order leaves a row pointing at nothing, which every list view then
 * renders as a document that cannot be downloaded. An orphaned FILE is
 * invisible and costs disk; an orphaned ROW is a support call.
 */
import { randomUUID } from 'node:crypto';
import { withTenant } from '../db/client';
// The same actor shape the secret service takes, because it is the same actor
// and a second interface with the same five fields would drift.
import type { ActorRef } from '../secrets/service';
import type { DekCache } from '../crypto/dek-cache';
import { wipe } from '../crypto/envelope';
import { activeDataKey, dataKeyById } from '../secrets/keys';
import { getDocumentStorage } from './storage';
import { documentBinding, openDocument, sealDocument } from './crypto';
import type { ExportStorage } from '../exports/storage';

export class DocumentError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'name_taken'
      | 'no_such_folder'
      | 'missing_bytes'
      | 'forbidden'
      | 'not_archived',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'DocumentError';
  }
}

export interface UploadedDocument {
  readonly id: string;
  readonly filename: string;
  readonly byteSize: number;
  readonly isInternalOnly: boolean;
}

export interface OpenedDocument {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Buffer;
  readonly auditEventUid: string;
}

interface DocumentServiceDeps {
  readonly dekCache: DekCache;
  readonly storage?: ExportStorage;
}

export class DocumentService {
  constructor(private readonly deps: DocumentServiceDeps) {}

  private get storage(): ExportStorage {
    return this.deps.storage ?? getDocumentStorage();
  }

  /**
   * Store a file in a client's document tree.
   *
   * `isInternalOnly` is a REQUEST, not a decision: a document dropped into an
   * internal-only folder is internal-only whatever was asked for, forced by a
   * trigger in 0560 rather than by this function remembering to.
   */
  async upload(
    actor: ActorRef,
    input: {
      organizationId: string;
      folderId: string | null;
      filename: string;
      contentType: string;
      isInternalOnly: boolean;
      bytes: Buffer;
    },
  ): Promise<UploadedDocument> {
    if (input.bytes.length === 0) {
      throw new DocumentError('missing_bytes', 'the file is empty');
    }

    const attachmentId = randomUUID();
    const sha256 = await sha256Of(input.bytes);

    const sealed = await withTenant(actor, async (tx) => {
      const key = await activeDataKey(tx, actor.tenantId);
      const dek = await this.deps.dekCache.get({
        dataKeyId: key.id,
        wrappedDek: key.wrappedDek,
        kekId: key.kekId,
        context: key.wrapContext,
      });
      return {
        dataKeyId: key.id,
        ...sealDocument(dek, input.bytes, documentBinding(actor.tenantId, attachmentId)),
      };
    });

    const storageKey = await this.storage.put(sealed.body);

    try {
      return await withTenant(actor, async (tx) => {
        const [row] = await tx<
          { id: string; filename: string; byte_size: string; is_internal_only: boolean }[]
        >`
          INSERT INTO attachment (
            id, tenant_id, organization_id, is_document, folder_id,
            filename, content_type, byte_size, storage_key, content_sha256,
            data_key_id, encryption_nonce, is_internal_only,
            scan_status, uploaded_by
          )
          VALUES (
            ${attachmentId}::uuid, ${actor.tenantId}::uuid, ${input.organizationId}::uuid,
            true, ${input.folderId},
            ${input.filename}, ${input.contentType}, ${input.bytes.length},
            ${storageKey}, ${sha256},
            ${sealed.dataKeyId}::uuid, ${sealed.nonce}, ${input.isInternalOnly},
            -- No scanner is wired in this deployment, and 'pending' would be a
            -- queue nothing drains — a status that reads as "we are checking"
            -- when nobody is. See docs/deployment/on-premises.md.
            'skipped'::attachment_scan_status, ${actor.actorId}::uuid
          )
          RETURNING id, filename, byte_size, is_internal_only
        `;
        if (!row) throw new DocumentError('not_found', 'the document could not be stored');

        await tx`
          SELECT helm.audit(
            'document.uploaded', 'attachment', ${row.id}::uuid, 'success',
            ${input.organizationId}::uuid, NULL, NULL,
            ${tx.json({
              filename: row.filename,
              byteSize: input.bytes.length,
              contentType: input.contentType,
              isInternalOnly: row.is_internal_only,
            })}::jsonb
          )
        `;

        return {
          id: row.id,
          filename: row.filename,
          byteSize: Number(row.byte_size),
          isInternalOnly: row.is_internal_only,
        };
      });
    } catch (cause) {
      // The row was refused, so the bytes belong to nothing.
      await this.storage.remove(storageKey).catch(() => {});
      throw translateWriteError(cause);
    } finally {
      wipe(sealed.body, sealed.nonce);
    }
  }

  /**
   * Fetch and decrypt a document.
   *
   * The read and the decryption happen INSIDE the transaction that writes the
   * audit row, so a file that turns out to be missing or unopenable rolls the
   * event back rather than leaving a trail saying somebody downloaded something
   * they never received.
   *
   * A REFUSAL IS RETURNED FROM THE TRANSACTION, NOT THROWN THROUGH IT, and that
   * is the same trap helm.open_document() was reshaped to avoid one level down.
   * The function writes a `document.download_denied` row and hands the refusal
   * back as data; throwing here would roll that row away with the transaction,
   * and a denied attempt on a client's files would leave no trace at all. So
   * the throw happens after the commit.
   */
  async download(actor: ActorRef, attachmentId: string): Promise<OpenedDocument> {
    const result = await withTenant(actor, async (tx) => {
      const [row] = await tx<
        {
          ok: boolean;
          attachment_id: string | null;
          filename: string | null;
          content_type: string | null;
          storage_key: string | null;
          data_key_id: string | null;
          encryption_nonce: Buffer | null;
          audit_event_uid: string;
        }[]
      >`
        SELECT ok, attachment_id, filename, content_type, storage_key,
               data_key_id, encryption_nonce, audit_event_uid
        FROM helm.open_document(${attachmentId}::uuid)
      `;
      // A refusal comes back as a row with ok = false and an audit event id,
      // rather than as an exception — see helm.open_document(). Out of scope,
      // internal-only to a client actor and simply absent are one answer on
      // purpose: a distinguishable "exists but you may not" tells a client
      // which documents the MSP keeps from them.
      if (!row || !row.ok || !row.attachment_id || !row.storage_key) {
        return { refused: true as const };
      }

      const body = await this.storage.get(row.storage_key);

      // 0130 pairs these two columns with a CHECK, so one without the other
      // cannot be stored — but a row written before documents existed, or by
      // hand, would still arrive here and must not be served as plaintext.
      if (!row.data_key_id || !row.encryption_nonce) {
        throw new DocumentError('missing_bytes', 'this document has no encryption envelope');
      }

      const key = await dataKeyById(tx, row.data_key_id);
      if (!key) throw new DocumentError('missing_bytes', 'the key this document was sealed with is gone');

      const dek = await this.deps.dekCache.get({
        dataKeyId: key.id,
        wrappedDek: key.wrappedDek,
        kekId: key.kekId,
        context: key.wrapContext,
      });

      const bytes = openDocument(
        dek,
        body,
        row.encryption_nonce,
        documentBinding(actor.tenantId, row.attachment_id),
      );

      return {
        refused: false as const,
        opened: {
          id: row.attachment_id,
          filename: row.filename ?? 'document',
          contentType: row.content_type ?? 'application/octet-stream',
          bytes,
          auditEventUid: row.audit_event_uid,
        },
      };
    });

    if (result.refused) throw new DocumentError('not_found', 'no such document');
    return result.opened;
  }

  /**
   * Permanently delete an archived document.
   *
   * The database decides — archive-first and asset:delete are both enforced in
   * helm.delete_document(), which also writes the audit row naming what was
   * destroyed. The bytes go AFTER the transaction commits: unlinking first
   * would destroy a file that a rollback then un-deletes.
   */
  async remove(actor: ActorRef, attachmentId: string): Promise<void> {
    const result = await withTenant(actor, async (tx) => {
      const [row] = await tx<
        {
          result: {
            deleted: boolean;
            reason?: 'not_found' | 'forbidden' | 'not_archived';
            message?: string;
            storage_key?: string;
          };
        }[]
      >`
        SELECT helm.delete_document(${attachmentId}::uuid) AS result
      `;
      if (!row) throw new DocumentError('not_found', 'no such document');
      return row.result;
    });

    // The refusal already wrote its own audit row inside the transaction above,
    // which is the reason the function returns one instead of raising.
    if (!result.deleted) {
      const reason = result.reason ?? 'not_found';
      throw new DocumentError(
        reason,
        result.message ?? (reason === 'not_found' ? 'no such document' : 'that is not permitted'),
      );
    }
    if (!result.storage_key) return;

    // Best effort. A file left behind is disk, not exposure — the row naming it
    // is gone and the bytes are ciphertext under a key this host cannot read on
    // its own. Failing the request here would report a deletion that DID happen
    // as a failure, which is worse.
    await this.storage.remove(result.storage_key).catch(() => {});
  }
}

async function sha256Of(bytes: Buffer): Promise<Buffer> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(bytes).digest();
}

/** Turn the constraint that fired into something a person can act on. */
function translateWriteError(cause: unknown): unknown {
  const code = (cause as { code?: string } | null)?.code;
  const constraint = (cause as { constraint_name?: string } | null)?.constraint_name;

  if (code === '23505' && constraint === 'attachment_document_name_uk') {
    return new DocumentError(
      'name_taken',
      'a document with that name is already in this folder. Documents are not ' +
        'versioned: rename this one, or archive the existing file first.',
      { cause },
    );
  }
  if (code === '23503') {
    return new DocumentError('no_such_folder', 'no such folder in this client', { cause });
  }
  return cause;
}
