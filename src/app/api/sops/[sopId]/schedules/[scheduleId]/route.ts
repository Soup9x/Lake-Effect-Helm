import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { deleteSchedule, isActiveMember, readSchedule, updateSchedule } from '@/lib/sops/schedules';

/** PATCH pauses, resumes or edits a schedule; DELETE removes it. Past runs stay. */
const patchSchema = z
  .object({
    enabled: z.boolean().optional(),
    intervalDays: z.number().int().min(1).max(366).optional(),
    nextRunAt: z.iso.datetime({ offset: true }).optional(),
    dueAfterDays: z.number().int().min(0).max(366).nullable().optional(),
    assignedTo: z.guid().nullable().optional(),
    siteId: z.guid().nullable().optional(),
    title: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to change' });

export const PATCH = tenantRoute(
  async ({ tx, request, params, identity }) => {
    const scheduleId = z.guid().safeParse(params.scheduleId);
    if (!scheduleId.success) throw ApiError.notFound('no such schedule');

    const body = await readJson(request, (raw) => {
      const result = patchSchema.safeParse(raw);
      if (!result.success) throw ApiError.invalid('invalid schedule change', { issues: zodIssues(result.error) });
      return result.data;
    });
    if (body.assignedTo && !(await isActiveMember(tx, identity.tenantId, body.assignedTo))) {
      throw ApiError.invalid('that person is not an active member of this tenant');
    }

    // RLS answers "not yours" as "no such row", the same as "not there".
    if (!(await updateSchedule(tx, scheduleId.data, body))) throw ApiError.notFound('no such schedule');
    return { schedule: await readSchedule(tx, scheduleId.data) };
  },
  { permissions: ['sop:execute'] },
);

export const DELETE = tenantRoute(
  async ({ tx, params }) => {
    const scheduleId = z.guid().safeParse(params.scheduleId);
    if (!scheduleId.success) throw ApiError.notFound('no such schedule');
    if (!(await deleteSchedule(tx, scheduleId.data))) throw ApiError.notFound('no such schedule');
    return { deleted: true };
  },
  { permissions: ['sop:execute'] },
);

export const dynamic = 'force-dynamic';
