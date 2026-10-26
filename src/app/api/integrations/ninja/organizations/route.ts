import { z } from 'zod';
import { readJson, tenantRoute } from '@/lib/api/handler';
import { ApiError, zodIssues } from '@/lib/api/errors';
import type { HelmTx } from '@/lib/db/client';
import { readNinjaSettings } from '@/lib/ninja/queries';

/**
 * Which client each NinjaOne organisation imports to (0980). Null stops
 * importing it; what was already imported stays, as the client's own
 * documentation.
 *
 * 'new' imports it to a client of the same name: an existing one if a client
 * is already called that, otherwise one created here. Most NinjaOne
 * organisations ARE clients, and a Helm that has none yet would otherwise
 * offer nothing to pick but the MSP's own organisation. Creating one needs
 * organization:write as well, which the organization insert policy holds.
 */
const schema = z.object({
  mappings: z.array(z.object({
    ninjaOrgId: z.string().trim().min(1).max(64),
    organizationId: z.union([z.guid(), z.literal('new')]).nullable(),
  })).min(1).max(1000),
});

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56).replace(/-+$/, '');
}

/** The client named like this NinjaOne organisation, created if there is none. */
async function clientFor(
  tx: HelmTx,
  identity: { tenantId: string; actorId: string },
  ninjaOrgId: string,
  name: string,
): Promise<string> {
  const [existing] = await tx<{ id: string }[]>`
    SELECT id FROM organization
    WHERE lower(btrim(name)) = lower(btrim(${name})) AND deleted_at IS NULL
    ORDER BY created_at LIMIT 1
  `;
  if (existing) return existing.id;

  const base = SLUG.test(slugify(name)) ? slugify(name) : `ninja-${slugify(ninjaOrgId) || 'org'}`;
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

export const PUT = tenantRoute(
  async ({ tx, request, session, identity }) => {
    const body = await readJson(request, (raw) => {
      const result = schema.safeParse(raw);
      if (!result.success) throw ApiError.invalid('invalid organisation mapping', { issues: zodIssues(result.error) });
      return result.data;
    });

    const current = await readNinjaSettings(tx);
    if (!current.connection) throw ApiError.notFound('NinjaOne is not set up');

    if (body.mappings.some((m) => m.organizationId === 'new') && !session.permissions.includes('organization:write')) {
      throw ApiError.forbidden('creating clients requires organization:write');
    }

    for (const mapping of body.mappings) {
      let organizationId = mapping.organizationId;
      if (organizationId === 'new') {
        const org = current.organizations.find((o) => o.ninjaOrgId === mapping.ninjaOrgId);
        if (!org) throw ApiError.notFound(`NinjaOne has no organisation ${mapping.ninjaOrgId}`);
        organizationId = await clientFor(tx, identity, org.ninjaOrgId, org.name);
      }

      const [row] = await tx<{ map_ninja_organization: boolean }[]>`
        SELECT helm.map_ninja_organization(
          ${current.connection.id}::uuid, ${mapping.ninjaOrgId}, ${organizationId}::uuid)
      `;
      if (!row?.map_ninja_organization) {
        throw ApiError.notFound(`NinjaOne has no organisation ${mapping.ninjaOrgId}`);
      }
    }

    return readNinjaSettings(tx);
  },
  { permissions: ['integration:rmm:manage'] },
);

export const dynamic = 'force-dynamic';
