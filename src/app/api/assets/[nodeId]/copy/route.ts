import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';

/**
 * POST /api/assets/:nodeId/copy — a new entry from this one, under a new name.
 *
 * helm.copy_asset() (1020) decides what goes across: the shared fields and the
 * kind's own row, never a password, a TOTP seed or a private key, and nothing
 * an external check observed. A domain takes the new name as its domain name.
 * Relationships, attachments and history stay with the original: a copy is a
 * starting point for a similar thing, not a second record of the same one.
 */
const schema = z.object({
  name: z.string().trim().min(1).max(200),
});

export const POST = tenantRoute(
  async ({ tx, request, params }) => {
    const nodeId = z.guid().safeParse(params.nodeId);
    if (!nodeId.success) throw ApiError.invalid('not an entry id');

    const body = await readJson(request, (raw) => {
      const result = schema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('a name for the copy', { issues: zodIssues(result.error) });
      }
      return result.data;
    });

    // Read under RLS first, so "not there" and "not yours" are one 404.
    const [source] = await tx<{ node_type: string }[]>`
      SELECT node_type::text AS node_type FROM asset_node
      WHERE id = ${nodeId.data}::uuid AND archived_at IS NULL
    `;
    if (!source) throw ApiError.notFound('no such entry');

    let copy: { id: string } | undefined;
    try {
      [copy] = await tx<{ id: string }[]>`SELECT helm.copy_asset(${nodeId.data}::uuid, ${body.name}) AS id`;
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw ApiError.conflict(
          source.node_type === 'domain'
            ? `${body.name} is already documented as a domain`
            : 'an entry like that already exists; give the copy a different name or address',
        );
      }
      throw error;
    }
    return { asset: { id: copy!.id, name: body.name, nodeType: source.node_type } };
  },
  { permissions: ['asset:write'] },
);

export const dynamic = 'force-dynamic';
