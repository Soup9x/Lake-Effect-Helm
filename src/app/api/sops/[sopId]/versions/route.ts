import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';
import { buildSnapshot, validateSteps } from '@/lib/sops/steps';

/**
 * POST /api/sops/[sopId]/versions — publish what the procedure says now.
 *
 * A VERSION IS EVIDENCE, which is the whole reason this table exists. 0090:
 * "a run snapshots the SOP version it executed against. Pointing a run at a
 * living, editable document would let today's edit rewrite yesterday's
 * evidence." So publishing freezes the current step list into
 * sop_version.snapshot, and a run copies from there.
 *
 * THE HASH IS COMPUTED IN SQL, DELIBERATELY. snapshot_sha256 is "sha256 over
 * the canonical snapshot", and jsonb is canonical by construction: Postgres
 * normalises key order and whitespace on storage, so `digest(snapshot::text,
 * 'sha256')` over the stored jsonb gives the same bytes whatever order this
 * process happened to serialise the object in. Hashing the JS string instead
 * would hash MY formatting, and a reader recomputing it from the stored row
 * would get a different answer — which is exactly the check the column exists
 * to support.
 *
 * sop_version is append-only by trigger (helm.deny_mutation on UPDATE and
 * DELETE), so a published version cannot be revised. Correcting one means
 * publishing the next.
 */
const publishSchema = z.object({
  changeNote: z.string().trim().max(2000).nullable().optional(),
});

interface SopRow {
  name: string;
  summary: string | null;
  body: string | null;
  current_version: number;
}

export const POST = tenantRoute(
  async ({ tx, request, identity, params }) => {
    const sopId = z.guid().safeParse(params.sopId);
    if (!sopId.success) throw ApiError.invalid('not a procedure id');

    const body = await readJson(request, (raw) => {
      const result = publishSchema.safeParse(raw);
      if (!result.success) throw ApiError.invalid('invalid change note');
      return result.data;
    });

    const [sop] = await tx<SopRow[]>`
      SELECT n.name, s.summary, s.body, s.current_version
      FROM sop s JOIN asset_node n ON n.id = s.id
      WHERE s.id = ${sopId.data}::uuid AND n.archived_at IS NULL
    `;
    if (!sop) throw ApiError.notFound('no such procedure');

    const steps = await tx<{ title: string; body: string | null }[]>`
      SELECT title, body FROM sop_step
      WHERE sop_id = ${sopId.data}::uuid ORDER BY position
    `;

    // HERE is where "at least one step" bites, rather than on every draft save.
    // A published version with no steps would produce a run that is complete
    // before anybody looks at it.
    const issues = validateSteps(steps.map((s) => ({ title: s.title, body: s.body ?? undefined })));
    if (issues.length > 0) {
      throw ApiError.invalid('this procedure cannot be published yet', {
        issues: issues.map((i) => ({
          path: i.index >= 0 ? `steps.${i.index}` : 'steps',
          message: i.message,
        })),
      });
    }

    const snapshot = buildSnapshot(
      { title: sop.name, summary: sop.summary, body: sop.body },
      steps.map((s) => ({ title: s.title, body: s.body ?? undefined })),
    );
    const version = sop.current_version + 1;

    let published: { id: string; version: number } | undefined;
    try {
      [published] = await tx<{ id: string; version: number }[]>`
        INSERT INTO sop_version (
          tenant_id, sop_id, version, snapshot, snapshot_sha256, change_note, published_by
        )
        VALUES (
          helm.current_tenant_id(), ${sopId.data}::uuid, ${version},
          ${tx.json(snapshot as never)}::jsonb,
          digest(${tx.json(snapshot as never)}::jsonb::text, 'sha256'),
          ${body.changeNote ?? null}, ${identity.actorId}::uuid
        )
        RETURNING id, version
      `;
    } catch (error) {
      // sop_version_uk UNIQUE (sop_id, version). Two people publishing at once
      // is a real race and a conflict is the honest answer: reload and see what
      // the other one wrote before publishing on top of it.
      if ((error as { code?: string }).code === '23505') {
        throw ApiError.conflict('somebody else published a version while you were working; reload');
      }
      throw error;
    }
    if (!published) throw ApiError.conflict('the version could not be published');

    await tx`
      UPDATE sop SET current_version = ${published.version} WHERE id = ${sopId.data}::uuid
    `;

    return { versionId: published.id, version: published.version, steps: steps.length };
  },
  { permissions: ['sop:write'] },
);

export const dynamic = 'force-dynamic';
