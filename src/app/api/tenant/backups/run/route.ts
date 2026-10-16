import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { requestBackupRun } from '@/lib/backups/settings';

/** POST — "Run now": queue a backup or a restore rehearsal for the service. */
const schema = z.object({ kind: z.enum(['backup', 'verify']).default('backup') });

export const POST = tenantRoute(
  async ({ tx, request }) => {
    const body = await readJson(request, (raw) => {
      const result = schema.safeParse(raw ?? {});
      if (!result.success) throw ApiError.invalid('a kind: backup or verify', { issues: zodIssues(result.error) });
      return result.data;
    });
    return { run: await requestBackupRun(tx, body.kind) };
  },
  { permissions: ['tenant:write'] },
);

export const dynamic = 'force-dynamic';
