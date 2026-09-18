/**
 * Editing what has been documented, and the dependency graph behind it.
 *
 * THREE BUGS, AND THEY WERE NOT THE SAME BUG.
 *
 *   SITES had a PATCH route covering thirteen fields and no caller anywhere in
 *   the interface. A site could be created and never corrected.
 *
 *   ASSETS had a PATCH route covering eight fields and a caller that used
 *   exactly one of them — RenameAsset, which offered the name and nothing else.
 *
 *   CREDENTIALS had no update path at all: no route, no service call from the
 *   interface, nothing. A typo in a username was permanent, and changing a
 *   password meant storing a second credential beside the wrong one.
 *
 * DEPENDENCIES were different again. The engine, the canonicalisation, the
 * bi-directional view and the routes all worked and were tested. Nothing in the
 * interface called them, and the read the asset page did perform returned every
 * edge TWICE — once each way — so one link rendered as two rows saying opposite
 * things.
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import { withTenant } from '../../src/lib/db/client';
import {
  buildHarness,
  connectPools,
  disconnectPools,
  IDS,
  resetDatabase,
  superuserSql,
  type Harness,
} from './harness';

import { POST as createSecret } from '../../src/app/api/secrets/route';
import { PATCH as patchSecret } from '../../src/app/api/secrets/[secretId]/route';
import { POST as rotateSecret } from '../../src/app/api/secrets/[secretId]/rotate/route';
import { POST as createSite, GET as listSites } from '../../src/app/api/sites/route';
import { PATCH as patchSite } from '../../src/app/api/sites/[siteId]/route';
import { PATCH as patchAsset } from '../../src/app/api/assets/[nodeId]/route';
import { POST as linkRoute, DELETE as unlinkRoute } from '../../src/app/api/assets/links/route';

let h: Harness;
let currentUser: SessionUser | null = null;
const asUser = (id: string, email: string) => {
  currentUser = { id, email };
};

const request = (url: string, init: RequestInit = {}) =>
  new NextRequest(new Request(`https://helm.test${url}`, init));

const json = (method: string, payload: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});

const body = async (response: Response) => (await response.json()) as Record<string, never>;

beforeAll(async () => {
  resetDatabase();
  connectPools();
  h = buildHarness();
  resetServices();
  setKekProvider(h.kek);
  useSessionResolver(async () => currentUser);
  await h.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'editing tests' });
}, 180_000);

afterAll(async () => {
  await disconnectPools();
});

describe('a site can be corrected after it is created', () => {
  it('PATCHes the fields it is given and leaves the rest alone', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');

    const created = await body(
      await createSite(
        request(
          '/api/sites',
          json('POST', {
            organizationId: IDS.orgAcme,
            name: 'Warehouse',
            city: 'Buffalo',
            mainPhone: '716-555-0100',
          }),
        ),
      ),
    );
    const siteId = (created.site as unknown as { id: string }).id;

    const response = await patchSite(
      request(`/api/sites/${siteId}`, json('PATCH', { name: 'North Warehouse' })),
      { params: Promise.resolve({ siteId }) },
    );
    expect(response.status).toBe(200);

    const sql = superuserSql();
    try {
      const [row] = await sql<{ name: string; city: string; main_phone: string }[]>`
        SELECT name, city, main_phone FROM site WHERE id = ${siteId}::uuid
      `;
      expect(row!.name).toBe('North Warehouse');
      // Absent from the body means "leave it", which is the contract the edit
      // form relies on when it sends only what changed.
      expect(row!.city).toBe('Buffalo');
      expect(row!.main_phone).toBe('716-555-0100');
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('clears a field when sent an explicit null', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const sites = await body(await listSites(request(`/api/sites?organizationId=${IDS.orgAcme}`)));
    const siteId = (sites.sites as unknown as { id: string; name: string }[]).find(
      (s) => s.name === 'North Warehouse',
    )!.id;

    await patchSite(request(`/api/sites/${siteId}`, json('PATCH', { city: null })), {
      params: Promise.resolve({ siteId }),
    });

    const sql = superuserSql();
    try {
      const [row] = await sql<{ city: string | null }[]>`
        SELECT city FROM site WHERE id = ${siteId}::uuid
      `;
      expect(row!.city).toBeNull();
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

describe('an asset can be edited beyond its name', () => {
  it('accepts every field the edit form offers, in one request', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');

    const response = await patchAsset(
      request(
        `/api/assets/${IDS.firewall}`,
        json('PATCH', {
          name: 'ACME edge firewall',
          description: 'HA pair, primary',
          status: 'maintenance',
          criticality: 5,
          tags: ['edge', 'ha'],
          isInternalOnly: true,
        }),
      ),
      { params: Promise.resolve({ nodeId: IDS.firewall }) },
    );
    expect(response.status).toBe(200);

    const sql = superuserSql();
    try {
      const [row] = await sql<{
        name: string; description: string; status: string;
        criticality: number; tags: string[]; is_internal_only: boolean;
      }[]>`SELECT name, description, status::text, criticality, tags, is_internal_only
           FROM asset_node WHERE id = ${IDS.firewall}::uuid`;
      expect(row!.name).toBe('ACME edge firewall');
      expect(row!.description).toBe('HA pair, primary');
      expect(row!.status).toBe('maintenance');
      expect(row!.criticality).toBe(5);
      expect(row!.tags.sort()).toEqual(['edge', 'ha']);
      expect(row!.is_internal_only).toBe(true);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('refuses a read-only client user', async () => {
    // Deliberately the read-only role rather than the client ADMIN: a client
    // admin legitimately holds asset:write inside their own organisation, so
    // asserting a refusal there would be asserting the wrong rule.
    asUser(IDS.acmeViewer, 'viewer@acme.test');
    const response = await patchAsset(
      request(`/api/assets/${IDS.firewall}`, json('PATCH', { name: 'renamed by a client' })),
      { params: Promise.resolve({ nodeId: IDS.firewall }) },
    );
    expect(response.status).toBe(403);
  });

  it('hides an internal-only asset from a client admin who could otherwise write it', async () => {
    // The previous test marked this asset internal-only. A client admin has
    // asset:write, so the permission gate lets them through — and RLS then
    // matches no row, which the route reports as a missing asset rather than
    // as a refusal. That is the correct shape: the asset does not exist as far
    // as this actor is concerned.
    asUser(IDS.acmeAdmin, 'it@acme.test');
    const response = await patchAsset(
      request(`/api/assets/${IDS.firewall}`, json('PATCH', { name: 'renamed by a client' })),
      { params: Promise.resolve({ nodeId: IDS.firewall }) },
    );
    expect(response.status).toBe(400);

    const sql = superuserSql();
    try {
      const [row] = await sql<{ name: string }[]>`
        SELECT name FROM asset_node WHERE id = ${IDS.firewall}::uuid
      `;
      expect(row!.name).toBe('ACME edge firewall');
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

describe('a credential can be edited, which it could not be at all', () => {
  let secretId = '';

  it('is created with the documentation it was given', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const created = await body(
      await createSecret(
        request(
          '/api/secrets',
          json('POST', {
            organizationId: IDS.orgAcme,
            label: 'Backup appliance',
            kind: 'password',
            value: 'correct-horse-battery-staple',
            username: 'admn',
            credentialType: 'local_admin',
          }),
        ),
      ),
    );
    secretId = created.secretId as unknown as string;
    expect(secretId).toBeTruthy();
  });

  it('corrects the username without touching the stored value', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');

    const before = superuserSql();
    let versionBefore: number;
    try {
      const [row] = await before<{ current_version: number }[]>`
        SELECT current_version FROM secret WHERE id = ${secretId}::uuid
      `;
      versionBefore = row!.current_version;
    } finally {
      await before.end({ timeout: 5 });
    }

    const response = await patchSecret(
      request(`/api/secrets/${secretId}`, json('PATCH', { username: 'admin', url: 'https://backup.acme.test' })),
      { params: Promise.resolve({ secretId }) },
    );
    expect(response.status).toBe(200);

    const sql = superuserSql();
    try {
      const [cred] = await sql<{ username: string; url: string }[]>`
        SELECT username::text, url FROM credential WHERE secret_id = ${secretId}::uuid
      `;
      expect(cred!.username).toBe('admin');
      expect(cred!.url).toBe('https://backup.acme.test');

      // Editing documentation is NOT a rotation: no new encrypted version.
      const [secret] = await sql<{ current_version: number }[]>`
        SELECT current_version FROM secret WHERE id = ${secretId}::uuid
      `;
      expect(secret!.current_version).toBe(versionBefore);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('tightens the access policy, and audits that it was tightened', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const tightened = await patchSecret(
      request(
        `/api/secrets/${secretId}`,
        json('PATCH', { requiresReason: true, requiresStepUp: true, sensitivity: 'critical' }),
      ),
      { params: Promise.resolve({ secretId }) },
    );
    expect(tightened.status).toBe(200);

    const sql = superuserSql();
    try {
      const [row] = await sql<{ requires_reason: boolean; sensitivity: string }[]>`
        SELECT requires_reason, sensitivity::text FROM secret WHERE id = ${secretId}::uuid
      `;
      expect(row!.requires_reason).toBe(true);
      expect(row!.sensitivity).toBe('critical');

      // "Who dropped the step-up requirement on the domain admin password" has
      // to be answerable, and a row carrying only its current state cannot.
      const [audit] = await sql<{ metadata: { fields: string[] } }[]>`
        SELECT metadata FROM audit_log
        WHERE action = 'secret.updated' AND entity_id = ${secretId}::uuid
        ORDER BY occurred_at DESC LIMIT 1
      `;
      expect(audit!.metadata.fields).toContain('requiresReason');
      expect(audit!.metadata.fields).toContain('sensitivity');
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('explains the critical/step-up rule instead of failing as an internal error', async () => {
    /*
     * `secret_critical_requires_step_up` says a critical credential must also
     * require re-authentication AND a written reason. Before this was mapped,
     * ticking "critical" in the form produced a 500 and the message "internal
     * error", which tells an operator nothing and reads as a broken feature.
     */
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await patchSecret(
      request(
        `/api/secrets/${secretId}`,
        json('PATCH', { sensitivity: 'critical', requiresStepUp: false, requiresReason: false }),
      ),
      { params: Promise.resolve({ secretId }) },
    );
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.message).toMatch(/re-authentication and a written reason/);
  });

  it('will not let somebody lock themselves out by raising the floor above their own rank', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await patchSecret(
      request(`/api/secrets/${secretId}`, json('PATCH', { minRoleRank: 101 })),
      { params: Promise.resolve({ secretId }) },
    );
    expect(response.status).toBe(400);
  });

  it('REFUSES to rotate a credential that requires a step-up, without one', async () => {
    /*
     * THE REQUIREMENT THE BRIEF NAMED: anything already gated behind a
     * step-up stays gated the same way on edit. The test above made this
     * credential critical, which forces requires_step_up — so rotating it now
     * is refused by the write handshake, in the database, exactly as revealing
     * it would be. Nothing in the route re-implements that check; a second
     * copy of an authorisation rule is a second place for it to drift.
     */
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await rotateSecret(
      request(
        `/api/secrets/${secretId}/rotate`,
        json('POST', { value: 'a-completely-different-passphrase', reason: 'rotated after the Miller offboarding' }),
      ),
      { params: Promise.resolve({ secretId }) },
    );
    expect(response.status).toBe(403);

    const sql = superuserSql();
    try {
      const rows = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM secret_version WHERE secret_id = ${secretId}::uuid
      `;
      // A refused rotation writes nothing.
      expect(Number(rows[0]!.n)).toBe(1);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('rotates an ungated credential as a new version, through the audited path', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const created = await body(
      await createSecret(
        request(
          '/api/secrets',
          json('POST', {
            organizationId: IDS.orgAcme,
            label: 'Switch console',
            kind: 'password',
            value: 'first-value-in-place',
            username: 'admin',
          }),
        ),
      ),
    );
    const plain = created.secretId as unknown as string;

    const response = await rotateSecret(
      request(
        `/api/secrets/${plain}/rotate`,
        json('POST', { value: 'a-completely-different-passphrase', reason: 'rotated after the Miller offboarding' }),
      ),
      { params: Promise.resolve({ secretId: plain }) },
    );
    expect(response.status).toBe(200);
    expect((await body(response)).version as unknown as number).toBe(2);

    const sql = superuserSql();
    try {
      const rows = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM secret_version WHERE secret_id = ${plain}::uuid
      `;
      // The old version is superseded, not deleted — an export taken yesterday
      // still makes sense.
      expect(Number(rows[0]!.n)).toBe(2);

      const [audit] = await sql<{ reason: string }[]>`
        SELECT reason FROM audit_log
        WHERE entity_id = ${plain}::uuid AND reason IS NOT NULL
        ORDER BY occurred_at DESC LIMIT 1
      `;
      expect(audit!.reason).toMatch(/Miller offboarding/);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('refuses a rotation with no stated reason', async () => {
    // The reason is the line somebody reads in the audit log a year from now.
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await rotateSecret(
      request(`/api/secrets/${secretId}/rotate`, json('POST', { value: 'x', reason: 'oops' })),
      { params: Promise.resolve({ secretId }) },
    );
    expect(response.status).toBe(400);
  });

  it('refuses a client-side role outright', async () => {
    asUser(IDS.acmeAdmin, 'it@acme.test');
    const response = await patchSecret(
      request(`/api/secrets/${secretId}`, json('PATCH', { username: 'taken-over' })),
      { params: Promise.resolve({ secretId }) },
    );
    expect(response.status).toBe(403);
  });
});

describe('dependencies', () => {
  /** The query the asset page runs, as the page runs it. */
  async function edgesFor(nodeId: string) {
    return withTenant(
      { tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' },
      async (tx) =>
        tx<{ relation: string; other_id: string; other_name: string; origin: string }[]>`
          SELECT e.relation::text, e.origin::text,
                 other.id AS other_id, other.name AS other_name
          FROM v_asset_edge e
          JOIN asset_node other ON other.id = e.to_node_id
          WHERE e.from_node_id = ${nodeId}::uuid
          ORDER BY e.relation, other.name
        `,
    );
  }

  it('shows a link ONCE, not once per direction', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');

    const created = await body(
      await linkRoute(
        request(
          '/api/assets/links',
          json('POST', {
            sourceNodeId: IDS.domainController,
            relation: 'depends_on',
            targetNodeId: IDS.network,
          }),
        ),
      ),
    );
    expect(created.created as unknown as boolean).toBe(true);

    const mine = await edgesFor(IDS.domainController);
    const toNetwork = mine.filter((e) => e.other_id === IDS.network && e.origin === 'manual');

    /*
     * THE REGRESSION. v_asset_edge emits every stored edge twice, once each
     * way, with the relation inverted on the reverse pass. The asset page used
     * to match `from = me OR to = me`, which matches BOTH copies — so this one
     * link rendered as "depends on Network" directly above "supports Network".
     */
    expect(toNetwork).toHaveLength(1);
    expect(toNetwork[0]!.relation).toBe('depends_on');
  });

  it('shows the same link from the other end, inverted', async () => {
    const theirs = await edgesFor(IDS.network);
    const back = theirs.filter((e) => e.other_id === IDS.domainController && e.origin === 'manual');
    expect(back).toHaveLength(1);
    // The view has already done the inverting, which is why the page can ask
    // only for rows where it is the source.
    expect(back[0]!.relation).toBe('supports');
  });

  it('removes a link, from either direction', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const removed = await body(
      await unlinkRoute(
        request(
          '/api/assets/links',
          json('DELETE', {
            // Deliberately the REVERSE of how it was created: the engine
            // canonicalises, and the person clicking is looking at whichever
            // end they happen to be on.
            sourceNodeId: IDS.network,
            relation: 'supports',
            targetNodeId: IDS.domainController,
          }),
        ),
      ),
    );
    expect(removed.removed as unknown as boolean).toBe(true);

    const mine = await edgesFor(IDS.domainController);
    expect(mine.filter((e) => e.other_id === IDS.network && e.origin === 'manual')).toHaveLength(0);
  });

  it('refuses a client-side role, which cannot draw the graph', async () => {
    asUser(IDS.acmeAdmin, 'it@acme.test');
    const response = await linkRoute(
      request(
        '/api/assets/links',
        json('POST', {
          sourceNodeId: IDS.firewall,
          relation: 'depends_on',
          targetNodeId: IDS.network,
        }),
      ),
    );
    expect(response.status).toBe(403);
  });
});
