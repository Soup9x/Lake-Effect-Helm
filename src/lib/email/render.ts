/**
 * What the messages say.
 *
 * PLAIN TEXT, AND ONLY PLAIN TEXT. No HTML part, which is a decision rather
 * than an omission:
 *
 *   An HTML body is a second rendering of the same facts, and the two drift —
 *   §2 of docs/architecture/10-notifications.md already had to fix four webhook
 *   formats saying different things. Text is the one body every client renders
 *   identically and no client refuses.
 *
 *   An HTML mail that links back into Helm wants images, a logo and a brand
 *   colour, and that is a tracking-pixel-shaped hole in a product whose whole
 *   argument is that it does not phone home.
 *
 * NO CREDENTIAL MATERIAL, EVER, and the allow-list that guarantees it lives in
 * SQL: helm.notification_payload() names every field that may leave, one key at
 * a time per event. These functions render what that produced; they cannot
 * reach past it. A credential's LABEL does appear — "ACME Domain Admin" — and
 * the settings page says so, because a notification that cannot name the thing
 * it is about is one nobody can act on.
 *
 * THE SUBJECT IS A SENTENCE SOMEBODY CAN ACT ON FROM A PHONE LOCK SCREEN. "A
 * step is due" is not; "Due tomorrow: Disable the account — ACME Ltd" is.
 */
import type { TaskReminderKind } from '../notifications/kinds';

export interface ReminderMessage {
  kind: TaskReminderKind;
  leadDay: number;
  recipientName: string | null;
  stepTitle: string;
  stepPosition: number;
  runTitle: string;
  organizationName: string;
  dueAt: Date | null;
  /** Absolute, so the link works from a mail client. */
  runUrl: string;
}

/**
 * How soon, in words.
 *
 * Exported because the subject and the body both need it and they must agree —
 * a subject saying "due tomorrow" over a body saying "due in 3 days" is the
 * kind of thing nobody notices until a technician misses a deadline.
 */
function dueInWords(leadDay: number, dueAt: Date | null): string {
  if (dueAt === null) return 'no due date';
  if (leadDay <= 0) {
    // Past the due date is a different sentence from due today, and the one
    // that matters more.
    return dueAt.getTime() < Date.now() ? 'overdue' : 'due today';
  }
  return leadDay === 1 ? 'due tomorrow' : `due in ${leadDay} days`;
}

export function reminderSubject(message: ReminderMessage): string {
  if (message.kind === 'assigned') {
    return `Assigned to you: ${message.stepTitle} — ${message.organizationName}`;
  }
  const when = dueInWords(message.leadDay, message.dueAt);
  // Capitalised, because it opens the subject.
  const lead = when.charAt(0).toUpperCase() + when.slice(1);
  return `${lead}: ${message.stepTitle} — ${message.organizationName}`;
}

export function reminderBody(message: ReminderMessage): string {
  const greeting = message.recipientName ? `Hello ${message.recipientName},` : 'Hello,';
  const when = dueInWords(message.leadDay, message.dueAt);

  const opening = message.kind === 'assigned'
    ? `A checklist step has been assigned to you.`
    : `A checklist step assigned to you is ${when}.`;

  return [
    greeting,
    '',
    opening,
    '',
    `  Step        ${message.stepPosition}. ${message.stepTitle}`,
    `  Checklist   ${message.runTitle}`,
    `  Client      ${message.organizationName}`,
    ...(message.dueAt
      ? [`  Due         ${formatDueLine(message.dueAt)}`]
      : ['  Due         not set']),
    '',
    message.runUrl,
    '',
    // Said in every message rather than only the first, because the person who
    // wants it to stop is reading THIS one.
    'You are receiving this because the step is assigned to you. You can turn',
    'these off under Account → Notifications.',
  ].join('\n');
}

/**
 * The due date, with its zone named.
 *
 * UTC with the suffix, not the reader's local time, and this is the rule E
 * settled: a shared fact gets a UTC-suffixed timestamp, because a mail
 * rendering it in the server's zone is a date that is wrong for whoever opens
 * it somewhere else. The web interface shows the reader's own zone beside it;
 * a mail cannot know the zone, so it says which one it used.
 */
function formatDueLine(dueAt: Date): string {
  const iso = dueAt.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export interface NotificationMessage {
  subject: string;
  eventType: string;
  organizationName: string | null;
  occurredAt: Date;
  /** Already filtered by helm.notification_payload(); rendered as given. */
  payload: Record<string, unknown>;
}

/**
 * A team-channel notification, as mail.
 *
 * THE SAME SENTENCE THE OTHER FORMATS USE. `subject` is built in SQL by
 * helm.notification_subject(), so a Discord embed, a Teams card and this mail
 * say the same thing about the same event — §2's rule that formatting differs
 * between platforms and facts do not.
 */
export function notificationBody(message: NotificationMessage): string {
  const lines = [
    message.subject,
    '',
    `  Event     ${message.eventType}`,
    ...(message.organizationName ? [`  Client    ${message.organizationName}`] : []),
    `  When      ${message.occurredAt.toISOString().replace('T', ' ').slice(0, 16)} UTC`,
  ];

  const detail = Object.entries(message.payload)
    // The allow-list already decided what may be here; this only drops the
    // empties, so a mail does not carry "omissions: " with nothing after it.
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `  ${key.padEnd(9)} ${renderValue(value)}`);

  if (detail.length > 0) lines.push('', ...detail);

  lines.push(
    '',
    'Sent by Lake Effect Helm because this event is subscribed on an email',
    'destination. An administrator can change that under Settings.',
  );
  return lines.join('\n');
}

function renderValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => String(v)).join(', ');
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}
