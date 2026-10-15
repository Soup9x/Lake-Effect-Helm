/**
 * The worker runtime's own guarantees, with real advisory locks.
 *
 * Three of them were missing: `--once` exited 0 whatever failed, nothing capped
 * how many jobs ran at once (so a small pool could be filled entirely with
 * held locks), and stop() waited only for the latest tick — not for a long job
 * an earlier tick had started.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkerRuntime, type Job, type JobLogger } from '../../src/workers/runtime';
import { connectPools, disconnectPools, resetDatabase } from './harness';

const quiet: JobLogger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  child: () => quiet,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Lock keys well clear of the real jobs' 0x48454C4D01..0D. */
let nextKey = 0x7e57_0000;
function job(name: string, run: Job['run'], everyMs = 60_000): Job {
  nextKey += 1;
  return { name, everyMs, lockKey: nextKey, run };
}

beforeAll(async () => {
  resetDatabase();
  connectPools();
}, 120_000);

afterAll(async () => {
  await disconnectPools();
});

describe('runOnce', () => {
  it('reports how many jobs failed, so --once can exit non-zero', async () => {
    const runtime = new WorkerRuntime(
      [
        job('fine', async () => ({ idle: true })),
        job('broken', async () => { throw new Error('nope'); }),
        job('also fine', async () => ({ idle: false })),
      ],
      { logger: quiet },
    );
    expect(await runtime.runOnce()).toEqual({ failed: 1 });
  });

  it('never runs more jobs at once than maxConcurrent, and still runs them all', async () => {
    let running = 0;
    let peak = 0;
    const ran: string[] = [];
    const slow = (name: string): Job =>
      job(name, async () => {
        running += 1;
        peak = Math.max(peak, running);
        await sleep(40);
        running -= 1;
        ran.push(name);
        return { idle: false };
      });

    const runtime = new WorkerRuntime(['a', 'b', 'c', 'd', 'e'].map(slow), {
      logger: quiet,
      maxConcurrent: 2,
    });
    expect(await runtime.runOnce()).toEqual({ failed: 0 });
    expect(peak).toBe(2);
    expect(ran.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('stop', () => {
  it('waits for a job an earlier tick started', async () => {
    let finished = false;
    const runtime = new WorkerRuntime(
      [
        job('long', async () => {
          await sleep(400);
          finished = true;
          return { idle: false };
        }, 1),
      ],
      { logger: quiet, tickMs: 50 },
    );

    runtime.start();
    // Several ticks pass while the job runs; each skips it as still running,
    // which is exactly when the old stop() lost track of it.
    await sleep(200);
    await runtime.stop();
    expect(finished).toBe(true);
  });
});
