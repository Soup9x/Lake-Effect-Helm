/**
 * A member's profile picture (1040): storing it, serving it, replacing it,
 * removing it.
 *
 * THE CLIENT LOGO'S MACHINERY, reused rather than copied: the same document
 * storage (opaque, 0600, under a root it will not escape), the same sealing
 * under the tenant data key, the same magic-number sniff that refuses anything
 * but four raster formats. What differs is whose it is — the policy lets only
 * the person write their own row — and the binding's field, 'avatar', so a
 * picture's ciphertext can never be opened as a logo or a document that
 * happens to share an id.
 *
 * NO AUDIT ROW. A logo change is a change to how a client looks to everybody
 * working on it; a person changing their own picture is not an event anybody
 * investigates, and recording each one would put noise in the chain that the
 * things that matter are read against.
 */
import { createHash } from 'node:crypto';
import { withTenant, type HelmTx } from '../db/client';
import type { ActorRef } from '../secrets/service';
import { activeDataKey, dataKeyById } from '../secrets/keys';
import { getDekCache } from '../services';
import { getDocumentStorage } from '../documents/storage';
import type { ExportStorage } from '../exports/storage';
import { openDocument, sealDocument } from '../documents/crypto';
import type { SecretBinding } from '../crypto/envelope';
import { LogoError, MAX_LOGO_BYTES, sniffImageType } from '../logos/service';

/** Reused as is: the same four codes mean the same four things. */
export { LogoError as AvatarError };

function avatarBinding(tenantId: string, userId: string): SecretBinding {
  return { tenantId, secretId: userId, field: 'avatar', version: 1 };
}

/**
 * Where a member's picture is served from, with its hash as the version: the
 * URL changes exactly when the bytes do, so a browser never shows a stale one.
 */
export function avatarUrl(userId: string, sha256Hex: string): string {
  return `/api/users/${userId}/avatar?v=${sha256Hex.slice(0, 16)}`;
}

/** Each listed member's picture URL, for a page that shows several people. */
export async function avatarUrls(tx: HelmTx, userIds?: readonly string[]): Promise<Map<string, string>> {
  const rows = userIds
    ? await tx<{ user_id: string; sha: string }[]>`
        SELECT user_id, encode(content_sha256, 'hex') AS sha FROM member_avatar
        WHERE user_id = ANY(${userIds as string[]}::uuid[])
      `
    : await tx<{ user_id: string; sha: string }[]>`
        SELECT user_id, encode(content_sha256, 'hex') AS sha FROM member_avatar
      `;
  return new Map(rows.map((r) => [r.user_id, avatarUrl(r.user_id, r.sha)]));
}

export class AvatarService {
  private readonly storage: ExportStorage;

  constructor(deps: { storage?: ExportStorage } = {}) {
    this.storage = deps.storage ?? getDocumentStorage();
  }

