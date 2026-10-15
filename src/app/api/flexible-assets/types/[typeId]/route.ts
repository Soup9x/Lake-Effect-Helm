import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { schemaToFields } from '@/lib/flexible/fields';

interface TypeDetailRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  icon: string | null;
  colour: string | null;
  is_active: boolean;
  client_visible: boolean;
  current_version_id: string | null;
  version: number | null;
  json_schema: unknown;
  ui_schema: unknown;
  secret_fields: string[] | null;
  searchable_fields: string[] | null;
  record_count: string;
}

/**
 * GET /api/flexible-assets/types/{typeId} — one type, with its live schema.
 *
 * The list endpoint deliberately does not return `json_schema`: it is read on
 * every sidebar render and a schema is up to 64KB. The editor needs it, so it
 * gets its own route rather than making every other caller pay.
 *
 * `fields` is the schema already decoded into the editor's model, so the client
 * component does not have to carry the conversion — and so there is exactly one
 * implementation of "what does this schema mean", shared with the publish path.
 *
 * `recordCount` is here because it changes what publishing a new version MEANS.
 * With no records it is a correction; with four hundred it marks four hundred
 * rows as needing migration. The screen says which before the button is
 * pressed.
 */
export const GET = tenantRoute(
  async ({ tx, params }) => {
    const typeId = z.string().uuid().safeParse(params.typeId);
    if (!typeId.success) throw ApiError.invalid('not a type id');

    const [row] = await tx<TypeDetailRow[]>`
      SELECT t.id, t.key, t.name, t.description, t.icon, t.colour,
             t.is_active, t.client_visible, t.current_version_id,
             v.version, v.json_schema, v.ui_schema,
             v.secret_fields, v.searchable_fields,
             (SELECT count(*) FROM flexible_asset_record r
               WHERE r.type_id = t.id) AS record_count
      FROM flexible_asset_type t
      LEFT JOIN flexible_asset_type_version v ON v.id = t.current_version_id
      WHERE t.id = ${typeId.data}::uuid
    `;
    // RLS makes "not yours" and "not there" the same answer, as everywhere else.
    if (!row) throw ApiError.notFound('no such type');

    return {
      id: row.id,
      key: row.key,
      name: row.name,
      description: row.description,
      icon: row.icon,
      colour: row.colour,
      isActive: row.is_active,
      clientVisible: row.client_visible,
      currentVersionId: row.current_version_id,
      currentVersion: row.version,
      jsonSchema: row.json_schema,
      uiSchema: row.ui_schema,
      secretFields: row.secret_fields ?? [],
      searchableFields: row.searchable_fields ?? [],
      fields: schemaToFields(row.json_schema, row.ui_schema),
      recordCount: Number(row.record_count),
    };
  },
  { permissions: ['asset:read'] },
);

/**
 * The type's own columns, and nothing a published version owns.
 *
 * `key` is absent on purpose. It is the stable identifier a record's type is
 * known by, it is unique per tenant, and an API client may well have it
 * written down; renaming it is a migration of somebody else's integration
 * rather than an edit. `name` is the display label and changes freely.
 */
const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  /** A lucide icon name. The sidebar resolves it and falls back when it cannot. */
  icon: z.string().max(64).nullable().optional(),
  colour: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'colour must be #rrggbb').nullable().optional(),
  isActive: z.boolean().optional(),
  clientVisible: z.boolean().optional(),
});

/**
 * PATCH /api/flexible-assets/types/{typeId} — the metadata, not the schema.
 *
 * Separate from publishing a version because the two have different costs. A
 * colour is a colour; a schema is an immutable artefact that marks every
 * existing record as needing migration. Folding them into one endpoint would
 * mean a rename could not be done without republishing.
 *
 * `clientVisible` IS AN ACCESS CHANGE, which is why it is here rather than
 * nowhere: flipping it on exposes every record of this type to client-side
 * roles, and flipping it off hides them again. It is `flexible_type:manage`,
 * msp_only, and the policies on flexible_asset_record consult the column
 * directly — so this writes the column and the database does the rest.
 */
export const PATCH = tenantRoute(
  async ({ tx, request, params }) => {
    const typeId = z.string().uuid().safeParse(params.typeId);
    if (!typeId.success) throw ApiError.invalid('not a type id');

    const body = await readJson(request, (raw) => {
      const result = patchSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid type', {
          issues: zodIssues(result.error),
        });
      }
      return result.data;
    });

    if (Object.keys(body).length === 0) throw ApiError.invalid('nothing to change');

    const [updated] = await tx<{ id: string }[]>`
      UPDATE flexible_asset_type SET
        name           = COALESCE(${body.name ?? null}, name),
        description    = ${body.description === undefined ? tx`description` : body.description},
        icon           = ${body.icon === undefined ? tx`icon` : body.icon},
        colour         = ${body.colour === undefined ? tx`colour` : body.colour},
        is_active      = COALESCE(${body.isActive ?? null}, is_active),
        client_visible = COALESCE(${body.clientVisible ?? null}, client_visible),
        updated_at     = now()
      WHERE id = ${typeId.data}::uuid
      RETURNING id
    `;
    // The read above would have thrown for a type RLS hides, so reaching here
    // with no row means the UPDATE policy refused what the SELECT allowed.
    if (!updated) throw ApiError.forbidden('your role does not permit editing this type');

    return { id: updated.id };
  },
  { permissions: ['flexible_type:manage'] },
);

export const dynamic = 'force-dynamic';
