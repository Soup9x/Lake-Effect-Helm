import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { MAX_SELECTION, resolveClients, resolveNodes } from '@/lib/bulk/service';
import { getExportService } from '@/lib/exports/service';

const schema = z.object({
  target: z.enum(['client', 'node']),
  ids: z.array(z.guid()).min(1).max(MAX_SELECTION),
  kind: z
    .enum(['client_offboarding', 'compliance_audit', 'disaster_recovery', 'asset_inventory', 'ad_hoc'])
    .default('ad_hoc'),
  format: z.enum(['pdf', 'json', 'zip']).default('zip'),
  reason: z.string().trim().min(10).max(2000),
  ttlHours: z.number().int().min(1).max(720).default(72),
});

/**
 * POST /api/bulk/export — export a selection.
 *
 * ONE JOB PER CLIENT, not one job for the selection, and that is the export
 * engine's shape rather than a limitation worked around. An export bundle IS a
 * client's documentation: it carries that client's assets, its contacts, its
 * approval record and its own expiry. A bundle spanning four clients would have
 * to answer "which client was this approved for", and the honest answer is that
 * there isn't one.
 *
 * So a selection of nodes is grouped by the client they belong to, and a
 * selection of clients becomes one job each. The response lists them.
 *
 * SECRET MATERIAL IS NOT INCLUDED, and this endpoint cannot ask for it. That
 * restriction MATTERS MORE since 0400, not less. A secret-bearing export needs
 * `secret:export` and a written reason, and it used to need a second approver
 * as well; with that gone, one person is enough. Letting a checkbox on a list
 * view request forty of them would mean a single click walking out with every
 * credential of every selected client — turning the most carefully gated
 * operation in the product into the easiest one to trigger by accident.
 *
 * Somebody who needs credentials in an export requests it one client at a time,
 * from the exports page, where the reason and the client are in front of them
 * and each job is its own audited, notified event.
 */
export const POST = tenantRoute(
  async ({ tx, request }) => {
    const body = await readJson(request, (raw) => {
      const result = schema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid bulk export request', {
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      return result.data;
    });

    // Resolve first. Both helpers refuse the whole selection if any part of it
    // is unreachable, so nothing is queued before the caller's reach is settled.
    const byClient = new Map<string, string[]>();
    if (body.target === 'client') {
      for (const id of await resolveClients(tx, body.ids)) byClient.set(id, []);
    } else {
      for (const node of await resolveNodes(tx, body.ids)) {
        const existing = byClient.get(node.organizationId);
        if (existing) existing.push(node.id);
        else byClient.set(node.organizationId, [node.id]);
      }
    }

    // requestInTransaction, not request(): the latter opens a transaction of its
    // own, so a loop over it would commit each job as it went and leave three
    // of five behind if the fourth failed. This batch is one unit or it is
    // nothing, exactly like the archive and tag operations above it.
    const jobs: { organizationId: string; exportJobId: string }[] = [];
    for (const [organizationId, nodeIds] of byClient) {
      const job = await getExportService().requestInTransaction(tx, {
        organizationId,
        kind: body.kind,
        format: body.format,
        reason: body.reason,
        includeSecrets: false,
        ttlHours: body.ttlHours,
        scope: nodeIds.length > 0 ? { nodeIds } : {},
      });
      jobs.push({ organizationId, exportJobId: job.exportJobId });
    }

    await tx`
      SELECT helm.audit(
        'bulk.export',
        ${body.target === 'client' ? 'organization' : 'asset_node'},
        NULL::uuid,
        'success'::audit_outcome,
        NULL::uuid, NULL::uuid, ${body.reason},
        ${tx.json({ selected: body.ids.length, jobs: jobs.length })}::jsonb
      )
    `;

    return { jobs, clients: jobs.length };
  },
  { permissions: ['export:create'] },
);

export const dynamic = 'force-dynamic';
