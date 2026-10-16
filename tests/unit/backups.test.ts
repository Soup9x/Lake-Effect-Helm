import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cronProblem, describeCron, nextRun, parseCron } from '../../src/lib/backups/cron';
import { decryptFile, encryptFile } from '../../src/lib/backups/crypto';
import { setName, setStamp, setsToPrune } from '../../src/lib/backups/retention';

describe('the cron parser', () => {
  it('finds the next daily, weekly and stepped slots in UTC', () => {
    const from = new Date('2026-10-16T14:30:00Z');
    expect(nextRun('0 2 * * *', from).toISOString()).toBe('2026-10-17T02:00:00.000Z');
    expect(nextRun('30 3 * * 0', from).toISOString()).toBe('2026-10-18T03:30:00.000Z');
    expect(nextRun('0 */6 * * *', from).toISOString()).toBe('2026-10-16T18:00:00.000Z');
    expect(nextRun('15 1 1 * *', from).toISOString()).toBe('2026-11-01T01:15:00.000Z');
    expect(nextRun('0 4 * * mon-fri', new Date('2026-10-17T10:00:00Z')).toISOString()).toBe('2026-10-19T04:00:00.000Z');
  });

  it('is strictly after the given instant', () => {
    expect(nextRun('0 2 * * *', new Date('2026-10-16T02:00:00Z')).toISOString()).toBe('2026-10-17T02:00:00.000Z');
  });

  it('refuses what it cannot run and explains', () => {
    expect(cronProblem('0 2 * *')).toMatch(/five fields/);
    expect(cronProblem('60 2 * * *')).toMatch(/outside/);
    expect(cronProblem('0 2 * * fun')).toMatch(/not a number/);
    expect(cronProblem('0 2 * * *')).toBeNull();
    expect(() => nextRun('0 0 31 2 *', new Date())).toThrow(/never comes round/);
  });

  it('describes the common shapes', () => {
    expect(describeCron('0 2 * * *')).toBe('Daily at 02:00 UTC');
    expect(describeCron('30 3 * * 0')).toBe('Every Sunday at 03:30 UTC');
    expect(describeCron('0 */6 * * *')).toBe('4 times a day');
    expect(parseCron('0 2 * * 7').daysOfWeek.has(0)).toBe(true);
  });
});

describe('the archive seal', () => {
  it('round-trips bytes and refuses the wrong passphrase', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'helm-bkp-'));
    const plain = join(dir, 'plain.bin');
    const body = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
    await writeFile(plain, body);
    const sealed = join(dir, 'plain.enc');
    const size = await encryptFile(plain, sealed, 'correct horse');
    expect(size).toBe(body.length + 8 + 16 + 12 + 16);

    const opened = join(dir, 'opened.bin');
    await decryptFile(sealed, opened, 'correct horse');
    expect((await readFile(opened)).equals(body)).toBe(true);

    await expect(decryptFile(sealed, join(dir, 'wrong.bin'), 'battery staple')).rejects.toThrow();
  });
});

describe('retention', () => {
  const now = new Date('2026-10-16T12:00:00Z');
  const day = (n: number) => ({ name: `s${n}`, createdAt: new Date(now.getTime() - n * 86_400_000) });

  it('keeps the newest N and anything within the window, whichever is more', () => {
    const sets = [1, 2, 3, 10, 40, 50, 60].map(day);
    expect(setsToPrune(sets, 30, 3, now).map((s) => s.name)).toEqual(['s40', 's50', 's60']);
    expect(setsToPrune(sets, 5, 6, now).map((s) => s.name)).toEqual(['s60']);
  });

  it('never prunes the newest set', () => {
    expect(setsToPrune([day(400)], 1, 1, now)).toEqual([]);
  });

  it('names sets so they sort and parse', () => {
    const at = new Date('2026-10-16T02:00:00Z');
    expect(setName(at)).toBe('helm-20261016T020000Z');
    expect(setStamp('helm-20261016T020000Z')?.toISOString()).toBe(at.toISOString());
    expect(setStamp('not-a-set')).toBeNull();
  });
});
