/**
 * Sending one message, and the two gates it passes first.
 *
 * THE RECIPIENT GATE IS NOT A VALIDATION, IT IS A DISCLOSURE BOUNDARY.
 * Notifications name clients, assets and credential labels — §3 of
 * docs/architecture/10-notifications.md — so an address outside the business is
 * a feed of that to whoever owns it. helm.email_recipient_allowed() decides,
 * in SQL, so the route that configures a destination and the worker that sends
 * to it cannot come to different conclusions. Checked HERE AS WELL as at
 * configuration time, deliberately: a tenant can narrow its allowed domains
 * after a destination was created, and the moment that matters is the moment
 * something is about to be sent.
 *
 * AND THE RELAY HAS TO BE ON. A tenant with no smtp_setting row, or one with
 * `enabled = false`, sends nothing — helm.smtp_transport() returns no row at
 * all in that case, which is the air-gapped default 0670 established and this
 * follows.
 *
 * THE PASSWORD LIVES FOR ONE CONNECTION. It is opened from the envelope here,
 * handed to a transport that is closed when the batch ends, and the buffer is
 * wiped. Never logged, never returned, never put in an error message.
 */
import { withTenant, db } from '../db/client';
import { openSmtpPassword } from './secret';
import {
  buildTransport, describeTransportError, fromHeader,
  EmailTransportError, type RelayConfig,
} from './transport';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
}

export interface RelayRow {
  host: string;
  port: number;
  security: RelayConfig['security'];
  tls_verify: boolean;
  tls_pinned_certificate: string | null;
  username: string | null;
  from_address: string;
  from_name: string | null;
  wrap_provider: string | null;
  kek_id: string | null;
  wrapped_dek: Buffer | null;
  secret_ciphertext: Buffer | null;
  secret_nonce: Buffer | null;
  secret_tag: Buffer | null;
  secret_aad: string | null;
}

/**
 * The tenant's relay, with the password opened, or null if email is off.
 *
 * Read as the worker, through the SECURITY DEFINER function that is the only
 * path to the envelope columns.
 */
export async function loadRelay(tenantId: string): Promise<RelayConfig | null> {
  const [row] = await db('worker')<RelayRow[]>`
    SELECT * FROM helm.smtp_transport(${tenantId}::uuid)
  `;
  if (!row) return null;

  // Null when the relay needs no credentials, which is a legitimate state on a
  // trusted network rather than a misconfiguration.
  const password = await openSmtpPassword(tenantId, row);

  return {
    host: row.host,
    port: Number(row.port),
    security: row.security,
    tlsVerify: row.tls_verify,
    tlsPinnedCertificate: row.tls_pinned_certificate,
    username: row.username,
    password,
    fromAddress: row.from_address,
    fromName: row.from_name,
  };
}

/**
 * Whether this tenant may send to this address.
 *
 * In SQL rather than by re-implementing the domain comparison here, because the
 * configuration route asks the same question and two copies of a disclosure
 * rule is one copy too many.
 */
export async function recipientAllowed(tenantId: string, address: string): Promise<boolean> {
  const [row] = await db('worker')<{ allowed: boolean }[]>`
    SELECT helm.email_recipient_allowed(${tenantId}::uuid, ${address}) AS allowed
  `;
  return row?.allowed === true;
}

/**
 * A connection held for a batch of messages, then closed.
 *
 * Opening one connection per message is how a relay's rate limiter decides Helm
 * is a spam source; holding one open for the life of the worker is how the
 * opened password outlives the work it was for. One per batch is the middle,
 * and `close()` is in a finally everywhere it is used.
 */
export class EmailBatch {
  private readonly transport;

  private constructor(
    private readonly tenantId: string,
    private readonly config: RelayConfig,
  ) {
    this.transport = buildTransport(config);
  }

  static async open(tenantId: string): Promise<EmailBatch | null> {
    const config = await loadRelay(tenantId);
    if (!config) return null;
    return new EmailBatch(tenantId, config);
  }

  /** The address messages will appear to come from, for a log line. */
  get from(): string {
    return this.config.fromAddress;
  }

  async send(mail: OutgoingMail): Promise<void> {
    if (!(await recipientAllowed(this.tenantId, mail.to))) {
      // Refused rather than dropped quietly: the caller records it against the
      // row so somebody can see WHY nothing arrived. The message names the
      // setting rather than the address, because the address is in the row.
      throw new EmailTransportError(
        'that address is outside the domains this tenant allows notifications to '
        + 'be sent to. An administrator can widen them under Settings.',
        'misconfigured',
      );
    }

    try {
      await this.transport.sendMail({
        from: fromHeader(this.config),
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        // A notification is not a conversation. Replies go nowhere useful, and
        // an auto-responder answering one of these must not start a loop.
        headers: {
          'auto-submitted': 'auto-generated',
          'x-helm-notification': '1',
        },
      });
    } catch (error) {
      throw describeTransportError(error);
    }
  }

  close(): void {
    this.transport.close();
    // The opened password goes with it. RelayConfig holds a string, which
    // cannot be wiped in JavaScript — so the reference is dropped and the
    // transport that held it is torn down, which is the best available.
    (this.config as { password: string | null }).password = null;
  }
}

/** Record the outcome against the relay, so the settings page can show it. */
export async function recordRelayResult(
  tenantId: string,
  ok: boolean,
  error?: string,
): Promise<void> {
  await db('worker')`
    SELECT helm.record_smtp_result(${tenantId}::uuid, ${ok}, ${error ?? null})
  `;
}

/**
 * A one-off send outside a batch, for the settings page's test button.
 *
 * Still goes through the same gates and the same transport builder — the point
 * of a test is to exercise the path a real message takes, which is §7's rule
 * about the webhook test queueing rather than POSTing.
 */
export async function sendOne(tenantId: string, mail: OutgoingMail): Promise<void> {
  const batch = await EmailBatch.open(tenantId);
  if (!batch) {
    throw new EmailTransportError(
      'outbound email is not configured for this tenant', 'misconfigured',
    );
  }
  try {
    await batch.send(mail);
    await recordRelayResult(tenantId, true);
  } catch (error) {
    const described = describeTransportError(error);
    await recordRelayResult(tenantId, false, described.message);
    throw described;
  } finally {
    batch.close();
  }
}

/** Re-exported so a caller needs one import. */
export { EmailTransportError, withTenant };
