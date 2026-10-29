/**
 * Refreshing what the outside world says about a domain or a certificate.
 *
 * OFF UNTIL SOMEBODY TURNS IT ON, which is decision 4 and is the first thing
 * this file does: the backlog comes from helm.external_check_backlog(), which
 * joins external_check_setting, so a tenant with no row contributes nothing and
 * an air-gapped install reports idle forever. There is no environment variable
 * to forget and no configuration that makes traffic leave the building by
 * default.
 *
 * NOTHING A PERSON TYPED IS OVERWRITTEN. The probe writes beside it:
 * `domain.registry_expires_at` next to `domain.expires_at`,
 * `ssl_certificate.observed_not_after` next to `not_after`. 0110's house rule
 * is that inbound data never overwrites a hand-edited field, and taken
 * literally ("only fill fields that are still NULL") it would defeat a refresh
 * job — so this keeps the rule's intent and gets the feature: both values
 * exist, and a DISAGREEMENT between them is visible rather than resolved behind
 * somebody's back. 0670's header has the full reasoning.
 *
 * EVERY FAILURE IS A RECORDED FACT, NOT AN EXCEPTION. A registry that is down,
 * a TLD with no RDAP service, a host that does not answer on 443 — each is
 * written to last_check_status and last_check_error and the job carries on. A
 * probe that threw would retry the same unreachable host every tick and fill
 * the error log with somebody else's outage.
 *
 * 'unsupported' IS NOT 'failed'. A ccTLD that publishes no expiry event will
 * never publish one; showing that in red beside a real outage trains people to
 * ignore both.
 *
 * WRITES ARE TENANT-SCOPED, through withTenant(..., { role: 'worker' }), and
 * that is not boilerplate: helm_worker is subject to RLS like every other role.
 * The first version of this job read the backlog as the bare worker and then ran
 * `UPDATE domain ... WHERE id = $1` with no tenant context, so every write
 * matched ZERO ROWS and reported success — the job logged a tidy count of
 * failures recorded while recording nothing at all. An integration test caught
 * it; nothing in the SQL could have, because an UPDATE that matches no rows is
 * not an error. The cross-tenant read stays on the bare worker because
 * helm.external_check_backlog() is SECURITY DEFINER; it hands back the tenant's
 * own system_sync actor so each write can go back inside that tenant.
 */
import { db, withTenant } from '../lib/db/client';
import { observeCertificate, CertificateProbeError } from '../lib/external/certificate';
import { lookupDomain, RdapError } from '../lib/external/rdap';
import type { Job, JobContext, JobResult } from './runtime';

interface BacklogRow {
  kind: 'domain' | 'certificate';
  row_id: string;
  tenant_id: string;
  /** The tenant's system_sync service account; see WRITES ARE TENANT-SCOPED. */
  worker_actor_id: string;
  target: string | null;
  rdap_base_url: string;
  interval_hours: number;
}

/** What withTenant needs to put a worker inside one tenant. */
type Actor = { tenantId: string; actorId: string; actorType: 'service_account' };

function actorFor(row: BacklogRow): Actor {
  return { tenantId: row.tenant_id, actorId: row.worker_actor_id, actorType: 'service_account' };
}

/** How long a claim holds before another worker may retry the same row. */
const CLAIM_SECONDS = 300;

export function externalChecksJob(): Job {
  return {
    name: 'external.checks',
    // The scheduler ticks every minute; WHICH rows are due is decided by
    // next_check_at in the database, from each tenant's own interval. This
    // number is the granularity of "due", not a probing rate.
    everyMs: 60 * 1000,
    lockKey: 0x48_45_4c_4d_0b,
    run: runExternalChecks,
  };
}

