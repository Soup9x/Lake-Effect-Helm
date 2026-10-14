import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import {
  INTERVAL_MAX_HOURS, INTERVAL_MIN_HOURS,
  readExternalCheckSetting, writeExternalCheckSetting,
} from '@/lib/external/settings';

/**
 * Whether Helm may reach outside to refresh domain and certificate facts.
 *
 * GATED ON tenant:write, which only super_admin holds. The policies on
 * external_check_setting name the same permission, so the route and the
 * database cannot come to disagree about who may start outbound traffic — the
 * same construction D used for the tenant sidebar default, and for a stronger
 * reason here: this switch decides whether a client's domain names leave the
 * building.
 *
 * SEPARATE FROM PATCH /api/tenant for the reason that route's header gives:
 * `settings` is a jsonb bag and a generic patch endpoint overwrites invariants
 * it never knew about. This feature has rules of its own — an interval with
 * bounds, an endpoint that must be https — so it gets a route with those rules
 * on it.
 *
 * GET IS NOT GATED. Every role benefits from knowing whether checking is on,
 * because that is what makes "last checked: never" legible on a domain page:
 * never checked because it is switched off is a different fact from never
 * checked because the registry is unreachable. The policy allows the read
 * tenant-wide for the same reason.
 *
 * THE ENDPOINT IS PART OF THE PAYLOAD, not a hidden constant. Somebody turning
 * this on can see, and change, where their clients' domain names are sent.
 */
const schema = z.object({
  domainsEnabled: z.boolean(),
  certificatesEnabled: z.boolean(),
  intervalHours: z.number().int().min(INTERVAL_MIN_HOURS).max(INTERVAL_MAX_HOURS),
  /*
   * https only, mirroring the CHECK constraint. Validated here as well as in
   * the database so the answer is a 400 naming the field rather than a 500
   * naming a constraint — and refused rather than coerced, because silently
   * upgrading somebody's http URL would send the request somewhere they did
   * not ask for.
   */
  rdapBaseUrl: z.url().refine((value) => value.startsWith('https://'), {
    message: 'must be an https:// URL — an answer somebody acts on cannot travel in clear text',
  }),
});

export const GET = tenantRoute(async ({ tx }) => readExternalCheckSetting(tx));

export const PUT = tenantRoute(
  async ({ tx, request, identity }) => {
    const body = await readJson(request, (raw) => {
      const result = schema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('an interval in hours and an https RDAP endpoint', {
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      return result.data;
    });

    return writeExternalCheckSetting(tx, body, identity.actorId);
  },
  { permissions: ['tenant:write'] },
);

export const dynamic = 'force-dynamic';
