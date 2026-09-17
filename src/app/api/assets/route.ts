import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';

/**
 * The node types this route creates.
 *
 * `credential`, `sop` and `flexible_asset` are absent on purpose. Each is a
 * node in the graph, but each is created by the flow that owns its payload —
 * a credential through /api/secrets so the value is encrypted on the way in, a
 * flexible asset through its template so the schema is applied. Accepting them
 * here would let somebody create the node and skip the part that gives it
 * meaning, leaving a graph entry that documents nothing.
 */
const CREATABLE = [
  'device',
  'network',
  'ip_address',
  'domain',
  'ssl_certificate',
  'application',
  'directory_service',
  'contract',
  'license',
  'isp_circuit',
  'vendor',
] as const;

const createSchema = z.object({
  organizationId: z.guid('organizationId must be a UUID'),
  siteId: z.guid().nullable().optional(),
  nodeType: z.enum(CREATABLE),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  /**
   * Informal context. Distinct from `description`, which is what this asset
   * IS; notes are what somebody needs to know about it. Bounded at 4000
   * characters by a CHECK in 0370.
   */
  notes: z.string().trim().max(4000).optional(),
  criticality: z.number().int().min(1).max(5).default(3),
  isInternalOnly: z.boolean().default(false),
  tags: z.array(z.string().trim().min(1).max(60)).max(30).default([]),

  // The one field each subtype cannot do without. Which of these is required is
  // decided by nodeType, below.
  deviceType: z
    .enum([
      'server',
      'workstation',
      'laptop',
      'virtual_machine',
      'hypervisor',
      'firewall',
      'router',
      'switch',
      'access_point',
      'nas',
      'san',
      'printer',
      'ups',
      'camera',
      'phone_system',
      'iot',
      'other',
    ])
    .optional(),
  networkKind: z.enum(['vlan', 'subnet', 'wan', 'vpn', 'wifi', 'management']).optional(),
  directoryKind: z
    .enum(['active_directory', 'entra_id', 'hybrid', 'ldap', 'google_workspace', 'okta'])
    .optional(),
  address: z.string().trim().max(45).optional(),
  domainName: z.string().trim().max(253).optional(),
  commonName: z.string().trim().max(253).optional(),
});

type CreateBody = z.infer<typeof createSchema>;

/** The subtype column each node type cannot be created without. */
const REQUIRED_FIELD: Partial<Record<(typeof CREATABLE)[number], keyof CreateBody>> = {
  device: 'deviceType',
  network: 'networkKind',
  directory_service: 'directoryKind',
  ip_address: 'address',
  domain: 'domainName',
  ssl_certificate: 'commonName',
};

/**
 * POST /api/assets — document a device, network, domain, certificate or the rest.
 *
 * An asset is two rows: the node that carries the shared shape and takes part
 * in the graph, and a subtype row holding what is true only of that kind. They
 * are written in ONE transaction — the route's own — because a node without its
 * subtype row is an asset that appears in every list and opens to nothing, and
 * the composite key `asset_node (id, node_type)` exists precisely so the second
 * row cannot claim a different type from the first.
 */
export const POST = tenantRoute(
  async ({ tx, request, identity }) => {
    const body = await readJson(request, (raw) => {
      const result = createSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid asset', {
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      return result.data;
    });

    const required = REQUIRED_FIELD[body.nodeType];
    if (required && !body[required]) {
      throw ApiError.invalid(`a ${body.nodeType.replace('_', ' ')} needs ${required}`, {
        issues: [{ path: required, message: 'required for this asset type' }],
      });
    }

    let node: { id: string } | undefined;
    try {
      [node] = await tx<{ id: string }[]>`
        INSERT INTO asset_node (
          tenant_id, organization_id, site_id, node_type, name, description, notes,
          criticality, is_internal_only, tags, created_by, updated_by
        )
        VALUES (
          ${identity.tenantId}::uuid, ${body.organizationId}::uuid,
          ${body.siteId ?? null}, ${body.nodeType}::node_type, ${body.name},
          ${body.description ?? null}, ${body.notes ?? null},
          ${body.criticality}, ${body.isInternalOnly},
          ${body.tags}, ${identity.actorId}::uuid, ${identity.actorId}::uuid
        )
        RETURNING id
      `;
    } catch (error) {
      // The organization and site are reached through composite keys carrying
      // tenant_id, so an id from another tenant fails here rather than being
      // re-checked above.
      if ((error as { code?: string }).code === '23503') {
        throw ApiError.invalid('no such client or site');
      }
      throw error;
    }
    if (!node) throw ApiError.conflict('the asset could not be created');

    // The subtype row. Same transaction: if this fails the node goes with it.
    switch (body.nodeType) {
      case 'device':
        await tx`INSERT INTO device (id, tenant_id, node_type, device_type)
                 VALUES (${node.id}::uuid, ${identity.tenantId}::uuid, 'device', ${body.deviceType!}::device_type)`;
        break;
      case 'network':
        await tx`INSERT INTO network (id, tenant_id, node_type, kind)
                 VALUES (${node.id}::uuid, ${identity.tenantId}::uuid, 'network', ${body.networkKind!}::network_kind)`;
        break;
      case 'directory_service':
        await tx`INSERT INTO directory_service (id, tenant_id, node_type, kind)
                 VALUES (${node.id}::uuid, ${identity.tenantId}::uuid, 'directory_service', ${body.directoryKind!}::directory_kind)`;
        break;
      case 'ip_address':
        await tx`INSERT INTO ip_address (id, tenant_id, node_type, address)
                 VALUES (${node.id}::uuid, ${identity.tenantId}::uuid, 'ip_address', ${body.address!}::inet)`;
        break;
      case 'domain':
        await tx`INSERT INTO domain (id, tenant_id, node_type, domain_name)
                 VALUES (${node.id}::uuid, ${identity.tenantId}::uuid, 'domain', ${body.domainName!})`;
        break;
      case 'ssl_certificate':
        await tx`INSERT INTO ssl_certificate (id, tenant_id, node_type, common_name)
                 VALUES (${node.id}::uuid, ${identity.tenantId}::uuid, 'ssl_certificate', ${body.commonName!})`;
        break;
      case 'application':
        await tx`INSERT INTO application (id, tenant_id, node_type)
                 VALUES (${node.id}::uuid, ${identity.tenantId}::uuid, 'application')`;
        break;
      case 'contract':
        await tx`INSERT INTO contract (id, tenant_id, node_type)
                 VALUES (${node.id}::uuid, ${identity.tenantId}::uuid, 'contract')`;
        break;
      case 'license':
        await tx`INSERT INTO license (id, tenant_id, node_type)
                 VALUES (${node.id}::uuid, ${identity.tenantId}::uuid, 'license')`;
        break;
      case 'isp_circuit':
        await tx`INSERT INTO isp_circuit (id, tenant_id, node_type)
                 VALUES (${node.id}::uuid, ${identity.tenantId}::uuid, 'isp_circuit')`;
        break;
      case 'vendor':
        await tx`INSERT INTO vendor (id, tenant_id, node_type)
                 VALUES (${node.id}::uuid, ${identity.tenantId}::uuid, 'vendor')`;
        break;
    }

    return { asset: { id: node.id, name: body.name, nodeType: body.nodeType } };
  },
  { permissions: ['asset:write'] },
);

export const dynamic = 'force-dynamic';
