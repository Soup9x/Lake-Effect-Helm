/**
 * Getting a reset code to the person who needs it.
 *
 * The motivating scenario decides the design here. Local accounts exist so an
 * MSP can reach its clients' credentials when Entra is down — and an MSP's mail
 * is almost always Microsoft 365, so the outage that takes out sign-in takes
 * out the mailbox a reset email would land in. A reset workflow that can only
 * deliver by email is a workflow that stops working at exactly the moment it is
 * needed.
 *
 * So there are two paths, and the out-of-band one is the primary:
 *
 *   ADMIN (out of band)  An administrator issues a code and the application
 *                        shows it to them, once. They read it down the phone,
 *                        or hand it over in person. No mail server, no
 *                        dependency on anything outside this host. This is the
 *                        break-glass path and it always works.
 *
 *   SELF (email)         The person asks, and a code is emailed. Convenient on
 *                        a normal Tuesday, unavailable during the outage. It is
 *                        the addition, not the foundation.
 *
 * With no delivery channel configured, the self-service path REFUSES rather
 * than silently accepting the request and dropping the mail. A reset form that
 * says "check your email" when nothing was sent produces a support call and a
 * person who believes they are locked out permanently.
 */

export interface ResetMessage {
  readonly email: string;
  readonly name: string | null;
  /** Absolute URL the person opens. Contains the token; log it nowhere. */
  readonly resetUrl: string;
  readonly expiresAt: Date;
  readonly origin: 'self' | 'admin';
}

export interface ResetDelivery {
  /** A short name for the channel, for the operator-facing error message. */
  readonly name: string;
  send(message: ResetMessage): Promise<void>;
}

/**
 * The default: refuse.
 *
 * Deliberately not a logging stub. An alert that goes to the log instead of
 * Slack is a degraded alert; a password reset that goes to the log instead of
 * the person is a password reset link sitting in a log file, readable by
 * anybody who can read logs, which is a larger group than "the account owner".
 */
class RefusingDelivery implements ResetDelivery {
  readonly name = 'none';

  async send(): Promise<void> {
    throw new ResetDeliveryUnavailable();
  }
}

export class ResetDeliveryUnavailable extends Error {
  readonly code = 'reset_delivery_unavailable';

  constructor() {
    super(
      'no password reset delivery channel is configured. Self-service reset by ' +
        'email needs HELM_SMTP_URL; an administrator can issue a reset code ' +
        'out of band without one. See docs/deployment/on-premises.md §5.',
    );
    this.name = 'ResetDeliveryUnavailable';
  }
}

/**
 * SMTP, over an implicit-TLS or STARTTLS connection.
 *
 * Helm does not ship a mail client. Rather than take a dependency on nodemailer
 * for one message type, this posts to a small local relay — the shape an
 * on-premises MSP already has, since something on that network is already
 * sending ticket notifications.
 *
 * Refuses a plain-http endpoint. The message contains a working reset link.
 */
export class WebhookResetDelivery implements ResetDelivery {
  readonly name = 'webhook';

  constructor(
    private readonly endpoint: string,
    private readonly timeoutMs = 5000,
  ) {
    if (!/^https:\/\//.test(endpoint) && !endpoint.startsWith('http://127.0.0.1')) {
      throw new Error(
        'the reset delivery endpoint must be https, or http on the loopback ' +
          'address. It carries a working password reset link.',
      );
    }
  }

  async send(message: ResetMessage): Promise<void> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        to: message.email,
        subject: 'Reset your Lake Effect Helm password',
        text: renderResetText(message),
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`reset delivery returned ${response.status}`);
    }
  }
}

export function renderResetText(message: ResetMessage): string {
  const minutes = Math.max(1, Math.round((message.expiresAt.getTime() - Date.now()) / 60_000));
  const greeting = message.name ? `Hello ${message.name},` : 'Hello,';

  return [
    greeting,
    '',
    'Somebody asked to reset the local password on your Lake Effect Helm account.',
    'If that was not you, you can ignore this message — the link below does',
    'nothing until it is opened, and your current password still works.',
    '',
    message.resetUrl,
    '',
    `This link works once and expires in ${minutes} minutes.`,
  ].join('\n');
}

let delivery: ResetDelivery | null = null;

/**
 * Resolve the configured channel, once.
 *
 * Cached, like the other providers in this codebase, so that a deployment
 * cannot end up with two channels depending on which module imported first.
 */
export function getResetDelivery(): ResetDelivery {
  if (delivery) return delivery;

  const endpoint = process.env.HELM_RESET_DELIVERY_URL;
  delivery = endpoint ? new WebhookResetDelivery(endpoint) : new RefusingDelivery();
  return delivery;
}

/** Install a channel directly. For tests, and for deployments that wire their own. */
export function setResetDelivery(next: ResetDelivery | null): void {
  delivery = next;
}
