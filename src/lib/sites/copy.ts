/**
 * "Make copies" on a selection of locations: each copied as "<name> (copy)" at
 * the same client, with its address, phones, public IPs, notes and tags.
 *
 * WHAT DOES NOT COME ACROSS, on purpose:
 *   * Primary location. A client has one, and a copy is not it.
 *   * The site code. Codes are unique within a client, so the copy has none
 *     until somebody gives it one.
 *   * What is recorded there. Entries, contacts and diagrams point at the
 *     original; a duplicate location starts empty.
 *
 * ONE TRANSACTION, under the caller's RLS: a selection reaching a location they
 * cannot see is refused whole and nothing is written, as every bulk action is.
 */
import { withTenant } from '../db/client';
import type { ActorRef } from '../secrets/service';
import { ApiError } from '../api/errors';

export interface SiteCopy {
  id: string;
  sourceId: string;
  name: string;
}

export async function copySites(actor: ActorRef, ids: readonly string[]): Promise<SiteCopy[]> {
  const unique = [...new Set(ids)];
  return withTenant(actor, async (tx) => {
    const sources = await tx<{ id: string }[]>`
      SELECT id FROM site
      WHERE id = ANY(${unique}::uuid[]) AND deleted_at IS NULL AND archived_at IS NULL
    `;
    if (sources.length !== unique.length) {
      const missing = unique.length - sources.length;
      throw unique.length === 1
        ? ApiError.notFound('no such location')
        : ApiError.notFound(`${missing} of these locations do not exist, or are archived. Nothing was copied.`);
    }

    const copies: SiteCopy[] = [];
    for (const source of sources) {
      const [copy] = await tx<{ id: string; name: string }[]>`
        INSERT INTO site (
          tenant_id, organization_id, name, code, is_primary,
          address_line1, address_line2, city, region, postal_code, country, latitude, longitude, timezone,
          main_phone, after_hours_phone, access_notes, physical_security, notes, public_ips, tags,
          created_by, updated_by
        )
        SELECT tenant_id, organization_id, left(name || ' (copy)', 200), NULL, false,
               address_line1, address_line2, city, region, postal_code, country, latitude, longitude, timezone,
               main_phone, after_hours_phone, access_notes, physical_security, notes, public_ips, tags,
               ${actor.actorId}::uuid, ${actor.actorId}::uuid
        FROM site WHERE id = ${source.id}::uuid
        RETURNING id, name
      `;
      if (!copy) throw ApiError.forbidden('those locations are not yours to copy. Nothing was copied.');
      copies.push({ id: copy.id, sourceId: source.id, name: copy.name });
    }

    await tx`
      SELECT helm.audit('bulk.copy', 'site', NULL::uuid, 'success'::audit_outcome,
                        NULL::uuid, NULL::uuid, NULL::text,
                        ${tx.json({ count: copies.length, copies: copies.map((c) => ({ id: c.id, sourceId: c.sourceId })) })}::jsonb)
    `;
    return copies;
  });
}
