/**
 * The secret engine.
 *
 * Every method here is a thin, careful shell around the SQL API in
 * db/sql/0210_secret_access_api.sql. That split is deliberate and is the whole
 * security argument:
 *
 *   * The DATABASE decides whether access is allowed and records it. Authorisation
 *     and the audit write happen in one transaction that this code cannot split.
 *   * This code does the CRYPTOGRAPHY the database must never see — unwrapping
 *     the DEK against KMS and running AES-256-GCM.
 *
 * So a bug in this file can fail to decrypt, but it cannot hand out a secret
 * without an audit row, cannot bypass the role/step-up/reason ladder, and cannot
 * reach another tenant's material. Those properties live in Postgres.
 */
import type { RevealDenialReason, RevealPurpose } from '@db/schema/secrets';
import type { DbRole, HelmTx } from '../db/client';
import { withTenant } from '../db/client';
import type { DekCache } from '../crypto/dek-cache';
import { openField, sealField, wipe, type SecretBinding } from '../crypto/envelope';
import type { BlindIndex } from '../crypto/blind-index';
import { scoreStrength } from '../crypto/blind-index';
import {
  base32Decode,
  generateTotp,
  type TotpAlgorithm,
  type TotpCode,
} from '../crypto/totp';
import { activeDataKey } from './keys';
import {
  NoActiveDataKeyError,
  SecretAccessDeniedError,
  SecretWriteError,
  StaleSecretVersionError,
} from './errors';
import { SecretValue } from './value';

/** The AAD field name for a secret's primary material. */
const FIELD_VALUE = 'value';

/** SQLSTATE 40001 — raised by begin_secret_write when the version moved. */
function isSerializationFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '40001'
  );
}

/*
 * Re-exported rather than redeclared. It was a second copy of the same union
 * here, which is how the two drift: a purpose added to one list and not the
 * other compiles everywhere and is then refused by the database at runtime.
 */
export type { RevealPurpose };

export interface RevealOptions {
  /** Required (>= 10 chars) when the secret has requires_reason. */
  reason?: string;
  purpose?: RevealPurpose;
  /** Omit for the current version. */
  version?: number;
  /**
   * Which connection pool to use. Defaults to the request pool; background
   * workers pass 'worker' so a long sync cannot starve HTTP traffic of
   * connections. It does not widen access — the tenant context, and therefore
   * every policy, comes from the actor either way.
   */
  role?: DbRole;
}

export interface RevealedSecret {
  value: SecretValue;
  secretId: string;
  version: number;
  kind: string;
  /** The audit event that recorded this access. Surface it in support tooling. */
  auditEventUid: string;
}

interface RawRevealRow {
  granted: boolean;
  denial_reason: RevealDenialReason | null;
  audit_event_uid: string;
  secret_id: string | null;
  version: number | null;
  kind: string | null;
  algorithm: string | null;
  ciphertext: Buffer | null;
  nonce: Buffer | null;
  auth_tag: Buffer | null;
  aad: string | null;
  data_key_id: string | null;
  wrapped_dek: Buffer | null;
  kek_id: string | null;
  wrap_provider: string | null;
  wrap_context: Record<string, string> | null;
}

/**
 * Internal result of a reveal attempt.
 *
 * A union rather than "throw on denial" so the caller can commit the
 * transaction — and therefore the denial audit row — before raising.
 */
type RevealOutcome =
  | { granted: true; revealed: RevealedSecret }
  | { granted: false; reason: RevealDenialReason; auditEventUid: string };

export interface SecretServiceDeps {
  dekCache: DekCache;
  /** null disables password-reuse detection; see crypto/blind-index.ts. */
  blindIndex: BlindIndex | null;
}

