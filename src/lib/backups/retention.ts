/**
 * Which backup sets to keep: the newest `keepCount`, and anything younger
 * than `keepDays`, whichever keeps more. Never the newest one, whatever the
 * numbers say — a retention rule that can delete the only backup is a bug
 * with a schedule.
 */
export interface BackupSet {
  name: string;
  createdAt: Date;
}

export function setsToPrune(sets: readonly BackupSet[], keepDays: number, keepCount: number, now: Date): BackupSet[] {
  const sorted = [...sets].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const cutoff = now.getTime() - keepDays * 86_400_000;
  return sorted.filter((set, index) => index > 0 && index >= keepCount && set.createdAt.getTime() < cutoff);
}

/** helm-20261016T020000Z — sortable, and the stamp is the manifest's too. */
export function setName(at: Date): string {
  return `helm-${at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`;
}

export function setStamp(name: string): Date | null {
  const m = /^helm-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(name);
  if (!m) return null;
  return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!));
}
