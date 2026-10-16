import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import {
  backupCapabilities, listBackupRuns, readBackupSettings, settingsPatchSchema, writeBackupSettings,
} from '@/lib/backups/settings';

/**
 * The instance's backup schedule and destination (0820).
 *
 * GET: the settings, the recent runs and what the environment allows. PUT:
 * any subset of the settings. Both are tenant:write, enforced again inside
 * helm.set_backup_settings(); the gate here is the clearer sentence.
 */
export const GET = tenantRoute(
  async ({ tx }) => ({
    settings: await readBackupSettings(tx),
    runs: await listBackupRuns(tx, 20),
    capabilities: backupCapabilities(),
  }),
  { permissions: ['tenant:write'] },
);

export const PUT = tenantRoute(
  async ({ tx, request }) => {
    const body = await readJson(request, (raw) => {
      const result = settingsPatchSchema.safeParse(raw);
      if (!result.success) throw ApiError.invalid('invalid backup settings', { issues: zodIssues(result.error) });
      return result.data;
    });
    const caps = backupCapabilities();
    if (body.destinationKind === 's3' && !caps.s3Configured) {
      throw ApiError.invalid('set HELM_BACKUP_S3_ACCESS_KEY_ID and HELM_BACKUP_S3_SECRET_ACCESS_KEY in .env before choosing an object store');
    }
    return { settings: await writeBackupSettings(tx, body) };
  },
  { permissions: ['tenant:write'] },
);

export const dynamic = 'force-dynamic';
