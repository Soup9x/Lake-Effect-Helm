import { z } from 'zod';
import { readJson, serviceRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { copyEntries } from '@/lib/assets/copy';
import { copyContacts } from '@/lib/contacts/copy';
import { copyPages } from '@/lib/documents/copy';
import { copySites } from '@/lib/sites/copy';

/**
 * POST /api/bulk/copy — "Make copies" on a list's selection: each entry copied
 * as "<name> (copy)", credentials with their passwords.
 *
 * WHOLE OR NOTHING, like the other bulk actions: every password is read first
 * and every copy is written in one transaction, so a refusal — a step-up, a
 * missing reason, a domain in the batch — leaves the list as it was and the
 * selection on screen to adjust. A domain is copied one at a time, because its
 * new name is its domain name and a batch cannot choose one.
 *
 * Fifty at a time rather than the five hundred archive allows: each credential
 * in the batch is a reveal, and a selection that large is far likelier to be a
 * slip than a plan.
 */
const MAX_COPIES = 50;

const schema = z.object({
  /**
   * Entries by default; 'contact' copies contacts (src/lib/contacts/copy.ts),
   * 'site' locations (src/lib/sites/copy.ts) and 'document' written documents
   * (src/lib/documents/copy.ts).
   */
  target: z.enum(['node', 'contact', 'site', 'document']).default('node'),
  ids: z.array(z.guid()).min(1).max(MAX_COPIES),
  /** For passwords that require one, recorded with each reveal. */
  reason: z.string().trim().max(500).optional(),
});

export const POST = serviceRoute(
  async ({ actor, request }) => {
    const body = await readJson(request, (raw) => {
      const result = schema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid(`between 1 and ${MAX_COPIES} entries to copy`, { issues: zodIssues(result.error) });
      }
      return result.data;
    });
    const unique = [...new Set(body.ids)];
    if (body.target === 'contact' || body.target === 'site' || body.target === 'document') {
      const copy = body.target === 'contact' ? copyContacts : body.target === 'site' ? copySites : copyPages;
      const copies = await copy(actor, unique);
      return { affected: copies.length, copies };
    }
    const copies = await copyEntries(actor, unique.map((id) => ({ id })), { reason: body.reason });
    return { affected: copies.length, copies: copies.map((c) => ({ id: c.id, sourceId: c.sourceId, name: c.name })) };
  },
  { permissions: ['asset:write'] },
);

export const dynamic = 'force-dynamic';
