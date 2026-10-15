import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { getFlexibleAssetValidator, getSecretService } from '@/lib/services';

const patchSchema = z.object({
  data: z.record(z.string(), z.unknown()),
});

interface RecordRow {
  record_id: string;
  type_id: string;
  pinned_version_id: string;
  organization_id: string;
  version_id: string;
  version: number;
  json_schema: unknown;
  secret_fields: string[];
  type_name: string;
}

/**
 * PATCH /api/flexible-assets/records/[recordId] — edit a record's own fields.
 *
 * ONLY the custom document. A record IS an asset_node, so its name, site,
 * status, criticality, tags and internal-only flag are PATCH /api/assets/[id]'s
 * business and are not accepted here — two routes writing the same columns is
 * how they come to disagree about which one validates what.
 *
 * VALIDATED AGAINST THE TYPE'S CURRENT VERSION, NOT THE RECORD'S PINNED ONE,
 * and that is the substantive decision in this file. Validating against the
 * pinned version would stand a record permanently on the schema it was written
 * under: a field added since could never be filled in, because the schema that
 * would accept it is not the one the record is being checked against. Pinning
 * is there so a record is never retroactively invalid, which is a statement
 * about READING it; writing is a new act and belongs under the current rules.
 *
 * So a successful edit IS the migration. It moves type_version_id forward and
 * clears needs_migration, which turns that flag from a permanent mark into
 * something a technician can act on: open the record, fix what the new schema
 * wants, save. Nothing else in Helm can clear it.
 *
 * A BLANK SECRET MEANS UNCHANGED. The record's secret values live in
 * flexible_asset_secret and are never sent to a browser, so the form cannot
 * show them and a blank box cannot mean "delete". An omitted (or null) secret
 * field leaves the stored value exactly as it was; a supplied one rotates
 * through the audited secret path, so the old version stays readable and the
 * change is on the record.
 */
export const PATCH = tenantRoute(
  async ({ tx, request, identity, params }) => {
    const recordId = z.guid().safeParse(params.recordId);
    if (!recordId.success) throw ApiError.invalid('not a record id');

    const body = await readJson(request, (raw) => {
      const result = patchSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid changes', {
          issues: zodIssues(result.error),
        });
      }
      return result.data;
    });

    const [record] = await tx<RecordRow[]>`
      SELECT r.id AS record_id, r.type_id, r.type_version_id AS pinned_version_id,
             n.organization_id,
             v.id AS version_id, v.version, v.json_schema, v.secret_fields,
             t.name AS type_name
      FROM flexible_asset_record r
      JOIN asset_node n ON n.id = r.id
      JOIN flexible_asset_type t ON t.id = r.type_id
      JOIN flexible_asset_type_version v ON v.id = t.current_version_id
      WHERE r.id = ${recordId.data}::uuid
        AND n.archived_at IS NULL
        AND t.is_active
    `;
    // RLS has already removed a record this actor may not see, so "no such
    // record", "archived", "its type was retired" and "its type has no
    // published version" arrive here as one answer — which is the intent.
    if (!record) throw ApiError.notFound('no such record');

    /*
     * The secrets this record already holds.
     *
     * One query for ONE record, which is the distinction that makes it
     * acceptable here: the same read was rejected for the LIST view, where it
     * would have been a query per row for hundreds of rows. Here the record is
     * already identified and its secrets are needed twice over — to satisfy
     * `required` for a field nobody retyped, and to tell a rotation from a
     * first write below.
     */
    const held = new Map(
      (
        await tx<{ field_path: string; secret_id: string }[]>`
          SELECT field_path, secret_id FROM flexible_asset_secret
          WHERE record_id = ${recordId.data}::uuid
        `
      ).map((row) => [row.field_path, row.secret_id]),
    );

    const validation = getFlexibleAssetValidator().validateRecord(
      record.version_id,
      record.json_schema,
      record.secret_fields,
      body.data,
      { heldSecrets: [...held.keys()] },
    );
    if (!validation.ok) {
      throw ApiError.invalid('the record does not match its template', {
        fields: validation.errors,
      });
    }

    const [updated] = await tx<{ id: string }[]>`
      UPDATE flexible_asset_record SET
        data            = ${tx.json(validation.data as never)}::jsonb,
        type_version_id = ${record.version_id}::uuid,
        validated_at    = now(),
        needs_migration = false
      WHERE id = ${recordId.data}::uuid
      RETURNING id
    `;
    if (!updated) throw ApiError.notFound('no such record');

    for (const [pointer, plaintext] of validation.secrets) {
      const existing = held.get(pointer);
      if (existing) {
        // A rotation, not an overwrite: helm.write_secret_version appends, so
        // the password that was on this record during last month's incident
        // stays readable.
        await getSecretService().rotateInTransaction(
          tx,
          { tenantId: identity.tenantId, actorId: identity.actorId },
          existing,
          plaintext,
          'edited on its flexible asset record',
        );
        continue;
      }

      // No stored secret for this pointer: either the field is new, or it
      // became secret in a later version of the template. Same label shape the
      // create path uses, so the two are indistinguishable afterwards.
      const created = await getSecretService().createInTransaction(
        tx,
        { tenantId: identity.tenantId, actorId: identity.actorId },
        {
          organizationId: record.organization_id,
          kind: 'generic',
          label: `${record.type_name} — ${pointer.replace(/^\//, '')}`,
        },
        plaintext,
      );
      await tx`
        INSERT INTO flexible_asset_secret (record_id, tenant_id, field_path, secret_id)
        VALUES (
          ${recordId.data}::uuid, ${identity.tenantId}::uuid, ${pointer}, ${created.secretId}::uuid
        )
      `;
    }

    /*
     * Touch the node so the edit is visible where people look for it.
     *
     * flexible_asset_record carries no updated_at of its own — asset_node is
     * where every other asset's "last updated, by whom" lives, and the client
     * page's recently-updated widget and the list view's columns both read it.
     * Without this, editing a record's fields would change nothing any of them
     * can see.
     */
    await tx`
      UPDATE asset_node
      SET updated_at = now(), updated_by = ${identity.actorId}::uuid
      WHERE id = ${recordId.data}::uuid
    `;

    return {
      nodeId: record.record_id,
      typeVersionId: record.version_id,
      typeVersion: record.version,
      migrated: record.pinned_version_id !== record.version_id,
      secretsWritten: [...validation.secrets.keys()],
    };
  },
  { permissions: ['asset:write'] },
);

export const dynamic = 'force-dynamic';
