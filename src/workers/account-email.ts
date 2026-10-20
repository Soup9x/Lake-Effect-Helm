/**
 * Account emails (1000): "you have access", "choose your password", "reset
 * your password" — sent through the tenant's own relay, like every message
 * Helm sends.
 *
 * THE LINK IS MADE HERE, at the moment of sending. The queued row says who and
 * what; this mints a token, hands only its digest to the database
 * (helm.issue_account_link), and puts the token in the message. Nothing at rest
 * holds a working link.
 *
 * A FAILURE SAYS WHY on the People page: no relay, an address outside the
 * domains this MSP allows, no public address to build a link from, or what the
 * relay itself answered. Configuration problems fail at once rather than
 * retrying, because retrying them changes nothing; a relay that is briefly
 * down is retried with backoff.
 */
import { randomBytes, createHash } from 'node:crypto';
import { db } from '../lib/db/client';
import type { Job, JobContext, JobResult } from './runtime';
import { describeError } from './runtime';
import { EmailBatch, recordRelayResult } from '../lib/email/sender';
import { EmailTransportError } from '../lib/email/transport';

interface BacklogRow {
  id: string;
  tenant_id: string;
  tenant_name: string;
  worker_actor_id: string;
  user_id: string;
  email: string;
  name: string | null;
  kind: 'access_granted' | 'password_setup' | 'password_reset';
  attempts: number;
}

/** How long each link works. A first password gets a day; a reset, an hour. */
const LINK_MINUTES = { password_setup: 1440, password_reset: 60 } as const;

export function accountEmailJob(): Job {
  return {
    name: 'accounts.email',
    // Somebody is usually waiting for this one, so it runs often.
    everyMs: 20 * 1000,
    lockKey: 0x48_45_4c_4d_11,
    run: sendAccountEmails,
  };
}

function publicBase(): string {
  return (process.env.HELM_PUBLIC_URL ?? process.env.AUTH_URL ?? '').replace(/\/+$/, '');
}

async function sendAccountEmails(ctx: JobContext): Promise<JobResult> {
  const backlog = await db('worker')<BacklogRow[]>`SELECT * FROM helm.account_email_backlog(50)`;
  if (backlog.length === 0) return { idle: true };

  let sent = 0;
  let failed = 0;
  const batches = new Map<string, EmailBatch | null>();

  try {
    for (const row of backlog) {
      if (ctx.stopping()) break;
      const actor = { tenantId: row.tenant_id, actorId: row.worker_actor_id, actorType: 'service_account' as const };
      const log = ctx.log.child({ tenant: row.tenant_name, kind: row.kind });

      const record = (ok: boolean, error: string | null, final: boolean) => db('worker')`
        SELECT helm.record_account_email(${row.id}::uuid, ${ok}, ${error}, ${final})
      `;

      if (!batches.has(row.tenant_id)) {
        batches.set(row.tenant_id, await EmailBatch.open(actor).catch((error) => {
          log.warn('could not open the relay', describeError(error));
          return null;
        }));
      }
      const batch = batches.get(row.tenant_id) ?? null;
      if (!batch) {
        failed += 1;
        await record(false, 'Email is not set up for this MSP. Configure the mail relay under Administration → Email & notifications, then send again.', true);
        continue;
      }

      const base = publicBase();
      let link: { url: string; expiresAt: Date } | null = null;
      if (row.kind !== 'access_granted') {
        if (!base) {
          failed += 1;
          await record(false, 'HELM_PUBLIC_URL is not set, so the link in the email would not open. Set it and send again.', true);
          continue;
        }
        try {
          const token = randomBytes(32).toString('base64url');
          const digest = createHash('sha256').update(token).digest();
          const [issued] = await db('worker')<{ issue_account_link: Date }[]>`
            SELECT helm.issue_account_link(${row.id}::uuid, ${digest}, ${LINK_MINUTES[row.kind]})
          `;
          const setup = row.kind === 'password_setup' ? '&setup=1' : '';
          link = { url: `${base}/sign-in/reset?token=${encodeURIComponent(token)}${setup}`, expiresAt: issued!.issue_account_link };
        } catch (error) {
          failed += 1;
          await record(false, String(describeError(error).error ?? 'the link could not be made'), true);
          continue;
        }
      }

      try {
        await batch.send({ to: row.email, ...render(row, base, link) }, { recipientGate: false });
        await record(true, null, false);
        await recordRelayResult(row.tenant_id, true);
        sent += 1;
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        // A refused recipient is configuration; a relay that did not answer
        // may answer next time.
        const final = error instanceof EmailTransportError && (error.reason === 'misconfigured' || error.reason === 'rejected');
        await record(false, message, final);
        if (!final) await recordRelayResult(row.tenant_id, false, message);
        log.warn('account email not sent', { final, ...describeError(error) });
      }
    }
  } finally {
    for (const batch of batches.values()) batch?.close();
  }

  return { counts: { sent, failed }, idle: sent === 0 && failed === 0 };
}

function render(
  row: BacklogRow,
  base: string,
  link: { url: string; expiresAt: Date } | null,
): { subject: string; text: string } {
  const hello = row.name ? `Hello ${row.name},` : 'Hello,';
  const signIn = base ? `${base}/sign-in` : 'the Helm sign-in page';
  const lasts = (d: Date) => {
    const minutes = Math.max(1, Math.round((d.getTime() - Date.now()) / 60_000));
    return minutes >= 120 ? `${Math.round(minutes / 60)} hours` : `${minutes} minutes`;
  };

  switch (row.kind) {
    case 'access_granted':
      return {
        subject: `You have access to ${row.tenant_name} in Lake Effect Helm`,
        text: [
          hello, '',
          `You have been given access to ${row.tenant_name} in Lake Effect Helm.`,
          `Sign in at ${signIn} with your work account (${row.email}).`,
        ].join('\n'),
      };
    case 'password_setup':
      return {
        subject: `Set up your Lake Effect Helm account for ${row.tenant_name}`,
        text: [
          hello, '',
          `An account has been created for you at ${row.tenant_name} in Lake Effect Helm.`,
          'Choose your password here:', '',
          link!.url, '',
          `The link works once and expires in ${lasts(link!.expiresAt)}. After that, sign in at ${signIn} with ${row.email}.`,
          'If you were not expecting this, you can ignore it.',
        ].join('\n'),
      };
    case 'password_reset':
      return {
        subject: 'Reset your Lake Effect Helm password',
        text: [
          hello, '',
          `An administrator at ${row.tenant_name} sent you a link to set a new Lake Effect Helm password:`, '',
          link!.url, '',
          `The link works once and expires in ${lasts(link!.expiresAt)}. Your current password keeps working until you use it.`,
        ].join('\n'),
      };
  }
}
