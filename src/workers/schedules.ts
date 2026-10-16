/**
 * Scheduled checklists: raise the runs whose slot has arrived.
 *
 * The same shape as the expiry alerts. A cross-tenant backlog says which
 * tenants have a due schedule and which worker identity to run as; the raise
 * itself happens inside each tenant's context, so the run, its steps, the
 * reminders and the audit row are written exactly as a person's would be,
 * under RLS, with an actor the audit log can name.
 *
 * IDEMPOTENT BY CONSTRUCTION. helm.raise_scheduled_runs() takes the due rows
 * FOR UPDATE SKIP LOCKED and advances each schedule in the same transaction
 * as the run it creates, so two runtimes on one tick raise one run, and a
 * tick that dies between the INSERT and the UPDATE rolls both back.
 *
 * MISSED SLOTS ARE SKIPPED, NOT QUEUED. A worker that was down for a month
 * raises one run per schedule, not four; the function advances by whole
 * intervals past everything already gone.
 */
import { withTenant, db } from '../lib/db/client';
import type { Job, JobContext, JobResult } from './runtime';
import { describeError } from './runtime';

interface BacklogRow {
  tenant_id: string;
  tenant_name: string;
  worker_actor_id: string;
  due: string;
}

interface RaisedRow {
  schedule_id: string;
  run_id: string | null;
  outcome: 'raised' | 'skipped';
}

export function scheduleChecklistsJob(): Job {
  return {
    name: 'checklists.schedule',
    // Five minutes: a slot is a date, so a run that appears within minutes of
    // it is on time, and a finer tick does the same backlog query for nothing.
    everyMs: 5 * 60 * 1000,
    lockKey: 0x48_45_4c_4d_0e,
    run: raiseScheduledRuns,
  };
}

async function raiseScheduledRuns(ctx: JobContext): Promise<JobResult> {
  const backlog = await db('worker')<BacklogRow[]>`SELECT * FROM helm.schedule_backlog(25)`;
  if (backlog.length === 0) return { idle: true };

  let raised = 0;
  let skipped = 0;
  let failed = 0;

  for (const tenant of backlog) {
    if (ctx.stopping()) break;
    const log = ctx.log.child({ tenant: tenant.tenant_name });
    try {
      const rows = await withTenant(
        { tenantId: tenant.tenant_id, actorId: tenant.worker_actor_id, actorType: 'service_account' },
        (tx) => tx<RaisedRow[]>`SELECT * FROM helm.raise_scheduled_runs(100)`,
        { role: 'worker' },
      );
      for (const row of rows) {
        if (row.outcome === 'raised') raised += 1;
        else {
          skipped += 1;
          log.warn('schedule skipped', { schedule: row.schedule_id });
        }
      }
    } catch (error) {
      // One tenant's failure must not stop the next tenant's slots.
      failed += 1;
      log.error('could not raise scheduled runs', describeError(error));
    }
  }

  return { counts: { tenants: backlog.length, raised, skipped, failed }, idle: raised + skipped + failed === 0 };
}
