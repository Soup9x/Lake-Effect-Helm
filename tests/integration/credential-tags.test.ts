/**
 * Kind stops being a question; tags take its place in the interface.
 *
 * Two properties carry this change, and they pull in opposite directions:
 *
 *   secret.kind MUST keep working. The reveal path returns it, the export
 *   renderer prints it, and credential.totp_secret_kind is generated from it.
 *   Removing the dropdown must not have removed the column's usefulness.
 *
 *   tags MUST NOT reach it. A tag is a label somebody chose; kind is a fact
 *   about the material. If tagging a credential could change what reveal or
 *   export do with it, the two systems are one system with a confusing name.
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import { withTenant } from '../../src/lib/db/client';
import {
  actor, buildHarness, connectPools, disconnectPools, IDS, resetDatabase, superuserSql,
  type Harness,
} from './harness';
import { POST as postSecret } from '../../src/app/api/secrets/route';
import { POST as bulkTags } from '../../src/app/api/bulk/tags/route';

let h: Harness;
let currentUser: SessionUser | null = null;

const post = (url: string, body: unknown) =>
  new NextRequest(new Request(`http://helm.test${url}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));

const json = async (r: Response) => (await r.json()) as Record<string, any>;

async function su<T>(fn: (sql: ReturnType<typeof superuserSql>) => Promise<T>): Promise<T> {
  const sql = superuserSql();
  try { return await fn(sql); } finally { await sql.end({ timeout: 5 }); }
}

const asActor = () => actor(IDS.tenant1, IDS.admin1);

/** What the database holds for a stored credential. */
const stored = (secretId: string) =>
  withTenant(asActor(), async (tx) => {
    const [row] = await tx<{ kind: string; tags: string[]; node_id: string }[]>`
      SELECT s.kind::text, n.tags, n.id AS node_id
      FROM secret s JOIN credential c ON c.secret_id = s.id JOIN asset_node n ON n.id = c.id
      WHERE s.id = ${secretId}::uuid
    `;
    return row!;
  });

const create = (body: Record<string, unknown>) =>
  postSecret(post('/api/secrets', {
    organizationId: IDS.orgAcme, label: 'a credential', value: 'the-value', ...body,
  }));

beforeAll(async () => {
  resetDatabase();
  connectPools();
  h = buildHarness();
  resetServices();
  setKekProvider(h.kek);
  useSessionResolver(async () => currentUser);
  await h.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'tag tests' });
}, 120_000);

beforeEach(() => {
  currentUser = { id: IDS.admin1, email: 'admin@northwind.test' };
});

afterAll(async () => { await disconnectPools(); });

describe('storing a credential without a kind', () => {
  it('succeeds, and the column default supplies one', async () => {
    // The form no longer sends `kind`. Before 0540 this was a NOT NULL
    // violation on the ordinary path.
    const response = await create({ label: 'no kind at all' });
    expect(response.status).toBe(200);

    const row = await stored((await json(response)).secretId);
    // 'generic', which secret_kind has always used for exactly this and which
    // the form already rendered as "Other".
    expect(row.kind).toBe('generic');
  });

  it('still honours a kind when a caller genuinely knows one', async () => {
    // An importer or a script may. The form does not.
    const response = await create({ label: 'an ssh key', kind: 'ssh_key' });
    expect((await stored((await json(response)).secretId)).kind).toBe('ssh_key');
  });

  it('leaves reveal working on a defaulted secret', async () => {
    // The consumer that made keeping the column necessary.
    const response = await create({ label: 'revealable' });
    const secretId = (await json(response)).secretId as string;

    const revealed = await h.secrets.reveal(asActor(), secretId);
    expect(revealed.kind).toBe('generic');
    expect(revealed.value.expose()).toBe('the-value');
    revealed.value.dispose();
  });

  it('leaves the export collector reading a kind for it', async () => {
    const response = await create({ label: 'exportable' });
    const secretId = (await json(response)).secretId as string;

    const row = await withTenant(asActor(), async (tx) => {
      const [r] = await tx<{ kind: string | null }[]>`
        SELECT kind::text FROM v_secret_metadata WHERE id = ${secretId}::uuid
      `;
      return r!;
    });
    expect(row.kind).toBe('generic');
  });
});