async function runExternalChecks(ctx: JobContext): Promise<JobResult> {
  const backlog = await db('worker')<BacklogRow[]>`
    SELECT * FROM helm.external_check_backlog(25)
  `;
  if (backlog.length === 0) return { idle: true };

  const counts = { domains: 0, certificates: 0, failed: 0, unsupported: 0, skipped: 0 };

  for (const row of backlog) {
    if (ctx.stopping()) break;

    const actor = actorFor(row);

    // Claimed one row at a time, so a shutdown mid-backlog leaves the rest
    // unclaimed for the next tick rather than holding a block of them.
    const claimed = await withTenant(
      actor,
      async (tx) => {
        const [claim] = row.kind === 'domain'
          ? await tx<{ claimed: boolean }[]>`
              SELECT helm.claim_domain_check(${row.row_id}::uuid, ${CLAIM_SECONDS}) AS claimed
            `
          : await tx<{ claimed: boolean }[]>`
              SELECT helm.claim_certificate_check(${row.row_id}::uuid, ${CLAIM_SECONDS}) AS claimed
            `;
        return claim?.claimed === true;
      },
      { role: 'worker' },
    );
    if (!claimed) {
      counts.skipped += 1;
      continue;
    }

    const log = ctx.log.child({ kind: row.kind, id: row.row_id, tenant: row.tenant_id });

    if (!row.target || row.target.trim() === '') {
      // A certificate with no common name, or a domain row with no name: there
      // is nothing to look up, and saying so against the row beats probing
      // whatever an empty string resolves to.
      await record(
        row,
        actor,
        'unsupported',
        `no ${row.kind === 'domain' ? 'domain name' : 'common name'} to look up`,
      );
      counts.unsupported += 1;
      continue;
    }

    try {
      if (row.kind === 'domain') {
        const found = await lookupDomain(row.rdap_base_url, row.target);
        /*
         * The details are kept even when the expiry is missing: a ccTLD that
         * publishes no expiration still names its registrar and nameservers,
         * and those are worth offering. The row is still 'unsupported' then,
         * because the expiry is what 0670's status is about.
         */
        const details = found.details as never;
        if (!found.expiry) {
          await withTenant(
            actor,
            async (tx) => tx`
              UPDATE domain SET registry_details = ${tx.json(details)}
              WHERE id = ${row.row_id}::uuid
            `,
            { role: 'worker' },
          );
          throw found.expiryError!;
        }
        const expiry = found.expiry;
        await withTenant(
          actor,
          async (tx) => tx`
            UPDATE domain SET
              registry_expires_at = ${expiry.expiresAt},
              registry_details    = ${tx.json(details)},
              last_checked_at     = now(),
              next_check_at       = now() + make_interval(hours => ${row.interval_hours}),
              last_check_status   = 'ok',
              last_check_error    = NULL
            WHERE id = ${row.row_id}::uuid
          `,
          { role: 'worker' },
        );
        counts.domains += 1;
      } else {
        const found = await observeCertificate(row.target);
        await withTenant(
          actor,
          async (tx) => tx`
            UPDATE ssl_certificate SET
              observed_not_after          = ${found.notAfter},
              observed_fingerprint_sha256 = ${found.fingerprintSha256},
              last_checked_at             = now(),
              next_check_at               = now() + make_interval(hours => ${row.interval_hours}),
              last_check_status           = 'ok',
              last_check_error            = NULL
            WHERE id = ${row.row_id}::uuid
          `,
          { role: 'worker' },
        );
        counts.certificates += 1;
      }
    } catch (error) {
      const unsupported = (error instanceof RdapError
        && (error.reason === 'unsupported' || error.reason === 'not_found'));
      const status = unsupported ? 'unsupported' : 'failed';
      const message = error instanceof RdapError || error instanceof CertificateProbeError
        ? error.message
        // Anything else is a bug in this file rather than somebody's outage, so
        // it is logged at error level AND recorded, instead of being swallowed.
        : `unexpected probe failure: ${error instanceof Error ? error.message : String(error)}`;

      if (!(error instanceof RdapError) && !(error instanceof CertificateProbeError)) {
        log.error('a probe failed in a way this job did not anticipate', { message });
      } else {
        log.debug('probe did not answer', { status, message });
      }

      await record(row, actor, status, message);
      if (unsupported) counts.unsupported += 1;
      else counts.failed += 1;
    }
  }

  return { counts };
}

/**
 * Write a non-success outcome against the row, and push the next check out.
 *
 * THE NEXT CHECK IS SCHEDULED EVEN ON FAILURE, which is the difference between
 * a job that retries politely and one that hammers a registry that is having a
 * bad day. The claim already moved next_check_at forward by CLAIM_SECONDS; this
 * sets it to the tenant's full interval, so a failure waits as long as a
 * success does.
 *
 * `last_checked_at` is NOT set on a failure, deliberately. It means "when did
 * we last successfully learn something", which is what "last checked: never"
 * has to mean on screen — a failed probe that advanced it would make a domain
 * nobody has ever successfully looked up read as recently checked.
 */
async function record(
  row: BacklogRow,
  actor: Actor,
  status: 'failed' | 'unsupported',
  message: string,
): Promise<void> {
  // Truncated: an error message is for a human reading one row, and some
  // registries answer with an HTML page.
  const error = message.slice(0, 500);
  await withTenant(
    actor,
    async (tx) => {
      if (row.kind === 'domain') {
        await tx`
          UPDATE domain SET
            next_check_at     = now() + make_interval(hours => ${row.interval_hours}),
            last_check_status = ${status}::external_check_status,
            last_check_error  = ${error}
          WHERE id = ${row.row_id}::uuid
        `;
      } else {
        await tx`
          UPDATE ssl_certificate SET
            next_check_at     = now() + make_interval(hours => ${row.interval_hours}),
            last_check_status = ${status}::external_check_status,
            last_check_error  = ${error}
          WHERE id = ${row.row_id}::uuid
        `;
      }
    },
    { role: 'worker' },
  );
}
