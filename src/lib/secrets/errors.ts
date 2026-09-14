/**
 * Secret access failures.
 *
 * A refusal carries the audit event id that recorded it. That is not a
 * convenience: when a technician says "it says I can't see this", the support
 * answer is a single audit lookup rather than a log trawl — and the denial is
 * already durably recorded, because helm.reveal_secret() commits the audit row
 * before returning the refusal.
 */
import type { RevealDenialReason } from '@db/schema/secrets';

export class SecretAccessDeniedError extends Error {
  readonly reason: RevealDenialReason;
  readonly auditEventUid: string;
  readonly secretId: string;

  constructor(secretId: string, reason: RevealDenialReason, auditEventUid: string) {
    super(`secret access denied: ${reason}`);
    this.name = 'SecretAccessDeniedError';
    this.reason = reason;
    this.auditEventUid = auditEventUid;
    this.secretId = secretId;
  }

  /**
   * Whether the user can do something about it themselves.
   *
   * Drives the UI: `step_up_required` shows a re-authentication prompt and
   * `reason_required` shows a justification box, whereas
   * `insufficient_role_rank` needs someone else to grant access. Getting this
   * wrong means showing a technician a prompt that cannot help them.
   */
  get isRecoverableByUser(): boolean {
    return this.reason === 'step_up_required' || this.reason === 'reason_required';
  }

  /**
   * Whether to tell the user the secret exists.
   *
   * `not_found` covers both "no such secret" and "not yours" on purpose — see
   * helm.reveal_secret(). The API must not undo that by rendering a different
   * message for each.
   */
  get shouldPresentAsNotFound(): boolean {
    return this.reason === 'not_found';
  }
}

export class SecretWriteError extends Error {
  readonly secretId: string;

  constructor(secretId: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SecretWriteError';
    this.secretId = secretId;
  }
}

export class NoActiveDataKeyError extends Error {
  readonly tenantId: string;

  constructor(tenantId: string) {
    super(
      `tenant ${tenantId} has no active data encryption key; ` +
        'run key provisioning before writing secrets',
    );
    this.name = 'NoActiveDataKeyError';
    this.tenantId = tenantId;
  }
}

/**
 * A re-encryption decrypted version N, but by the time it went to write, the
 * secret had moved on.
 *
 * Almost always benign: a technician rotated the password while the key
 * rotation worker was mid-flight. The worker must SKIP, not retry with its
 * stale copy — writing it back would revert the technician's change, and a
 * rotation job silently restoring an old credential is the worst outcome this
 * system has. The newer version is already under the active key anyway, because
 * write_secret_version only accepts the active one.
 */
export class StaleSecretVersionError extends Error {
  readonly secretId: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(
    secretId: string,
    expectedVersion: number,
    /** -1 when the database reported the conflict without naming the new version. */
    actualVersion: number,
    options?: { cause?: unknown },
  ) {
    super(
      `secret ${secretId} moved on from version ${expectedVersion}` +
        (actualVersion >= 0 ? ` to ${actualVersion}` : '') +
        ' during re-encryption; skipping rather than reverting it',
      options,
    );
    this.name = 'StaleSecretVersionError';
    this.secretId = secretId;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}