describe('tags on a credential', () => {
  it('are stored on the asset_node at creation', async () => {
    const response = await create({ label: 'tagged', tags: ['Vendor Portal', 'ssh key'] });
    const row = await stored((await json(response)).secretId);

    // Lowercased, deduplicated and sorted the way every other tag write
    // normalises them, so one typed here and one from the bulk toolbar match.
    expect(row.tags).toEqual(['ssh key', 'vendor portal']);
  });

  it('are optional — a credential with none is ordinary', async () => {
    const response = await create({ label: 'untagged' });
    expect((await stored((await json(response)).secretId)).tags).toEqual([]);
  });

  it('go through the SAME endpoint the client tag control uses', async () => {
    // The audit's finding: a credential is an asset_node, asset_node.tags
    // already existed, and /api/bulk/tags already targeted it. No new table.
    const created = await json(await create({ label: 'retaggable' }));
    const { node_id } = await stored(created.secretId);

    const added = await bulkTags(post('/api/bulk/tags', {
      target: 'node', ids: [node_id], tags: ['retired'], mode: 'add',
    }));
    expect(added.status).toBe(200);
    expect((await stored(created.secretId)).tags).toEqual(['retired']);

    const removed = await bulkTags(post('/api/bulk/tags', {
      target: 'node', ids: [node_id], tags: ['retired'], mode: 'remove',
    }));
    expect(removed.status).toBe(200);
    expect((await stored(created.secretId)).tags).toEqual([]);
  });
});

describe('the two systems are independent', () => {
  it('tagging a credential "ssh_key" does NOT change its kind', async () => {
    // The constraint the brief was explicit about. A tag that could set kind
    // would mean tagging a credential silently changes what reveal and export
    // report about the material.
    const created = await json(await create({ label: 'independence' }));
    const { node_id } = await stored(created.secretId);
    expect((await stored(created.secretId)).kind).toBe('generic');

    await bulkTags(post('/api/bulk/tags', {
      target: 'node', ids: [node_id], tags: ['ssh_key', 'password', 'certificate'], mode: 'add',
    }));

    const after = await stored(created.secretId);
    expect(after.tags).toEqual(['certificate', 'password', 'ssh_key']);
    expect(after.kind).toBe('generic');
  });

  it('changing the kind does NOT change the tags', async () => {
    // The other direction, so the independence is not one-way.
    const created = await json(await create({ label: 'other direction', tags: ['vip'] }));
    await su((sql) => sql`
      UPDATE secret SET kind = 'certificate' WHERE id = ${created.secretId}::uuid
    `);

    const after = await stored(created.secretId);
    expect(after.kind).toBe('certificate');
    expect(after.tags).toEqual(['vip']);
  });

  it('no trigger reads both, which is what keeps it that way', async () => {
    // Asserted structurally rather than trusted: a future trigger deriving one
    // from the other would pass both tests above until it fired.
    const offenders = await su(async (sql) => {
      const rows = await sql<{ proname: string }[]>`
        SELECT DISTINCT p.proname
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE NOT t.tgisinternal
          AND c.relname IN ('secret', 'asset_node', 'credential')
          AND pg_get_functiondef(p.oid) ~ '\\mkind\\M'
          AND pg_get_functiondef(p.oid) ~ '\\mtags\\M'
          AND p.proname NOT IN ('index_asset_node', 'index_organization', 'index_site',
                                'index_contact', 'index_attachment', 'index_flexible_record')
      `;
      return rows.map((r) => r.proname);
    });
    expect(offenders).toEqual([]);
  });
});

describe('the one-time backfill', () => {
  it('turns an existing kind into a starting tag, keeping tags already there', async () => {
    // Reproduces a pre-0540 credential: a kind, and tags somebody had already
    // applied. The migration must add the first without disturbing the second.
    const created = await json(await create({ label: 'legacy', tags: ['vip'] }));
    const { node_id } = await stored(created.secretId);
    await su(async (sql) => {
      await sql`UPDATE secret SET kind = 'license_key' WHERE id = ${created.secretId}::uuid`;
      // The migration's UPDATE, run again over this row.
      await sql`
        UPDATE asset_node n
           SET tags = (SELECT coalesce(array_agg(DISTINCT t ORDER BY t), '{}'::text[])
                       FROM unnest(n.tags || ARRAY[s.kind::text]) AS t)
          FROM credential c JOIN secret s ON s.id = c.secret_id
         WHERE n.id = c.id AND n.id = ${node_id}::uuid
           AND NOT (s.kind::text = ANY (n.tags))
      `;
    });

    const after = await stored(created.secretId);
    expect(after.tags).toEqual(['license_key', 'vip']);
    // And the kind itself is untouched — it is still what reveal and export read.
    expect(after.kind).toBe('license_key');
  });
});
