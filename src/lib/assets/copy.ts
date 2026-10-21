/**
 * Copying entries, one or a batch (1020's helm.copy_asset, and the password).
 *
 * WHAT COMES ACROSS is copy_asset()'s business: the shared fields and the
 * kind's own row, nothing an external check observed, and no secret. A
 * credential's PASSWORD then comes across here, as a NEW secret holding the
 * same value — never a second pointer at the original's, or rotating the copy
 * would rotate the original — with the original's sensitivity and its rules.
 * The one-time code seed is not copied: two entries generating the same codes
 * would be one login filed twice.
 *
 * COPYING A PASSWORD IS READING IT, so it is a reveal with purpose 'copy': the
 * same gate as Reveal and one audit row on the original. EVERY password is read
 * before anything is written, so a refusal — a step-up, a missing reason —
 * leaves nothing half-made, and the retry after re-authenticating makes each
 * copy once. All the copies, and their secrets, are then written in one
 * transaction: a batch is copied whole or not at all, which is the rule the
 * other bulk actions follow.
 */
import { withTenant, type HelmTx } from '../db/client';
import { getSecretService } from '../services';
import { ApiError } from '../api/errors';
import type { SessionContextRequest } from '../db/context';
import { isCopyable } from './copyable';


interface Source {
  id: string;
  name: string;
  node_type: string;
  organization_id: string;
  secret_id: string | null;
  kind: string | null;
  sensitivity: 'standard' | 'elevated' | 'critical' | null;
  requires_step_up: boolean | null;
  requires_reason: boolean | null;
  min_role_rank: number | null;
  rotation_interval_days: number | null;
}

export interface CopyRequest {
  id: string;
  /** The copy's name; omitted in a batch, which uses "<name> (copy)". */
  name?: string | undefined;
}

export interface CopyResult {
  id: string;
  sourceId: string;
  name: string;
  nodeType: string;
  passwordCopied: boolean;
}

type Actor = SessionContextRequest;

export async function copyEntries(
  actor: Actor,
  requests: readonly CopyRequest[],
  options: { reason?: string | undefined } = {},
): Promise<CopyResult[]> {
  const ids = requests.map((r) => r.id);

  // Read under RLS, so "not there" and "not yours" are one answer.
  const { sources, canWriteSecret } = await withTenant(actor, async (tx) => {
    const rows = await tx<Source[]>`
      SELECT n.id, n.name, n.node_type::text AS node_type, n.organization_id, c.secret_id,
             s.kind::text AS kind, s.sensitivity::text AS sensitivity, s.requires_step_up,
             s.requires_reason, s.min_role_rank, s.rotation_interval_days
      FROM asset_node n
      LEFT JOIN credential c ON c.id = n.id
      LEFT JOIN secret s ON s.id = c.secret_id
      WHERE n.id = ANY (${ids}::uuid[]) AND n.archived_at IS NULL
    `;
    const [perm] = await tx<{ ok: boolean }[]>`SELECT helm.has_permission('secret:write') AS ok`;
    return { sources: new Map(rows.map((r) => [r.id, r])), canWriteSecret: perm?.ok ?? false };
  });

  const missing = ids.filter((id) => !sources.has(id));
  if (missing.length > 0) {
    throw requests.length === 1
      ? ApiError.notFound('no such entry')
      : ApiError.notFound(`${missing.length} of these entries do not exist, or are archived`);
  }
  const plan = requests.map((r) => {
    const source = sources.get(r.id)!;
    return { source, name: (r.name ?? `${source.name} (copy)`).slice(0, 200) };
  });

  const refused = plan.filter((p) => !isCopyable(p.source.node_type));
  if (refused.length > 0) {
    throw ApiError.invalid(
      `procedures and custom records cannot be copied yet: ${refused.map((p) => p.source.name).join(', ')}`,
    );
  }
  // A domain is called by its domain name, which is unique per tenant, so a
  // batch cannot name one for you: "acme.test (copy)" is not a domain.
  if (requests.length > 1) {
    const domains = plan.filter((p) => p.source.node_type === 'domain');
    if (domains.length > 0) {
      throw ApiError.invalid(
        `a domain is copied one at a time, under its new domain name: ${domains.map((p) => p.source.name).join(', ')}`,
      );
    }
  }
  if (plan.some((p) => p.source.secret_id) && !canWriteSecret) {
    throw ApiError.forbidden('missing permission: secret:write');
  }

  // Read every password first. A refusal throws SecretAccessDeniedError, which
  // the route maps to a status the client can act on (step_up_required).
  const revealed = new Map<string, Awaited<ReturnType<ReturnType<typeof getSecretService>['reveal']>>>();
  try {
    for (const { source } of plan) {
      if (!source.secret_id) continue;
      revealed.set(source.id, await getSecretService().reveal(actor, source.secret_id, {
        purpose: 'copy',
        ...(options.reason ? { reason: options.reason } : {}),
      }));
    }

    return await withTenant(actor, async (tx) => {
      const results: CopyResult[] = [];
      for (const { source, name } of plan) {
        const copyId = await copyOne(tx, source, name);
        const secret = revealed.get(source.id);
        if (secret) {
          const created = await getSecretService().createInTransaction(
            tx,
            actor,
            {
              organizationId: source.organization_id,
              label: name,
              ...(source.kind ? { kind: source.kind } : {}),
              ...(source.sensitivity ? { sensitivity: source.sensitivity } : {}),
              ...(source.requires_step_up !== null ? { requiresStepUp: source.requires_step_up } : {}),
              ...(source.requires_reason !== null ? { requiresReason: source.requires_reason } : {}),
              ...(source.min_role_rank !== null ? { minRoleRank: source.min_role_rank } : {}),
              ...(source.rotation_interval_days !== null ? { rotationIntervalDays: source.rotation_interval_days } : {}),
            },
            secret.value.expose(),
          );
          await tx`UPDATE credential SET secret_id = ${created.secretId}::uuid WHERE id = ${copyId}::uuid`;
        }
        results.push({
          id: copyId, sourceId: source.id, name, nodeType: source.node_type, passwordCopied: secret !== undefined,
        });
      }
      return results;
    });
  } finally {
    for (const secret of revealed.values()) secret.value.dispose();
  }
}

async function copyOne(tx: HelmTx, source: Source, name: string): Promise<string> {
  try {
    const [row] = await tx<{ id: string }[]>`SELECT helm.copy_asset(${source.id}::uuid, ${name}) AS id`;
    return row!.id;
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw ApiError.conflict(
        source.node_type === 'domain'
          ? `${name} is already documented as a domain`
          : `an entry like ${source.name} already exists; give the copy a different name or address`,
      );
    }
    throw error;
  }
}
