import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { ARROWS, DIAGRAM_COLORS, LINE_STYLES } from '@/lib/topology/style';

function ids(params: Record<string, string>): { diagramId: string; linkId: string } {
  const diagramId = params.diagramId;
  const linkId = params.linkId;
  if (!diagramId || !z.guid().safeParse(diagramId).success) {
    throw ApiError.invalid('diagramId must be a UUID');
  }
  if (!linkId || !z.guid().safeParse(linkId).success) {
    throw ApiError.invalid('linkId must be a UUID');
  }
  return { diagramId, linkId };
}

/**
 * PATCH one line: its label, style, arrow or colour (1190).
 *
 * An explicit null clears the label or colour, and an absent field is left
 * alone, as on PATCH …/nodes/{nodeId}. "reverse" swaps the two ends, so an
 * arrow that points the wrong way can be turned round without redrawing it;
 * the pair index is over the unordered pair, so a swap is never a duplicate.
 */
const patchSchema = z
  .object({
    label: z.string().trim().max(80).nullable().optional(),
    lineStyle: z.enum(LINE_STYLES).optional(),
    arrow: z.enum(ARROWS).optional(),
    color: z.enum(DIAGRAM_COLORS).nullable().optional(),
    reverse: z.literal(true).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to change' });

export const PATCH = tenantRoute(
  async ({ tx, request, params }) => {
    const { diagramId, linkId } = ids(params);
    const body = await readJson(request, (raw) => {
      const result = patchSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid topology link change', { issues: zodIssues(result.error) });
      }
      return result.data;
    });

    const reverse = body.reverse === true;
    const [row] = await tx<{ id: string }[]>`
      UPDATE topology_link SET
        label        = CASE WHEN ${body.label !== undefined} THEN ${body.label || null} ELSE label END,
        line_style   = COALESCE(${body.lineStyle ?? null}, line_style),
        arrow        = COALESCE(${body.arrow ?? null}, arrow),
        color        = CASE WHEN ${body.color !== undefined} THEN ${body.color ?? null} ELSE color END,
        from_node_id = CASE WHEN ${reverse} THEN to_node_id ELSE from_node_id END,
        to_node_id   = CASE WHEN ${reverse} THEN from_node_id ELSE to_node_id END
      WHERE id = ${linkId}::uuid AND diagram_id = ${diagramId}::uuid
      RETURNING id
    `;
    // RLS refuses a link outside the actor's reach by matching no row.
    if (!row) throw ApiError.notFound('no such topology link');
    return { linkId: row.id };
  },
  { permissions: ['asset:write'] },
);

/** DELETE one line. Nothing re-derives it, so it stays deleted. */
export const DELETE = tenantRoute(
  async ({ tx, params }) => {
    const { diagramId, linkId } = ids(params);

    const [row] = await tx<{ id: string }[]>`
      DELETE FROM topology_link
      WHERE id = ${linkId}::uuid AND diagram_id = ${diagramId}::uuid
      RETURNING id
    `;
    if (!row) throw ApiError.notFound('no such topology link');

    return { deleted: row.id };
  },
  { permissions: ['asset:write'] },
);

export const dynamic = 'force-dynamic';
