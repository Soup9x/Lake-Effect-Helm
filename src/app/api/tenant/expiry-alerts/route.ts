import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { parseLeadDays } from '@/lib/alerts/expiry';
import { readExpiryAlertSetting, writeExpiryAlertSetting } from '@/lib/alerts/queries';

/**
 * The tenant's expiry warnings: on or off, and how many days ahead.
 *
 * Edits the default rule 0730 gives every tenant. Delivery is whatever
 * destinations subscribe to "Expiring soon" under Notifications; this decides
 * when a warning is raised, not where it goes.
 *
 * GATED ON alert:manage, the permission the alert evaluator itself requires.
 * GET is not gated: anybody looking at an expiry list can usefully know when
 * the team will be warned about it.
 */
const schema = z.object({
  enabled: z.boolean(),
  leadDays: z.array(z.number()).max(32),
});

export const GET = tenantRoute(async ({ tx }) => readExpiryAlertSetting(tx));

export const PUT = tenantRoute(
  async ({ tx, request }) => {
    const body = await readJson(request, (raw) => {
      const result = schema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('enabled (boolean) and leadDays (array of days) are required');
      }
      return result.data;
    });

    const parsed = parseLeadDays(body.leadDays);
    if (!parsed.ok) throw ApiError.invalid(parsed.error);

    return writeExpiryAlertSetting(tx, { enabled: body.enabled, leadDays: parsed.leadDays });
  },
  { permissions: ['alert:manage'] },
);

export const dynamic = 'force-dynamic';
