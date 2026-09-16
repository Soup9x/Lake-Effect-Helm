/**
 * Where an alert actually goes.
 *
 * Helm's job is to decide that a certificate expires in seven days and to
 * record that it said so. How the message reaches a human is a deployment
 * decision — one MSP wants a PSA ticket, another a Teams card, a third an email
 * to a shared mailbox — and baking any one of them in would mean every other
 * MSP patches this file.
 *
 * So: an interface, a webhook implementation that covers Slack, Teams and
 * anything with an inbound URL, and a logging implementation that is the
 * default. The default is deliberately not "silently drop": an operator who has
 * not configured a channel sees the alerts in the worker log and knows the
 * evaluation half is working.
 *
 * Alert messages carry expiry metadata and never secret material. The payload
 * is built in SQL from the expiration projection, which has no route to
 * ciphertext.
 */
import { describeError } from './runtime';

export interface AlertMessage {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly channel: string;
  readonly target: string;
  readonly ruleName: string;
  readonly severity: 'info' | 'notice' | 'warning' | 'critical' | 'expired';
  readonly leadDay: number;
  readonly firedAt: Date;
  readonly payload: Record<string, unknown>;
}

export interface AlertNotifier {
  send(message: AlertMessage): Promise<void>;
}

/** Human-readable one-liner, shared by every channel. */
export function summarise(message: AlertMessage): string {
  const label = String(message.payload.label ?? 'an item');
  const kind = String(message.payload.kind ?? 'expiry').replace(/_/g, ' ');
  const days = Number(message.payload.days_remaining ?? 0);

  const when =
    days < 0 ? `expired ${Math.abs(days)} day(s) ago`
    : days === 0 ? 'expires today'
    : `expires in ${days} day(s)`;

  return `[${message.severity.toUpperCase()}] ${message.tenantName}: ${kind} — ${label} ${when}`;
}

class LoggingNotifier implements AlertNotifier {
  async send(message: AlertMessage): Promise<void> {
    // Not a silent drop: an unconfigured channel still produces a visible
    // record, so "alerts are not arriving" is distinguishable from "alerts are
    // not firing".
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        logger: 'alerts',
        msg: summarise(message),
        channel: message.channel,
        target: message.target,
        rule: message.ruleName,
        tenant: message.tenantName,
      }),
    );
  }
}

/**
 * POST the alert as JSON to the rule's target URL.
 *
 * Covers Slack and Teams incoming webhooks (both accept a `text` field) and any
 * bespoke receiver. The target is refused unless it is https: an alert says
 * which client has which expiring asset, which is reconnaissance, and an
 * on-premises MSP network is not a reason to put that on the wire in clear.
 */
export class WebhookNotifier implements AlertNotifier {
  constructor(private readonly timeoutMs = 5000) {}

  async send(message: AlertMessage): Promise<void> {
    if (!/^https:\/\//.test(message.target)) {
      throw new Error(`alert target must be an https URL, got ${message.target.slice(0, 40)}`);
    }

    const text = summarise(message);
    const response = await fetch(message.target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        severity: message.severity,
        tenant: message.tenantName,
        rule: message.ruleName,
        leadDay: message.leadDay,
        firedAt: message.firedAt.toISOString(),
        expiry: message.payload,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`webhook returned ${response.status}`);
    }
  }
}

/**
 * Dispatch by the rule's channel, falling back to the log.
 *
 * `email`, `psa_ticket`, `slack` and `teams` all route through the webhook
 * notifier when the target is a URL, which is how Slack and Teams work anyway
 * and how most PSA systems expose ticket creation. An `email` channel whose
 * target is an address has no transport here and is logged — adding SMTP is a
 * deployment decision, and a half-configured mail path that swallows alerts is
 * worse than one that says it did nothing.
 */
export class ChannelRouter implements AlertNotifier {
  constructor(
    private readonly webhook: AlertNotifier = new WebhookNotifier(),
    private readonly fallback: AlertNotifier = new LoggingNotifier(),
  ) {}

  async send(message: AlertMessage): Promise<void> {
    if (/^https:\/\//.test(message.target)) {
      await this.webhook.send(message);
      return;
    }
    await this.fallback.send(message);
  }
}

let notifier: AlertNotifier | null = null;

export function resolveNotifier(): AlertNotifier {
  notifier ??= new ChannelRouter();
  return notifier;
}

/** Install a different notifier. For tests and for deployments with SMTP. */
export function setNotifier(next: AlertNotifier | null): void {
  notifier = next;
}

export { LoggingNotifier };
export { describeError };
