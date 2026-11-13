/**
 * Is Helm's background worker alive, and what is it doing (1310)?
 *
 * Every sync runs in the worker. When it was stopped, stalled with every
 * pooled connection stuck, or locked out by another process, "Sync now"
 * answered "Queued" and then nothing happened, with nothing anywhere saying
 * why. The worker now writes a heartbeat each tick; this reads the latest one
 * for the integration cards, which turn it into a sentence.
 */
import type { HelmTx as Tx } from '@/lib/db/client';

export interface WorkerLiveness {
  /** The database's clock when this was read, so the browser's clock does not matter. */
  readonly now: string;
  readonly seenAt: string;
  readonly startedAt: string;
  /** Job name → since when, and whether it has its database connection yet. */
  readonly running: Record<string, { since: string; phase: 'connecting' | 'running' }>;
  /** Job name → since when another process has held its lock. */
  readonly lockedOut: Record<string, string>;
}

/** Null when no worker has ever checked in (or not since the update that added this). */
export async function readWorkerLiveness(tx: Tx): Promise<WorkerLiveness | null> {
  const [row] = await tx<{
    started_at: Date; seen_at: Date; running: unknown; locked_out: unknown; now: Date;
  }[]>`SELECT started_at, seen_at, running, locked_out, now FROM helm.worker_liveness()`;
  if (!row) return null;
  return {
    now: row.now.toISOString(),
    seenAt: row.seen_at.toISOString(),
    startedAt: row.started_at.toISOString(),
    running: (row.running ?? {}) as WorkerLiveness['running'],
    lockedOut: (row.locked_out ?? {}) as WorkerLiveness['lockedOut'],
  };
}

/** The worker ticks every 15 seconds; two minutes of silence is not a hiccup. */
export const WORKER_STALE_MS = 2 * 60 * 1000;
/** A Sync now not picked up within this long is worth explaining. */
export const QUEUED_SLOW_MS = 2 * 60 * 1000;

export interface RunLike {
  readonly status: string;
  readonly requestedAt?: string | null;
  readonly startedAt: string | null;
}

export type WaitingReason =
  | { kind: 'never'; }
  | { kind: 'stale'; seenAt: string; minutes: number }
  | { kind: 'connecting'; since: string; minutes: number }
  | { kind: 'busy'; since: string; minutes: number }
  | { kind: 'locked'; since: string }
  | { kind: 'not-picked-up'; minutes: number };

const minutesBetween = (from: string, to: string) =>
  Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60_000));

/**
 * Why runs for `jobName` are not happening, or null when nothing looks wrong.
 * A stopped worker is always worth saying; the rest only once a Sync now has
 * sat queued for a couple of minutes.
 */
export function waitingReason(
  worker: WorkerLiveness | null,
  jobName: string,
  runs: readonly RunLike[],
): WaitingReason | null {
  const queued = runs.find((r) => r.status === 'queued');
  if (!worker) return queued ? { kind: 'never' } : null;

  const silentMs = Date.parse(worker.now) - Date.parse(worker.seenAt);
  if (silentMs > WORKER_STALE_MS) {
    return { kind: 'stale', seenAt: worker.seenAt, minutes: minutesBetween(worker.seenAt, worker.now) };
  }

  if (!queued?.requestedAt) return null;
  const waited = Date.parse(worker.now) - Date.parse(queued.requestedAt);
  if (waited < QUEUED_SLOW_MS) return null;

  const job = worker.running[jobName];
  if (job?.phase === 'connecting') {
    return { kind: 'connecting', since: job.since, minutes: minutesBetween(job.since, worker.now) };
  }
  if (job) return { kind: 'busy', since: job.since, minutes: minutesBetween(job.since, worker.now) };
  const locked = worker.lockedOut[jobName];
  if (locked) return { kind: 'locked', since: locked };
  return { kind: 'not-picked-up', minutes: Math.round(waited / 60_000) };
}
