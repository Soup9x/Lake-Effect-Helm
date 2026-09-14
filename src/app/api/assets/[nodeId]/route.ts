import { z } from 'zod';
import { tenantRoute } from '@/lib/api/handler';
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

export const dynamic = 'force-dynamic';
