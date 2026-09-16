/**
 * Tenant data key lifecycle.
 *
 * Runs as `helm_key_admin`, which is the only role permitted to write
 * tenant_data_key. Deliberately a separate module from SecretService: the
 * request path reads wrapped keys and must never be able to mint or retire one.
 *
 * Rotation is a three-phase state machine rather than a swap, because a swap
 * would strand every ciphertext encrypted under the old key:
 *
 *   pending  -> just minted, not yet accepting writes
 *   active   -> encrypts all new material (exactly one per tenant, by index)
 *   retiring -> still decrypts history, refuses new writes
 *   retired  -> no ciphertext references it any more
 *   destroyed-> key material shredded at the KEK; ciphertext is unrecoverable
 *
 * `helm.write_secret_version()` refuses any key that is not `active`, so a
 * retiring key cannot accumulate more ciphertext and the re-encryption backlog
 * actually converges.
 */
import type { HelmTx } from '../db/client';
import { withTenant, withoutTenantContext } from '../db/client';
import { HelmCryptoError } from '../crypto/errors';
import {
  supportsRewrap,
  tenantKeyContext,
  type EncryptionContext,
  type KekProvider,
} from '../crypto/kek';
import { wipe } from '../crypto/envelope';
import { NoActiveDataKeyError } from './errors';

export interface DataKeyRow {
  id: string;
  generation: number;
  status: 'pending' | 'active' | 'retiring' | 'retired' | 'destroyed';
  wrappedDek: Buffer;
  kekId: string;
  wrapProvider: string;
  wrapContext: EncryptionContext;
}

interface RawDataKeyRow {
  id: string;
  generation: number;
  status: DataKeyRow['status'];
  wrapped_dek: Buffer;
  kek_id: string;
  wrap_provider: string;
  wrap_context: Record<string, string>;
}

function toDataKey(row: RawDataKeyRow): DataKeyRow {
  return {
    id: row.id,
    generation: row.generation,
    status: row.status,
    wrappedDek: row.wrapped_dek,
    kekId: row.kek_id,
    wrapProvider: row.wrap_provider,
    wrapContext: row.wrap_context,
  };
}

/**
 * Read the tenant's active key.
 *
 * Uses the caller's existing transaction so the key read and the secret write
 * share one snapshot — otherwise a rotation landing between the two would have
 * the write rejected by write_secret_version's `active` check, intermittently
 * and confusingly.
 */
export async function activeDataKey(tx: HelmTx, tenantId: string): Promise<DataKeyRow> {
  const [row] = await tx<RawDataKeyRow[]>`
    SELECT id, generation, status, wrapped_dek, kek_id, wrap_provider, wrap_context
    FROM tenant_data_key
    WHERE status = 'active'
  `;
  if (!row) throw new NoActiveDataKeyError(tenantId);
  return toDataKey(row);
}

/** Read a specific key, including retiring ones, so old versions stay readable. */
export async function dataKeyById(tx: HelmTx, dataKeyId: string): Promise<DataKeyRow | null> {
  const [row] = await tx<RawDataKeyRow[]>`
    SELECT id, generation, status, wrapped_dek, kek_id, wrap_provider, wrap_context
    FROM tenant_data_key
    WHERE id = ${dataKeyId}::uuid
  `;
  return row ? toDataKey(row) : null;
}

export class TenantKeyService {
  constructor(private readonly kek: KekProvider) {}

