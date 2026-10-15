/**
 * A client's logo: storing it, serving it, replacing it, removing it.
 *
 * REUSES THE DOCUMENT STORAGE AND THE DOCUMENT CRYPTO, which is what the plan
 * asked for and is the whole reason this file is short. `getDocumentStorage()`
 * already writes opaque, unguessable, 0600 files under a root it refuses to
 * escape, and sealDocument()/openDocument() already bind ciphertext to a tenant
 * and a row id. One place writes bytes to disk; one place encrypts them.
 *
 * BUT NOT THE `attachment` TABLE — see 0680's header. A logo is chrome rather
 * than documentation: as an attachment it would appear in the client's document
 * tree, be deletable by anybody holding asset:write, and be rendered into an
 * export bundle as a file the client never attached. It has its own table with
 * organization_id as the primary key, so "one logo per client" is a fact about
 * the schema rather than a route that remembers to delete the old row.
 *
 * THE BINDING NAMES THE FIELD 'logo', not 'document'. documentBinding() would
 * produce the same AAD for an attachment id and an organisation id, and the two
 * id spaces are different tables — so a logo's ciphertext would be
 * interchangeable with the ciphertext of an attachment that happened to share
 * an id. Distinct fields make that structurally impossible rather than
 * improbable.
 *
 * IT IS ENCRYPTED, even though a logo is usually on the client's own website.
 * The bytes are not the secret; the SET of clients an MSP has is, and an
 * unencrypted logo file sitting in a backup says one of their names out loud to
 * anybody who opens it.
 *
 * SVG IS REFUSED HERE AND IN A CHECK CONSTRAINT. An SVG served from Helm's
 * origin can carry <script> and run with the reader's session. "It is only a
 * logo" is how that gets waved through, so the refusal is in both places and
 * the route says why.
 */
import { createHash } from 'node:crypto';
import { withTenant } from '../db/client';
import type { ActorRef } from '../secrets/service';
import { activeDataKey, dataKeyById } from '../secrets/keys';
import { getDekCache } from '../services';
import { getDocumentStorage } from '../documents/storage';
import type { ExportStorage } from '../exports/storage';
import { openDocument, sealDocument } from '../documents/crypto';
import type { SecretBinding } from '../crypto/envelope';
import { MAX_LOGO_BYTES, type LogoContentType } from './limits';

/*
 * The limits live in ./limits.ts, which imports nothing — the upload control is
 * a client component and importing them from here would pull node:crypto and
 * the database client into the browser bundle. Re-exported so a server-side
 * caller needs one import.
 */
export {
  LOGO_CONTENT_TYPES, MAX_LOGO_BYTES, type LogoContentType,
} from './limits';

export class LogoError extends Error {
  readonly code: 'too_large' | 'empty' | 'unsupported_type' | 'not_found' | 'refused';

  constructor(code: LogoError['code'], message: string) {
    super(message);
    this.name = 'LogoError';
    this.code = code;
  }
}

export interface StoredLogo {
  organizationId: string;
  contentType: string;
  byteSize: number;
  /** Lower-case hex of the plaintext. The ETag. */
  sha256: string;
  uploadedAt: string;
}

function logoBinding(tenantId: string, organizationId: string): SecretBinding {
  return { tenantId, secretId: organizationId, field: 'logo', version: 1 };
}

/**
 * Whether these bytes really are the image type they claim to be.
 *
 * THE DECLARED CONTENT TYPE IS A CLAIM BY THE BROWSER and the document upload
 * route says so at length: it stores the claim and never trusts it, leaving the
 * download route to decide what a browser may do with the bytes. A logo cannot
 * take that approach, because its whole job is to be rendered inline by an
 * <img> — so the bytes are sniffed here and a mismatch is refused.
 *
 * Magic numbers only, and only for the four permitted types. This is not a
 * general-purpose image validator and does not pretend to be: it answers "could
 * this be mistaken for something a browser would execute", and a file whose
 * first bytes are a PNG signature cannot be.
 */
