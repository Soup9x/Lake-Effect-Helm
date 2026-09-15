/**
 * Worker entry point: `pnpm helm:worker`.
 *
 * Runs as helm_worker, which is a member of helm_app — same table privileges,
 * same RLS policies — plus EXECUTE on the cross-tenant backlog enumerators that
 * the request role must never hold.
 *
 * Deployment shapes, both supported:
 *
 *   LONG-RUNNING (default). One systemd unit alongside the web tier. Multiple
 *   instances are safe: each job takes a Postgres advisory lock, so exactly one
 *   instance does the work and the others skip that tick.
 *
 *   ONE-SHOT (--once). Run every job once and exit, for a deployment that
 *   prefers its own cron or a Kubernetes CronJob. Same code, same locking.
 */
import { closeAllPools } from '../lib/db/client';
import { describeKeyCustody } from '../lib/services';
import { deliverExpiryAlertsJob, evaluateExpiryAlertsJob } from './alerts';
import { anchorAuditChainJob } from './anchor';
import { integrationSyncJob } from './sync';
import { renderExportsJob, expireExportsJob } from './exports';
import { pruneAuthAttemptsJob } from './auth-hygiene';
import { WorkerRuntime, createLogger, type LogLevel } from './runtime';

function jobs() {
  return [
    evaluateExpiryAlertsJob(),
    deliverExpiryAlertsJob(),
    integrationSyncJob(),
    anchorAuditChainJob(),
    renderExportsJob(),
    expireExportsJob(),
    pruneAuthAttemptsJob(),
  ];
}

async function main(): Promise<void> {
  const once = process.argv.includes('--once');
  const log = createLogger('helm-worker', (process.env.HELM_LOG_LEVEL as LogLevel) ?? 'info');

  // Resolve key custody at start-up rather than on the first secret the sync
  // worker touches. A misconfigured KEK should fail the unit immediately, where
  // the deployment notices, not four hours later inside one tenant's sync run.
  const custody = describeKeyCustody();
  log.info('key custody resolved', {
    provider: custody.provider,
    custody: custody.custody,
    hostHoldsMasterKey: custody.hostHoldsMasterKey,
  });

  const runtime = new WorkerRuntime(jobs(), { logger: log });

  if (once) {
    await runtime.runOnce();
    await closeAllPools();
    return;
  }

  runtime.start();

  // Graceful shutdown: stop scheduling, let in-flight jobs finish, then release
  // the pools — which is what releases the advisory locks. Exiting without this
  // leaves a lock held until the server notices the dead connection.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { signal });
    void runtime
      .stop()
      .then(() => closeAllPools())
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        log.error('shutdown failed', { error: String(error) });
        process.exit(1);
      });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Hold the process open; the scheduler's timer is unref'd on purpose so that
  // this interval is the single thing keeping the runtime alive.
  setInterval(() => {}, 1 << 30);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