  /**
   * Mint the tenant's first key, or the next generation.
   *
   * The plaintext DEK is used only to produce the wrapped form and is wiped
   * before returning. Nothing outside the KEK provider ever sees it, and the
   * caller has no way to ask for it.
   */
  async provision(
    tenantId: string,
    actorId: string,
    options: { activate?: boolean; reason?: string } = {},
  ): Promise<DataKeyRow> {
    return withTenant(
      { tenantId, actorId },
      async (tx) => {
        const [generationRow] = await tx<{ next: number }[]>`
          SELECT coalesce(max(generation), 0) + 1 AS next FROM tenant_data_key
        `;
        const next = generationRow?.next ?? 1;

        const context = tenantKeyContext(tenantId, next);
        const generated = await this.kek.generateDek(context);

        try {
          const [row] = await tx<RawDataKeyRow[]>`
            INSERT INTO tenant_data_key (
              tenant_id, generation, status, wrapped_dek,
              wrap_provider, kek_id, wrap_context, created_by, rotation_reason,
              activated_at
            )
            VALUES (
              ${tenantId}::uuid, ${next},
              ${options.activate === false ? 'pending' : 'active'}::data_key_status,
              ${generated.wrapped},
              ${this.kek.provider}, ${generated.kekId},
              ${tx.json(context as Record<string, string>)}::jsonb,
              ${actorId}::uuid, ${options.reason ?? null},
              ${options.activate === false ? null : new Date()}
            )
            RETURNING id, generation, status, wrapped_dek, kek_id, wrap_provider, wrap_context
          `;
          if (!row) throw new HelmCryptoError('kek_unavailable', 'data key insert returned no row');

          await tx`
            SELECT helm.audit(
              'key.provisioned', 'tenant_data_key', ${row.id}::uuid, 'success',
              NULL, NULL, ${options.reason ?? null},
              ${tx.json({ generation: next, kek_id: generated.kekId, provider: this.kek.provider })}::jsonb
            )
          `;

          return toDataKey(row);
        } finally {
          // The wrapped copy is what persists; the plaintext has no further use.
          wipe(generated.plaintext);
        }
      },
      { role: 'keyAdmin' },
    );
  }

  /**
   * Begin a rotation: mint a new active key and move the old one to `retiring`.
   *
   * New writes immediately use the new key. Existing ciphertext keeps working
   * because the retiring key still decrypts. Call `reEncryptBacklog()` until it
   * reports zero, then `retire()`.
   */
  async beginRotation(
    tenantId: string,
    actorId: string,
    reason: string,
  ): Promise<{ previous: DataKeyRow | null; current: DataKeyRow }> {
    return withTenant(
      { tenantId, actorId },
      async (tx) => {
        const [previousRow] = await tx<RawDataKeyRow[]>`
          SELECT id, generation, status, wrapped_dek, kek_id, wrap_provider, wrap_context
          FROM tenant_data_key WHERE status = 'active' FOR UPDATE
        `;

        // Demote first: the partial unique index permits only one active key
        // per tenant, so inserting the new one before demoting would fail.
        if (previousRow) {
          await tx`
            UPDATE tenant_data_key
            SET status = 'retiring', retiring_at = now()
            WHERE id = ${previousRow.id}::uuid
          `;
        }

        const [generationRow] = await tx<{ next: number }[]>`
          SELECT coalesce(max(generation), 0) + 1 AS next FROM tenant_data_key
        `;
        const next = generationRow?.next ?? 1;
        const context = tenantKeyContext(tenantId, next);
        const generated = await this.kek.generateDek(context);

        try {
          const [row] = await tx<RawDataKeyRow[]>`
            INSERT INTO tenant_data_key (
              tenant_id, generation, status, wrapped_dek,
              wrap_provider, kek_id, wrap_context, created_by, rotation_reason, activated_at
            )
            VALUES (
              ${tenantId}::uuid, ${next}, 'active', ${generated.wrapped},
              ${this.kek.provider}, ${generated.kekId},
              ${tx.json(context as Record<string, string>)}::jsonb,
              ${actorId}::uuid, ${reason}, now()
            )
            RETURNING id, generation, status, wrapped_dek, kek_id, wrap_provider, wrap_context
          `;
          if (!row) throw new HelmCryptoError('kek_unavailable', 'rotation insert returned no row');

          await tx`
            SELECT helm.audit(
              'key.rotation_started', 'tenant_data_key', ${row.id}::uuid, 'success',
              NULL, NULL, ${reason},
              ${tx.json({
                generation: next,
                previous_key_id: previousRow?.id ?? null,
                kek_id: generated.kekId,
              })}::jsonb
            )
          `;

          return {
            previous: previousRow ? toDataKey(previousRow) : null,
            current: toDataKey(row),
          };
        } finally {
          wipe(generated.plaintext);
        }
      },
      { role: 'keyAdmin' },
    );
  }

