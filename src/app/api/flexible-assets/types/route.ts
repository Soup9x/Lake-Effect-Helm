import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { getFlexibleAssetValidator } from '@/lib/services';

interface TypeRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  is_active: boolean;
  client_visible: boolean;
  current_version_id: string | null;
  version: number | null;
  secret_fields: string[] | null;
}

/** GET /api/flexible-assets/types — templates available in this tenant. */
export const GET = tenantRoute(
  async ({ tx }) => {
    const rows = await tx<TypeRow[]>`
      SELECT t.id, t.key, t.name, t.description, t.is_active, t.client_visible,
             t.current_version_id, v.version, v.secret_fields
      FROM flexible_asset_type t
      LEFT JOIN flexible_asset_type_version v ON v.id = t.current_version_id
      ORDER BY t.name
    `;
    return {
      types: rows.map((r) => ({
        id: r.id,
        key: r.key,
        name: r.name,
        description: r.description,
        isActive: r.is_active,
        clientVisible: r.client_visible,
        currentVersionId: r.current_version_id,
        currentVersion: r.version,
        secretFields: r.secret_fields ?? [],
      })),
    };
  },
  { permissions: ['asset:read'] },
);

const publishSchema = z.object({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,62}$/, 'key must be lowercase letters, digits and underscores'),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  clientVisible: z.boolean().default(false),
  // Both are arbitrary JSON authored by the technician. postgres.js's json()
  // helper is typed against its own JSONValue, so they are narrowed at the call
  // site rather than being loosely typed here where the shape is documented.
  jsonSchema: z.unknown(),
  uiSchema: z.record(z.string(), z.unknown()).default({}),
  /** Fields promoted into global search. Allow-list, never inferred. */
  searchableFields: z.array(z.string()).default([]),
  changeNote: z.string().max(1000).optional(),
});

/**
 * POST /api/flexible-assets/types — create a template and publish version 1.
 *
 * The schema is vetted BEFORE it is stored, because storing it is what makes it
 * immutable: published versions cannot be edited (enforced by trigger), so an
 * unsafe pattern accepted here is permanent until someone publishes a
 * replacement and migrates every record.
 *
 * `secretFields` is derived from the schema's `x-helm-secret` markers rather
 * than taken from the request. A caller who could nominate which fields are
 * secret could nominate none, and every password in the template would then be
 * stored in the clear.
 */
export const POST = tenantRoute(
  async ({ tx, request, identity }) => {
    const body = await readJson(request, (raw) => {
      const result = publishSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid template', {
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      return result.data;
    });

    const inspection = getFlexibleAssetValidator().inspect(body.jsonSchema);
    if (!inspection.ok) {
      throw ApiError.invalid('the schema was rejected', { issues: inspection.issues });
    }

    const overlap = body.searchableFields.filter((f) => inspection.secretFields.includes(f));
    if (overlap.length > 0) {
      // Also a CHECK on the table; caught here so the author gets a real message
      // rather than a constraint violation.
      throw ApiError.invalid('a secret field cannot also be searchable', { fields: overlap });
    }

    const [type] = await tx<{ id: string }[]>`
      INSERT INTO flexible_asset_type (tenant_id, key, name, description, client_visible, created_by)
      VALUES (
        ${identity.tenantId}::uuid, ${body.key}, ${body.name},
        ${body.description ?? null}, ${body.clientVisible}, ${identity.actorId}::uuid
      )
      RETURNING id
    `;
    if (!type) throw ApiError.conflict('a template with that key already exists');

    const [version] = await tx<{ id: string; version: number }[]>`
      INSERT INTO flexible_asset_type_version (
        tenant_id, type_id, version, status, json_schema, ui_schema,
        secret_fields, searchable_fields, published_at, published_by,
        change_note, created_by
      )
      VALUES (
        ${identity.tenantId}::uuid, ${type.id}, 1, 'published',
        ${tx.json(body.jsonSchema as never)}::jsonb,
        ${tx.json(body.uiSchema as never)}::jsonb,
        ${inspection.secretFields}, ${body.searchableFields},
        now(), ${identity.actorId}::uuid,
        ${body.changeNote ?? null}, ${identity.actorId}::uuid
      )
      RETURNING id, version
    `;
    if (!version) throw ApiError.conflict('failed to publish the schema version');

    await tx`
      UPDATE flexible_asset_type SET current_version_id = ${version.id}::uuid WHERE id = ${type.id}::uuid
    `;

    return {
      typeId: type.id,
      versionId: version.id,
      version: version.version,
      secretFields: inspection.secretFields,
    };
  },
  { permissions: ['flexible_type:manage'] },
);

export const dynamic = 'force-dynamic';
