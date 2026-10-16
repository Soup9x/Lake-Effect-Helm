import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import { emailEntrySchema, phoneEntrySchema, readChannels, replaceChannels } from '@/lib/contacts/channels';

export const dynamic = 'force-dynamic';

interface ContactRow {
  id: string; organization_id: string; site_id: string | null;
  first_name: string; last_name: string; title: string | null; notes: string | null;
  is_primary: boolean; is_technical: boolean; is_billing: boolean; is_emergency: boolean; is_authorised: boolean;
}

const SELECT = (tx: Parameters<Parameters<typeof tenantRoute>[0]>[0]['tx'], id: string) => tx<ContactRow[]>`
  SELECT id, organization_id, site_id, first_name, last_name, title, notes,
         is_primary, is_technical, is_billing, is_emergency, is_authorised
  FROM contact WHERE id = ${id}::uuid AND deleted_at IS NULL
`;

async function view(tx: Parameters<typeof SELECT>[0], id: string) {
  const [row] = await SELECT(tx, id);
  if (!row) throw ApiError.notFound('no such contact');
  const channels = await readChannels(tx, id);
  return {
    contact: {
      id: row.id, organizationId: row.organization_id, siteId: row.site_id,
      firstName: row.first_name, lastName: row.last_name, title: row.title, notes: row.notes,
      isPrimary: row.is_primary, isTechnical: row.is_technical, isBilling: row.is_billing,
      isEmergency: row.is_emergency, isAuthorised: row.is_authorised,
      ...channels,
    },
  };
}

/** GET — the contact with every email and number, for the edit form. */
export const GET = tenantRoute(
  async ({ tx, params }) => {
    const contactId = z.guid().safeParse(params.contactId);
    if (!contactId.success) throw ApiError.invalid('contactId must be a UUID');
    return view(tx, contactId.data);
  },
  { permissions: ['asset:read'] },
);

const patchSchema = z
  .object({
    siteId: z.guid().nullable().optional(),
    firstName: z.string().trim().min(1).max(120).optional(),
    lastName: z.string().trim().min(1).max(120).optional(),
    title: z.string().trim().max(160).nullable().optional(),
    notes: z.string().trim().max(4000).nullable().optional(),
    isPrimary: z.boolean().optional(),
    isTechnical: z.boolean().optional(),
    isBilling: z.boolean().optional(),
    isEmergency: z.boolean().optional(),
    isAuthorised: z.boolean().optional(),
    /** The whole list for that kind (0790); omit a list to leave it alone. */
    emails: z.array(emailEntrySchema).max(20).optional(),
    phones: z.array(phoneEntrySchema).max(20).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to change' });

/**
 * PATCH — correct a person. There was no way to at all: a typo in a name
 * meant removing the contact and typing them in again.
 */
export const PATCH = tenantRoute(
  async ({ tx, request, params, identity }) => {
    const contactId = z.guid().safeParse(params.contactId);
    if (!contactId.success) throw ApiError.invalid('contactId must be a UUID');

    const body = await readJson(request, (raw) => {
      const result = patchSchema.safeParse(raw);
      if (!result.success) throw ApiError.invalid('invalid contact change', { issues: zodIssues(result.error) });
      return result.data;
    });

    let updated: { id: string }[];
    try {
      updated = await tx<{ id: string }[]>`
        UPDATE contact SET
          site_id       = ${body.siteId === undefined ? tx`site_id` : tx`${body.siteId}::uuid`},
          first_name    = coalesce(${body.firstName ?? null}, first_name),
          last_name     = coalesce(${body.lastName ?? null}, last_name),
          title         = ${body.title === undefined ? tx`title` : body.title},
          notes         = ${body.notes === undefined ? tx`notes` : body.notes},
          is_primary    = coalesce(${body.isPrimary ?? null}, is_primary),
          is_technical  = coalesce(${body.isTechnical ?? null}, is_technical),
          is_billing    = coalesce(${body.isBilling ?? null}, is_billing),
          is_emergency  = coalesce(${body.isEmergency ?? null}, is_emergency),
          is_authorised = coalesce(${body.isAuthorised ?? null}, is_authorised),
          updated_by    = ${identity.actorId}::uuid
        WHERE id = ${contactId.data}::uuid AND deleted_at IS NULL
        RETURNING id
      `;
    } catch (error) {
      if ((error as { code?: string }).code === '23503') throw ApiError.invalid('no such site');
      throw error;
    }
    if (updated.length === 0) throw ApiError.notFound('no such contact');

    if (body.emails !== undefined || body.phones !== undefined) {
      await replaceChannels(tx, identity.tenantId, contactId.data, { emails: body.emails, phones: body.phones });
    }
    return view(tx, contactId.data);
  },
  { permissions: ['asset:write'] },
);

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
