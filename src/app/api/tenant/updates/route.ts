import { tenantRoute } from '@/lib/api/handler';
import { getUpdateStatus } from '@/lib/updates/check';

/**
 * Whether a newer Helm is on GitHub (src/lib/updates/check.ts).
 *
 * GET: the cached answer, asking GitHub if it is more than a few hours old.
 * POST: ask now — the "Check now" button. Both are tenant:write, which only
 * super_admin holds: the build's commit and how far behind it is are
 * reconnaissance, the reason /api/health says nothing about versions.
 */
export const GET = tenantRoute(async () => ({ status: await getUpdateStatus() }), {
  permissions: ['tenant:write'],
});

export const POST = tenantRoute(async () => ({ status: await getUpdateStatus({ force: true }) }), {
  permissions: ['tenant:write'],
});

export const dynamic = 'force-dynamic';
