import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { getFlexibleAssetValidator } from '@/lib/services';
import { schemaCompatibility } from '@/lib/flexible/compatibility';

/**
 * Publishing a new schema version for an existing type.
 *
 * WHY THIS ROUTE HAD TO EXIST. POST /api/flexible-assets/types creates a type
 * AND publishes version 1, and there was nothing else — so "edit a type's
 * fields" had no API at all. A published version cannot be edited (0080's
 * freeze_published_schema trigger), which is the right design and which makes
 * a second route mandatory rather than optional: the only way to change a
 * schema is to supersede it.
 *
 * `secret_fields` IS DERIVED, NEVER ACCEPTED. Same rule as version 1, for the
 * same reason: a caller who could nominate which fields are secret could
 * nominate none, and every password in the template would then be stored in
 * the clear in `data`.
 */
const publishVersionSchema = z.object({
  jsonSchema: z.unknown(),
  uiSchema: z.record(z.string(), z.unknown()).default({}),
  /**
   * JSON POINTERS into the schema's own properties — '/hostname', not
   * 'hostname'. See the note in src/lib/flexible/fields.ts: 0240's indexing
   * trigger does `substring(v_path from 2)`, so a bare name silently indexes
   * nothing. This endpoint refuses the bare form rather than storing something
   * that will quietly do nothing.
   */
  searchableFields: z.array(z.string()).default([]),
  changeNote: z.string().max(1000).optional(),
});

interface CurrentRow {
  type_id: string;
  current_version_id: string | null;
  current_version: number | null;
  current_schema: unknown;
  highest_version: number;
}

export const POST = tenantRoute(
  async ({ tx, request, identity, params }) => {
    const typeId = z.string().uuid().safeParse(params.typeId);
    if (!typeId.success) throw ApiError.invalid('not a type id');

    const body = await readJson(request, (raw) => {
      const result = publishVersionSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid schema version', {
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      return result.data;
    });

    const inspection = getFlexibleAssetValidator().inspect(body.jsonSchema);
    if (!inspection.ok) {
      throw ApiError.invalid('the schema was rejected', { issues: inspection.issues });
    }

    /*
     * searchableFields must be pointers that resolve to a property this schema
     * actually declares. Three failure modes, all silent before this check:
     *
     *   'hostname'   stored, indexes data->>'ostname', finds nothing
     *   '/typo'      stored, indexes a key no record has
     *   '/api_token' a secret — and in POINTER form the overlap check below
     *                and the CHECK constraint both catch it, which is exactly
     *                why the bare form must be refused rather than normalised.
     */
    const properties = ((body.jsonSchema as { properties?: Record<string, unknown> })
      .properties ?? {});
    const badPointers = body.searchableFields.filter(
      (f) => !f.startsWith('/') || !(f.slice(1) in properties),
    );
    if (badPointers.length > 0) {
      throw ApiError.invalid(
        'searchable fields must be JSON pointers to fields this schema declares, like "/hostname"',
        { fields: badPointers },
      );
    }

    const overlap = body.searchableFields.filter((f) => inspection.secretFields.includes(f));
    if (overlap.length > 0) {
      // Also flexible_version_secrets_not_searchable; caught here so the author
      // gets a sentence rather than a constraint name.
      throw ApiError.invalid('a secret field cannot also be searchable', { fields: overlap });
    }

    const [current] = await tx<CurrentRow[]>`
      SELECT t.id AS type_id, t.current_version_id,
             v.version AS current_version, v.json_schema AS current_schema,
             coalesce((SELECT max(version) FROM flexible_asset_type_version
                        WHERE type_id = t.id), 0) AS highest_version
      FROM flexible_asset_type t
      LEFT JOIN flexible_asset_type_version v ON v.id = t.current_version_id
      WHERE t.id = ${typeId.data}::uuid
    `;
    if (!current) throw ApiError.notFound('no such type');

    const nextVersion = current.highest_version + 1;

    const [version] = await tx<{ id: string; version: number }[]>`
      INSERT INTO flexible_asset_type_version (
        tenant_id, type_id, version, status, json_schema, ui_schema,
        secret_fields, searchable_fields, published_at, published_by,
        change_note, created_by
      )
      VALUES (
        ${identity.tenantId}::uuid, ${current.type_id}::uuid, ${nextVersion}, 'published',
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
      UPDATE flexible_asset_type
      SET current_version_id = ${version.id}::uuid, updated_at = now()
      WHERE id = ${current.type_id}::uuid
    `;

    /*
     * needs_migration, which until now nothing ever set.
     *
     * The flag means "this record no longer conforms to its type's current
     * version" (0080), so it is written from a schema comparison rather than a
     * per-record validation — stored `data` is the post-split document and
     * re-validating it would fail `required` on every secret field. See
     * src/lib/flexible/compatibility.ts for why, and for why the answer errs
     * towards flagging.
     *
     * Set AND CLEARED. A compatible publish clears stale flags, so republishing
     * to fix a mistake takes the warning off the records it was about rather
     * than leaving them marked forever. `type_version_id` is deliberately NOT
     * moved: it records which schema a record's data was written against, and
     * rewriting it would make this flag meaningless and point the indexing
     * trigger at the wrong searchable_fields.
     */
    const compatibility = schemaCompatibility(current.current_schema, body.jsonSchema);
    const [flagged] = await tx<{ n: number }[]>`
      UPDATE flexible_asset_record
      SET needs_migration = ${!compatibility.compatible}
      WHERE type_id = ${current.type_id}::uuid
        AND type_version_id <> ${version.id}::uuid
        AND needs_migration <> ${!compatibility.compatible}
      RETURNING 1 AS n
    `.then((rows) => [{ n: rows.length }]);

    return {
      typeId: current.type_id,
      versionId: version.id,
      version: version.version,
      supersededVersion: current.current_version,
      secretFields: inspection.secretFields,
      /** What changed for the records already stored, and why. */
      compatible: compatibility.compatible,
      compatibilityReasons: compatibility.reasons,
      recordsFlagged: compatibility.compatible ? 0 : (flagged?.n ?? 0),
      recordsCleared: compatibility.compatible ? (flagged?.n ?? 0) : 0,
    };
  },
  { permissions: ['flexible_type:manage'] },
);

export const dynamic = 'force-dynamic';
