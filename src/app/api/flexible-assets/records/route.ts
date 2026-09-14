import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { getFlexibleAssetValidator, getSecretService } from '@/lib/services';

const recordSchema = z.object({
  typeId: z.guid(),
  organizationId: z.guid(),
  siteId: z.guid().optional(),
  name: z.string().min(1).max(200),
  data: z.record(z.string(), z.unknown()),
  criticality: z.number().int().min(1).max(5).optional(),
});

interface VersionRow {
  version_id: string;
  json_schema: unknown;
  secret_fields: string[];
  type_name: string;
}

/**
 * POST /api/flexible-assets/records
 *
 * The full write path for a technician-defined template, and the place where
 * Step 1's schema, Step 2's secret engine and Step 3's validator meet:
 *
 *   1. Resolve the type's CURRENT published version and pin the record to it.
 *      Records validate against the schema they were written under, forever.
 *   2. Validate, and split `x-helm-secret` fields out of the document.
 *   3. Create the asset_node and the record — the document now provably holds
 *      no secret values, and a database trigger rejects it if this is wrong.
 *   4. Write each secret through the audited secret API and record the
 *      pointer in flexible_asset_secret.
 *
 * All in ONE transaction. A half-written record — document stored, secrets not,
 * or vice versa — would be a credential silently missing from documentation the
 * technician believes is complete.
 */
export const POST = tenantRoute(
  async ({ tx, request, identity }) => {
    const body = await readJson(request, (raw) => {
      const result = recordSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid record', {
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      return result.data;
    });

    const [version] = await tx<VersionRow[]>`
      SELECT v.id AS version_id, v.json_schema, v.secret_fields, t.name AS type_name
      FROM flexible_asset_type t
      JOIN flexible_asset_type_version v ON v.id = t.current_version_id
      WHERE t.id = ${body.typeId}::uuid AND t.is_active
    `;
    if (!version) {
      // Covers "no such type", "not yours" and "no published version" alike.
      throw ApiError.notFound('no active template with a published schema');
    }

    const validation = getFlexibleAssetValidator().validateRecord(
      version.version_id,
      version.json_schema,
      version.secret_fields,
      body.data,
    );
    if (!validation.ok) {
      throw ApiError.invalid('the record does not match its template', {
        fields: validation.errors,
      });
    }

    const [node] = await tx<{ id: string }[]>`
      INSERT INTO asset_node (
        tenant_id, organization_id, site_id, node_type, name, criticality, created_by, updated_by
      )
      VALUES (
        ${identity.tenantId}::uuid, ${body.organizationId}::uuid,
        ${body.siteId ?? null}::uuid, 'flexible_asset', ${body.name},
        ${body.criticality ?? 3}, ${identity.actorId}::uuid, ${identity.actorId}::uuid
      )
      RETURNING id
    `;
    if (!node) throw ApiError.invalid('could not create the asset');

    await tx`
      INSERT INTO flexible_asset_record (id, tenant_id, type_id, type_version_id, data, validated_at)
      VALUES (
        ${node.id}::uuid, ${identity.tenantId}::uuid, ${body.typeId}::uuid,
        ${version.version_id}::uuid, ${tx.json(validation.data as never)}::jsonb, now()
      )
    `;

    // Each secret goes through the same audited path a credential does, so a
    // custom template's password is no less protected than a first-class one.
    const secretIds: Record<string, string> = {};
    for (const [pointer, plaintext] of validation.secrets) {
      const created = await getSecretService().createInTransaction(
        tx,
        { tenantId: identity.tenantId, actorId: identity.actorId },
        {
          organizationId: body.organizationId,
          kind: 'generic',
          label: `${version.type_name} — ${pointer.replace(/^\//, '')}`,
        },
        plaintext,
      );
      secretIds[pointer] = created.secretId;

      await tx`
        INSERT INTO flexible_asset_secret (record_id, tenant_id, field_path, secret_id)
        VALUES (
          ${node.id}::uuid, ${identity.tenantId}::uuid, ${pointer}, ${created.secretId}::uuid
        )
      `;
    }

    return {
      nodeId: node.id,
      typeVersionId: version.version_id,
      secretFields: Object.keys(secretIds),
    };
  },
  { permissions: ['asset:write'] },
);

export const dynamic = 'force-dynamic';
