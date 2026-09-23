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
 *   03  integration.sync       07  auth.prune
 *   04  audit.anchor           08  notifications.fanout
 */
import { deliverExpiryAlertsJob, evaluateExpiryAlertsJob } from './alerts';
import { anchorAuditChainJob } from './anchor';
import { integrationSyncJob } from './sync';
import { renderExportsJob, expireExportsJob } from './exports';
import { pruneAuthAttemptsJob } from './auth-hygiene';
import { fanOutNotificationsJob, deliverNotificationsJob } from './notifications';
import { unifiSyncJob } from './unifi-sync';
import type { Job } from './runtime';

export function allJobs(): Job[] {
  return [
    evaluateExpiryAlertsJob(),
    deliverExpiryAlertsJob(),
    integrationSyncJob(),
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
  ];
}
