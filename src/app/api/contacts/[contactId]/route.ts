import { z } from 'zod';
import { tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

/**
 * DELETE /api/contacts/:id — the person is no longer at this client.
 *
 * A SOFT DELETE, because `contact` carries deleted_at and not archived_at, and
 * the difference is not cosmetic. An archived asset has somewhere to live — the
 * archive view, a restore path, a bulk endpoint that flips the flag back. A
 * removed contact has none of those: the row stays for referential integrity and
 * for the audit trail, and nothing in the product shows it again.
 *
 * So the interface says "remove" rather than "archive", and says it is not
 * reversible from here. Promising an undo that does not exist is worse than
 * being plain about it.
 *
 * `asset:write`, matching creation and matching contact's own RLS write rank of
 * 40. Deleting a contact destroys no credential material, which is why this is
 * not on the asset:delete ladder.
 */
export const DELETE = tenantRoute(
  async ({ tx, params, identity }) => {
    const contactId = z.guid().safeParse(params.contactId);
    if (!contactId.success) throw ApiError.invalid('contactId must be a UUID');

    const [row] = await tx<{ id: string; name: string }[]>`
      UPDATE contact
      SET deleted_at = now(), updated_at = now(), updated_by = ${identity.actorId}::uuid
      WHERE id = ${contactId.data}::uuid AND deleted_at IS NULL
      RETURNING id, (first_name || ' ' || last_name) AS name
    `;
    // RLS refuses a contact outside this actor's reach by matching no row, so
    // "not there" and "not yours" are one answer.
    if (!row) throw ApiError.notFound('no such contact');

    return { removed: row.id, name: row.name };
  },
  { permissions: ['asset:write'] },
);
