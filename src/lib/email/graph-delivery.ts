/**
 * Sending through Microsoft 365 rather than a relay (1010).
 *
 * The app registration is the one the MSP connected for its own organisation
 * under Microsoft 365 (0990). Its client secret is opened the way the sync
 * opens it — through the secret service, purpose 'integration', as the
 * tenant's sync identity (1010 says why that one) — so each batch of mail is
 * one audited access, and the plaintext lives only until the token is issued.
 *
 * SIGNED IN LAZILY, on the first message of a batch. A batch is opened for any
 * tenant with something due, and a sign-in that fails should fail THAT message,
 * where the queue records why and retries, rather than the opening of the
 * batch, which callers can only report as "email is not set up".
 */
import { withTenant } from '../db/client';
import { getSecretService } from '../services';
import { fetchToken, GraphError, sendMail, type GraphTarget } from '../m365/client';
import { EmailTransportError } from './transport';
import type { OutgoingMail, WorkerActor } from './sender';

interface ConnectionRow {
  tenant: string | null;
  client_id: string | null;
  client_secret_id: string | null;
}

export class GraphDelivery {
  private session: { target: GraphTarget; token: string } | null = null;

  constructor(
    /** The tenant's sync identity; null when the tenant has none. */
    private readonly actor: WorkerActor | null,
    private readonly connectionId: string | null,
    readonly from: string,
  ) {}

  private async signIn(): Promise<{ target: GraphTarget; token: string }> {
    if (this.session) return this.session;
    if (!this.connectionId) {
      throw new EmailTransportError(
        'email is set to go through Microsoft 365, but the connection it used has been removed. '
        + 'Choose one under Administration → Email & notifications.',
        'misconfigured',
      );
    }

    if (!this.actor) {
      throw new EmailTransportError(
        'this tenant has no integration service account to open the Microsoft 365 secret with.',
        'misconfigured',
      );
    }
    const actor = this.actor;
    const connectionId = this.connectionId;
    const row = await withTenant(actor, async (tx) => {
      const [found] = await tx<ConnectionRow[]>`
        SELECT config ->> 'tenant_id' AS tenant, config ->> 'client_id' AS client_id,
               credential_secret_ids ->> 'client_secret' AS client_secret_id
        FROM integration_connection
        WHERE id = ${connectionId}::uuid AND provider = 'microsoft_graph'
      `;
      return found;
    }, { role: 'worker' });
    if (!row?.tenant || !row.client_id || !row.client_secret_id) {
      throw new EmailTransportError(
        'the Microsoft 365 connection has no tenant, client id or secret. '
        + 'Set them under Administration → Integrations → Microsoft 365.',
        'misconfigured',
      );
    }

    const revealed = await getSecretService().reveal(actor, row.client_secret_id, {
      purpose: 'integration',
      role: 'worker',
      reason: 'Email through Microsoft 365',
    });
    try {
      const target: GraphTarget = { tenant: row.tenant, clientId: row.client_id, clientSecret: revealed.value.expose() };
      const token = await fetchToken(target);
      // The secret is not kept past the sign-in: sendMail needs only the token.
      this.session = { target: { tenant: row.tenant, clientId: row.client_id, clientSecret: '' }, token };
      return this.session;
    } finally {
      revealed.value.dispose();
    }
  }

  async send(mail: OutgoingMail): Promise<void> {
    try {
      const { target, token } = await this.signIn();
      await sendMail(target, token, this.from, mail);
    } catch (error) {
      throw asTransportError(error);
    }
  }

  close(): void {
    this.session = null;
  }
}

/** Graph's failure, in the shape the queues already record. */
function asTransportError(error: unknown): EmailTransportError {
  if (error instanceof EmailTransportError) return error;
  if (error instanceof GraphError) {
    const message = `${error.message}${error.remedy ? ` — ${error.remedy}` : ''}`;
    // Throttling and Microsoft's own outages pass; the queue tries again. A
    // refused permission or a missing mailbox does not, until somebody fixes it.
    const passing = error.kind === 'unreachable'
      || (error.kind === 'http_error' && (error.status === 429 || (error.status ?? 0) >= 500));
    return new EmailTransportError(message, passing ? 'unreachable' : 'rejected');
  }
  return new EmailTransportError(error instanceof Error ? error.message.slice(0, 300) : String(error), 'rejected');
}
