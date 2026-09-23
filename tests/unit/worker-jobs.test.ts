/**
 * The worker's job list is only as good as its lock keys.
 *
 * WorkerRuntime refuses to construct when two jobs share an advisory lock key,
 * and it is right to: two jobs on one key serialise against each other forever,
 * and the symptom is a job that mysteriously never runs. But that guard lived
 * only at start-up, and the list it guards lived in main.ts, which calls main()
 * at module load and so could not be imported and checked.
 *
 * So the guard fired in production instead of in CI. Three collisions shipped —
 * notifications.fanout took exports.render's key, notifications.deliver took
 * exports.expire's, and unifi.sync took auth.prune's — and the worker container
 * threw on construction and restarted forever, on a first install, with 880
 * other tests passing.
 *
 * These are the cheapest tests in the suite and they cover the whole class.
 */
import { describe, expect, it } from 'vitest';
import { allJobs } from '../../src/workers/jobs';
import { WorkerRuntime } from '../../src/workers/runtime';

/** Report collisions by name, because `310400273669` names nothing. */
function duplicatesBy<K>(key: (job: ReturnType<typeof allJobs>[number]) => K): string[] {
  const seen = new Map<K, string[]>();
  for (const job of allJobs()) {
    const existing = seen.get(key(job));
    if (existing) existing.push(job.name);
    else seen.set(key(job), [job.name]);
  }
  return [...seen.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([value, names]) => `${String(value)}: ${names.join(' + ')}`);
}

describe('the worker job list', () => {
  it('gives every job its own advisory lock key', () => {
    expect(duplicatesBy((job) => job.lockKey)).toEqual([]);
  });

  /**
   * WorkerRuntime keys its per-job state map by name. Two jobs sharing one
   * would silently share `lastRunAt` and `consecutiveFailures`, so one of them
   * would run on the other's schedule — quieter than a lock collision and
   * harder to see, since nothing throws.
   */
  it('gives every job its own name', () => {
    expect(duplicatesBy((job) => job.name)).toEqual([]);
  });

  it('constructs a runtime over the real list, which is what a deployment does', () => {
    expect(() => new WorkerRuntime(allJobs())).not.toThrow();
  });

  it('schedules every job on a positive interval', () => {
    for (const job of allJobs()) {
      expect(job.everyMs, `${job.name} must have a positive interval`).toBeGreaterThan(0);
    }
  });
});
