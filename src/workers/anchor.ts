/**
 * Audit chain anchoring.
 *
 * The per-tenant hash chain proves that nobody edited a historical audit row
 * without also rewriting every row after it. It does NOT prove that the whole
 * chain was not rewritten end to end by someone with ownership of the database
 * — which, on an on-premises deployment where the MSP's own staff administer
 * the server, is precisely the party an audit log most needs to bind.
 *
 * Anchoring closes that gap. Once the head hash at sequence N has been
 * witnessed somewhere Helm cannot reach or alter, history up to N is fixed: a
 * rewritten chain no longer matches the witness. Everything after the last
 * anchor is still only as trustworthy as the database, which is why the job
 * runs often and why `anchored_seq` is surfaced in the compliance export.
 *
 * Two things this job does that a naive "write the hash somewhere" would not:
 *
 *   It VERIFIES BEFORE IT ANCHORS. helm.verify_audit_chain() re-walks the chain
 *   and recomputes every row hash. Anchoring a chain that is already broken
 *   would be worse than not anchoring at all: it manufactures evidence that
 *   tampered history was witnessed intact.
 *
 *   It anchors a SPECIFIC (sequence, hash) pair and the database checks that
 *   the pair is real. A receipt naming a hash that never appeared in the chain
 *   proves nothing, and the failure would only be discovered by the auditor who
 *   tried to rely on it.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { db, withTenant } from '../lib/db/client';
import type { Job, JobContext, JobResult } from './runtime';
import { describeError } from './runtime';

interface AnchorBacklogRow {
  tenant_id: string;
  tenant_name: string;
  worker_actor_id: string;
  chain_seq: string;
  head_hash: Buffer;
  anchored_seq: string;
  anchored_at: Date | null;
  unanchored: string;
}

interface VerifyRow {
  verified_rows: string;
  first_seq: string | null;
  last_seq: string | null;
  is_intact: boolean;
  broken_at_seq: string | null;
}

/**
 * Where a witnessed head is recorded.
 *
 * The interface exists because the right answer is deployment-specific and
 * genuinely varies: an object-lock bucket, a transparency log, a HSM signature,
 * a line in a printed logbook kept in a safe. What every implementation must
 * provide is a reference that lets a future auditor find the witness again —
 * that reference is what `anchor_ref` stores, and the database refuses an empty
 * one.
 */
export interface AuditAnchorSink {
  readonly name: string;
  /** Returns the reference under which the receipt can be found later. */
  anchor(receipt: AnchorReceipt): Promise<string>;
}

export interface AnchorReceipt {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly chainSeq: number;
  readonly headHashHex: string;
  readonly verifiedRows: number;
  readonly witnessedAt: string;
}

/**
 * Append-only file sink: one JSON line per anchor, under HELM_AUDIT_ANCHOR_DIR.
 *
 * The default because it needs nothing beyond a filesystem, which an
 * on-premises deployment definitely has. It is only as good as the directory it
 * writes to — point it at a WORM mount, a share the Helm host can append to but
 * not rewrite, or a path your backup system snapshots. A directory the Helm
 * process can also rewrite is not a witness, and this is said here rather than
 * left for the reader to work out.
 */
export class FileAnchorSink implements AuditAnchorSink {
  readonly name = 'file';

  constructor(private readonly directory: string) {}

  async anchor(receipt: AnchorReceipt): Promise<string> {
    const day = receipt.witnessedAt.slice(0, 10);
    const path = join(this.directory, `helm-audit-anchors-${day}.jsonl`);
    await mkdir(dirname(path), { recursive: true });

    const line = JSON.stringify(receipt);
    // The receipt's own hash goes in the reference, so a modified line is
    // detectable from the database side alone.
    const digest = createHash('sha256').update(line).digest('hex').slice(0, 16);

    await writeFile(path, `${line}\n`, { flag: 'a', mode: 0o600 });
    return `file:${path}#${digest}`;
  }
}

/**
 * Records the receipt in the worker log and nothing else.
 *
 * The default when no sink is configured. Deliberately NOT silent: an operator
 * who has not set up a witness can still see that the chain is being verified
 * and where it has reached, and the log line is itself a (weak) witness if the
 * logs ship off-host. It does not write `anchored_seq`, because claiming an
 * anchor that does not exist is the failure this whole job is guarding against.
 */
export class LoggingAnchorSink implements AuditAnchorSink {
  readonly name = 'log';

