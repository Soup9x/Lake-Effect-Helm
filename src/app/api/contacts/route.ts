import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

/**
 * POST /api/contacts — document a person at a client.
 *
 * WHY THIS DID NOT EXIST UNTIL NOW. `contact` has been in the schema since 0010
 * and the organisation page has always listed contacts, but nothing in the
 * product could create one — they arrived by SQL or not at all. The redesign's
 * Contacts grid made that visible, because a "+ New" button over an empty list
 * with no endpoint behind it is a worse answer than no button.
 *
 * `asset:write`, matching every other piece of client documentation. A contact is
 * not a credential: it carries no secret material, inherits the organisation's
 * own visibility through RLS, and a technician who may document a server may
 * document the person who owns it.
 */
const createSchema = z.object({
  organizationId: z.guid('organizationId must be a UUID'),
  siteId: z.guid().nullable().optional(),
  firstName: z.string().trim().min(1).max(120),
  lastName: z.string().trim().min(1).max(120),
  title: z.string().trim().max(160).optional(),
  /*
   * Deliberately NOT z.email(). Exports carry "dana@acme.test (personal)" and
   * "n/a", and refusing the whole row for a malformed address loses the person's
   * name and phone number too. The column is citext with no format constraint;
   * what is stored is what somebody can correct later.
   */
  email: z.string().trim().max(320).optional(),
  phone: z.string().trim().max(40).optional(),
  mobile: z.string().trim().max(40).optional(),
  extension: z.string().trim().max(16).optional(),
  notes: z.string().trim().max(4000).optional(),
  isPrimary: z.boolean().default(false),
  isTechnical: z.boolean().default(false),
  isBilling: z.boolean().default(false),
  isEmergency: z.boolean().default(false),
  isAuthorised: z.boolean().default(false),
});

export const POST = tenantRoute(
  async ({ tx, request, identity }) => {
    const body = await readJson(request, (raw) => {
      const result = createSchema.safeParse(raw);
      if (!result.success) {
        throw ApiError.invalid('invalid contact', {
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      return result.data;
    });

    try {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO contact (
          tenant_id, organization_id, site_id, first_name, last_name, title,
          email, phone, mobile, extension, notes,
          is_primary, is_technical, is_billing, is_emergency, is_authorised,
          created_by, updated_by
        )
        VALUES (
          helm.require_tenant_id(), ${body.organizationId}::uuid, ${body.siteId ?? null}::uuid,
          ${body.firstName}, ${body.lastName}, ${body.title ?? null},
          ${body.email ?? null}, ${body.phone ?? null}, ${body.mobile ?? null},
          ${body.extension ?? null}, ${body.notes ?? null},
          ${body.isPrimary}, ${body.isTechnical}, ${body.isBilling},
          ${body.isEmergency}, ${body.isAuthorised},
          ${identity.actorId}::uuid, ${identity.actorId}::uuid
        )
        RETURNING id
      `;
      if (!row) throw ApiError.conflict('the contact could not be created');
      return { contactId: row.id };
    } catch (error) {
      // The org and site FKs are both composite on tenant_id, so an id from
      // another tenant — or one that is simply not there — lands here rather
      // than as a bare 500.
      if ((error as { code?: string }).code === '23503') {
        throw ApiError.invalid('no such client or site');
      }
      throw error;
    }
  },
  { permissions: ['asset:write'] },
);