export interface CreateSecretInput {
  organizationId: string;
  /**
   * What the material IS — for the reveal and export paths, not for the person
   * storing it. Optional since 0540: the credential form no longer asks, and
   * omitting it lets the column's own default ('generic') apply rather than
   * having the application pick a value the database already has an opinion
   * about. Callers that genuinely know — the TOTP path, an importer — still say.
   */
  kind?: string;
  label: string;
  sensitivity?: 'standard' | 'elevated' | 'critical';
  requiresStepUp?: boolean;
  requiresReason?: boolean;
  minRoleRank?: number;
  rotationIntervalDays?: number;
}

export interface WriteValueResult {
  secretId: string;
  version: number;
  auditEventUid: string;
}

export interface ActorRef {
  tenantId: string;
  actorId: string;
  actorType?: 'user' | 'service_account';
  requestId?: string;
  ip?: string;
  userAgent?: string;
}

export class SecretService {
  constructor(private readonly deps: SecretServiceDeps) {}

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  /**
   * Create the secret row and write version 1 in one transaction.
   *
   * Both together, because a secret with current_version = 0 is a half-made
   * object that every reader has to special-case, and leaving one behind after
   * a failed write is exactly the kind of debris that accumulates in a vault.
   */
  async create(
    actor: ActorRef,
    input: CreateSecretInput,
    plaintext: string,
  ): Promise<WriteValueResult> {
    return withTenant(actor, (tx) => this.createInTransaction(tx, actor, input, plaintext));
  }

