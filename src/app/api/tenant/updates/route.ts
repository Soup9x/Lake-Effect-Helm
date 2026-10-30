import { tenantRoute } from '@/lib/api/handler';
import { getUpdateStatus } from '@/lib/updates/check';
import { listUpdateRequests, readUpdater } from '@/lib/updates/requests';

/**
 * Whether a newer Helm is on GitHub (src/lib/updates/check.ts), and the
 * updates requested from the Updates page (1210).
 *
 * GET: the cached answer, asking GitHub if it is more than a few hours old,
 * plus the host updater's state and the recent requests. POST: ask GitHub now
 * — the "Check now" button. Both are tenant:write, which only super_admin
 * holds: the build's commit and how far behind it is are reconnaissance, the
 * reason /api/health says nothing about versions.
 */
export const GET = tenantRoute(
  async ({ tx }) => ({
    status: await getUpdateStatus(),
    updater: await readUpdater(tx),
    requests: await listUpdateRequests(tx),
  }),
  { permissions: ['tenant:write'] },
);

export const POST = tenantRoute(
  async ({ tx }) => ({
    status: await getUpdateStatus({ force: true }),
    updater: await readUpdater(tx),
    requests: await listUpdateRequests(tx),
  }),
  { permissions: ['tenant:write'] },
);

export const dynamic = 'force-dynamic';
