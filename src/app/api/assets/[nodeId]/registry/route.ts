import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { detailFieldsFor } from '@/lib/assets/detail-fields';
import { writeDetail } from '@/lib/assets/detail-write';
import type { RegistryDetails } from '@/lib/external/rdap';
import { VERIFIABLE_KEYS } from '@/lib/external/registry-suggestions';

/**
 * POST /api/assets/[nodeId]/registry — a person's verdict on what the
 * registry says about a domain (1140).
 *
 *   { apply: ['registrar', 'nameservers'] }   use the registry's values
 *   { keep:  ['expires_at'] }                 keep what is recorded
 *
 * THE VALUES COME FROM THE DATABASE, NOT THE REQUEST. The request names which
 * fields; what is written is registry_details as the probe stored it, so the
 * button applies exactly what the page showed the person and nothing a client
 * could substitute. Applying goes through writeDetail with the domain
 * catalogue — the same casts, refusals and history entry as Edit details —
 * and the change is recorded as the person's, because it is.
 *
 * Keeping stores the registry's current value in registry_dismissed, so the
 * suggestion stays quiet until the registry says something different.
 */
const bodySchema = z.object({
  apply: z.array(z.string()).max(16).optional(),
  keep: z.array(z.string()).max(16).optional(),
}).refine((b) => (b.apply?.length ?? 0) + (b.keep?.length ?? 0) > 0, 'name at least one field');

export const POST = tenantRoute(
  async ({ tx, request, identity, params }) => {
    const nodeId = z.guid().safeParse(params.nodeId);
    if (!nodeId.success) throw ApiError.invalid('not an asset id');

    const body = await readJson(request, (raw) => {
      const result = bodySchema.safeParse(raw);
      if (!result.success) throw ApiError.invalid('{ apply: [...] } or { keep: [...] }');
      return result.data;
    });
    const apply = [...new Set(body.apply ?? [])];
    const keep = [...new Set(body.keep ?? [])];
    const unknown = [...apply, ...keep].filter((k) => !VERIFIABLE_KEYS.has(k));
    if (unknown.length > 0) {
      throw ApiError.invalid(`not a field the registry fills: ${unknown.join(', ')}`, { fields: unknown });
    }

    const [row] = await tx<{ details: RegistryDetails | null }[]>`
      SELECT d.registry_details AS details
      FROM domain d JOIN asset_node n ON n.id = d.id
      WHERE d.id = ${nodeId.data}::uuid AND n.archived_at IS NULL
      FOR UPDATE OF d
    `;
    if (!row) throw ApiError.notFound('no such domain');
    const details = row.details ?? {};

    const missing = [...apply, ...keep].filter((k) => details[k as keyof RegistryDetails] === undefined);
    if (missing.length > 0) {
      throw ApiError.conflict(
        `the registry has not said anything about ${missing.join(', ')}; reload the page`,
      );
    }

    const values = Object.fromEntries(apply.map((k) => [k, details[k as keyof RegistryDetails]]));
    const applied = apply.length === 0
      ? []
      : await writeDetail(tx, 'domain', detailFieldsFor('domain'), nodeId.data, values, { kindName: 'domain' });

    // Applied fields drop any earlier "keep mine"; kept ones record the value
    // the person declined. One statement, so the two cannot disagree.
    const kept = Object.fromEntries(keep.map((k) => [k, details[k as keyof RegistryDetails]]));
    await tx`
      UPDATE domain SET registry_dismissed = nullif(
        (coalesce(registry_dismissed, '{}'::jsonb) - ${apply}::text[]) || ${tx.json(kept as never)},
        '{}'::jsonb)
      WHERE id = ${nodeId.data}::uuid
    `;
    if (applied.length > 0) {
      await tx`
        UPDATE asset_node SET updated_at = now(), updated_by = ${identity.actorId}::uuid
        WHERE id = ${nodeId.data}::uuid
      `;
    }
    return { applied, kept: keep };
  },
  { permissions: ['asset:write'] },
);

export const dynamic = 'force-dynamic';