  /**
   * How much ciphertext still depends on non-active keys.
   *
   * Goes through helm.rotation_backlog() rather than querying secret_version
   * directly, because no role — including this one — can read that table. The
   * function returns counts only and never ciphertext, which is what lets the
   * rotation worker see its own progress without being handed a read capability
   * on the vault.
   */
  async rotationBacklog(tenantId: string, actorId: string): Promise<RotationBacklogEntry[]> {
    return withTenant(
      { tenantId, actorId },
      async (tx) => {
        const rows = await tx<
          { data_key_id: string; generation: number; status: DataKeyRow['status']; secret_count: string }[]
        >`SELECT * FROM helm.rotation_backlog()`;

        return rows.map((r) => ({
          dataKeyId: r.data_key_id,
          generation: r.generation,
          status: r.status,
          secretCount: Number(r.secret_count),
        }));
      },
      { role: 'keyAdmin' },
    );
  }

  /**
   * The next batch of secrets to re-encrypt under the current active key.
   *
   * Ordered most-sensitive first, so a rotation interrupted halfway has moved
   * the credentials that matter most.
   */
  async pendingReEncryption(
    tenantId: string,
    actorId: string,
    limit = 100,
  ): Promise<PendingReEncryption[]> {
    return withTenant(
      { tenantId, actorId },
      async (tx) => {
        const rows = await tx<
          {
            secret_id: string;
            organization_id: string;
            version: number;
            data_key_id: string;
            sensitivity: 'standard' | 'elevated' | 'critical';
            requires_step_up: boolean;
          }[]
        >`SELECT * FROM helm.secrets_pending_reencryption(${limit})`;

        return rows.map((r) => ({
          secretId: r.secret_id,
          organizationId: r.organization_id,
          version: r.version,
          dataKeyId: r.data_key_id,
          sensitivity: r.sensitivity,
          requiresStepUp: r.requires_step_up,
        }));
      },
      { role: 'keyAdmin' },
    );
  }

  /**
   * Move every one of a tenant's DEKs onto the current KEK version.
   *
   * This is MASTER key rotation, which is not the same operation as data key
   * rotation and is much cheaper: the DEK does not change, so no field
   * ciphertext is touched. One UPDATE per tenant key, and the secrets are
   * untouched and readable throughout.
   *
   * Idempotent by construction — a key already on the current version is
   * skipped — so a rotation interrupted halfway is resumed by running it again.
   *
   * Destroyed keys are excluded: their material is gone at the KEK and
   * re-wrapping is neither possible nor meaningful. Retired and retiring keys
   * ARE included, because history must stay readable, and because an old KEK
   * version cannot be retired from the key ring until nothing references it.
   */
  async rewrapUnderCurrentKek(
    tenantId: string,
    actorId: string,
    reason: string,
  ): Promise<KekRewrapResult> {
    const kek = this.kek;
    if (!supportsRewrap(kek)) {
      throw new HelmCryptoError(
        'kek_unavailable',
        `the ${kek.provider} provider cannot re-wrap an existing DEK, so the master key ` +
          'cannot be rotated without re-encrypting every secret',
      );
    }

    return withTenant(
      { tenantId, actorId },
      async (tx) => {
        const rows = await tx<RawDataKeyRow[]>`
          SELECT id, generation, status, wrapped_dek, kek_id, wrap_provider, wrap_context
          FROM tenant_data_key
          WHERE status <> 'destroyed'
          ORDER BY generation
          FOR UPDATE
        `;

        const result: KekRewrapResult = { tenantId, rewrapped: 0, unchanged: 0, failed: [] };

        for (const row of rows) {
          // Re-derive the context rather than trusting the stored copy: it is
          // the AAD the original wrap used, and a row whose stored context had
          // drifted would fail to unwrap here rather than being silently
          // re-wrapped under the wrong binding.
          const context = tenantKeyContext(tenantId, row.generation);

          let next;
          try {
            next = await kek.rewrapDek(row.wrapped_dek, row.kek_id, context);
          } catch (error) {
            result.failed.push({
              generation: row.generation,
              kekId: row.kek_id,
              reason: error instanceof Error ? error.message : 'unknown failure',
            });
            continue;
          }

          if (next.kekId === row.kek_id) {
            result.unchanged += 1;
            continue;
          }

          await tx`
            UPDATE tenant_data_key
            SET wrapped_dek = ${next.wrapped}, kek_id = ${next.kekId}
            WHERE id = ${row.id}::uuid
          `;

          await tx`
            SELECT helm.audit(
              'key.kek_rewrapped', 'tenant_data_key', ${row.id}::uuid, 'success',
              NULL, NULL, ${reason},
              ${tx.json({
                generation: row.generation,
                from_kek_id: row.kek_id,
                to_kek_id: next.kekId,
                provider: kek.provider,
              })}::jsonb
            )
          `;
          result.rewrapped += 1;
        }

        // A partial failure is recorded too. The operator needs to know a key
        // was left behind BEFORE they delete the old master key version, and a
        // log line on a machine nobody reads is not that record.
        if (result.failed.length > 0) {
          await tx`
            SELECT helm.audit(
              'key.kek_rewrap_incomplete', 'tenant', ${tenantId}::uuid, 'error',
              NULL, NULL, ${reason},
              ${tx.json({ failed: result.failed, rewrapped: result.rewrapped })}::jsonb
            )
          `;
        }

        return result;
      },
      { role: 'keyAdmin' },
    );
  }

