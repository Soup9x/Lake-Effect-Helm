/**
 * What a person can be emailed about.
 *
 * MIRRORS helm.notification_kinds_valid(), AND A TEST ASSERTS IT. The database
 * holds the legal set — it is a CHECK on user_notification_preference.kinds —
 * and this is the copy a form needs in order to render a checkbox per kind.
 * `tests/integration/email.test.ts` fails if the two lists diverge, which is
 * the same construction D used for SIDEBAR_SLUGS against
 * helm.sidebar_layout_valid() and for the same reason: a kind added in one
 * place only produces a save that returns 500 and a checkbox nobody can tick.
 *
 * BOTH ARE ON BY DEFAULT when no preference row exists, and that is a decision
 * rather than an accident of the schema. Email is off at the tenant level until
 * an administrator configures a relay, so nothing can arrive unasked-for; once
 * they have, somebody who is given work and a deadline should be told about
 * both. The alternative — default off — means the feature appears broken to
 * every person who was not told to go and switch it on.
 *
 * An EMPTY array is not the same as no row: it means somebody turned everything
 * off, and 0690's table comment explains why that distinction has to survive.
 */

export const NOTIFICATION_KINDS = ['task_assigned', 'task_due'] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** The kinds a person gets when they have never touched the setting. */
export const DEFAULT_NOTIFICATION_KINDS: readonly NotificationKind[] = NOTIFICATION_KINDS;

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
