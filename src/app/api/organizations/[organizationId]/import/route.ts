import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { getSecretService } from '@/lib/services';
import { parseCsv, CSV_MAX_BYTES } from '@/lib/import/csv';
import { asBoolean, importSpecFor, mapRow, type ImportSpec } from '@/lib/import/specs';
import { categoryBySlug } from '@/lib/nav/org-categories';
import { parseTotpEnrolment, TotpEnrolmentError } from '@/lib/secrets/totp-enrolment';

export const dynamic = 'force-dynamic';

/**
 * POST /api/organizations/{id}/import — bring a CSV in.
 *
 * TWO PHASES, ONE ENDPOINT. `commit: false` validates and reports; `commit: true`
 * writes. The preview is not a nicety — it is what makes the write safe to make
 * all-or-nothing, which is the other half of this design.
 *
 * ALL OR NOTHING. 500 rows with 3 bad ones import zero. The alternative is a
 * client whose records are half migrated and whose technician has to work out
 * which half, and this codebase has taken the same position everywhere else a
 * partial write was possible: a credential that exists while its second factor
 * silently did not store is worse than a refused form. The preview means nobody
 * discovers the three bad rows by having the import fail.
 *
 * THE PASSWORD COLUMN NEVER COMES BACK. A preview reports a row by its NAME and
 * its errors, never its values. Echoing the parsed cells would put every
 * plaintext credential in the file into a response body, a browser's memory and
 * any proxy log in between — for a feature whose entire purpose is to get those
 * credentials INTO the vault. The same reasoning as the TOTP seed reveal.
 */
const bodySchema = z.object({
  category: z.string().trim().min(1).max(64),
  /** The file's text. Bounded here as well as by the body limit. */
  csv: z.string().min(1).max(CSV_MAX_BYTES),
  commit: z.boolean().default(false),
});

interface RowResult {
  /** 1-based line in the file, counting the header. */
  line: number;
  /** How the row identifies itself — a name, never a secret. */
  label: string;
  errors: string[];
}

/** Validate one mapped row. Returns the problems, not the payload. */
function validate(spec: ImportSpec, values: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const field of spec.fields) {
    const value = values[field.key] ?? '';
    if (field.required && value === '') {
      errors.push(`${field.label} is required`);
      continue;
    }
    if (field.maxLength && value.length > field.maxLength) {
      errors.push(`${field.label} is longer than ${field.maxLength} characters`);
    }
  }

  if (spec.slug === 'passwords' && (values.totpSeed ?? '') !== '') {
    // Parsed now rather than at write time, so a bad seed is a preview error on
    // its own row instead of an exception that rolls back the whole import.
    try {
      parseTotpEnrolment(values.totpSeed!);
    } catch (error) {
      errors.push(
        error instanceof TotpEnrolmentError ? error.message : 'the one-time code seed is not valid',
      );
    }
  }

  const criticality = values.criticality;
  if (criticality !== undefined && criticality !== '') {
    const n = Number(criticality);
    if (!Number.isInteger(n) || n < 1 || n > 5) {
      errors.push('Criticality must be a whole number from 1 to 5');
    }
  }

  return errors;
}

