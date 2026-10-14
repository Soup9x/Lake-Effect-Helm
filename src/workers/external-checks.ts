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
 */
import { db } from '../lib/db/client';
import { observeCertificate, CertificateProbeError } from '../lib/external/certificate';
import { lookupDomainExpiry, RdapError } from '../lib/external/rdap';
import type { Job, JobContext, JobResult } from './runtime';

interface BacklogRow {
  kind: 'domain' | 'certificate';
  row_id: string;
  tenant_id: string;
  target: string | null;
  rdap_base_url: string;
  interval_hours: number;
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

    // Claimed one row at a time, so a shutdown mid-backlog leaves the rest
    // unclaimed for the next tick rather than holding a block of them.
    const [claim] = row.kind === 'domain'
      ? await db('worker')<{ claimed: boolean }[]>`
          SELECT helm.claim_domain_check(${row.row_id}::uuid, ${CLAIM_SECONDS}) AS claimed
        `
      : await db('worker')<{ claimed: boolean }[]>`
          SELECT helm.claim_certificate_check(${row.row_id}::uuid, ${CLAIM_SECONDS}) AS claimed
        `;
    if (!claim?.claimed) {
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
        'unsupported',
        `no ${row.kind === 'domain' ? 'domain name' : 'common name'} to look up`,
      );
      counts.unsupported += 1;
      continue;
    }

    try {
      if (row.kind === 'domain') {
        const found = await lookupDomainExpiry(row.rdap_base_url, row.target);
        await db('worker')`
          UPDATE domain SET
            registry_expires_at = ${found.expiresAt},
            last_checked_at     = now(),
            next_check_at       = now() + make_interval(hours => ${row.interval_hours}),
            last_check_status   = 'ok',
            last_check_error    = NULL
          WHERE id = ${row.row_id}::uuid
        `;
        counts.domains += 1;
      } else {
        const found = await observeCertificate(row.target);
        await db('worker')`
          UPDATE ssl_certificate SET
            observed_not_after          = ${found.notAfter},
            observed_fingerprint_sha256 = ${found.fingerprintSha256},
            last_checked_at             = now(),
            next_check_at               = now() + make_interval(hours => ${row.interval_hours}),
            last_check_status           = 'ok',
            last_check_error            = NULL
          WHERE id = ${row.row_id}::uuid
        `;
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

      await record(row, status, message);
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
  status: 'failed' | 'unsupported',
  message: string,
): Promise<void> {
  // Truncated: an error message is for a human reading one row, and some
  // registries answer with an HTML page.
  const error = message.slice(0, 500);
  if (row.kind === 'domain') {
    await db('worker')`
      UPDATE domain SET
        next_check_at     = now() + make_interval(hours => ${row.interval_hours}),
        last_check_status = ${status}::external_check_status,
        last_check_error  = ${error}
      WHERE id = ${row.row_id}::uuid
    `;
  } else {
    await db('worker')`
      UPDATE ssl_certificate SET
        next_check_at     = now() + make_interval(hours => ${row.interval_hours}),
        last_check_status = ${status}::external_check_status,
        last_check_error  = ${error}
      WHERE id = ${row.row_id}::uuid
    `;
  }
}
