import { z } from 'zod';
import { readJson, serviceRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { withTenant } from '@/lib/db/client';
import { getSecretService } from '@/lib/services';

/**
 * POST /api/assets/:nodeId/copy — a new entry from this one, under a new name.
 *
 * helm.copy_asset() (1020) decides what of the entry goes across: the shared
 * fields and the kind's own row, nothing an external check observed, and no
 * secret. A domain takes the new name as its domain name. Relationships,
 * attachments and history stay with the original.
 *
 * A CREDENTIAL'S PASSWORD COMES ACROSS TOO, as a NEW secret holding the same
 * value — never a second pointer at the original's, or rotating the copy would
 * rotate the original. Copying it means reading it, so it is a reveal with
 * purpose 'copy': the same gate as Reveal (permission, rank, step-up, a reason
 * where the password asks for one), one audit row, and the new secret keeps
 * the original's sensitivity and its rules. The one-time code seed is not
 * copied; two entries generating the same codes would be one login filed twice.
 *
 * THE PASSWORD IS READ FIRST, before anything is written, so a refusal — a
 * step-up, a missing reason — leaves nothing half-made, and the retry after
 * re-authenticating makes one copy, not a second. The copy and its secret are
 * then written in one transaction.
 *
 * A serviceRoute, as the reveal route is, so that reveal's audit row carries
 * this request's id, address and user agent.
 */
const schema = z.object({
  name: z.string().trim().min(1).max(200),
  /** For a password that requires one, recorded with the reveal. */
  reason: z.string().trim().max(500).optional(),
});

interface Source {
  node_type: string;
  organization_id: string;
  secret_id: string | null;
  kind: string | null;
  sensitivity: 'standard' | 'elevated' | 'critical' | null;
  requires_step_up: boolean | null;
  requires_reason: boolean | null;
  min_role_rank: number | null;
  rotation_interval_days: number | null;
  can_write_secret: boolean;
}

export const POST = serviceRoute(
  async ({ actor, request, params }) => {
    const nodeId = z.guid().safeParse(params.nodeId);
    if (!nodeId.success) throw ApiError.invalid('not an entry id');

    const body = await readJson(request, (raw) => {
      const result = schema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('a name for the copy', { issues: zodIssues(result.error) });
      }
      return result.data;
    });

    // Read under RLS, so "not there" and "not yours" are one 404.
    const source = await withTenant(actor, async (tx) => {
      const [row] = await tx<Source[]>`
        SELECT n.node_type::text AS node_type, n.organization_id, c.secret_id,
               s.kind::text AS kind, s.sensitivity::text AS sensitivity, s.requires_step_up,
               s.requires_reason, s.min_role_rank, s.rotation_interval_days,
               helm.has_permission('secret:write') AS can_write_secret
        FROM asset_node n
        LEFT JOIN credential c ON c.id = n.id
        LEFT JOIN secret s ON s.id = c.secret_id
        WHERE n.id = ${nodeId.data}::uuid AND n.archived_at IS NULL
      `;
      return row;
    });
    if (!source) throw ApiError.notFound('no such entry');
    if (source.secret_id && !source.can_write_secret) {
      throw ApiError.forbidden('missing permission: secret:write');
    }

    // Refusals throw SecretAccessDeniedError, which the handler maps to a
    // status the dialog can act on: step_up_required prompts a re-auth.
    const revealed = source.secret_id
      ? await getSecretService().reveal(actor, source.secret_id, {
        purpose: 'copy',
        ...(body.reason ? { reason: body.reason } : {}),
      })
      : null;

    try {
      return await withTenant(actor, async (tx) => {
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

        if (revealed) {
          const created = await getSecretService().createInTransaction(
            tx,
            actor,
            {
              organizationId: source.organization_id,
              label: body.name,
              ...(source.kind ? { kind: source.kind } : {}),
              ...(source.sensitivity ? { sensitivity: source.sensitivity } : {}),
              ...(source.requires_step_up !== null ? { requiresStepUp: source.requires_step_up } : {}),
              ...(source.requires_reason !== null ? { requiresReason: source.requires_reason } : {}),
              ...(source.min_role_rank !== null ? { minRoleRank: source.min_role_rank } : {}),
              ...(source.rotation_interval_days !== null ? { rotationIntervalDays: source.rotation_interval_days } : {}),
            },
            revealed.value.expose(),
          );
          await tx`UPDATE credential SET secret_id = ${created.secretId}::uuid WHERE id = ${copy!.id}::uuid`;
        }

        return {
          asset: { id: copy!.id, name: body.name, nodeType: source.node_type },
          passwordCopied: revealed !== null,
        };
      });
    } finally {
      revealed?.value.dispose();
    }
  },
  { permissions: ['asset:write'] },
);

export const dynamic = 'force-dynamic';
