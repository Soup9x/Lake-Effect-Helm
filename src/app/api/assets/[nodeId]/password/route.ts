import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { getSecretService } from '@/lib/services';

/**
 * PUT /api/assets/:nodeId/password — store a password on a credential that
 * has none: one made without a value, or a copy of another entry (1020 copies
 * no secrets).
 *
 * ONLY WHERE THERE IS NONE. A credential that already has a password is
 * changed through /api/secrets/:id/rotate, which keeps the version history
 * and asks why. Writing a second secret here and repointing the credential
 * would orphan the first one, live key material that nothing lists.
 *
 * The secret is created in this transaction with the credential's link to
 * it, so there is no state in which one exists without the other.
 */
const schema = z.object({
  /** Bounded exactly as creation is. */
  value: z.string().min(1).max(65_536),
});

export const PUT = tenantRoute(
  async ({ tx, request, params, identity }) => {
    const nodeId = z.guid().safeParse(params.nodeId);
    if (!nodeId.success) throw ApiError.invalid('not a credential id');

    const body = await readJson(request, (raw) => {
      const result = schema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('a password', { issues: zodIssues(result.error) });
      }
      return result.data;
    });

    // FOR UPDATE: two people pressing Save at once must not both create one.
    const [credential] = await tx<{ organization_id: string; name: string; secret_id: string | null }[]>`
      SELECT n.organization_id, n.name, c.secret_id
      FROM credential c JOIN asset_node n ON n.id = c.id
      WHERE c.id = ${nodeId.data}::uuid AND n.archived_at IS NULL
      FOR UPDATE OF c
    `;
    if (!credential) throw ApiError.notFound('no such credential');
    if (credential.secret_id) {
      throw ApiError.conflict('this credential already has a password; change it instead');
    }

    const created = await getSecretService().createInTransaction(
      tx,
      { tenantId: identity.tenantId, actorId: identity.actorId, actorType: identity.actorType },
      { organizationId: credential.organization_id, label: credential.name },
      body.value,
    );
    await tx`UPDATE credential SET secret_id = ${created.secretId}::uuid WHERE id = ${nodeId.data}::uuid`;

    return { secretId: created.secretId, version: created.version, auditEventUid: created.auditEventUid };
  },
  { permissions: ['secret:write', 'asset:write'] },
);

export const dynamic = 'force-dynamic';
