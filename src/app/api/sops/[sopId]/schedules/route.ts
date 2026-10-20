import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { createSchedule, isActiveMember, listSchedules, readSchedule } from '@/lib/sops/schedules';

/**
 * A procedure's schedules: list, and add one.
 *
 * A schedule is a run started in advance, so it asks for the same permission
 * as starting one (sop:execute) and RLS writes it at the same rank. The worker
 * raises the runs; see src/workers/schedules.ts and 0770.
 */
const createSchema = z.object({
  intervalDays: z.number().int().min(1).max(366),
  firstRunAt: z.iso.datetime({ offset: true }),
  dueAfterDays: z.number().int().min(0).max(366).nullable().optional(),
  assignedTo: z.guid().nullable().optional(),
  siteId: z.guid().nullable().optional(),
  title: z.string().trim().min(1).max(200).nullable().optional(),
});

export const GET = tenantRoute(
  async ({ tx, params }) => {
    const sopId = z.guid().safeParse(params.sopId);
    if (!sopId.success) throw ApiError.notFound('no such procedure');
    return { schedules: await listSchedules(tx, sopId.data) };
  },
  { permissions: ['sop:read'] },
);

export const POST = tenantRoute(
  async ({ tx, request, params, identity }) => {
    const sopId = z.guid().safeParse(params.sopId);
    if (!sopId.success) throw ApiError.notFound('no such procedure');

    const body = await readJson(request, (raw) => {
      const result = createSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('an interval of 1 to 366 days and a first run date', {
          issues: zodIssues(result.error),
        });
      }
      return result.data;
    });

    // Scheduling a run of something never published would raise nothing but
    // an error on the schedule, forever; say so now instead.
    const [published] = await tx<{ ok: boolean }[]>`
      SELECT true AS ok FROM sop s JOIN asset_node n ON n.id = s.id
      WHERE s.id = ${sopId.data}::uuid AND s.current_version > 0 AND n.archived_at IS NULL
    `;
    if (!published) throw ApiError.invalid('publish the procedure before scheduling it');

    if (body.assignedTo && !(await isActiveMember(tx, identity.tenantId, body.assignedTo))) {
      throw ApiError.invalid('that person is not an active member of this tenant');
    }
    if (body.siteId) {
      const [site] = await tx<{ ok: boolean }[]>`
        SELECT true AS ok FROM site st JOIN asset_node n ON n.organization_id = st.organization_id
        WHERE st.id = ${body.siteId}::uuid AND n.id = ${sopId.data}::uuid AND st.deleted_at IS NULL AND st.archived_at IS NULL
      `;
      if (!site) throw ApiError.invalid('that site is not one of this client’s');
    }

    const id = await createSchedule(tx, identity.tenantId, sopId.data, identity.actorId, body);
    return { schedule: await readSchedule(tx, id) };
  },
  { permissions: ['sop:execute'] },
);

export const dynamic = 'force-dynamic';
