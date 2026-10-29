/**
 * The client an RMM organisation imports to when somebody picks "New client"
 * (NinjaOne 0980, Action1 1160): an existing client of the same name if there
 * is one, otherwise one created here. Creating needs organization:write, which
 * the organization insert policy holds.
 */
import { ApiError } from '@/lib/api/errors';
import type { HelmTx } from '@/lib/db/client';

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56).replace(/-+$/, '');
}

/**
 * @param fallbackSlug used when the name makes no usable slug (all symbols, say),
 *   like `ninja-42`.
 */
export async function clientNamedLike(
  tx: HelmTx,
  identity: { tenantId: string; actorId: string },
  name: string,
  fallbackSlug: string,
): Promise<string> {
  const [existing] = await tx<{ id: string }[]>`
    SELECT id FROM organization
    WHERE lower(btrim(name)) = lower(btrim(${name})) AND deleted_at IS NULL
    ORDER BY created_at LIMIT 1
  `;
  if (existing) return existing.id;

  const base = SLUG.test(slugify(name)) ? slugify(name) : slugify(fallbackSlug) || 'client';
  const taken = new Set((await tx<{ slug: string }[]>`
    SELECT slug FROM organization WHERE slug = ${base} OR slug LIKE ${`${base}-%`}
  `).map((r) => r.slug));
  let slug = base;
  for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`;

  const [created] = await tx<{ id: string }[]>`
    INSERT INTO organization (tenant_id, slug, name, status, relationship, timezone, created_by)
    VALUES (${identity.tenantId}::uuid, ${slug}, ${name.trim()}, 'active'::organization_status,
            'client'::organization_relationship, 'America/New_York', ${identity.actorId}::uuid)
    RETURNING id
  `;
  if (!created) throw ApiError.conflict(`a client for ${name} could not be created`);
  return created.id;
}
