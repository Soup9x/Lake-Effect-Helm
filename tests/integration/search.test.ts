/**
 * Global search: what it finds, what it will not find, and in what order.
 *
 * This file exists because search was broken in a way no test could see. It
 * matched with websearch_to_tsquery alone — WORD matching after stemming — so
 * `acme-dc` found nothing for ACME-DC01, and the only projectors that existed
 * were for asset nodes and contacts, so `Manufacturing` found nothing for the
 * client called Acme Manufacturing. Clients, sites and uploaded documents were
 * not in the index AT ALL, and no query, however written, could reach them.
 *
 * Nothing failed. The endpoint returned 200 with an empty list, which reads as
 * "there is no such thing" rather than "this feature does not work" — and a
 * technician who searches for a client, finds nothing, and documents it a
 * second time is the outcome.
 *
 * So these tests are written from the SEARCHER's side. They assert what a
 * person types and what comes back, not that a projector wrote a row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import { withTenant } from '../../src/lib/db/client';
import { search, type SearchResponse } from '../../src/lib/search/service';
import {
  buildHarness,
  connectPools,
  disconnectPools,
  IDS,
  resetDatabase,
  superuserSql,
  type Harness,
} from './harness';

let h: Harness;
let currentUser: SessionUser | null = null;

const SITE_ID = '1c111111-0000-0000-0000-000000000001';
const DOC_ID = '1c111111-0000-0000-0000-000000000002';
const CRED_ID = '1c111111-0000-0000-0000-000000000003';

async function find(query: string, actor: string = IDS.admin1): Promise<SearchResponse> {
  return withTenant({ tenantId: IDS.tenant1, actorId: actor, actorType: 'user' }, (tx) =>
    search(tx, { query, limit: 60 }),
  );
}

const titles = (r: SearchResponse) => r.hits.map((h) => h.title);

beforeAll(async () => {
  resetDatabase();
  connectPools();
  h = buildHarness();
  resetServices();
  setKekProvider(h.kek);
  useSessionResolver(async () => currentUser);

  // A site and an uploaded document, neither of which the fixtures carry, plus
  // notes and tags — every field this batch made searchable.
  const sql = superuserSql();
  try {
    await sql`
      INSERT INTO site (id, tenant_id, organization_id, name, code, address_line1, city,
                        region, postal_code, notes)
      VALUES (${SITE_ID}::uuid, ${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid,
              'Buffalo Headquarters', 'BUF-HQ', '412 Delaware Avenue', 'Buffalo',
              'NY', '14202', 'Loading dock is round the back on Tupper.')
    `;
    await sql`
      INSERT INTO attachment (id, tenant_id, organization_id, node_id, filename,
                              content_type, byte_size, storage_key, content_sha256)
      VALUES (${DOC_ID}::uuid, ${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid,
              ${IDS.firewall}::uuid, 'acme-network-diagram-2026.vsdx',
              'application/vnd.visio', 4096, 'k/1', sha256('acme-network-diagram'::bytea))
    `;
    await sql`
      UPDATE organization SET notes = 'Renewal negotiated by Priya every March.',
                              tags = ARRAY['managed', 'gold-tier']
      WHERE id = ${IDS.orgAcme}::uuid
    `;
    await sql`
      UPDATE asset_node SET notes = 'Console cable lives in the top drawer.'
      WHERE id = ${IDS.firewall}::uuid
    `;

    // A credential NODE — the documented account, not the material. The
    // integration fixtures carry none, and "credentials group separately from
    // assets" is not a claim that can be tested against a kind nothing has.
    await sql`
      INSERT INTO asset_node (id, tenant_id, organization_id, node_type, name, notes)
      VALUES (${CRED_ID}::uuid, ${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid,
              'credential', 'ACME Domain Admin', 'Rotate after every technician leaves.')
    `;
    await sql`
      INSERT INTO credential (id, tenant_id, node_type, credential_type, username)
      VALUES (${CRED_ID}::uuid, ${IDS.tenant1}::uuid, 'credential', 'domain_admin',
              'ACME\\Administrator')
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
}, 120_000);

afterAll(async () => {
  await disconnectPools();
});

// ---------------------------------------------------------------------------

describe('the queries that used to return nothing', () => {
  it('finds a CLIENT by name', async () => {
    // The headline failure. Clients had no projector, so no query could reach
    // them — searching for the client you work with every day found nothing.
    const found = await find('Manufacturing');
    expect(titles(found)).toContain('Acme Manufacturing');
    expect(found.hits[0]!.kind).toBe('client');
  });

  it('finds an asset by a FRAGMENT of its name', async () => {
    // `acme-dc` for ACME-DC01. Word matching cannot do this: "acme-dc" is not a
    // word and does not stem to anything "acme-dc01" stems to.
    expect(titles(await find('acme-dc'))).toContain('ACME-DC01');
  });

  it('finds a client by a fragment in the MIDDLE of a word', async () => {
    expect(titles(await find('ufactur'))).toContain('Acme Manufacturing');
  });

  it('finds a device by part of its serial number', async () => {
    expect((await find('fgt60')).hits.length).toBeGreaterThan(0);
  });
});

describe('the fields that are searched', () => {
  it('a site, by its name', async () => {
    expect(titles(await find('Buffalo Headquarters'))).toContain('Buffalo Headquarters');
  });

  it('a site, by its STREET ADDRESS', async () => {
    const found = await find('Delaware Avenue');
    expect(titles(found)).toContain('Buffalo Headquarters');
    expect(found.hits.find((h) => h.title === 'Buffalo Headquarters')!.kind).toBe('site');
  });

  it('a site, by its postcode and by its code', async () => {
    expect(titles(await find('14202'))).toContain('Buffalo Headquarters');
    expect(titles(await find('BUF-HQ'))).toContain('Buffalo Headquarters');
  });

  it('a document, by part of its FILENAME', async () => {
    const found = await find('diagram');
    expect(titles(found)).toContain('acme-network-diagram-2026.vsdx');
    expect(found.hits[0]!.kind).toBe('document');
  });

  it('a document, by its extension', async () => {
    expect(titles(await find('vsdx'))).toContain('acme-network-diagram-2026.vsdx');
  });

  it("a client, by something written in its NOTES", async () => {
    // Notes were added in 0370 and were not indexed until this batch — which
    // matters more than descriptions, because a note is what somebody
    // half-remembers: "the one where Priya does the renewal".
    expect(titles(await find('Priya'))).toContain('Acme Manufacturing');
  });

  it("an asset, by something written in its notes", async () => {
    expect(titles(await find('console cable'))).toContain('acme-fw-01');
  });

  it('by TAG', async () => {
    expect(titles(await find('gold-tier'))).toContain('Acme Manufacturing');
  });

  it('and a tag match is ranked as an exact handle, not as prose', async () => {
    const hit = (await find('gold-tier')).hits.find((h) => h.title === 'Acme Manufacturing');
    expect(hit!.matchTier).toBe(4);
  });
});

describe('grouping', () => {
  it('buckets a broad query by kind instead of returning one flat list', async () => {
    const found = await find('acme');
    const kinds = found.groups.map((g) => g.kind);

    expect(kinds).toContain('client');
    expect(kinds).toContain('asset');
    expect(kinds).toContain('document');
    // Every hit lands in exactly one group, and the groups account for all of them.
    expect(found.groups.reduce((n, g) => n + g.hits.length, 0)).toBe(found.hits.length);
  });

  it('puts clients before assets, because that is what people are looking for', async () => {
    const found = await find('acme');
    const order = found.groups.map((g) => g.kind);
    expect(order.indexOf('client')).toBeLessThan(order.indexOf('asset'));
  });

  it('omits groups with no hits rather than showing empty headings', async () => {
    const found = await find('Delaware');
    expect(found.groups.every((g) => g.hits.length > 0)).toBe(true);
  });

  it('separates credentials from other assets', async () => {
    // entity_type is 'asset_node' for a credential and for a firewall alike,
    // which is why every result used to look identical. `kind` is what makes
    // them two headings.
    const found = await find('ACME');
    const credentials = found.groups.find((g) => g.kind === 'credential');
    expect(credentials?.hits.map((h) => h.title)).toContain('ACME Domain Admin');
    expect(found.groups.find((g) => g.kind === 'asset')?.hits.length).toBeGreaterThan(0);
  });
});

describe('relevance', () => {
  it('ranks an exact title above a document that merely contains the term', async () => {
    const found = await find('acme-fw-01');
    expect(found.hits[0]!.title).toBe('acme-fw-01');
    expect(found.hits[0]!.matchTier).toBe(5);
  });

  it('ranks a title match above a body match', async () => {
    const found = await find('acme');
    const client = found.hits.find((h) => h.kind === 'client')!;
    const bodyOnly = found.hits.filter((h) => h.matchTier === 1);
    for (const hit of bodyOnly) expect(client.matchTier).toBeGreaterThan(hit.matchTier);
  });

  it('orders within a group by tier, highest first', async () => {
    const found = await find('acme');
    for (const group of found.groups) {
      const tiers = group.hits.map((h) => h.matchTier);
      expect([...tiers].sort((a, b) => b - a)).toEqual(tiers);
    }
  });

  it('is stable: the same query twice gives the same order', async () => {
    // Without an explicit tie-break, equally-ranked rows swap between calls and
    // the list looks broken to somebody re-running a search.
    expect(titles(await find('acme'))).toEqual(titles(await find('acme')));
  });
});

describe('what search must not do', () => {
  it('treats % as a per cent sign, not as "everything"', async () => {
    // Unescaped, this would return every document in the tenant.
    expect((await find('%')).hits).toHaveLength(0);
  });

  it('treats _ as an underscore, not as "any character"', async () => {
    const found = await find('_');
    // A wildcard underscore would match every document with at least one
    // character, which is all of them.
    const all = await find('acme');
    expect(found.hits.length).toBeLessThan(all.hits.length);
  });

  it('never returns another tenant\'s documents', async () => {
    const found = await find('contoso');
    expect(found.hits).toHaveLength(0);
  });

  it('shows a client administrator only their own client', async () => {
    const found = await find('acme', IDS.acmeAdmin);
    for (const hit of found.hits) expect(hit.organizationId).toBe(IDS.orgAcme);
  });

  it('WITHHOLDS internal-only documentation from a client-side role', async () => {
    // search_document's RLS policy scopes by organisation and says nothing
    // about is_internal_only, so without an explicit filter in helm.search() a
    // co-managed client administrator would find the MSP's private notes about
    // their own account — and a search that now matches fragments would have
    // made that materially easier to stumble into.
    const sql = superuserSql();
    try {
      await sql`
        UPDATE asset_node SET is_internal_only = true, notes = 'Escalate to Dave, never to the client.'
        WHERE id = ${IDS.firewall}::uuid
      `;
    } finally {
      await sql.end({ timeout: 5 });
    }

    expect(titles(await find('Escalate to Dave', IDS.admin1))).toContain('acme-fw-01');
    expect(titles(await find('Escalate to Dave', IDS.acmeAdmin))).not.toContain('acme-fw-01');
  });

  it('never indexes credential material', async () => {
    // The rule the whole index is built around. Asserted against the stored
    // blob rather than through a query, so it holds for every future projector.
    const sql = superuserSql();
    try {
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM search_document
        WHERE search_text LIKE '%a-domain-admin-password%'
           OR search_text LIKE '%correct horse%'
      `;
      expect(row!.n).toBe(0);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

describe('the index keeps up with the data', () => {
  it('drops an archived client, and brings it back when restored', async () => {
    const sql = superuserSql();
    try {
      await sql`UPDATE organization SET archived_at = now() WHERE id = ${IDS.orgGlobex}::uuid`;
      expect(titles(await find('Globex'))).not.toContain('Globex Corporation');

      await sql`UPDATE organization SET archived_at = NULL WHERE id = ${IDS.orgGlobex}::uuid`;
      expect(titles(await find('Globex'))).toContain('Globex Corporation');
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('follows a rename', async () => {
    const sql = superuserSql();
    try {
      await sql`UPDATE organization SET name = 'Acme Fabrication' WHERE id = ${IDS.orgAcme}::uuid`;
      expect(titles(await find('Fabrication'))).toContain('Acme Fabrication');
      expect(titles(await find('Manufacturing'))).not.toContain('Acme Fabrication');

      await sql`UPDATE organization SET name = 'Acme Manufacturing' WHERE id = ${IDS.orgAcme}::uuid`;
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('picks up a note the moment it is written', async () => {
    // The trigger has to fire on `notes`. It did not until this batch, so a
    // note saved through the interface reached the row and never the index.
    const sql = superuserSql();
    try {
      await sql`
        UPDATE site SET notes = 'Fire panel code changed in April.' WHERE id = ${SITE_ID}::uuid
      `;
      expect(titles(await find('fire panel'))).toContain('Buffalo Headquarters');
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