export function sniffImageType(bytes: Buffer): LogoContentType | null {
  if (bytes.length < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  // GIF: "GIF87a" or "GIF89a"
  if (bytes.subarray(0, 6).toString('latin1').match(/^GIF8[79]a$/)) return 'image/gif';
  // WebP: "RIFF" .... "WEBP"
  if (
    bytes.subarray(0, 4).toString('latin1') === 'RIFF'
    && bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export class LogoService {
  /**
   * Storage is injected, exactly as DocumentService takes it, so a test can
   * point this at a temp directory and then read the file off disk to check
   * that what landed there is ciphertext. Reaching for the singleton in a field
   * initialiser would bind it at construction, before a test could override it.
   */
  private readonly storage: ExportStorage;

  constructor(deps: { storage?: ExportStorage } = {}) {
    this.storage = deps.storage ?? getDocumentStorage();
  }

  /**
   * Store or replace a client's logo.
   *
   * REPLACEMENT DELETES THE OLD BYTES, and the order matters: the row is
   * updated first and the old file removed afterwards, so a crash between the
   * two leaves an orphaned file rather than a row pointing at nothing. An
   * orphan wastes a few kilobytes; a dangling row renders a broken image on
   * every page that lists clients.
   */
  async put(
    actor: ActorRef,
    input: { organizationId: string; contentType: string; bytes: Buffer },
  ): Promise<StoredLogo> {
    if (input.bytes.length === 0) throw new LogoError('empty', 'the file is empty');
    if (input.bytes.length > MAX_LOGO_BYTES) {
      throw new LogoError(
        'too_large',
        `a logo must be ${Math.floor(MAX_LOGO_BYTES / 1024)} KB or smaller`,
      );
    }

    const sniffed = sniffImageType(input.bytes);
    if (sniffed === null) {
      throw new LogoError(
        'unsupported_type',
        'that is not a PNG, JPEG, WebP or GIF image. An SVG cannot be used as a '
        + 'logo: served from this origin it could run script with your session.',
      );
    }
    if (input.contentType !== sniffed) {
      // Not an error worth refusing over — a browser sending image/jpg for a
      // JPEG is ordinary — but the SNIFFED type is what gets stored and served,
      // so the Content-Type a reader receives always describes the bytes.
      input.contentType = sniffed;
    }

    const sha256 = createHash('sha256').update(input.bytes).digest();

    const sealed = await withTenant(actor, async (tx) => {
      const key = await activeDataKey(tx, actor.tenantId);
      const dek = await getDekCache().get({
        dataKeyId: key.id,
        wrappedDek: key.wrappedDek,
        kekId: key.kekId,
        context: key.wrapContext,
      });
      return {
        dataKeyId: key.id,
        ...sealDocument(dek, input.bytes, logoBinding(actor.tenantId, input.organizationId)),
      };
    });

    const storageKey = await this.storage.put(sealed.body);

    let replaced: string | null = null;
    try {
      const row = await withTenant(actor, async (tx) => {
        const [inserted] = await tx<{
          content_type: string; byte_size: string; uploaded_at: Date; previous: string | null;
        }[]>`
          WITH prior AS (
            SELECT storage_key FROM organization_logo
            WHERE organization_id = ${input.organizationId}::uuid
          ), upserted AS (
            INSERT INTO organization_logo (
              organization_id, tenant_id, content_type, byte_size, storage_key,
              content_sha256, data_key_id, encryption_nonce, uploaded_by
            )
            VALUES (
              ${input.organizationId}::uuid, ${actor.tenantId}::uuid,
              ${input.contentType}, ${input.bytes.length}, ${storageKey},
              ${sha256}, ${sealed.dataKeyId}::uuid, ${sealed.nonce},
              ${actor.actorId}::uuid
            )
            ON CONFLICT (organization_id) DO UPDATE SET
              content_type = EXCLUDED.content_type,
              byte_size = EXCLUDED.byte_size,
              storage_key = EXCLUDED.storage_key,
              content_sha256 = EXCLUDED.content_sha256,
              data_key_id = EXCLUDED.data_key_id,
              encryption_nonce = EXCLUDED.encryption_nonce,
              uploaded_at = now(),
              uploaded_by = EXCLUDED.uploaded_by
            RETURNING content_type, byte_size, uploaded_at
          )
          SELECT u.content_type, u.byte_size, u.uploaded_at,
                 (SELECT storage_key FROM prior) AS previous
          FROM upserted u
        `;
        if (!inserted) {
          // RLS declined, which it does by writing nothing rather than raising.
          throw new LogoError('refused', 'you may not change this client');
        }

        await tx`
          SELECT helm.audit(
            'organization.logo_set', 'organization', ${input.organizationId}::uuid,
            'success', ${input.organizationId}::uuid, NULL, NULL,
            ${tx.json({
              contentType: input.contentType,
              byteSize: input.bytes.length,
              replaced: inserted.previous !== null,
            })}::jsonb
          )
        `;
        return inserted;
      });

      replaced = row.previous;
      return {
        organizationId: input.organizationId,
        contentType: row.content_type,
        byteSize: Number(row.byte_size),
        sha256: sha256.toString('hex'),
        uploadedAt: row.uploaded_at.toISOString(),
      };
    } catch (cause) {
      // The row was refused, so these bytes belong to nothing.
      await this.storage.remove(storageKey).catch(() => {});
      throw cause;
    } finally {
      sealed.body.fill(0);
      sealed.nonce.fill(0);
      // Only once the row is committed, and only the file it replaced.
      if (replaced) await this.storage.remove(replaced).catch(() => {});
    }
  }

  /**
   * The bytes, decrypted, with what the route needs to serve them.
   *
   * Returns null rather than throwing when there is no logo or the reader
   * cannot see the client: both are "no image here", the route answers 404 for
   * each, and distinguishing them in the response would tell an outsider which
   * organisation ids exist.
   */
  async open(
    actor: ActorRef,
    organizationId: string,
  ): Promise<{ bytes: Buffer; contentType: string; sha256: string } | null> {
    const row = await withTenant(actor, async (tx) => {
      const [found] = await tx<{
        content_type: string; storage_key: string; content_sha256: Buffer;
        data_key_id: string | null; encryption_nonce: Buffer | null;
      }[]>`
        SELECT content_type, storage_key, content_sha256, data_key_id, encryption_nonce
        FROM organization_logo
        WHERE organization_id = ${organizationId}::uuid
      `;
      if (!found) return null;

      if (found.data_key_id === null || found.encryption_nonce === null) {
        // The pairing CHECK makes this unreachable; treated as corruption
        // rather than as plaintext, because guessing wrong means serving
        // ciphertext to a browser as an image.
        throw new LogoError('not_found', 'the stored logo is unreadable');
      }

      /*
       * dataKeyById, NOT activeDataKey. The row names the key that sealed it,
       * and after a rotation that is not the active one — reading with the
       * active key would fail authentication on every logo uploaded before the
       * rotation, which is a broken image on every client page and no error
       * anybody would connect to key management. The type checker caught this:
       * activeDataKey takes no key id.
       */
      const key = await dataKeyById(tx, found.data_key_id);
      if (!key) throw new LogoError('not_found', 'the key this logo was sealed with is gone');
      const dek = await getDekCache().get({
        dataKeyId: key.id,
        wrappedDek: key.wrappedDek,
        kekId: key.kekId,
        context: key.wrapContext,
      });
      return {
        contentType: found.content_type,
        storageKey: found.storage_key,
        sha256: found.content_sha256.toString('hex'),
        nonce: found.encryption_nonce,
        dek,
      };
    });
    if (!row) return null;

    const body = await this.storage.get(row.storageKey);
    const bytes = openDocument(
      row.dek, body, row.nonce, logoBinding(actor.tenantId, organizationId),
    );
    return { bytes, contentType: row.contentType, sha256: row.sha256 };
  }

  /** Remove it, bytes and all. Returns false if there was nothing to remove. */
  async remove(actor: ActorRef, organizationId: string): Promise<boolean> {
    const storageKey = await withTenant(actor, async (tx) => {
      const [row] = await tx<{ storage_key: string }[]>`
        DELETE FROM organization_logo
        WHERE organization_id = ${organizationId}::uuid
        RETURNING storage_key
      `;
      if (!row) return null;
      await tx`
        SELECT helm.audit(
          'organization.logo_removed', 'organization', ${organizationId}::uuid,
          'success', ${organizationId}::uuid, NULL, NULL, NULL
        )
      `;
      return row.storage_key;
    });
    if (!storageKey) return false;

    // After the row is gone: an orphaned file is waste, a row pointing at a
    // deleted file is a broken image on every client list.
    await this.storage.remove(storageKey).catch(() => {});
    return true;
  }
}

let service: LogoService | null = null;

export function getLogoService(): LogoService {
  if (!service) service = new LogoService();
  return service;
}


