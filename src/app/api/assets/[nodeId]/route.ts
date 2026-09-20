import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';

interface NodeRow {
  id: string;
  organization_id: string;
  site_id: string | null;
  node_type: string;
  name: string;
  description: string | null;
  status: string;
  tags: string[];
  criticality: number;
  is_internal_only: boolean;
  created_at: Date;
  updated_at: Date;
}

interface SecretRow {
  id: string;
  label: string;
  kind: string;
  sensitivity: string;
  requires_step_up: boolean;
  requires_reason: boolean;
  rotation_due_at: Date | null;
}

/**
 * GET /api/assets/:nodeId
 *
 * Node metadata plus the credentials attached to it — as METADATA. `secret` and
 * `v_secret_metadata` carry no ciphertext, so browsing an asset generates no
 * reveal events and leaks nothing if the response is cached by a client.
 * Getting a value is a separate, audited POST.
 */
export const GET = tenantRoute(
  async ({ tx, params }) => {
    const nodeId = params.nodeId;
    if (!nodeId || !z.guid().safeParse(nodeId).success) {
      throw ApiError.invalid('nodeId must be a UUID');
    }

    const [node] = await tx<NodeRow[]>`
      SELECT id, organization_id, site_id, node_type::text AS node_type, name, description,
             status::text AS status, tags, criticality, is_internal_only, created_at, updated_at
      FROM asset_node
      WHERE id = ${nodeId}::uuid AND archived_at IS NULL
    `;

    // RLS already filtered an out-of-scope node to zero rows, so "not found" and
    // "not yours" arrive here identically — which is the intent.
    if (!node) throw ApiError.notFound('no such asset');

    const secrets = await tx<SecretRow[]>`
      SELECT m.id, m.label, m.kind::text AS kind, m.sensitivity::text AS sensitivity,
             m.requires_step_up, m.requires_reason, m.rotation_due_at
      FROM v_secret_metadata m
      JOIN credential c ON c.secret_id = m.id
      WHERE c.id = ${nodeId}::uuid
      ORDER BY m.label
    `;

    return {
      asset: {
        id: node.id,
        organizationId: node.organization_id,
        siteId: node.site_id,
        nodeType: node.node_type,
        name: node.name,
        description: node.description,
        status: node.status,
        tags: node.tags,
        criticality: node.criticality,
        isInternalOnly: node.is_internal_only,
        createdAt: node.created_at,
        updatedAt: node.updated_at,
      },
      secrets: secrets.map((s) => ({
        id: s.id,
        label: s.label,
        kind: s.kind,
        sensitivity: s.sensitivity,
        requiresStepUp: s.requires_step_up,
        requiresReason: s.requires_reason,
        rotationDueAt: s.rotation_due_at,
      })),
    };
  },
  { permissions: ['asset:read'] },
);

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    /** Informal context, bounded at 4000 characters by a CHECK in 0370. */
    notes: z.string().trim().max(4000).nullable().optional(),
    siteId: z.guid().nullable().optional(),
    status: z
      .enum(['planned', 'active', 'maintenance', 'retired', 'decommissioned'])
      .optional(),
    criticality: z.number().int().min(1).max(5).optional(),
    isInternalOnly: z.boolean().optional(),
    tags: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' });

/**
 * PATCH /api/assets/[nodeId] — rename or re-describe an asset.
 *
 * `node_type` is not settable. It is half of the composite key the subtype row
 * hangs off (`asset_node (id, node_type)`), so changing it would orphan that
 * row rather than convert it — a device that is suddenly a domain, with device
 * columns nothing can reach. Documenting the same thing as a different kind is
 * a new asset and a link, not an edit.
 *
 * `organization_id` is not settable either: moving an asset between clients
 * would move its credentials, its links and its audit history with it, and
 * "which client was this under when it was revealed" would stop having one
 * answer.
 */
export const PATCH = tenantRoute(
  async ({ tx, request, identity, params }) => {
    const nodeId = z.guid().safeParse(params.nodeId);
    if (!nodeId.success) throw ApiError.invalid('not an asset id');

    const body = await readJson(request, (raw) => {
      const result = patchSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid changes', {
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      return result.data;
    });

    let updated: { id: string; name: string; node_type: string } | undefined;
    try {
      [updated] = await tx<{ id: string; name: string; node_type: string }[]>`
        UPDATE asset_node SET
          name             = COALESCE(${body.name ?? null}, name),
          description      = ${body.description === undefined ? tx`description` : body.description},
          notes            = ${body.notes === undefined ? tx`notes` : body.notes},
          site_id          = ${body.siteId === undefined ? tx`site_id` : body.siteId}::uuid,
          status           = COALESCE(${body.status ?? null}::node_status, status),
          criticality      = COALESCE(${body.criticality ?? null}, criticality),
          is_internal_only = COALESCE(${body.isInternalOnly ?? null}, is_internal_only),
          tags             = COALESCE(${body.tags ?? null}, tags),
          updated_at       = now(),
          updated_by       = ${identity.actorId}::uuid
        WHERE id = ${nodeId.data}::uuid AND archived_at IS NULL
        RETURNING id, name, node_type::text AS node_type
      `;
    } catch (error) {
      if ((error as { code?: string }).code === '23503') {
        throw ApiError.invalid('no such site');
      }
      throw error;
    }

    if (!updated) throw ApiError.invalid('no such asset');

    return {
      asset: { id: updated.id, name: updated.name, nodeType: updated.node_type },
    };
  },
  { permissions: ['asset:write'] },
);

/**
 * DELETE — permanent removal of an already-archived CREDENTIAL.
 *
 * Credentials only, and the narrowness is the point: this is the one asset type
 * whose deletion has to reason about encrypted material that may be documented
 * in more than one place. helm.delete_credential() removes the node, then the
 * secret and its versions only if nothing else references them — a password
 * shared between two credentials survives the deletion of one of them, which is
 * the same many-to-one helm.secret_node_visible() resolves with bool_or.
 *
 * Other asset types archive and stay archived. Extending this is a decision
 * about data retention, not a missing branch.
 */
export const DELETE = tenantRoute(
  async ({ tx, params }) => {
    const nodeId = z.guid().safeParse(params.nodeId);
    if (!nodeId.success) throw ApiError.invalid('not an item id');

    try {
      const [row] = await tx<{ result: { name: string; secrets_removed: number } }[]>`
        SELECT helm.delete_credential(${nodeId.data}::uuid) AS result
      `;
      return { deleted: true, ...(row?.result ?? {}) };
    } catch (error) {
      if ((error as { detail?: string }).detail === 'archive_first') {
        throw ApiError.invalid(
          'archive this credential first — permanent deletion is only available from the archive',
        );
      }
      throw error;
    }
  },
  { permissions: ['secret:delete'] },
);

export const dynamic = 'force-dynamic';
