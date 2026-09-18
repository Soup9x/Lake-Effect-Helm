/**
 * One event, four payload shapes.
 *
 * The platforms do not agree on anything, and the 0110 comment claiming a
 * single `{ text }` body "covers Slack, Teams and anything with an inbound URL"
 * was two-thirds right in a way that matters:
 *
 *   slack    accepts a bare `text`. Blocks make it readable.
 *   teams    the legacy Office 365 connector accepted `text`. Those connectors
 *            are retired; Power Automate Workflows wants an Adaptive Card.
 *   discord  REFUSES a bare `text` with a 400. It wants `content` or `embeds`.
 *            So the Discord case was never actually working.
 *   generic  Helm's own JSON, for a receiver somebody wrote themselves.
 *
 * WHAT IS THE SAME EVERYWHERE: the words. `subject` is built in SQL
 * (helm.notification_subject) and every format renders that same sentence.
 * Formatting is per-platform; facts are not.
 *
 * NOTHING HERE DECIDES WHAT GOES IN A PAYLOAD. That is
 * helm.notification_payload()'s allow-list, and by the time a delivery reaches
 * this file the fields have already been chosen. These functions arrange what
 * they are given; they never reach back for more.
 */

/** A queued delivery, as helm.claim_notifications() returns it. */
export interface NotificationEvent {
  readonly event: string;
  readonly subject: string;
  readonly payload: Record<string, unknown>;
  readonly occurredAt: Date;
  readonly organizationName: string | null;
  readonly tenantName: string;
}

export type WebhookFormat = 'generic' | 'slack' | 'discord' | 'teams';

/**
 * How loud an event is.
 *
 * Drives colour only. A credential-bearing export and a refused reveal are the
 * two an MSP wants to spot in a busy channel without reading, which is what a
 * red stripe down the side of a card is for.
 */
export type Severity = 'info' | 'notice' | 'warning' | 'critical';

export function severityOf(event: NotificationEvent): Severity {
  switch (event.event) {
    case 'export.requested':
      // The one 0400 removed the approval gate from. Loud on purpose.
      return event.payload.include_secrets === true ? 'critical' : 'notice';
    case 'export.downloaded':
      return 'warning';
    case 'access.denied':
      return 'warning';
    case 'secret.revealed':
      return event.payload.sensitivity === 'critical' ? 'warning' : 'info';
    case 'integration.failed':
      return 'warning';
    case 'expiration.warning': {
      const days = Number(event.payload.days_remaining ?? 99);
      if (days < 0) return 'critical';
      return days <= 7 ? 'warning' : 'notice';
    }
    case 'export.revoked':
    case 'key.rotated':
      return 'notice';
    default:
      return 'info';
  }
}

/** Discord embed colours, as the integers its API wants. */
const DISCORD_COLOUR: Record<Severity, number> = {
  info: 0x64_74_8b, // slate
  notice: 0x25_63_eb, // blue
  warning: 0xd9_77_06, // amber
  critical: 0xdc_26_26, // red
};

/** Teams Adaptive Card accent names. */
const TEAMS_STYLE: Record<Severity, string> = {
  info: 'default',
  notice: 'accent',
  warning: 'warning',
  critical: 'attention',
};

/** Slack attachment colours. */
const SLACK_COLOUR: Record<Severity, string> = {
  info: '#64748b',
  notice: '#2563eb',
  warning: '#d97706',
  critical: '#dc2626',
};

/**
 * Payload keys rendered as labelled rows, in this order.
 *
 * An explicit order rather than Object.keys(), so the same event always reads
 * the same way and a new key does not silently reshuffle a card somebody scans
 * every morning. Anything not listed is appended alphabetically afterwards —
 * visible rather than dropped, because a field that made it through the SQL
 * allow-list is one somebody chose to send.
 */
const FIELD_ORDER = [
  'include_secrets', 'kind', 'format', 'purpose', 'sensitivity', 'label',
  'cause', 'record_count', 'secret_count', 'byte_size', 'download_number',
  'days_remaining', 'expires_at', 'provider', 'error',
];

