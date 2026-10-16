import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { DEVICE_TYPES, detailFieldsFor } from '@/lib/assets/detail-fields';
import { writeDetail } from '@/lib/assets/detail-write';
import { contactBelongs, interfaceSchema, readDevice, replaceInterfaces } from '@/lib/assets/devices';

/**
 * POST /api/devices — document a configuration in one request (0800).
 *
 * The node, the device row, its contact and its interfaces, in one
 * transaction: the sectioned form saves once, and a refusal anywhere (an
 * address that is not one, a contact of another client) leaves nothing
 * behind. The device columns go through the detail catalogue, so the same
 * casts and refusals apply as to PATCH /api/assets/:id/detail.
 */
export const NODE_STATUSES = ['active', 'inactive', 'retired', 'planned', 'maintenance'] as const;

export const createSchema = z.object({
  organizationId: z.guid(),
  name: z.string().trim().min(1).max(200),
  deviceType: z.enum(DEVICE_TYPES),
  status: z.enum(NODE_STATUSES).default('active'),
  siteId: z.guid().nullable().optional(),
  contactId: z.guid().nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
  isInternalOnly: z.boolean().default(false),
  /** Device columns by catalogue key: serial_number, warranty_expires_at, primary_ip… */
  detail: z.record(z.string().min(1).max(64), z.unknown()).default({}),
  interfaces: z.array(interfaceSchema).max(32).default([]),
});

export const POST = tenantRoute(
  async ({ tx, request, identity }) => {
    const body = await readJson(request, (raw) => {
      const result = createSchema.safeParse(raw);
      if (!result.success) throw ApiError.invalid('invalid configuration', { issues: zodIssues(result.error) });
      return result.data;
    });

    if (body.contactId && !(await contactBelongs(tx, body.contactId, body.organizationId))) {
      throw ApiError.invalid('that contact is not one of this client’s');
    }

    let node: { id: string } | undefined;
    try {
      [node] = await tx<{ id: string }[]>`
        INSERT INTO asset_node (
          tenant_id, organization_id, site_id, node_type, name, notes, status,
          is_internal_only, created_by, updated_by
        )
        VALUES (
          ${identity.tenantId}::uuid, ${body.organizationId}::uuid, ${body.siteId ?? null}::uuid,
          'device', ${body.name}, ${body.notes ?? null}, ${body.status}::node_status,
          ${body.isInternalOnly}, ${identity.actorId}::uuid, ${identity.actorId}::uuid
        )
        RETURNING id
      `;
    } catch (error) {
      if ((error as { code?: string }).code === '23503') throw ApiError.invalid('no such client or site');
      throw error;
    }
    if (!node) throw ApiError.conflict('the configuration could not be created');

    await tx`
      INSERT INTO device (id, tenant_id, node_type, device_type, contact_id)
      VALUES (${node.id}::uuid, ${identity.tenantId}::uuid, 'device', ${body.deviceType}::device_type,
              ${body.contactId ?? null}::uuid)
    `;
    const { device_type: _ignored, ...detail } = body.detail;
    await writeDetail(tx, 'device', detailFieldsFor('device'), node.id, detail, { kindName: 'device' });
    await replaceInterfaces(tx, identity.tenantId, node.id, body.interfaces);

    return { device: await readDevice(tx, node.id) };
  },
  { permissions: ['asset:write'] },
);

export const dynamic = 'force-dynamic';
