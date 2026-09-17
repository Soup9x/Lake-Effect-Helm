import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { MAX_SELECTION, bulkSetArchived } from '@/lib/bulk/service';

const schema = z.object({
  target: z.enum(['client', 'node']),
  ids: z.array(z.guid()).min(1).max(MAX_SELECTION),
  /** false restores. The same endpoint, because they are one state. */
  archived: z.boolean(),
});

/**
 * POST /api/bulk/archive — archive a selection, or put it back.
 *
 * Archiving is NOT deleting. Nothing is removed: the rows keep their columns,
 * their credentials stay decryptable, their audit history still resolves, and
 * `archived: false` restores them. What changes is that default views stop
 * showing them and the search index drops them, so the people who work here
 * stop tripping over clients the MSP parted ways with in 2023.
 *
 * Archiving a client does NOT archive the assets under it. That is deliberate:
 * a cascade would be unrecoverable in practice, because restoring the client
 * could not tell which children were already archived beforehand. The client
 * disappearing from the list is what the person asked for.
 */
export const POST = tenantRoute(
  async ({ tx, request }) => {
    const body = await readJson(request, (raw) => {
      const result = schema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid bulk archive request', {
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      return result.data;
    });

    const outcome = await bulkSetArchived(tx, body.target, body.ids, body.archived);

    await tx`
      SELECT helm.audit(
        ${body.archived ? 'bulk.archive' : 'bulk.restore'},
        ${body.target === 'client' ? 'organization' : 'asset_node'},
        NULL::uuid,
        'success'::audit_outcome,
        NULL::uuid, NULL::uuid, NULL::text,
        ${tx.json({ count: outcome.affected.length, ids: outcome.affected })}::jsonb
      )
    `;

    return { affected: outcome.affected.length, ids: outcome.affected };
  },
  /*
   * `asset:write` is the floor for reaching this endpoint at all, not the rule
   * for what it may archive. Archiving a CLIENT additionally needs
   * `organization:write`, and that is enforced where it belongs — in
   * organization_rls_update, which every UPDATE here passes through. A tier1
   * technician holds asset:write and not organization:write, so their archive
   * of a client matches zero rows, comes up short, and is refused outright
   * rather than partly applied. Declaring organization:write here instead
   * would lock tier1 out of archiving assets, which they may do.
   */
  { permissions: ['asset:write'] },
);

export const dynamic = 'force-dynamic';
