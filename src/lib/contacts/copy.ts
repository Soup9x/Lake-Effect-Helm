/**
 * "Make copies" on a selection of contacts: each copied as "<last name> (copy)"
 * at the same client, with everything that describes the person — title,
 * location, every email and phone with its label, the role flags, notes and
 * tags.
 *
 * WHAT DOES NOT COME ACROSS, on purpose:
 *   * Primary contact. A client has one, and a copy is not it.
 *   * A Helm login or a PSA link (app_user_id, psa_contact_id). Those name one
 *     real person in another system; two contacts claiming them would be a lie
 *     in both.
 *   * What the contact is "Contact for". Responsibilities are given, not
 *     inherited by a duplicate.
 *
 * ONE TRANSACTION, under the caller's RLS: a selection reaching a contact they
 * cannot see is refused whole and nothing is written, as every bulk action is.
 */
import { withTenant } from '../db/client';
import type { ActorRef } from '../secrets/service';
import { ApiError } from '../api/errors';

export interface ContactCopy {
  id: string;
  sourceId: string;
  name: string;
}

export async function copyContacts(actor: ActorRef, ids: readonly string[]): Promise<ContactCopy[]> {
  const unique = [...new Set(ids)];
  return withTenant(actor, async (tx) => {
    const sources = await tx<{ id: string; first_name: string; last_name: string }[]>`
      SELECT id, first_name, last_name FROM contact
      WHERE id = ANY(${unique}::uuid[]) AND deleted_at IS NULL AND archived_at IS NULL
    `;
    if (sources.length !== unique.length) {
      const missing = unique.length - sources.length;
      throw unique.length === 1
        ? ApiError.notFound('no such contact')
        : ApiError.notFound(`${missing} of these contacts do not exist, or are archived. Nothing was copied.`);
    }

    const copies: ContactCopy[] = [];
    for (const source of sources) {
      // The channels are copied as rows below, so email, phone and mobile go in
      // empty: filled, the seeding trigger would add them a second time.
      const [copy] = await tx<{ id: string; last_name: string }[]>`
        INSERT INTO contact (
          tenant_id, organization_id, site_id, first_name, last_name, title,
          is_primary, is_technical, is_billing, is_emergency, is_authorised,
          notes, tags, created_by, updated_by
        )
        SELECT tenant_id, organization_id, site_id, first_name, left(last_name || ' (copy)', 200), title,
               false, is_technical, is_billing, is_emergency, is_authorised,
               notes, tags, ${actor.actorId}::uuid, ${actor.actorId}::uuid
        FROM contact WHERE id = ${source.id}::uuid
        RETURNING id, last_name
      `;
      if (!copy) throw ApiError.forbidden('those contacts are not yours to copy. Nothing was copied.');
      await tx`
        INSERT INTO contact_email (tenant_id, contact_id, address, label, is_primary, position)
        SELECT tenant_id, ${copy.id}::uuid, address, label, is_primary, position
        FROM contact_email WHERE contact_id = ${source.id}::uuid
      `;
      await tx`
        INSERT INTO contact_phone (tenant_id, contact_id, number, extension, label, is_primary, position)
        SELECT tenant_id, ${copy.id}::uuid, number, extension, label, is_primary, position
        FROM contact_phone WHERE contact_id = ${source.id}::uuid
      `;
      copies.push({ id: copy.id, sourceId: source.id, name: `${source.first_name} ${copy.last_name}` });
    }

    await tx`
      SELECT helm.audit('bulk.copy', 'contact', NULL::uuid, 'success'::audit_outcome,
                        NULL::uuid, NULL::uuid, NULL::text,
                        ${tx.json({ count: copies.length, copies: copies.map((c) => ({ id: c.id, sourceId: c.sourceId })) })}::jsonb)
    `;
    return copies;
  });
}