  async anchor(receipt: AnchorReceipt): Promise<string> {
    console.log(JSON.stringify({ ts: receipt.witnessedAt, logger: 'anchor', msg: 'chain head', ...receipt }));
    throw new UnwitnessedError(
      'no audit anchor sink is configured; set HELM_AUDIT_ANCHOR_DIR to an ' +
        'append-only location, or install a sink with setAnchorSink()',
    );
  }
}

/** Raised when a head was verified but could not be witnessed. Not a chain fault. */
export class UnwitnessedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnwitnessedError';
  }
}

let sink: AuditAnchorSink | null = null;

export function resolveAnchorSink(): AuditAnchorSink {
  if (sink) return sink;
  const directory = process.env.HELM_AUDIT_ANCHOR_DIR?.trim();
  sink = directory ? new FileAnchorSink(directory) : new LoggingAnchorSink();
  return sink;
}

export function setAnchorSink(next: AuditAnchorSink | null): void {
  sink = next;
}

export function anchorAuditChainJob(): Job {
  return {
    name: 'audit.anchor',
    // Hourly. The window of history that is chain-protected but not
    // witness-protected is bounded by this interval, so it is a security
    // parameter rather than a scheduling convenience.
    everyMs: 60 * 60 * 1000,
    lockKey: 0x48_45_4c_4d_04,
    run: anchorAuditChains,
  };
}

async function anchorAuditChains(ctx: JobContext): Promise<JobResult> {
  const backlog = await db('worker')<AnchorBacklogRow[]>`SELECT * FROM helm.audit_anchor_backlog()`;
  if (backlog.length === 0) return { idle: true };

  const target = resolveAnchorSink();
  let anchored = 0;
  let broken = 0;
  let unwitnessed = 0;

  for (const tenant of backlog) {
    if (ctx.stopping()) break;
    const log = ctx.log.child({ tenant: tenant.tenant_name, sink: target.name });

    const actor = {
      tenantId: tenant.tenant_id,
      actorId: tenant.worker_actor_id,
      actorType: 'service_account' as const,
    };

    try {
      const [verification] = await withTenant(
        actor,
        async (tx) => tx<VerifyRow[]>`
          SELECT * FROM helm.verify_audit_chain(${tenant.tenant_id}::uuid)
        `,
        { role: 'worker' },
      );

      if (!verification?.is_intact) {
        // The loudest thing this system can say. Anchoring now would certify a
        // chain that has already been altered, so the job refuses and leaves
        // anchored_seq where it was — which is itself evidence, because the
        // last good anchor bounds when the alteration could have happened.
        broken += 1;
        log.error('AUDIT CHAIN IS BROKEN — not anchoring', {
          brokenAtSeq: verification?.broken_at_seq ?? null,
          lastAnchoredSeq: Number(tenant.anchored_seq),
          lastAnchoredAt: tenant.anchored_at?.toISOString() ?? null,
        });
        continue;
      }

      const receipt: AnchorReceipt = {
        tenantId: tenant.tenant_id,
        tenantName: tenant.tenant_name,
        chainSeq: Number(tenant.chain_seq),
        headHashHex: tenant.head_hash.toString('hex'),
        verifiedRows: Number(verification.verified_rows),
        witnessedAt: new Date().toISOString(),
      };

      let reference: string;
      try {
        reference = await target.anchor(receipt);
      } catch (error) {
        unwitnessed += 1;
        if (error instanceof UnwitnessedError) log.warn(error.message);
        else log.error('anchor sink failed', describeError(error));
        continue;
      }

      // Recorded only after the witness exists. The ordering matters: a crash
      // between the two leaves the anchor un-recorded and the next run repeats
      // it, which costs a duplicate receipt. The other ordering would claim an
      // anchor that was never written.
      await withTenant(
        actor,
        async (tx) => tx`
          SELECT helm.record_audit_anchor(
            ${tenant.tenant_id}::uuid, ${tenant.chain_seq}::bigint,
            ${tenant.head_hash}, ${reference}
          )
        `,
        { role: 'worker' },
      );

      anchored += 1;
      log.info('chain anchored', {
        chainSeq: receipt.chainSeq,
        newlyAnchored: Number(tenant.unanchored),
        ref: reference,
      });
    } catch (error) {
      log.error('anchoring failed', describeError(error));
    }
  }

  return { counts: { tenants: backlog.length, anchored, broken, unwitnessed } };
}
