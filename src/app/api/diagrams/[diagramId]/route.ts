import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(4000).nullable().optional(),
    siteId: z.guid().nullable().optional(),
    networkId: z.guid().nullable().optional(),
    isInternalOnly: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' });

function diagramIdOf(params: Record<string, string>): string {
  const id = z.guid().safeParse(params.diagramId);
  if (!id.success) throw ApiError.invalid('diagramId must be a UUID');
  return id.data;
}

/**
 * PATCH /api/diagrams/[diagramId] — rename, re-describe, re-file, archive or
 * restore a diagram.
 *
 * An absent field is left alone and an explicit null clears it, the shape
 * PATCH /api/sites uses. Archiving keeps every box and line; the diagram leaves
 * the list until somebody ticks "Include archived" and restores it.
 */
export const PATCH = tenantRoute(
  async ({ tx, request, identity, params }) => {
    const diagramId = diagramIdOf(params);
    const body = await readJson(request, (raw) => {
      const result = patchSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid changes', { issues: zodIssues(result.error) });
      }
      return result.data;
    });

    let row: { id: string } | undefined;
    try {
      [row] = await tx<{ id: string }[]>`
        UPDATE network_diagram SET
          name             = COALESCE(${body.name ?? null}, name),
          description      = CASE WHEN ${body.description !== undefined}
                                  THEN ${body.description || null} ELSE description END,
          site_id          = CASE WHEN ${body.siteId !== undefined}
                                  THEN ${body.siteId ?? null}::uuid ELSE site_id END,
          network_id       = CASE WHEN ${body.networkId !== undefined}
                                  THEN ${body.networkId ?? null}::uuid ELSE network_id END,
          is_internal_only = COALESCE(${body.isInternalOnly ?? null}::boolean, is_internal_only),
          archived_at      = ${body.archived === undefined
            ? tx`archived_at`
            : body.archived ? tx`coalesce(archived_at, now())` : tx`NULL`},
          updated_by       = ${identity.actorId}::uuid
        WHERE id = ${diagramId}::uuid
        RETURNING id
      `;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === '23503') throw ApiError.invalid('no such location or network');
      if (code === '23514') {
        throw ApiError.invalid('the location and network must be this client’s');
      }
      throw error;
    }
    // RLS refuses a diagram outside this actor's reach by matching no row, so
    // "not there" and "not yours" are one answer.
    if (!row) throw ApiError.notFound('no such diagram');
    return { diagramId: row.id };
  },
  { permissions: ['asset:write'] },
);

/**
 * DELETE /api/diagrams/[diagramId] — destroy an archived diagram, with every
 * box and line on it (the foreign keys cascade).
 *
 * Archive first, then delete, the order everything else in Helm uses: a live
 * diagram is refused rather than deleted from under somebody reading it.
 */
export const DELETE = tenantRoute(
  async ({ tx, params }) => {
    const diagramId = diagramIdOf(params);
    const [row] = await tx<{ id: string; archived: boolean }[]>`
      SELECT id, archived_at IS NOT NULL AS archived FROM network_diagram WHERE id = ${diagramId}::uuid
    `;
    if (!row) throw ApiError.notFound('no such diagram');
    if (!row.archived) throw ApiError.conflict('archive the diagram before deleting it');

    // RETURNING, because a delete the write policy refuses matches no row
    // rather than raising.
    const [gone] = await tx<{ id: string }[]>`
      DELETE FROM network_diagram WHERE id = ${diagramId}::uuid RETURNING id
    `;
    if (!gone) throw ApiError.forbidden('you may not delete this diagram');
    return { deleted: gone.id };
  },
  { permissions: ['asset:write'] },
);

export const dynamic = 'force-dynamic';