  /**
   * Set or replace the acting person's own picture. The row is written first
   * and the old file removed after, as for a logo: a crash between the two
   * leaves an orphaned file, never a row pointing at nothing.
   */
  async put(actor: ActorRef, input: { contentType: string; bytes: Buffer }): Promise<{ url: string }> {
    // Said here as well as by the policy, whose answer to an INSERT is an RLS
    // error rather than a refusal anybody could read.
    if (actor.actorType === 'service_account') throw notAPerson();
    if (input.bytes.length === 0) throw new LogoError('empty', 'the file is empty');
    if (input.bytes.length > MAX_LOGO_BYTES) {
      throw new LogoError('too_large', `a picture must be ${Math.floor(MAX_LOGO_BYTES / 1024)} KB or smaller`);
    }
    const contentType = sniffImageType(input.bytes);
    if (contentType === null) {
      throw new LogoError(
        'unsupported_type',
        'that is not a PNG, JPEG, WebP or GIF image. An SVG cannot be used: served from this '
        + 'address it could run script with your session.',
      );
    }
    const sha256 = createHash('sha256').update(input.bytes).digest();
    const userId = actor.actorId;

    const sealed = await withTenant(actor, async (tx) => {
      const key = await activeDataKey(tx, actor.tenantId);
      const dek = await getDekCache().get({
        dataKeyId: key.id, wrappedDek: key.wrappedDek, kekId: key.kekId, context: key.wrapContext,
      });
      return { dataKeyId: key.id, ...sealDocument(dek, input.bytes, avatarBinding(actor.tenantId, userId)) };
    });

    const storageKey = await this.storage.put(sealed.body);
    let replaced: string | null = null;
    try {
      replaced = await withTenant(actor, async (tx) => {
        const [row] = await tx<{ previous: string | null }[]>`
          WITH prior AS (
            SELECT storage_key FROM member_avatar WHERE user_id = ${userId}::uuid
          ), upserted AS (
            INSERT INTO member_avatar (
              tenant_id, user_id, content_type, byte_size, storage_key,
              content_sha256, data_key_id, encryption_nonce
            )
            VALUES (
              ${actor.tenantId}::uuid, ${userId}::uuid, ${contentType}, ${input.bytes.length},
              ${storageKey}, ${sha256}, ${sealed.dataKeyId}::uuid, ${sealed.nonce}
            )
            ON CONFLICT (tenant_id, user_id) DO UPDATE SET
              content_type = EXCLUDED.content_type,
              byte_size = EXCLUDED.byte_size,
              storage_key = EXCLUDED.storage_key,
              content_sha256 = EXCLUDED.content_sha256,
              data_key_id = EXCLUDED.data_key_id,
              encryption_nonce = EXCLUDED.encryption_nonce,
              uploaded_at = now()
            RETURNING 1
          )
          SELECT (SELECT storage_key FROM prior) AS previous FROM upserted
        `;
        if (!row) throw notAPerson();
        return row.previous;
      });
      return { url: avatarUrl(userId, sha256.toString('hex')) };
    } catch (cause) {
      await this.storage.remove(storageKey).catch(() => {});
      throw cause;
    } finally {
      sealed.body.fill(0);
      sealed.nonce.fill(0);
      if (replaced) await this.storage.remove(replaced).catch(() => {});
    }
  }

  /** A member's picture, decrypted. Null when they have none or are not in this tenant. */
  async open(
    actor: ActorRef,
    userId: string,
  ): Promise<{ bytes: Buffer; contentType: string; sha256: string } | null> {
    const row = await withTenant(actor, async (tx) => {
      const [found] = await tx<{
        content_type: string; storage_key: string; content_sha256: Buffer;
        data_key_id: string; encryption_nonce: Buffer;
      }[]>`
        SELECT content_type, storage_key, content_sha256, data_key_id, encryption_nonce
        FROM member_avatar WHERE user_id = ${userId}::uuid
      `;
      if (!found) return null;
      // The key that sealed it, which after a rotation is not the active one.
      const key = await dataKeyById(tx, found.data_key_id);
      if (!key) throw new LogoError('not_found', 'the key this picture was sealed with is gone');
      const dek = await getDekCache().get({
        dataKeyId: key.id, wrappedDek: key.wrappedDek, kekId: key.kekId, context: key.wrapContext,
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
    const bytes = openDocument(row.dek, body, row.nonce, avatarBinding(actor.tenantId, userId));
    return { bytes, contentType: row.contentType, sha256: row.sha256 };
  }

  /** Remove the acting person's own picture. False when there was none. */
  async remove(actor: ActorRef): Promise<boolean> {
    const storageKey = await withTenant(actor, async (tx) => {
      const [row] = await tx<{ storage_key: string }[]>`
        DELETE FROM member_avatar WHERE user_id = ${actor.actorId}::uuid RETURNING storage_key
      `;
      return row?.storage_key ?? null;
    });
    if (!storageKey) return false;
    await this.storage.remove(storageKey).catch(() => {});
    return true;
  }
}

function notAPerson(): LogoError {
  return new LogoError('refused', 'only a person signed in as themselves can set their picture');
}

let service: AvatarService | null = null;

export function getAvatarService(): AvatarService {
  if (!service) service = new AvatarService();
  return service;
}