  /**
   * Create a secret inside a transaction the caller already owns.
   *
   * Needed wherever a secret is one part of a larger atomic write — a flexible
   * asset record and the credentials attached to it, say. Doing those as
   * separate transactions can leave a record whose documentation claims a
   * password exists when it does not, which is worse than the write failing
   * outright: the technician believes the credential is captured.
   */
  async createInTransaction(
    tx: HelmTx,
    actor: ActorRef,
    input: CreateSecretInput,
    plaintext: string,
  ): Promise<WriteValueResult> {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO secret (
        tenant_id, organization_id, kind, sensitivity, label,
        requires_step_up, requires_reason, min_role_rank,
        rotation_interval_days, created_by, updated_by
      )
      VALUES (
        ${actor.tenantId}::uuid, ${input.organizationId}::uuid,
        ${input.kind ? tx`${input.kind}::secret_kind` : tx`DEFAULT`},
        ${input.sensitivity ?? 'standard'}::secret_sensitivity,
        ${input.label},
        ${input.requiresStepUp ?? input.sensitivity === 'critical'},
        ${input.requiresReason ?? input.sensitivity === 'critical'},
        ${input.minRoleRank ?? 40},
        ${input.rotationIntervalDays ?? null},
        ${actor.actorId}::uuid, ${actor.actorId}::uuid
      )
      RETURNING id
    `;
    if (!row) throw new SecretWriteError('unknown', 'secret insert returned no row');

    const written = await this.#writeVersion(tx, actor.tenantId, row.id, plaintext, null);
    return { secretId: row.id, ...written };
  }

  /**
   * Write a new version of an existing secret.
   *
   * Never an update: helm.write_secret_version appends, and secret_version
   * rejects UPDATE and DELETE by trigger. Old passwords stay readable, which is
   * what makes "what did this account's credential look like when the incident
   * happened" answerable.
   */
  async rotate(
    actor: ActorRef,
    secretId: string,
    plaintext: string,
    reason: string,
  ): Promise<WriteValueResult> {
    try {
      return await withTenant(actor, async (tx) => {
        const written = await this.#writeVersion(tx, actor.tenantId, secretId, plaintext, reason);
        return { secretId, ...written };
      });
    } catch (cause) {
      // write_secret_version raises on refusal, which rolls back the denial row
      // it wrote. Record it separately so refused writes are as visible as
      // refused reads. A stale-version skip is not a denial and is not logged
      // as one.
      if (!(cause instanceof StaleSecretVersionError)) {
        await this.#auditWriteDenial(actor, secretId, cause);
      }
      throw cause;
    }
  }

  /**
   * Rotate inside a transaction the caller already owns.
   *
   * The `createInTransaction` counterpart, and needed for the same reason: a
   * rotation that is one part of a larger atomic write. Attaching a replacement
   * TOTP seed writes the new version AND updates the credential's algorithm,
   * digits and period — two statements that must not come apart, because a
   * credential holding a SHA256 seed and a row that still says SHA1 generates
   * confidently wrong codes.
   *
   * The denial audit is kept, and works despite the caller's transaction
   * aborting: #auditWriteDenial opens its own. That matters here — a refused
   * rotation rolls back the denial row write_secret_version wrote, so without
   * this a refused TOTP replacement would leave no trace at all.
   */
  async rotateInTransaction(
    tx: HelmTx,
    actor: ActorRef,
    secretId: string,
    plaintext: string,
    reason: string,
  ): Promise<WriteValueResult> {
    try {
      const written = await this.#writeVersion(tx, actor.tenantId, secretId, plaintext, reason);
      return { secretId, ...written };
    } catch (cause) {
      if (!(cause instanceof StaleSecretVersionError)) {
        await this.#auditWriteDenial(actor, secretId, cause);
      }
      throw cause;
    }
  }

  async #writeVersion(
    tx: HelmTx,
    tenantId: string,
    secretId: string,
    plaintext: string,
    reason: string | null,
    options: { field?: string; expectedCurrentVersion?: number } = {},
  ): Promise<{ version: number; auditEventUid: string }> {
    const field = options.field ?? FIELD_VALUE;
    const key = await activeDataKey(tx, tenantId);
    const dek = await this.deps.dekCache.get({
      dataKeyId: key.id,
      wrappedDek: key.wrappedDek,
      kekId: key.kekId,
      context: key.wrapContext,
    });

    const bytes = Buffer.from(plaintext, 'utf8');

    try {
      // The AAD binds a ciphertext to its version, so we must know the version
      // before encrypting — but the version is allocated by the database under a
      // row lock. helm.begin_secret_write() does both: it takes the lock (as the
      // definer, so this path needs no UPDATE privilege on `secret`) and returns
      // the number the next version will carry. The lock is held for the rest of
      // this transaction, so the value cannot go stale underneath us.
      //
      // It also enforces the stale-version check for re-encryption, in the
      // database rather than here — see db/sql/0260_secret_write_handshake.sql.
      let allocated: { next_version: number; current_version: number } | undefined;
      try {
        [allocated] = await tx<{ next_version: number; current_version: number }[]>`
          SELECT next_version, current_version FROM helm.begin_secret_write(
            ${secretId}::uuid,
            ${options.expectedCurrentVersion ?? null}
          )
        `;
      } catch (cause) {
        if (isSerializationFailure(cause) && options.expectedCurrentVersion !== undefined) {
          throw new StaleSecretVersionError(secretId, options.expectedCurrentVersion, -1, {
            cause,
          });
        }
        throw cause;
      }

      if (!allocated) {
        throw new SecretWriteError(secretId, 'begin_secret_write returned no row');
      }

      const binding: SecretBinding = {
        tenantId,
        secretId,
        field,
        version: allocated.next_version,
      };
      const envelope = sealField(dek, bytes, binding);

      const reuseHmac = this.deps.blindIndex?.compute(tenantId, bytes) ?? null;
      const strength = scoreStrength(plaintext);

      const [written] = await tx<{ version: number; audit_event_uid: string }[]>`
        SELECT * FROM helm.write_secret_version(
          ${secretId}::uuid,
          ${key.id}::uuid,
          ${envelope.ciphertext},
          ${envelope.nonce},
          ${envelope.authTag},
          ${envelope.aad},
          ${reuseHmac},
          ${strength}::smallint,
          ${Math.min(bytes.length, 32767)}::smallint,
          ${reason}
        )
      `;
      if (!written) {
        throw new SecretWriteError(secretId, 'write_secret_version returned no row');
      }

      if (written.version !== binding.version) {
        // The database allocated a different version than the one bound into
        // the AAD, which would make the stored ciphertext unopenable. Abort
        // rather than persist a secret nobody can ever read.
        throw new SecretWriteError(
          secretId,
          `version race: bound ${binding.version}, database allocated ${written.version}`,
        );
      }

      return { version: written.version, auditEventUid: written.audit_event_uid };
    } finally {
      wipe(bytes);
    }
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /**
   * Decrypt a secret.
   *
   * Refusals throw SecretAccessDeniedError carrying the audit event id. Note
   * that the refusal is already committed by the time this throws — the SQL
   * function returns rather than raising precisely so the record of a denied
   * attempt survives. See db/sql/0210_secret_access_api.sql.
   */
  async reveal(
    actor: ActorRef,
    secretId: string,
    options: RevealOptions = {},
  ): Promise<RevealedSecret> {
    const outcome = await withTenant(
      actor,
      async (tx) => this.#revealInTx(tx, actor, secretId, options),
      options.role ? { role: options.role } : {},
    );

    // THROW OUTSIDE THE TRANSACTION. This is the whole reason reveal_secret
    // returns a refusal rather than raising one: PostgreSQL has no autonomous
    // transactions, so the audit row recording a denied attempt only survives if
    // the transaction commits. Throwing inside withTenant() would roll it back
    // and silently undo the guarantee the SQL layer went to some trouble to
    // provide — a denied access attempt is exactly what an investigation needs.
    if (!outcome.granted) {
      throw new SecretAccessDeniedError(secretId, outcome.reason, outcome.auditEventUid);
    }
    return outcome.revealed;
  }

  async #revealInTx(
    tx: HelmTx,
    actor: ActorRef,
    secretId: string,
    options: RevealOptions,
  ): Promise<RevealOutcome> {
    const [row] = await tx<RawRevealRow[]>`
      SELECT * FROM helm.reveal_secret(
        ${secretId}::uuid,
        ${options.reason ?? null},
        ${options.purpose ?? 'view'},
        ${options.version ?? null}
      )
    `;

    if (!row) throw new SecretWriteError(secretId, 'reveal_secret returned no row');

    if (!row.granted) {
      return {
        granted: false,
        reason: row.denial_reason ?? 'not_found',
        auditEventUid: row.audit_event_uid,
      };
    }

    // Granted implies every envelope column is present; assert rather than
    // spray non-null assertions through the decrypt path.
    const {
      ciphertext, nonce, auth_tag: authTag, aad,
      data_key_id: dataKeyId, wrapped_dek: wrappedDek, kek_id: kekId,
      wrap_context: wrapContext, version, kind,
    } = row;

    if (
      !ciphertext || !nonce || !authTag || !aad ||
      !dataKeyId || !wrappedDek || !kekId || !wrapContext ||
      version === null || !kind
    ) {
      throw new SecretWriteError(secretId, 'reveal_secret granted access but returned no envelope');
    }

    const dek = await this.deps.dekCache.get({
      dataKeyId,
      wrappedDek,
      kekId,
      context: wrapContext,
    });

    // Verify the binding rather than trusting the stored AAD: a row swapped at
    // the database level would otherwise decrypt cleanly under its own AAD.
    const expected: SecretBinding = {
      tenantId: actor.tenantId,
      secretId,
      field: FIELD_VALUE,
      version,
    };

    const plaintext = openField(dek, { ciphertext, nonce, authTag, aad }, expected);

    return {
      granted: true,
      revealed: {
        value: new SecretValue(plaintext, kind),
        secretId,
        version,
        kind,
        auditEventUid: row.audit_event_uid,
      },
    };
  }

  /**
   * Record that a GRANTED reveal was refused anyway, after the fact.
   *
   * 0590 moved the TOTP-seed rule into reveal_secret, so the ordinary attempt is
   * refused before anything is decrypted and produces one correctly labelled
   * `secret.reveal_denied` row. One narrow path still reaches a route holding
   * seed plaintext: purpose 'export' is legitimately granted to a caller with
   * secret:export whose seed is in a live export job, and the browser reveal
   * route declines to serve it even then — the offboarding bundle is built by
   * the export worker, which never comes through an HTTP route.
   *
   * On that path the database has already written `secret.revealed` / success,
   * truthfully: the material WAS decrypted. This adds the second half of the
   * story — that it was then withheld — so the pair reads as what happened
   * rather than as a successful read of a seed through the browser. It cannot
   * replace the first row: audit_log is append-only and a reveal that happened
   * is not something to erase.
   *
   * Best-effort, like the write-denial counterpart: the caller is already
   * throwing, and a logging failure must not become the error they see.
   */
  async auditRevealWithheld(
    actor: ActorRef,
    secretId: string,
    details: { cause: string; purpose: string; grantedEventUid: string },
  ): Promise<void> {
    try {
      await withTenant(actor, async (tx) => {
        await tx`
          SELECT helm.audit(
            'secret.reveal_denied', 'secret', ${secretId}::uuid, 'denied',
            NULL, NULL, NULL,
            ${tx.json({
              cause: details.cause,
              purpose: details.purpose,
              /* So an auditor can pair the two rows without guessing by timestamp. */
              withheld_after_event: details.grantedEventUid,
            })}::jsonb
          )
        `;
      });
    } catch {
      // Swallowed deliberately. See the doc comment.
    }
  }

  /**
   * Record a refused WRITE.
   *
   * helm.write_secret_version raises on refusal — which is the right shape for
   * a write, since the caller must not proceed — but a raise rolls back the
   * audit row it wrote first. Recording it from a separate transaction is the
   * only way to keep "every denied attempt is logged" true on the write path
   * as well as the read path.
   *
   * Best-effort: if this fails, the original write error is what matters and
   * must not be masked by a logging failure.
   */
  async #auditWriteDenial(actor: ActorRef, secretId: string, cause: unknown): Promise<void> {
    const message = cause instanceof Error ? cause.message : String(cause);
    try {
      await withTenant(actor, async (tx) => {
        await tx`
          SELECT helm.audit(
            'secret.write_denied', 'secret', ${secretId}::uuid, 'denied',
            NULL, NULL, NULL,
            ${tx.json({ cause: message.slice(0, 500) })}::jsonb
          )
        `;
      });
    } catch {
      // Swallowed deliberately. See the doc comment.
    }
  }

  /**
   * Record that a value reached the clipboard.
   *
   * A technician who reveals a password on screen and one who copies it have
   * both taken it out of the system; an audit trail that shows only the reveal
   * understates what happened.
   */
  async recordCopy(actor: ActorRef, secretId: string, field = FIELD_VALUE): Promise<string> {
    return withTenant(actor, async (tx) => {
      const [row] = await tx<{ uid: string }[]>`
        SELECT helm.record_secret_copy(${secretId}::uuid, ${field}) AS uid
      `;
      if (!row) throw new SecretWriteError(secretId, 'record_secret_copy returned no row');
      return row.uid;
    });
  }

  // -------------------------------------------------------------------------
  // TOTP
  // -------------------------------------------------------------------------

  /**
   * Generate the current code for a stored TOTP seed.
   *
   * The seed is revealed through the same audited path as any other secret —
   * generating a code IS accessing the credential, and an MSP that cannot show
   * who generated MFA codes for a shared client account has an incomplete trail.
   *
   * The decrypted seed never leaves this method: it is used and wiped, and only
   * the six digits come back.
   */
  async generateTotpCode(
    actor: ActorRef,
    totpSecretId: string,
    config: { algorithm?: TotpAlgorithm; digits?: 6 | 7 | 8; periodSeconds?: number } = {},
    options: RevealOptions = {},
  ): Promise<TotpCode & { auditEventUid: string }> {
    /*
     * purpose 'totp', not 'view', and this is the whole audit story of the
     * feature. Until 0590 both this and a refused attempt to pull the raw seed
     * through POST /api/secrets/{id}/reveal wrote `secret.revealed` with purpose
     * 'view' on the same secret, so the log could not tell a technician reading
     * a code from somebody trying to walk off with the key that generates every
     * future one. The purpose is what separates them, and reveal_secret now
     * refuses a seed under any other.
     *
     * Spread first, so a caller cannot quietly relabel this read as something
     * else: the purpose is a property of what this method does.
     */
    const revealed = await this.reveal(actor, totpSecretId, {
      ...options,
      purpose: 'totp',
    });

    try {
      const seed = base32Decode(revealed.value.expose());
      try {
        return { ...generateTotp(seed, config), auditEventUid: revealed.auditEventUid };
      } finally {
        wipe(seed);
      }
    } finally {
      revealed.value.dispose();
    }
  }

  // -------------------------------------------------------------------------
  // Rotation support
  // -------------------------------------------------------------------------

  /**
   * Re-encrypt one secret under the tenant's current active key.
   *
   * Reveal and write happen in ONE transaction, so a crash between them cannot
   * leave the secret half-moved. Both legs are audited exactly as a human
   * rotation would be — a key rotation that silently touched every credential
   * without a trail would be indistinguishable from an attacker exfiltrating
   * the vault.
   */
  async reEncrypt(actor: ActorRef, secretId: string): Promise<WriteValueResult> {
    const keyAdmin = { role: 'keyAdmin' as const };

    // Two transactions, deliberately.
    //
    // One transaction would make reveal+write atomic, but a failed write would
    // then roll back the audit row saying the worker decrypted this secret —
    // and an automated process that reads every credential in the vault without
    // leaving a trace is precisely what the audit log exists to rule out.
    //
    // Splitting is safe because versions are append-only: if the write never
    // happens, the secret simply stays on the old key and the next pass retries.
    const revealed = await withTenant(
      actor,
      async (tx) => this.#revealInTx(tx, actor, secretId, {
        purpose: 'rotation',
        reason: 'data key rotation',
      }),
      keyAdmin,
    );

    if (!revealed.granted) {
      throw new SecretAccessDeniedError(secretId, revealed.reason, revealed.auditEventUid);
    }

    try {
      return await withTenant(
        actor,
        async (tx) => {
          const written = await this.#writeVersion(
            tx,
            actor.tenantId,
            secretId,
            revealed.revealed.value.expose(),
            'data key rotation',
            { expectedCurrentVersion: revealed.revealed.version },
          );
          return { secretId, ...written };
        },
        keyAdmin,
      );
    } finally {
      revealed.revealed.value.dispose();
    }
  }

  /**
   * Passwords reused across secrets in this tenant.
   *
   * Compares blind indexes, never plaintext, and returns groups rather than
   * values. Requires secret:audit and a tenant-wide scope — a client-side user
   * must not learn that their password is shared with another organisation.
   */
  async findReusedSecrets(
    actor: ActorRef,
  ): Promise<{ secretIds: string[]; organizationIds: string[]; count: number }[]> {
    if (!this.deps.blindIndex) return [];

    return withTenant(actor, async (tx) => {
      const rows = await tx<
        { occurrence_count: string; secret_ids: string[]; organization_ids: string[] }[]
      >`SELECT occurrence_count, secret_ids, organization_ids FROM helm.find_reused_secrets()`;

      return rows.map((r) => ({
        count: Number(r.occurrence_count),
        secretIds: r.secret_ids,
        organizationIds: r.organization_ids,
      }));
    });
  }
}

export {
  SecretAccessDeniedError,
  SecretWriteError,
  NoActiveDataKeyError,
  StaleSecretVersionError,
  SecretValue,
};
