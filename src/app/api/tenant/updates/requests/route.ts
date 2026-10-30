import { z } from 'zod';
import { actorFor, publicRoute, readJson } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { installSessionResolver } from '@/lib/auth/bootstrap';
import { resolveIdentity } from '@/lib/auth/identity';
import { reauthenticate } from '@/lib/auth/reauthenticate';
import { withTenant } from '@/lib/db/client';
import { getUpdateStatus } from '@/lib/updates/check';
import { readUpdater, requestUpdate } from '@/lib/updates/requests';

/**
 * POST /api/tenant/updates/requests — install the newest Helm, now or at a time.
 *
 * THE PASSWORD EVERY TIME, not a step-up left over from a credential reveal ten
 * minutes ago: this rebuilds and restarts the whole product. The body carries
 * it and the route verifies it through the ordinary sign-in path (throttle,
 * lockout, authenticator code if the person has one), which also records the
 * step-up helm.request_helm_update() insists on.
 *
 * THE SERVER PICKS THE COMMIT. The request says "the latest", and the latest is
 * whatever this process last read from GitHub — so nobody can ask the host to
 * install an arbitrary commit by posting one here. The updater on the host
 * refuses anything not on the configured branch regardless.
 *
 * Verify first, then open the transaction, for the reason the step-up route
 * gives: a RADIUS round trip must not hold a pooled connection open.
 */
const bodySchema = z.object({
  password: z.string().min(1).max(1024),
  code: z.string().trim().max(32).optional(),
  /** ISO instant to start at; absent or null for "now". */
  at: z.string().datetime({ offset: true }).nullable().optional(),
});

export const POST = publicRoute(async (request, requestId) => {
  await installSessionResolver();
  const identity = await resolveIdentity(request);

  const body = await readJson(request, (raw) => {
    const result = bodySchema.safeParse(raw);
    if (!result.success) throw ApiError.invalid('your password, and optionally a start time', { issues: zodIssues(result.error) });
    return result.data;
  });

  const status = await getUpdateStatus();
  if (status.state !== 'available' || !status.latest) {
    throw ApiError.conflict('there is no newer version to install');
  }

  await reauthenticate(request, identity, { password: body.password, code: body.code, secondFactor: 'if_enrolled' });

  return withTenant(actorFor(identity, requestId), async (tx, session) => {
    if (!session.permissions.includes('tenant:write')) {
      throw ApiError.forbidden('updates are installed by tenant administrators');
    }
    if (!(await readUpdater(tx)).installed) {
      throw ApiError.conflict('the updater is not running on the Helm server; run sudo ./deploy/setup.sh there once to install it');
    }
    return { request: await requestUpdate(tx, status.latest!.commit, body.at ? new Date(body.at) : null) };
  });
});

export const dynamic = 'force-dynamic';
