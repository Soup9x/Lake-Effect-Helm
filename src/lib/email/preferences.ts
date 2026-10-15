/**
 * One person's notification choices.
 *
 * EVERY QUERY HERE IS SCOPED BY RLS AND NOT BY THIS FILE.
 * user_notification_preference admits only rows where
 * `user_id = helm.current_actor_id()`, so there is no `WHERE user_id = …` to
 * get wrong and no way for a caller to read or write somebody else's — see
 * 0690's policies and the guard that asserts the SELECT policy names the
 * current actor.
 *
 * THE MISSING ROW IS THE INTERESTING CASE. No row means the shipped default,
 * which is every kind on; an empty array means somebody turned everything off.
 * Both are reported as `kinds`, with `configured` telling them apart — the
 * account screen needs to know whether a decision has been made, and the
 * reminder sweep does not.
 */
import type { HelmTx } from '../db/client';
import {
  DEFAULT_NOTIFICATION_KINDS, normaliseKinds, type NotificationKind,
} from '../notifications/kinds';

export interface NotificationPreference {
  kinds: NotificationKind[];
  /** Whether a row exists, as opposed to these being the shipped defaults. */
  configured: boolean;
  /**
   * Whether the tenant can send mail at all.
   *
   * Carried here because a toggle with no relay behind it is a control that
   * does nothing, and the screen has to be able to say so rather than letting
   * somebody tick a box and wait for a message that will never come.
   */
  emailConfigured: boolean;
}

export async function readMyNotificationKinds(tx: HelmTx): Promise<NotificationPreference> {
  const [row] = await tx<{ kinds: string[] }[]>`
    SELECT kinds FROM user_notification_preference
    WHERE tenant_id = helm.current_tenant_id() AND user_id = helm.current_actor_id()
  `;

  // Read through the view function rather than the table: this role has no
  // privilege on smtp_setting's envelope columns, and `enabled` is all that is
  // wanted.
  const [relay] = await tx<{ enabled: boolean }[]>`
    SELECT enabled FROM helm.smtp_settings()
  `;

  return {
    kinds: row ? normaliseKinds(row.kinds) : [...DEFAULT_NOTIFICATION_KINDS],
    configured: row !== undefined,
    emailConfigured: relay?.enabled === true,
  };
}

export async function writeMyNotificationKinds(
  tx: HelmTx,
  kinds: readonly string[],
): Promise<NotificationPreference> {
  // Normalised before storing, so two saves of the same set produce the same
  // array and a diff of the column means something.
  const stored = normaliseKinds(kinds);

  const [row] = await tx<{ kinds: string[] }[]>`
    INSERT INTO user_notification_preference (tenant_id, user_id, kinds)
    VALUES (
      helm.current_tenant_id(), helm.current_actor_id(),
      ${tx.json(stored)}::jsonb
    )
    ON CONFLICT (tenant_id, user_id) DO UPDATE SET
      kinds = EXCLUDED.kinds,
      updated_at = now()
    RETURNING kinds
  `;
  if (!row) {
    // RLS declined by writing nothing, which is how a policy says no. Reported
    // rather than returned as a success carrying the old values.
    throw new Error('the notification preference was not written');
  }

  const [relay] = await tx<{ enabled: boolean }[]>`
    SELECT enabled FROM helm.smtp_settings()
  `;

  return {
    kinds: normaliseKinds(row.kinds),
    configured: true,
    emailConfigured: relay?.enabled === true,
  };
}