function labelise(key: string): string {
  const words = key.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** The payload as ordered (label, value) pairs. */
export function fields(event: NotificationEvent): [string, string][] {
  const keys = Object.keys(event.payload);
  const ordered = [
    ...FIELD_ORDER.filter((k) => keys.includes(k)),
    ...keys.filter((k) => !FIELD_ORDER.includes(k)).sort(),
  ];
  return ordered.map((k) => [labelise(k), renderValue(event.payload[k])]);
}

/** The line under the subject: which client, which deployment, when. */
export function context(event: NotificationEvent): string {
  const parts = [event.organizationName, event.tenantName].filter(
    (p): p is string => Boolean(p),
  );
  return `${parts.join(' · ')} · ${event.occurredAt.toISOString()}`;
}

/**
 * Helm's own shape.
 *
 * Deliberately flat and stable: this is the one somebody writes a receiver
 * against, so the shape is a contract rather than a convenience.
 */
export function generic(event: NotificationEvent): unknown {
  return {
    event: event.event,
    severity: severityOf(event),
    subject: event.subject,
    tenant: event.tenantName,
    organization: event.organizationName,
    occurredAt: event.occurredAt.toISOString(),
    data: event.payload,
    source: 'lake-effect-helm',
  };
}

export function slack(event: NotificationEvent): unknown {
  const severity = severityOf(event);
  return {
    // `text` is both the fallback and the notification preview, so it carries
    // the whole sentence rather than a title.
    text: event.subject,
    attachments: [
      {
        color: SLACK_COLOUR[severity],
        fields: fields(event).map(([title, value]) => ({ title, value, short: true })),
        footer: context(event),
      },
    ],
  };
}

/**
 * Discord.
 *
 * `content` AND `embeds`: content is what appears in a notification preview and
 * a mobile banner, the embed is what is readable in the channel. An embed alone
 * produces a push notification that says only "Lake Effect Helm sent a message".
 *
 * Discord caps an embed at 25 fields and 1024 characters per value; the slice
 * and truncation below are those limits, not taste. Exceeding either is a 400,
 * which would look exactly like a bad URL.
 */
export function discord(event: NotificationEvent): unknown {
  const severity = severityOf(event);
  return {
    content: event.subject.slice(0, 2000),
    embeds: [
      {
        title: titleFor(event.event),
        description: event.subject.slice(0, 4096),
        color: DISCORD_COLOUR[severity],
        timestamp: event.occurredAt.toISOString(),
        fields: fields(event)
          .slice(0, 25)
          .map(([name, value]) => ({
            name: name.slice(0, 256),
            value: value.slice(0, 1024) || '—',
            inline: true,
          })),
        footer: { text: context(event).slice(0, 2048) },
      },
    ],
  };
}

/**
 * Microsoft Teams, as a Power Automate Workflows message.
 *
 * NOT the `@type: MessageCard` shape. That is the Office 365 connector format,
 * and those connectors are retired — defaulting to it would send every new
 * deployment down a path Microsoft has closed. Workflows accepts an Adaptive
 * Card inside an attachment envelope, which is what this builds.
 */
export function teams(event: NotificationEvent): unknown {
  const severity = severityOf(event);
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            {
              type: 'TextBlock',
              text: titleFor(event.event),
              weight: 'Bolder',
              size: 'Medium',
              color: TEAMS_STYLE[severity],
              wrap: true,
            },
            { type: 'TextBlock', text: event.subject, wrap: true },
            {
              type: 'FactSet',
              facts: fields(event).map(([title, value]) => ({ title, value })),
            },
            {
              type: 'TextBlock',
              text: context(event),
              isSubtle: true,
              size: 'Small',
              wrap: true,
            },
          ],
        },
      },
    ],
  };
}

/** A short human title per event, used as a card heading. */
function titleFor(event: string): string {
  switch (event) {
    case 'export.requested':
      return 'Export requested';
    case 'export.rendered':
      return 'Export ready';
    case 'export.downloaded':
      return 'Export downloaded';
    case 'export.revoked':
      return 'Export revoked';
    case 'secret.revealed':
      return 'Credential revealed';
    case 'access.denied':
      return 'Access refused';
    case 'expiration.warning':
      return 'Expiring soon';
    case 'integration.failed':
      return 'Integration failing';
    case 'key.rotated':
      return 'Encryption key moved';
    default:
      return 'Lake Effect Helm';
  }
}

/** Build the body for a destination's format. */
export function formatPayload(format: WebhookFormat, event: NotificationEvent): unknown {
  switch (format) {
    case 'slack':
      return slack(event);
    case 'discord':
      return discord(event);
    case 'teams':
      return teams(event);
    case 'generic':
      return generic(event);
  }
}
