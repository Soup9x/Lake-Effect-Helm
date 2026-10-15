/**
 * What a person can be told about, by email (0690) and in the bell (0700).
 *
 * MIRRORS helm.notification_kinds(), AND A TEST ASSERTS IT. The database holds
 * the legal set — it is a CHECK on user_notification_preference.kinds and on
 * user_notification.kind — and this is the copy a form needs in order to render
 * a checkbox per kind. `tests/integration/email-settings.test.ts` fails if the
 * two lists diverge, which is the same construction D used for SIDEBAR_SLUGS
 * against helm.sidebar_layout_valid() and for the same reason: a kind added in
 * one place only produces a save that returns 500 and a checkbox nobody can
 * tick.
 *
 * ONE SET GOVERNS BOTH CHANNELS. A kind somebody has turned off produces
 * neither an email nor a bell row, which is the only rule that does not require
 * explaining: honouring a preference in one channel and not the other is the
 * kind of half-measure a person has to discover for themselves.
 *
 * TWO HALVES, AND THE DEFAULT SPLITS BETWEEN THEM.
 *
 *   MINE — task_assigned, task_due — are ON by default. Being given work and a
 *   deadline is something to tell somebody without being asked, and nothing can
 *   arrive unbidden anyway: email is off at the tenant level until an
 *   administrator configures a relay. Defaulting these off would mean the
 *   feature appears broken to everybody who was not told to switch it on.
 *
 *   OVERSIGHT — export_activity, credential_access, expiring_soon, operations —
 *   are OFF by default, because each is a feed of everything that happens in
 *   the business rather than a message about this person's own work. They also
 *   reach only a tenant-wide seat holding audit:read (decision 31), so a client
 *   administrator cannot subscribe to them at all. Defaulting them on would
 *   additionally have meant emailing every administrator about every export the
 *   moment 0700 applied, which nobody asked for.
 *
 * An EMPTY array is not the same as no row: it means somebody turned everything
 * off, and 0690's table comment explains why that distinction has to survive.
 */

export const NOTIFICATION_KINDS = [
  'task_assigned',
  'task_due',
  'export_activity',
  'credential_access',
  'expiring_soon',
  'operations',
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/**
 * The kinds that reach only a tenant-wide seat holding audit:read.
 *
 * Kept as data rather than as a condition in the component, because the
 * account screen has to decide whether to render a checkbox at all and the
 * rule is the database's — helm.notification_audience() is where it is
 * enforced, and a screen that offers a control the audience test will refuse is
 * a control that silently does nothing.
 */
export const OVERSIGHT_KINDS: readonly NotificationKind[] = [
  'export_activity',
  'credential_access',
  'expiring_soon',
  'operations',
];

/**
 * The kinds a person gets when they have never touched the setting.
 *
 * Mirrors helm.default_notification_kinds(), which a guard in 0700 asserts is
 * a subset of the legal set — a default naming a kind the CHECK refuses would
 * make every preference row unwritable.
 */
export const DEFAULT_NOTIFICATION_KINDS: readonly NotificationKind[] = [
  'task_assigned',
  'task_due',
];

/** Matches 0690's task_reminder_kind enum. */
export type TaskReminderKind = 'assigned' | 'due';

/**
 * Which preference governs a reminder.
 *
 * The two vocabularies are deliberately not the same word: the reminder's kind
 * is why it was raised ('assigned', 'due'), while the preference names what a
 * person is choosing to receive ('task_assigned', 'task_due'). Keeping them
 * distinct means the queue's enum can grow a kind — a reminder for a blocked
 * step, say — without silently inheriting somebody's answer to a different
 * question.
 */
export function kindFor(reminder: TaskReminderKind): NotificationKind {
  return reminder === 'assigned' ? 'task_assigned' : 'task_due';
}

export const KIND_LABELS: Record<NotificationKind, { title: string; hint: string }> = {
  task_assigned: {
    title: 'A checklist step is assigned to me',
    hint: 'One message when somebody gives you a step. Nothing is sent when you '
      + 'assign a step to yourself.',
  },
  task_due: {
    title: 'A step assigned to me is due',
    hint: 'Three days before, the day before, and on the day. One message each, '
      + 'never repeated — and nothing once the step is complete.',
  },
  export_activity: {
    title: 'Somebody exports a client\u2019s documentation',
    hint: 'Requested, produced, downloaded and revoked. Credential exports no '
      + 'longer need a second approver, so this is how anybody finds out one '
      + 'happened.',
  },
  credential_access: {
    title: 'A credential is revealed, or access is refused',
    hint: 'Who revealed what, and anything turned down. Busy on an active team '
      + '\u2014 repeated refusals are the part worth watching.',
  },
  expiring_soon: {
    title: 'Something is expiring',
    hint: 'Certificates, warranties, domains and contracts, at the lead times '
      + 'this MSP configured.',
  },
  operations: {
    title: 'The machinery needs looking at',
    hint: 'A sync that keeps failing means documentation going quietly stale. '
      + 'Also covers a tenant key being rotated or retired.',
  },
};

/** Whether a stored preference enables a kind, with the default applied. */
export function wants(
  stored: readonly string[] | null | undefined,
  kind: NotificationKind,
): boolean {
  if (stored === null || stored === undefined) {
    return DEFAULT_NOTIFICATION_KINDS.includes(kind);
  }
  return stored.includes(kind);
}

/** Drop anything that is not a known kind, and de-duplicate. */
export function normaliseKinds(raw: readonly string[]): NotificationKind[] {
  const seen = new Set<NotificationKind>();
  for (const value of raw) {
    if ((NOTIFICATION_KINDS as readonly string[]).includes(value)) {
      seen.add(value as NotificationKind);
    }
  }
  // Returned in the catalogue's own order rather than the caller's, so two
  // saves of the same set store the same array and a diff of the column is
  // meaningful.
  return NOTIFICATION_KINDS.filter((kind) => seen.has(kind));
}
