/**
 * The job list, in one place that can be imported without starting a worker.
 *
 * It lived in main.ts, which calls main() at module load — so nothing could
 * import it to check it, and the one invariant the runtime enforces (no two
 * jobs share an advisory lock key) was only ever tested by starting the
 * container. Three collisions reached a release that way: notifications reused
 * the two export keys and unifi-sync reused auth-hygiene's, so
 * `new WorkerRuntime(...)` threw on construction and the worker restarted
 * forever. tests/unit/worker-jobs.test.ts now asserts it in CI instead.
 *
 * LOCK KEYS ARE ALLOCATED HERE, and the table below is the allocation. A new
 * job takes the next free value; it never borrows one that reads as related.
 * The keys are arbitrary — 0x48454C4D is "HELM" — and only their uniqueness
 * matters, so there is no reason to reuse one and every reason not to.
 *
 *   01  alerts.evaluate        05  exports.render       09  notifications.deliver
 *   02  alerts.deliver         06  exports.expire       0a  unifi.sync
 *   03  (retired)              07  auth.prune           0b  external.checks
 *   04  audit.anchor           08  notifications.fanout 0c  reminders.raise
 *                                                       0d  reminders.deliver
 *                                                       0e  checklists.schedule
 *                                                       0f  ninja.sync
 *                                                       10  m365.sync
 *                                                       11  accounts.email
 *                                                       12  proxmox.sync
 *                                                       13  action1.sync
 *
 * 03 belonged to integration.sync, the generic RMM/PSA adapter, removed because
 * nothing could configure a connection for it. Do not reuse it: an old worker
 * still running during a rolling upgrade could hold it.
 */
import { deliverExpiryAlertsJob, evaluateExpiryAlertsJob } from './alerts';
import { anchorAuditChainJob } from './anchor';
import { renderExportsJob, expireExportsJob } from './exports';
import { pruneAuthAttemptsJob } from './auth-hygiene';
import { fanOutNotificationsJob, deliverNotificationsJob } from './notifications';
import { unifiSyncJob } from './unifi-sync';
import { externalChecksJob } from './external-checks';
import { deliverRemindersJob, raiseRemindersJob } from './reminders';
import { scheduleChecklistsJob } from './schedules';
import { ninjaSyncJob } from './ninja-sync';
import { m365SyncJob } from './m365-sync';
import { accountEmailJob } from './account-email';
import { proxmoxSyncJob } from './proxmox-sync';
import { action1SyncJob } from './action1-sync';
import type { Job } from './runtime';

export function allJobs(): Job[] {
  return [
    evaluateExpiryAlertsJob(),
    deliverExpiryAlertsJob(),
    anchorAuditChainJob(),
    renderExportsJob(),
    expireExportsJob(),
    pruneAuthAttemptsJob(),
    // 0400 removed two-person approval from credential exports on the stated
    // understanding that detection replaces prevention. These two jobs ARE the
    // detection, so a deployment running the worker at all runs them.
    fanOutNotificationsJob(),
    deliverNotificationsJob(),
    // Which mappings are due is decided by next_poll_at in the database, from
    // each mapping's own interval — this job's tick is the granularity of
    // "due", not a polling rate.
    unifiSyncJob(),
    // Domain and certificate probes (H). Registered unconditionally and inert
    // unless a tenant opted in: the backlog joins external_check_setting, so an
    // air-gapped install runs this job and it reports idle, every tick,
    // forever. That is cheaper than a registration branch somebody has to
    // remember, and it means the job's own log line says "nothing to do"
    // rather than the job being invisible.
    externalChecksJob(),
    /*
     * Checklist reminders, split evaluation from delivery the same way the
     * expiry alerts are: a relay that is down must not stop tomorrow's sweep
     * from noticing that a step is now overdue. Both contribute nothing until a
     * tenant has configured a mail relay, which 0690 makes structural.
     */
    raiseRemindersJob(),
    deliverRemindersJob(),
    // Recurring checklists (0770): raises a run for every schedule whose slot
    // has arrived, as the tenant's sync worker identity, then moves the slot
    // on. Idle for a tenant with no schedules, like the reminders above.
    scheduleChecklistsJob(),
    // NinjaOne device sync (0980). Idle for a tenant that has not configured
    // a connection: sync_due() only returns enabled ones.
    ninjaSyncJob(),
    // Microsoft 365 per client (0990). Idle until a client is connected.
    m365SyncJob(),
    // Invitations and password links (1000), through the tenant's relay.
    accountEmailJob(),
    // Proxmox per cluster (1110). Idle until a cluster is connected.
    proxmoxSyncJob(),
    // Action1 endpoint sync (1160). Idle until a connection is saved.
    action1SyncJob(),
  ];
}
