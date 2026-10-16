/**
 * The backup schedule and destination as the Settings page sees them (0820).
 *
 * Everything here goes through helm.backup_settings(), set_backup_settings(),
 * backup_runs() and request_backup(): the tables themselves grant nothing to
 * the application role, and each function insists on tenant:write.
 */
import { z } from 'zod';
import type { HelmTx } from '../db/client';
import { cronProblem } from './cron';

export interface BackupSettings {
  enabled: boolean;
  schedule: string;
  destinationKind: 'local' | 's3';
  localSubdir: string;
  s3Bucket: string | null;
  s3Prefix: string;
  s3Endpoint: string | null;
  s3Region: string;
  keepDays: number;
  keepCount: number;
  includeVolumes: boolean;
  verifyWeekday: number | null;
  updatedAt: string;
}

export interface BackupRun {
  id: string;
  kind: 'backup' | 'verify';
  trigger: 'schedule' | 'manual';
  status: 'requested' | 'running' | 'succeeded' | 'failed';
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  destination: string | null;
  location: string | null;
  bytes: number | null;
  detail: Record<string, unknown>;
  error: string | null;
}

/** What the environment makes possible; the card greys out the rest. */
export interface BackupCapabilities {
  /** The mounted root the local destination writes under, as the container sees it. */
  localRoot: string;
  passphraseConfigured: boolean;
  s3Configured: boolean;
}

export function backupCapabilities(env: NodeJS.ProcessEnv = process.env): BackupCapabilities {
  return {
    localRoot: env.HELM_BACKUP_ROOT ?? '/var/lib/helm/backups',
    passphraseConfigured: Boolean(env.HELM_BACKUP_PASSPHRASE_FILE || env.HELM_BACKUP_PASSPHRASE),
    s3Configured: Boolean(env.HELM_BACKUP_S3_ACCESS_KEY_ID && env.HELM_BACKUP_S3_SECRET_ACCESS_KEY),
  };
}

export const settingsPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    schedule: z.string().trim().min(9).max(100).refine((v) => cronProblem(v) === null, {
      message: 'not a schedule this service can run',
    }).optional(),
    destinationKind: z.enum(['local', 's3']).optional(),
    localSubdir: z.string().trim().max(200).regex(/^(?!\/)(?!.*(^|\/)\.\.(\/|$))[\w./ -]*$/, 'a relative folder name').optional(),
    s3Bucket: z.string().trim().min(3).max(63).nullable().optional(),
    s3Prefix: z.string().trim().max(200).optional(),
    s3Endpoint: z.string().trim().url().max(500).nullable().optional(),
    s3Region: z.string().trim().min(1).max(64).optional(),
    keepDays: z.number().int().min(1).max(3650).optional(),
    keepCount: z.number().int().min(1).max(1000).optional(),
    includeVolumes: z.boolean().optional(),
    verifyWeekday: z.number().int().min(0).max(6).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to change' });
export type BackupSettingsPatch = z.infer<typeof settingsPatchSchema>;

interface RawSetting {
  enabled: boolean; schedule: string; destination_kind: 'local' | 's3'; local_subdir: string;
  s3_bucket: string | null; s3_prefix: string; s3_endpoint: string | null; s3_region: string;
  keep_days: number; keep_count: number; include_volumes: boolean; verify_weekday: number | null;
  updated_at: Date;
}
const toSettings = (r: RawSetting): BackupSettings => ({
  enabled: r.enabled, schedule: r.schedule, destinationKind: r.destination_kind, localSubdir: r.local_subdir,
  s3Bucket: r.s3_bucket, s3Prefix: r.s3_prefix, s3Endpoint: r.s3_endpoint, s3Region: r.s3_region,
  keepDays: r.keep_days, keepCount: r.keep_count, includeVolumes: r.include_volumes,
  verifyWeekday: r.verify_weekday, updatedAt: r.updated_at.toISOString(),
});

interface RawRun {
  id: string; kind: BackupRun['kind']; trigger: BackupRun['trigger']; status: BackupRun['status'];
  requested_at: Date; started_at: Date | null; finished_at: Date | null; destination: string | null;
  location: string | null; bytes: string | number | null; detail: Record<string, unknown>; error: string | null;
}
const toRun = (r: RawRun): BackupRun => ({
  id: r.id, kind: r.kind, trigger: r.trigger, status: r.status,
  requestedAt: r.requested_at.toISOString(), startedAt: r.started_at?.toISOString() ?? null,
  finishedAt: r.finished_at?.toISOString() ?? null, destination: r.destination, location: r.location,
  bytes: r.bytes === null ? null : Number(r.bytes), detail: r.detail ?? {}, error: r.error,
});

export async function readBackupSettings(tx: HelmTx): Promise<BackupSettings> {
  const [row] = await tx<RawSetting[]>`SELECT * FROM helm.backup_settings()`;
  if (!row) throw new Error('backup settings missing');
  return toSettings(row);
}

export async function writeBackupSettings(tx: HelmTx, patch: BackupSettingsPatch): Promise<BackupSettings> {
  const [row] = await tx<RawSetting[]>`SELECT * FROM helm.set_backup_settings(${tx.json(patch as never)}::jsonb)`;
  if (!row) throw new Error('backup settings missing');
  return toSettings(row);
}

export async function listBackupRuns(tx: HelmTx, limit = 20): Promise<BackupRun[]> {
  const rows = await tx<RawRun[]>`SELECT * FROM helm.backup_runs(${limit})`;
  return rows.map(toRun);
}

export async function requestBackupRun(tx: HelmTx, kind: 'backup' | 'verify'): Promise<BackupRun> {
  const [row] = await tx<RawRun[]>`SELECT * FROM helm.request_backup(${kind})`;
  if (!row) throw new Error('the run was not recorded');
  return toRun(row);
}

/** The newest successful backup, for the "last backup" line and the stale banner. */
export function lastSuccessfulBackup(runs: readonly BackupRun[]): BackupRun | null {
  return runs.find((r) => r.kind === 'backup' && r.status === 'succeeded') ?? null;
}