  /**
   * Tenants this key admin is responsible for, with their key custody.
   *
   * Goes through helm.tenants_with_keys(), the one narrowly-granted bypass that
   * exists so the rotation job can enumerate tenants without holding BYPASSRLS.
   */
  async tenantsWithKeys(): Promise<TenantKeyCustody[]> {
    return withoutTenantContext(
      async (sql) => {
        const rows = await sql<
          { tenant_id: string; name: string; status: string; key_count: string; host_held: string }[]
        >`SELECT * FROM helm.tenants_with_keys()`;

        return rows.map((r) => ({
          tenantId: r.tenant_id,
          name: r.name,
          status: r.status,
          keyCount: Number(r.key_count),
          hostHeldKeys: Number(r.host_held),
        }));
      },
      { role: 'keyAdmin' },
    );
  }

  /**
   * Finish a rotation. Refused by the database while live ciphertext still
   * depends on the key, so a worker running stale code cannot strand data.
   */
  async retire(tenantId: string, actorId: string, dataKeyId: string): Promise<boolean> {
    return withTenant(
      { tenantId, actorId },
      async (tx) => {
        const [row] = await tx<{ retired: boolean }[]>`
          SELECT helm.retire_data_key(${dataKeyId}::uuid) AS retired
        `;
        return row?.retired ?? false;
      },
      { role: 'keyAdmin' },
    );
  }
}

export interface KekRewrapResult {
  tenantId: string;
  /** Keys that moved onto the current KEK version. */
  rewrapped: number;
  /** Keys already on it — a re-run of a completed rotation moves nothing. */
  unchanged: number;
  /** Keys whose old KEK version this process no longer holds. */
  failed: { generation: number; kekId: string; reason: string }[];
}

export interface RotationBacklogEntry {
  dataKeyId: string;
  generation: number;
  status: DataKeyRow['status'];
  secretCount: number;
}

export interface PendingReEncryption {
  secretId: string;
  organizationId: string;
  version: number;
  dataKeyId: string;
  sensitivity: 'standard' | 'elevated' | 'critical';
  requiresStepUp: boolean;
}

export interface TenantKeyCustody {
  tenantId: string;
  name: string;
  status: string;
  keyCount: number;
  hostHeldKeys: number;
}