export const POST = tenantRoute(
  async ({ tx, request, params, identity, session }) => {
    const organizationId = params.organizationId;
    if (!organizationId || !z.guid().safeParse(organizationId).success) {
      throw ApiError.invalid('organizationId must be a UUID');
    }

    const body = await readJson(request, (raw) => {
      const result = bodySchema.safeParse(raw);
      if (!result.success) throw ApiError.invalid('invalid import request');
      return result.data;
    });

    const spec = importSpecFor(body.category);
    if (!spec) {
      throw ApiError.invalid(
        `${body.category} cannot be imported from a file — documents are uploaded, and SOPs are written in Helm`,
      );
    }

    /*
     * Passwords need secret:write on top of the route's asset:write. Checked
     * here rather than relying on the database refusing the first INSERT,
     * because by then the file has been parsed and the refusal reads as a
     * failure partway through rather than as "you may not do this".
     */
    if (spec.slug === 'passwords' && !session.permissions.includes('secret:write')) {
      throw ApiError.forbidden('missing permission: secret:write');
    }

    // RLS decides whether this organisation exists for this actor.
    const [org] = await tx<{ id: string }[]>`
      SELECT id FROM organization WHERE id = ${organizationId}::uuid
    `;
    if (!org) throw ApiError.notFound('no such client');

    const parsed = parseCsv(body.csv);
    const fileErrors = parsed.errors.map((e) => `line ${e.line}: ${e.message}`);

    const results: RowResult[] = [];
    const ignored = new Set<string>();
    const mapped: Record<string, string>[] = [];

    parsed.rows.forEach((row, index) => {
      const { values, ignored: unknown } = mapRow(spec, row);
      unknown.forEach((h) => ignored.add(h));
      mapped.push(values);
      results.push({
        line: index + 2, // +1 for zero-based, +1 for the header
        label:
          values.name || [values.firstName, values.lastName].filter(Boolean).join(' ') || '(unnamed)',
        errors: validate(spec, values),
      });
    });

    const invalid = results.filter((r) => r.errors.length > 0).length;
    const summary = {
      category: spec.slug,
      rows: results.length,
      valid: results.length - invalid,
      invalid,
      ignoredColumns: [...ignored],
      fileErrors,
      // Capped: a file where every row is wrong should not return 5000 of them.
      rows_detail: results.filter((r) => r.errors.length > 0).slice(0, 50),
    };

    if (!body.commit) {
      return { ...summary, committed: 0 };
    }

    if (fileErrors.length > 0 || invalid > 0 || results.length === 0) {
      throw ApiError.invalid(
        results.length === 0
          ? 'there is nothing to import'
          : `${invalid} of ${results.length} rows cannot be imported — nothing was written`,
        { ...summary },
      );
    }

    const actor = {
      tenantId: identity.tenantId,
      actorId: identity.actorId,
      actorType: identity.actorType,
    };

    // Sites are addressed by NAME in an asset import, so resolve them once
    // rather than per row.
    const siteByName = new Map<string, string>();
    if (spec.fields.some((f) => f.key === 'site')) {
      const sites = await tx<{ id: string; name: string }[]>`
        SELECT id, name FROM site
        WHERE organization_id = ${organizationId}::uuid AND deleted_at IS NULL
      `;
      for (const s of sites) siteByName.set(s.name.toLowerCase(), s.id);
    }

    let committed = 0;
    for (const values of mapped) {
      if (spec.slug === 'contacts') {
        await tx`
          INSERT INTO contact (
            tenant_id, organization_id, first_name, last_name, title, email, phone,
            mobile, notes, is_primary, is_technical, is_billing, is_emergency,
            created_by, updated_by)
          VALUES (
            helm.require_tenant_id(), ${organizationId}::uuid,
            ${values.firstName!}, ${values.lastName!}, ${values.title || null},
            ${values.email || null}, ${values.phone || null}, ${values.mobile || null},
            ${values.notes || null},
            ${asBoolean(values.isPrimary)}, ${asBoolean(values.isTechnical)},
            ${asBoolean(values.isBilling)}, ${asBoolean(values.isEmergency)},
            ${identity.actorId}::uuid, ${identity.actorId}::uuid)
        `;
      } else if (spec.slug === 'locations') {
        await tx`
          INSERT INTO site (
            tenant_id, organization_id, name, code, address_line1, address_line2,
            city, region, postal_code, country, main_phone, notes, is_primary,
            created_by, updated_by)
          VALUES (
            helm.require_tenant_id(), ${organizationId}::uuid,
            ${values.name!}, ${values.code || null},
            ${values.addressLine1 || null}, ${values.addressLine2 || null},
            ${values.city || null}, ${values.region || null},
            ${values.postalCode || null}, ${(values.country || 'US').toUpperCase().slice(0, 2)},
            ${values.mainPhone || null}, ${values.notes || null},
            ${asBoolean(values.isPrimary)},
            ${identity.actorId}::uuid, ${identity.actorId}::uuid)
        `;
      } else if (spec.slug === 'passwords') {
        /*
         * The same two writes POST /api/secrets makes, in the same order and the
         * same transaction: the secret, then the credential node that points at
         * it. Routed through the service so the plaintext is sealed by the one
         * piece of code that knows how, and so the audit row is written.
         */
        const created = await getSecretService().createInTransaction(
          tx, actor,
          { organizationId, label: values.name!, sensitivity: 'standard' },
          values.password!,
        );

        const [node] = await tx<{ id: string }[]>`
          INSERT INTO asset_node (
            tenant_id, organization_id, node_type, name, notes, criticality,
            created_by, updated_by)
          VALUES (
            helm.require_tenant_id(), ${organizationId}::uuid, 'credential'::node_type,
            ${values.name!}, ${values.notes || null}, 3,
            ${identity.actorId}::uuid, ${identity.actorId}::uuid)
          RETURNING id
        `;

        let totpSecretId: string | null = null;
        let algorithm = 'SHA1';
        let digits = 6;
        let period = 30;
        if ((values.totpSeed ?? '') !== '') {
          // Already proven parseable during validation.
          const enrolment = parseTotpEnrolment(values.totpSeed!);
          const seed = await getSecretService().createInTransaction(
            tx, actor,
            { organizationId, kind: 'totp_seed', label: `${values.name!} (TOTP seed)`, sensitivity: 'elevated' },
            enrolment.seed,
          );
          totpSecretId = seed.secretId;
          algorithm = enrolment.algorithm;
          digits = enrolment.digits;
          period = enrolment.periodSeconds;
        }

        await tx`
          INSERT INTO credential (
            id, tenant_id, node_type, credential_type, username, url, secret_id,
            totp_secret_id, totp_algorithm, totp_digits, totp_period_seconds)
          VALUES (
            ${node!.id}::uuid, helm.require_tenant_id(), 'credential', 'other'::credential_type,
            ${values.username || null}, ${values.url || null}, ${created.secretId}::uuid,
            ${totpSecretId}::uuid, ${algorithm}, ${digits}, ${period})
        `;
      } else {
        const category = categoryBySlug(spec.slug)!;
        const siteId = values.site ? (siteByName.get(values.site.toLowerCase()) ?? null) : null;
        await tx`
          INSERT INTO asset_node (
            tenant_id, organization_id, site_id, node_type, name, description, notes,
            criticality, created_by, updated_by)
          VALUES (
            helm.require_tenant_id(), ${organizationId}::uuid, ${siteId}::uuid,
            ${category.source}::node_type, ${values.name!},
            ${values.description || null}, ${values.notes || null},
            ${values.criticality ? Number(values.criticality) : 3},
            ${identity.actorId}::uuid, ${identity.actorId}::uuid)
        `;
      }
      committed += 1;
    }

    return { ...summary, committed };
  },
  { permissions: ['asset:write'] },
);
