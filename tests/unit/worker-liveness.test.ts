import { describe, expect, it } from 'vitest';
import { waitingReason, type WorkerLiveness } from '../../src/lib/integrations/worker-liveness';

const NOW = '2026-11-13T18:00:00.000Z';
const ago = (minutes: number) => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();

const worker = (over: Partial<WorkerLiveness> = {}): WorkerLiveness => ({
  now: NOW, seenAt: ago(0.2), startedAt: ago(600), running: {}, lockedOut: {}, ...over,
});
const queued = (minutes: number) => [{ status: 'queued', requestedAt: ago(minutes), startedAt: null }];

describe('why a sync is not starting', () => {
  it('says nothing when the worker is checking in and nothing is waiting', () => {
    expect(waitingReason(worker(), 'ninja.sync', [])).toBeNull();
    expect(waitingReason(worker(), 'ninja.sync', queued(0.5))).toBeNull();
  });

  it('says the worker has gone quiet, whether or not anything is queued', () => {
    expect(waitingReason(worker({ seenAt: ago(42) }), 'ninja.sync', [])).toMatchObject({ kind: 'stale', minutes: 42 });
  });

  it('says the worker has never checked in, once something is waiting for it', () => {
    expect(waitingReason(null, 'ninja.sync', [])).toBeNull();
    expect(waitingReason(null, 'ninja.sync', queued(1))).toEqual({ kind: 'never' });
  });

  it('names the job stuck waiting for a database connection', () => {
    const w = worker({ running: { 'ninja.sync': { since: ago(90), phase: 'connecting' } } });
    expect(waitingReason(w, 'ninja.sync', queued(5))).toMatchObject({ kind: 'connecting', minutes: 90 });
  });

  it('names a job that is still busy, and a lock held by another process', () => {
    const busy = worker({ running: { 'ninja.sync': { since: ago(300), phase: 'running' } } });
    expect(waitingReason(busy, 'ninja.sync', queued(5))).toMatchObject({ kind: 'busy', minutes: 300 });
    const locked = worker({ lockedOut: { 'ninja.sync': ago(30) } });
    expect(waitingReason(locked, 'ninja.sync', queued(5))).toMatchObject({ kind: 'locked' });
  });

  it('says plainly when the worker is fine but has not picked the request up', () => {
    expect(waitingReason(worker(), 'ninja.sync', queued(6))).toEqual({ kind: 'not-picked-up', minutes: 6 });
  });
});
