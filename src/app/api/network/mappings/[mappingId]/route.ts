import { z } from 'zod';
import { tenantRoute } from '@/lib/api/handler';
import { ApiError } from '@/lib/api/errors';

const idSchema = z.guid();

/**
 * Remove a controller mapping.
 *
 * THE INVENTORY STAYS. network_assets.mapping_id is ON DELETE SET NULL, so
 * removing a controller does not delete the client's device records or the
 * notes, asset tags and departments somebody wrote on them. Losing a
 * controller and losing a year of documentation are different acts, and only
 * one of them was asked for.
 *
 * The API key secret is deliberately NOT deleted either: it stays in the vault
 * where its history and audit trail remain readable, and the mapping's foreign
 * key is ON DELETE RESTRICT in the other direction so the credential cannot be
 * removed out from under a live mapping.
 */
export const DELETE = tenantRoute(
  async ({ tx, params }) => {
    const mappingId = idSchema.safeParse(params.mappingId);
    if (!mappingId.success) throw ApiError.invalid('invalid mapping id');

    const [gone] = await tx<{ forget_unifi_mapping: boolean }[]>`
      SELECT helm.forget_unifi_mapping(${mappingId.data}::uuid)
    `;
    if (!gone?.forget_unifi_mapping) {
      throw ApiError.notFound('there is no such controller mapping');
    }
    return { removed: true };
  },
  { permissions: ['integration:network:manage'] },
);

export const dynamic = 'force-dynamic';
