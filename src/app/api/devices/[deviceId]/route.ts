import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { DEVICE_TYPES, detailFieldsFor } from '@/lib/assets/detail-fields';
import { writeDetail } from '@/lib/assets/detail-write';
import { contactBelongs, interfaceSchema, readDevice, replaceInterfaces } from '@/lib/assets/devices';
import { NODE_STATUSES } from '../route';

/** GET — the configuration whole, for the edit form. */
export const GET = tenantRoute(
  async ({ tx, params }) => {
    const deviceId = z.guid().safeParse(params.deviceId);
    if (!deviceId.success) throw ApiError.invalid('not a device id');
    const device = await readDevice(tx, deviceId.data);
    if (!device) throw ApiError.notFound('no such configuration');
    return { device };
  },
  { permissions: ['asset:read'] },
);

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    deviceType: z.enum(DEVICE_TYPES).optional(),
    status: z.enum(NODE_STATUSES).optional(),
    siteId: z.guid().nullable().optional(),
    contactId: z.guid().nullable().optional(),
    notes: z.string().trim().max(4000).nullable().optional(),
    isInternalOnly: z.boolean().optional(),
    detail: z.record(z.string().min(1).max(64), z.unknown()).optional(),
    /** The whole list; omit to leave the interfaces alone. */
    interfaces: z.array(interfaceSchema).max(32).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to change' });

/** PATCH — every section at once, or any one of them. */
export const PATCH = tenantRoute(
  async ({ tx, request, params, identity }) => {
    const deviceId = z.guid().safeParse(params.deviceId);
    if (!deviceId.success) throw ApiError.invalid('not a device id');

    const body = await readJson(request, (raw) => {
      const result = patchSchema.safeParse(raw);
      if (!result.success) throw ApiError.invalid('invalid configuration change', { issues: zodIssues(result.error) });
      return result.data;
    });

    const current = await readDevice(tx, deviceId.data);
    if (!current) throw ApiError.notFound('no such configuration');
    if (body.contactId && !(await contactBelongs(tx, body.contactId, current.organizationId))) {
      throw ApiError.invalid('that contact is not one of this client’s');
    }

    try {
      await tx`
        UPDATE asset_node SET
          name             = coalesce(${body.name ?? null}, name),
          status           = coalesce(${body.status ?? null}::node_status, status),
          site_id          = ${body.siteId === undefined ? tx`site_id` : tx`${body.siteId}::uuid`},
          notes            = ${body.notes === undefined ? tx`notes` : body.notes},
          is_internal_only = coalesce(${body.isInternalOnly ?? null}, is_internal_only),
          updated_at       = now(),
          updated_by       = ${identity.actorId}::uuid
        WHERE id = ${deviceId.data}::uuid
      `;
    } catch (error) {
      if ((error as { code?: string }).code === '23503') throw ApiError.invalid('no such site');
      throw error;
    }
    if (body.deviceType !== undefined || body.contactId !== undefined) {
      await tx`
        UPDATE device SET
          device_type = coalesce(${body.deviceType ?? null}::device_type, device_type),
          contact_id  = ${body.contactId === undefined ? tx`contact_id` : tx`${body.contactId}::uuid`}
        WHERE id = ${deviceId.data}::uuid
      `;
    }
    if (body.detail !== undefined) {
      const { device_type: _ignored, ...detail } = body.detail;
      await writeDetail(tx, 'device', detailFieldsFor('device'), deviceId.data, detail, { kindName: 'device' });
    }
    if (body.interfaces !== undefined) {
      await replaceInterfaces(tx, identity.tenantId, deviceId.data, body.interfaces);
    }
    return { device: await readDevice(tx, deviceId.data) };
  },
  { permissions: ['asset:write'] },
);

export const dynamic = 'force-dynamic';
