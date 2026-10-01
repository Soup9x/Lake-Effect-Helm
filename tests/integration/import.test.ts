/**
 * CSV import, through the route.
 *
 * Two properties carry this feature and both are negative: a file with any bad
 * row writes NOTHING, and a password column never comes back out. Everything
 * else is mapping, which the unit tests cover.
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import {
  buildHarness, connectPools, disconnectPools, IDS, resetDatabase, superuserSql, type Harness,
} from './harness';
import { POST as importRoute } from '../../src/app/api/organizations/[organizationId]/import/route';
import { POST as createContact } from '../../src/app/api/contacts/route';

let h: Harness;
let currentUser: SessionUser | null = null;
const asUser = (id: string, email: string) => { currentUser = { id, email }; };

const request = (payload: unknown) =>
  new NextRequest(new Request('https://helm.test/api/organizations/x/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }));

const orgParams = { params: Promise.resolve({ organizationId: IDS.orgAcme }) };
const body = async (r: Response) => (await r.json()) as Record<string, unknown>;

const run = (category: string, csv: string, commit = false) =>
  importRoute(request({ category, csv, commit }), orgParams);

async function count(sql: string): Promise<number> {
  const db = superuserSql();
  try {
    const [row] = await db.unsafe<{ n: string }[]>(sql);
    return Number(row!.n);
  } finally {
    await db.end({ timeout: 5 });
  }
}

beforeAll(async () => {
  resetDatabase();
  connectPools();
  h = buildHarness();
  resetServices();
  setKekProvider(h.kek);
  useSessionResolver(async () => currentUser);
  await h.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'import tests' });
  asUser(IDS.admin1, 'admin@northwind.test');
}, 180_000);

afterAll(async () => { await disconnectPools(); });

// ---------------------------------------------------------------------------
describe('previewing', () => {
  it('reports what it found without writing anything', async () => {
    const before = await count(`SELECT count(*)::text AS n FROM contact`);
    const payload = await body(await run('contacts',
      'First name,Last name,Email\nDana,Whitfield,dana@acme.test\nMarcus,Reyes,marcus@acme.test\n'));

    expect(payload).toMatchObject({ rows: 2, valid: 2, invalid: 0, committed: 0 });
    expect(await count(`SELECT count(*)::text AS n FROM contact`)).toBe(before);
  });

  it('names the columns it did not recognise', async () => {
    const payload = await body(await run('contacts',
      'First name,Last name,Favourite biscuit\nDana,Whitfield,hobnob\n'));
    expect(payload.ignoredColumns).toEqual(['Favourite biscuit']);
  });

  it('matches a column however the export spelled it', async () => {
    // LastPass, 1Password and Excel each name these differently.
    const payload = await body(await run('contacts',
      'GIVEN_NAME,surname,Email Address\nDana,Whitfield,dana@acme.test\n'));
    expect(payload).toMatchObject({ rows: 1, valid: 1, invalid: 0 });
  });

  it('reports a row that is missing something required, by line', async () => {
    const payload = await body(await run('contacts',
      'First name,Last name\nDana,Whitfield\n,Reyes\n'));
    expect(payload).toMatchObject({ rows: 2, valid: 1, invalid: 1 });
    const detail = payload.rows_detail as { line: number; errors: string[] }[];
    expect(detail[0]!.line).toBe(3);
    expect(detail[0]!.errors[0]).toMatch(/First name is required/);
  });
});

// ---------------------------------------------------------------------------
describe('committing', () => {
  it('writes the rows and says how many', async () => {
    const payload = await body(await run('locations',
      'Name,City,Code\nHolland Plant,Holland,HL-01\nKalamazoo Depot,Kalamazoo,KZ-02\n', true));
    expect(payload.committed).toBe(2);

    const n = await count(
      `SELECT count(*)::text AS n FROM site WHERE name IN ('Holland Plant','Kalamazoo Depot')`);
    expect(n).toBe(2);
  });

  /*
   * The load-bearing one. 3 good rows and 1 bad row writes zero — a client half
   * migrated is worse than one not migrated, and the preview is what makes that
   * a reasonable answer.
   */
  it('writes NOTHING when any row is bad', async () => {
    const before = await count(`SELECT count(*)::text AS n FROM asset_node WHERE node_type='network'`);
    const response = await run('networks',
      'Name,Criticality\nVLAN 10,3\nVLAN 20,3\nVLAN 30,99\nVLAN 40,2\n', true);

    expect(response.status).toBe(400);
    const payload = await body(response);
    expect((payload.error as { message: string }).message).toMatch(/1 of 4 rows/);
    expect(await count(`SELECT count(*)::text AS n FROM asset_node WHERE node_type='network'`))
      .toBe(before);
  });

  it('refuses a file it could not parse, and writes nothing', async () => {
    const before = await count(`SELECT count(*)::text AS n FROM contact`);
    const response = await run('contacts', 'First name,Last name\n"Dana,Whitfield\n', true);
    expect(response.status).toBe(400);
    expect(await count(`SELECT count(*)::text AS n FROM contact`)).toBe(before);
  });

  it('resolves an asset to a site by name', async () => {
    await run('locations', 'Name\nImport Site A\n', true);
    await run('configurations', 'Name,Site\nimported-sw-01,Import Site A\n', true);

    const n = await count(`
      SELECT count(*)::text AS n FROM asset_node n
      JOIN site s ON s.id = n.site_id
      WHERE n.name = 'imported-sw-01' AND s.name = 'Import Site A'`);
    expect(n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('passwords', () => {
  const CSV =
    'Name,Username,Password,URL\n' +
    'Acme Registrar,billing@acme.test,hunter2-but-longer,https://registrar.test\n';

  it('encrypts the value and never returns it', async () => {
    const preview = await run('passwords', CSV);
    const previewBody = JSON.stringify(await body(preview));
    expect(previewBody).not.toContain('hunter2-but-longer');

    const committed = await run('passwords', CSV, true);
    const committedBody = JSON.stringify(await body(committed));
    expect(committedBody).not.toContain('hunter2-but-longer');

    // Stored, and stored encrypted: the ciphertext table holds no plaintext.
    const db = superuserSql();
    try {
      const [row] = await db<{ n: string }[]>`
        SELECT count(*)::text AS n FROM secret_version
        WHERE encode(ciphertext, 'escape') LIKE '%hunter2%'
      `;
      expect(row!.n).toBe('0');
    } finally {
      await db.end({ timeout: 5 });
    }
  });

  it('builds a credential that reveals back to what the file said', async () => {
    await run('passwords',
      'Name,Password\nImported Credential,a-value-from-the-file\n', true);

    const db = superuserSql();
    let secretId: string;
    try {
      const [row] = await db<{ secret_id: string }[]>`
        SELECT c.secret_id::text FROM credential c
        JOIN asset_node n ON n.id = c.id
        WHERE n.name = 'Imported Credential'
      `;
      secretId = row!.secret_id;
    } finally {
      await db.end({ timeout: 5 });
    }

    const revealed = await h.secrets.reveal(
      { tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' },
      secretId, { purpose: 'view' });
    try {
      expect(revealed.value.expose()).toBe('a-value-from-the-file');
    } finally {
      revealed.value.dispose();
    }
  });

  it('carries a TOTP seed in and refuses a bad one before writing', async () => {
    const good = await body(await run('passwords',
      'Name,Password,TOTP\nWith MFA,pw-value-here,GEZDGNBVGY3TQOJQ\n', true));
    expect(good.committed).toBe(1);

    const n = await count(`
      SELECT count(*)::text AS n FROM credential c JOIN asset_node a ON a.id=c.id
      WHERE a.name='With MFA' AND c.totp_secret_id IS NOT NULL`);
    expect(n).toBe(1);

    const bad = await run('passwords',
      'Name,Password,TOTP\nBad MFA,pw-value-here,NOT!BASE32\n', true);
    expect(bad.status).toBe(400);
    expect(await count(`SELECT count(*)::text AS n FROM asset_node WHERE name='Bad MFA'`)).toBe(0);
  });

  it('refuses a password import to somebody without secret:write', async () => {
    // client_admin holds asset:write but not secret:write.
    asUser(IDS.acmeAdmin, 'admin@acme.test');
    const response = await run('passwords', CSV, true);
    expect(response.status).toBe(403);
    expect((await body(response)).error).toMatchObject({ message: 'missing permission: secret:write' });
    asUser(IDS.admin1, 'admin@northwind.test');
  });
});

// ---------------------------------------------------------------------------
describe('what cannot be imported', () => {
  it('refuses documents, which are files rather than rows', async () => {
    const response = await run('documents', 'Name\nanything\n', true);
    expect(response.status).toBe(400);
    expect((await body(response)).error).toMatchObject({
      message: expect.stringMatching(/documents are uploaded/),
    });
  });
});

// ---------------------------------------------------------------------------
describe('the contacts endpoint the grid needed', () => {
  it('creates one', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await createContact(new NextRequest(
      new Request('https://helm.test/api/contacts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          organizationId: IDS.orgAcme, firstName: 'Priya', lastName: 'Raman',
          title: 'Finance Lead', isPrimary: false,
        }),
      })));
    expect(response.status).toBe(200);
    expect(await count(`SELECT count(*)::text AS n FROM contact WHERE last_name='Raman'`)).toBe(1);
  });

  it('refuses a read-only client user', async () => {
    asUser(IDS.acmeViewer, 'viewer@acme.test');
    const response = await createContact(new NextRequest(
      new Request('https://helm.test/api/contacts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId: IDS.orgAcme, firstName: 'No', lastName: 'Entry' }),
      })));
    expect(response.status).toBe(403);
    asUser(IDS.admin1, 'admin@northwind.test');
  });
});
