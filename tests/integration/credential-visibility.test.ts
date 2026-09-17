/**
 * A stored credential has to be FINDABLE, not merely stored.
 *
 * This file exists because of a bug that every other test in the suite was
 * blind to. `POST /api/secrets` returned 200, encrypted the material correctly,
 * wrote `secret` and `secret_version` — and stopped. A credential in Helm is
 * two rows: the encrypted material, and the `credential` asset node that points
 * at it and carries the account it belongs to. Only the first was written.
 *
 * Every existing test asserted on the response body or on the `secret` table,
 * so all of them passed while the feature was broken. The technician stored a
 * domain admin password, the interface said it had been stored, and the
 * client's Credentials card stayed empty — because that card lists credential
 * ASSETS, and the row it needed did not exist. It was missing from search for
 * the same reason.
 *
 * So these tests deliberately assert from the READING side: they run the same
 * query the client page runs, rather than trusting the write's own report. A
 * write that reports success and produces nothing anybody can see is the
 * failure mode worth a file of its own, because it is the one where the person
 * believes the credential is captured.
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import {
  buildHarness,
  connectPools,
  disconnectPools,
  IDS,
  resetDatabase,
  superuserSql,
  type Harness,
} from './harness';

import { POST as postSecret } from '../../src/app/api/secrets/route';

let h: Harness;
let currentUser: SessionUser | null = null;
const asUser = (id: string, email: string) => {
  currentUser = { id, email };
};

const store = (payload: unknown) =>
  new NextRequest(
    new Request('http://helm.test/api/secrets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );

const body = async (response: Response) => (await response.json()) as Record<string, unknown>;

const CREDENTIAL = {
  organizationId: IDS.orgAcme,
  label: 'Domain admin — DC01',
  kind: 'password' as const,
  value: 'a-domain-admin-password',
  sensitivity: 'standard' as const,
};

/**
 * The query the client page runs for its Credentials card, verbatim.
 *
 * Copied rather than imported on purpose: this is the reader's view, and the
 * test is worth nothing if it drifts to match whatever the writer happens to
 * produce.
 */
async function credentialsVisibleOn(organizationId: string) {
  const sql = superuserSql();
  try {
    return await sql<
      {
        node_id: string;
        name: string;
        credential_type: string;
        username: string | null;
        secret_id: string | null;
      }[]
    >`
      SELECT n.id AS node_id, n.name, c.credential_type::text, c.username::text,
             c.secret_id::text
      FROM credential c
      JOIN asset_node n ON n.id = c.id
      WHERE n.organization_id = ${organizationId}::uuid AND n.archived_at IS NULL
      ORDER BY n.name
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function countWhere(table: string, predicate: string): Promise<number> {
  const sql = superuserSql();
  try {
    const [row] = await sql.unsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM ${table} WHERE ${predicate}`,
    );
    return row!.n;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

beforeAll(async () => {
  resetDatabase();
  connectPools();
  h = buildHarness();
  resetServices();
  setKekProvider(h.kek);
  useSessionResolver(async () => currentUser);
  await h.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'test provisioning' });
}, 120_000);

afterAll(async () => {
  await disconnectPools();
});

describe('storing a credential against a client', () => {
  it('APPEARS on that client afterwards', async () => {
    // The regression test. Before the fix this returned 200 and the list below
    // was empty — the whole bug in three lines.
    const before = await credentialsVisibleOn(IDS.orgAcme);

    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await postSecret(store(CREDENTIAL));
    expect(response.status).toBe(200);

    const after = await credentialsVisibleOn(IDS.orgAcme);
    expect(after.length).toBe(before.length + 1);
    expect(after.map((c) => c.name)).toContain('Domain admin — DC01');
  });

  it('links the visible row to the material that was encrypted', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const created = await body(await postSecret(store({ ...CREDENTIAL, label: 'Linked' })));

    const [row] = (await credentialsVisibleOn(IDS.orgAcme)).filter((c) => c.name === 'Linked');
    expect(row).toBeDefined();
    expect(row!.secret_id).toBe(created.secretId);
    expect(row!.node_id).toBe(created.credentialId);
  });

  it('writes the node and the material in one transaction', async () => {
    // Both rows or neither. A node with no material documents an account
    // nobody can use; material with no node is the bug this file is about.
    asUser(IDS.admin1, 'admin@northwind.test');
    await postSecret(store({ ...CREDENTIAL, label: 'Atomic' }));

    expect(await countWhere('secret', "label = 'Atomic'")).toBe(1);
    expect(
      await countWhere(
        'credential c JOIN asset_node n ON n.id = c.id',
        "n.name = 'Atomic' AND c.secret_id IS NOT NULL",
      ),
    ).toBe(1);
  });

  it('leaves no secret behind when the node cannot be created', async () => {
    // A site belonging to nobody. The node insert fails on the composite
    // foreign key, and the secret written moments earlier must roll back with
    // it rather than being orphaned exactly as before.
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await postSecret(
      store({
        ...CREDENTIAL,
        label: 'Rolled back',
        siteId: '00000000-0000-0000-0000-0000000000ff',
      }),
    );

    expect(response.status).toBe(400);
    expect(await countWhere('secret', "label = 'Rolled back'")).toBe(0);
  });

  it('records the credential type and username the form collected', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    await postSecret(
      store({
        ...CREDENTIAL,
        label: 'Service account',
        credentialType: 'service_account',
        username: 'svc-backup',
        url: 'https://backup.acme.test',
      }),
    );

    const [row] = (await credentialsVisibleOn(IDS.orgAcme)).filter(
      (c) => c.name === 'Service account',
    );
    expect(row!.credential_type).toBe('service_account');
    expect(row!.username).toBe('svc-backup');
  });

  it('is reachable from search, not only from the client page', async () => {
    // asset_node feeds the search index. A credential that exists only as a
    // `secret` row is unfindable by name, which is how somebody concludes it
    // was never saved and stores it a second time.
    asUser(IDS.admin1, 'admin@northwind.test');
    await postSecret(store({ ...CREDENTIAL, label: 'Findable by name' }));

    expect(await countWhere('search_document', "title = 'Findable by name'")).toBe(1);
  });

  it('cannot be stored against another tenant\'s client', async () => {
    // The node insert reaches organization through a composite key carrying
    // tenant_id, so this fails there even though the caller is an
    // administrator of their own tenant.
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await postSecret(
      store({ ...CREDENTIAL, label: 'Cross tenant', organizationId: IDS.orgContoso }),
    );

    // 400, not 500: naming a client that is not yours is a bad request, and
    // the answer must not distinguish "another tenant's" from "no such".
    expect(response.status).toBe(400);
    expect(await countWhere('secret', "label = 'Cross tenant'")).toBe(0);
    expect(
      await countWhere('asset_node', "name = 'Cross tenant'"),
    ).toBe(0);
  });

  it('refuses a client-side role outright', async () => {
    asUser(IDS.acmeViewer, 'viewer@acme.test');
    const response = await postSecret(store({ ...CREDENTIAL, label: 'Not permitted' }));

    expect(response.status).toBe(403);
    expect(await countWhere('secret', "label = 'Not permitted'")).toBe(0);
  });
});
