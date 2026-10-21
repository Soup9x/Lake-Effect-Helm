/**
 * Bulk actions, and the one thing they must never do.
 *
 * A bulk action may not do something the person could not have done one item at
 * a time. That is easy to state and easy to get wrong, because the tempting
 * implementation — check the permission once, then loop — is exactly the shape
 * that lets somebody tag forty clients when they had authority over two of
 * them.
 *
 * Helm's answer is that the permission is not checked once anywhere. Every
 * statement runs under the caller's RLS, so an UPDATE simply does not match
 * rows the policy refuses. What these tests establish is the part RLS cannot do
 * on its own: NOTICING. A policy that silently matches eight of ten rows is a
 * correct policy and a terrible experience — the person ticked ten boxes, saw
 * "archived", and two clients are still live. So a shortfall aborts the whole
 * operation, and the mixed-permission tests below are the ones that matter.
 */
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import {
  actor,
  buildHarness,
  connectPools,
  disconnectPools,
  IDS,
  resetDatabase,
  superuserSql,
  type Harness,
} from './harness';

import { POST as bulkTags } from '../../src/app/api/bulk/tags/route';
import { POST as bulkArchive } from '../../src/app/api/bulk/archive/route';
import { POST as bulkExport } from '../../src/app/api/bulk/export/route';
import { POST as bulkCopy } from '../../src/app/api/bulk/copy/route';
import { collectExport } from '../../src/lib/exports/collect';
import { withTenant } from '../../src/lib/db/client';

let h: Harness;
let currentUser: SessionUser | null = null;
const asUser = (id: string, email: string) => {
  currentUser = { id, email };
};

/**
 * A tier2 technician scoped to ONE client.
 *
 * The fixtures have nobody like this, and without them there is no genuine
 * mixed-permission case to test: client_admin holds no organization:write at
 * all (a co-managed customer does not relabel their own company record), so
 * their bulk tag fails for every client rather than for some. tier2 holds
 * organization:write and this membership scopes it to Acme — so a selection of
 * Acme and Globex is exactly half reachable, which is the case that matters.
 */
const SCOPED_ID = '1b000000-0000-0000-0000-0000000000aa';

const post = (path: string, payload: unknown) =>
  new NextRequest(
    new Request(`http://helm.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );

const body = async (response: Response) => (await response.json()) as Record<string, unknown>;

async function tagsOf(table: 'organization' | 'asset_node', id: string): Promise<string[]> {
  const sql = superuserSql();
  try {
    const [row] = await sql.unsafe<{ tags: string[] }[]>(
      `SELECT tags FROM ${table} WHERE id = $1`,
      [id],
    );
    return row?.tags ?? [];
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function archivedAt(table: 'organization' | 'asset_node', id: string): Promise<Date | null> {
  const sql = superuserSql();
  try {
    const [row] = await sql.unsafe<{ archived_at: Date | null }[]>(
      `SELECT archived_at FROM ${table} WHERE id = $1`,
      [id],
    );
    return row?.archived_at ?? null;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function reset(): Promise<void> {
  const sql = superuserSql();
  try {
    await sql`UPDATE organization SET tags = '{}', archived_at = NULL, deleted_at = NULL`;
    await sql`UPDATE asset_node SET tags = '{}', archived_at = NULL`;
    // Export jobs accumulate across tests. The audit log deliberately does not
    // get the same treatment: it is hash-chained and append-only, so a test
    // that deleted from it would be breaking the property the tamper suite
    // exists to prove. Assertions over it are scoped instead.
    await sql`DELETE FROM export_job`;
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

  const sql = superuserSql();
  try {
    await sql`
      INSERT INTO app_user (id, email, name)
      VALUES (${SCOPED_ID}::uuid, 'scoped@northwind.test', 'Acme Account Lead')
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO membership (tenant_id, user_id, role_key, org_scope_all, org_scope, require_step_up)
      VALUES (${IDS.tenant1}::uuid, ${SCOPED_ID}::uuid, 'tier2', false,
              ARRAY[${IDS.orgAcme}]::uuid[], false)
      ON CONFLICT DO NOTHING
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
}, 120_000);

beforeEach(reset);

afterAll(async () => {
  await disconnectPools();
});

// ---------------------------------------------------------------------------

describe('a selection the actor can reach in full', () => {
  it('tags every client in it', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await bulkTags(
      post('/api/bulk/tags', {
        target: 'client',
        ids: [IDS.orgAcme, IDS.orgGlobex],
        tags: ['managed', 'gold tier'],
      }),
    );

    expect(response.status).toBe(200);
    expect((await body(response)).affected).toBe(2);
    expect(await tagsOf('organization', IDS.orgAcme)).toEqual(['gold tier', 'managed']);
    expect(await tagsOf('organization', IDS.orgGlobex)).toEqual(['gold tier', 'managed']);
  });

  it('keeps tags that are already there', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    await bulkTags(post('/api/bulk/tags', { target: 'client', ids: [IDS.orgAcme], tags: ['first'] }));
    await bulkTags(post('/api/bulk/tags', { target: 'client', ids: [IDS.orgAcme], tags: ['second'] }));

    expect(await tagsOf('organization', IDS.orgAcme)).toEqual(['first', 'second']);
  });

  it('lowercases, so "Production" and "production" are one tag', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    await bulkTags(
      post('/api/bulk/tags', { target: 'client', ids: [IDS.orgAcme], tags: ['Production', 'PRODUCTION'] }),
    );
    expect(await tagsOf('organization', IDS.orgAcme)).toEqual(['production']);
  });

  it('removes tags without touching the others', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    await bulkTags(
      post('/api/bulk/tags', { target: 'client', ids: [IDS.orgAcme], tags: ['keep', 'drop'] }),
    );
    await bulkTags(
      post('/api/bulk/tags', { target: 'client', ids: [IDS.orgAcme], tags: ['drop'], mode: 'remove' }),
    );
    expect(await tagsOf('organization', IDS.orgAcme)).toEqual(['keep']);
  });

  it('archives, and restores', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    await bulkArchive(
      post('/api/bulk/archive', { target: 'client', ids: [IDS.orgGlobex], archived: true }),
    );
    expect(await archivedAt('organization', IDS.orgGlobex)).not.toBeNull();

    await bulkArchive(
      post('/api/bulk/archive', { target: 'client', ids: [IDS.orgGlobex], archived: false }),
    );
    expect(await archivedAt('organization', IDS.orgGlobex)).toBeNull();
  });

  it('archives without deleting — the row and its assets are untouched', async () => {
    // The distinction the whole feature rests on. An archive that loses data is
    // a delete that lies about it.
    asUser(IDS.admin1, 'admin@northwind.test');
    await bulkArchive(
      post('/api/bulk/archive', { target: 'client', ids: [IDS.orgAcme], archived: true }),
    );

    const sql = superuserSql();
    try {
      const [org] = await sql<{ name: string; deleted_at: Date | null }[]>`
        SELECT name, deleted_at FROM organization WHERE id = ${IDS.orgAcme}::uuid
      `;
      expect(org!.name).toBe('Acme Manufacturing');
      expect(org!.deleted_at).toBeNull();

      const [assets] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM asset_node
        WHERE organization_id = ${IDS.orgAcme}::uuid AND archived_at IS NULL
      `;
      // Archiving a client does not cascade. A cascade would be unrecoverable:
      // restoring the client could not tell which children were already
      // archived beforehand.
      expect(assets!.n).toBeGreaterThan(0);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('queues one export per client, never one bundle for several', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await bulkExport(
      post('/api/bulk/export', {
        target: 'client',
        ids: [IDS.orgAcme, IDS.orgGlobex],
        reason: 'Ticket 4821 — quarterly documentation handover',
      }),
    );

    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(payload.clients).toBe(2);
    expect((payload.jobs as unknown[]).length).toBe(2);
  });

  it('never includes secret material in a bulk export', async () => {
    // Four-eyes approval exists precisely so a secret-bearing export is a
    // deliberate act. A checkbox on a list view must not be able to request
    // forty of them.
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await bulkExport(
      post('/api/bulk/export', {
        target: 'client',
        ids: [IDS.orgAcme],
        reason: 'Ticket 4821 — quarterly documentation handover',
        includeSecrets: true,
      }),
    );
    expect(response.status).toBe(200);

    const sql = superuserSql();
    try {
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM export_job WHERE include_secrets
      `;
      expect(row!.n).toBe(0);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

// ---------------------------------------------------------------------------

describe('A MIXED-PERMISSION SELECTION', () => {
  /**
   * The scoped tier2 above may write Acme and may not write Globex. A selection
   * naming both is the exact case a bulk action must not quietly half-apply.
   */
  it('is refused outright, and changes NOTHING — not even the reachable half', async () => {
    asUser(SCOPED_ID, 'scoped@northwind.test');
    const response = await bulkTags(
      post('/api/bulk/tags', {
        target: 'client',
        ids: [IDS.orgAcme, IDS.orgGlobex],
        tags: ['mine'],
      }),
    );

    expect(response.status).toBe(403);
    // The reachable half is the assertion that matters. A partial apply would
    // have tagged Acme and reported an error, leaving the person unsure which
    // of the two took effect.
    expect(await tagsOf('organization', IDS.orgAcme)).toEqual([]);
    expect(await tagsOf('organization', IDS.orgGlobex)).toEqual([]);
  });

  it('says how many were refused, without saying which exist', async () => {
    asUser(SCOPED_ID, 'scoped@northwind.test');
    const response = await bulkTags(
      post('/api/bulk/tags', {
        target: 'client',
        ids: [IDS.orgAcme, IDS.orgGlobex],
        tags: ['mine'],
      }),
    );

    const message = String((((await body(response)).error as Record<string, unknown>).message));
    expect(message).toContain('1 of 2');
    expect(message).toContain('Nothing was changed');
    // "not yours to tag" covers both "not permitted" and "no such client".
    // Distinguishing them would make the endpoint an enumeration oracle for
    // clients in other parts of the tenant.
    expect(message).not.toMatch(/does not exist|no such/i);
  });

  it('succeeds when the selection is narrowed to what they can reach', async () => {
    asUser(SCOPED_ID, 'scoped@northwind.test');
    const response = await bulkTags(
      post('/api/bulk/tags', { target: 'client', ids: [IDS.orgAcme], tags: ['mine'] }),
    );

    expect(response.status).toBe(200);
    expect(await tagsOf('organization', IDS.orgAcme)).toEqual(['mine']);
  });

  it('refuses a selection containing an id from ANOTHER TENANT', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await bulkArchive(
      post('/api/bulk/archive', {
        target: 'client',
        ids: [IDS.orgAcme, IDS.orgContoso],
        archived: true,
      }),
    );

    expect(response.status).toBe(403);
    expect(await archivedAt('organization', IDS.orgAcme)).toBeNull();
    expect(await archivedAt('organization', IDS.orgContoso)).toBeNull();
  });

  it('refuses a bulk EXPORT of a mixed selection before queueing anything', async () => {
    asUser(SCOPED_ID, 'scoped@northwind.test');
    const response = await bulkExport(
      post('/api/bulk/export', {
        target: 'client',
        ids: [IDS.orgAcme, IDS.orgGlobex],
        reason: 'Ticket 4821 — quarterly documentation handover',
      }),
    );

    expect(response.status).toBe(403);

    const sql = superuserSql();
    try {
      const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM export_job`;
      // Not "one job for Acme". Resolution happens before anything is queued,
      // and the jobs share the route's transaction, so a refusal leaves none.
      expect(row!.n).toBe(0);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('refuses ASSETS the actor cannot reach, the same way', async () => {
    asUser(SCOPED_ID, 'scoped@northwind.test');
    const response = await bulkArchive(
      post('/api/bulk/archive', {
        target: 'node',
        // An Acme asset and a Globex one.
        ids: [IDS.firewall, IDS.globexServer],
        archived: true,
      }),
    );

    expect(response.status).toBe(403);
    expect(await archivedAt('asset_node', IDS.firewall)).toBeNull();
    expect(await archivedAt('asset_node', IDS.globexServer)).toBeNull();
  });
});

describe('a permission the actor simply does not hold', () => {
  /**
   * tier1 holds asset:write and NOT organization:write. Their reach over
   * clients is read-only, so a bulk archive of clients must fail entirely —
   * even though every client named is inside their organisation scope.
   *
   * This is the case an application-side permission check gets wrong most
   * easily: the endpoint declares asset:write, the actor holds it, and the
   * loop proceeds. Here the UPDATE meets organization_rls_update, matches
   * nothing, comes up short, and is refused.
   */
  it('cannot bulk archive clients as a tier1 technician', async () => {
    asUser(IDS.tech1, 'tech1@northwind.test');
    const response = await bulkArchive(
      post('/api/bulk/archive', { target: 'client', ids: [IDS.orgAcme], archived: true }),
    );

    expect(response.status).toBe(403);
    expect(await archivedAt('organization', IDS.orgAcme)).toBeNull();
  });

  it('CAN bulk archive assets as a tier1 technician', async () => {
    // The other half of the same claim: the refusal above is about clients, not
    // about tier1. A test that only showed the refusal would be satisfied by an
    // endpoint that refused everything.
    asUser(IDS.tech1, 'tech1@northwind.test');
    const response = await bulkArchive(
      post('/api/bulk/archive', { target: 'node', ids: [IDS.firewall], archived: true }),
    );

    expect(response.status).toBe(200);
    expect(await archivedAt('asset_node', IDS.firewall)).not.toBeNull();
  });

  it('refuses a client administrator writing their OWN client', async () => {
    // Not a scope failure: client_admin holds organization:read and not
    // organization:write, so RLS raises on the write rather than hiding the
    // row. Both shapes have to come back as the same refusal, which is what
    // runSelection() in lib/bulk/service.ts is for.
    asUser(IDS.acmeAdmin, 'it@acme.test');
    const response = await bulkTags(
      post('/api/bulk/tags', { target: 'client', ids: [IDS.orgAcme], tags: ['nope'] }),
    );

    expect(response.status).toBe(403);
    const message = String((((await body(response)).error as Record<string, unknown>).message));
    expect(message).toContain('Nothing was changed');
    expect(message).not.toMatch(/row-level security|violates/i);
    expect(await tagsOf('organization', IDS.orgAcme)).toEqual([]);
  });

  it('refuses a read-only client user outright', async () => {
    asUser(IDS.acmeViewer, 'viewer@acme.test');
    const response = await bulkTags(
      post('/api/bulk/tags', { target: 'client', ids: [IDS.orgAcme], tags: ['nope'] }),
    );

    expect(response.status).toBe(403);
    expect(await tagsOf('organization', IDS.orgAcme)).toEqual([]);
  });
});

describe('the shape of a selection', () => {
  it('refuses an empty one', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    expect(
      (await bulkTags(post('/api/bulk/tags', { target: 'client', ids: [], tags: ['x'] }))).status,
    ).toBe(400);
  });

  it('refuses one larger than the cap', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const ids = Array.from({ length: 501 }, () => IDS.orgAcme);
    expect(
      (await bulkTags(post('/api/bulk/tags', { target: 'client', ids, tags: ['x'] }))).status,
    ).toBe(400);
  });

  it('counts a repeated id once rather than refusing the selection', async () => {
    // A checkbox list cannot produce duplicates, but a script can, and
    // "requested 3, affected 1" would otherwise read as a permission failure.
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await bulkTags(
      post('/api/bulk/tags', {
        target: 'client',
        ids: [IDS.orgAcme, IDS.orgAcme, IDS.orgAcme],
        tags: ['once'],
      }),
    );

    expect(response.status).toBe(200);
    expect((await body(response)).affected).toBe(1);
  });

  it('refuses an unknown target rather than guessing a table', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    expect(
      (await bulkTags(post('/api/bulk/tags', { target: 'secret', ids: [IDS.orgAcme], tags: ['x'] })))
        .status,
    ).toBe(400);
  });
});

describe('the audit trail', () => {
  it('records one event for the whole selection, not one per item', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    await bulkTags(
      post('/api/bulk/tags', {
        target: 'client',
        ids: [IDS.orgAcme, IDS.orgGlobex],
        tags: ['audited'],
      }),
    );

    const sql = superuserSql();
    try {
      const rows = await sql<{ action: string; metadata: Record<string, unknown> }[]>`
        SELECT action, metadata FROM audit_log WHERE action LIKE 'bulk.%'
        ORDER BY occurred_at DESC LIMIT 20
      `;
      // Scoped to THIS selection's tag. The audit log is append-only and
      // hash-chained, so it carries every earlier test's events too.
      const tagEvents = rows.filter(
        (r) => r.action === 'bulk.tag_add' && JSON.stringify(r.metadata.tags).includes('audited'),
      );
      // "Somebody tagged two clients" is the fact worth reading back. Two
      // identical rows is the same fact spread thin enough to scroll past.
      expect(tagEvents).toHaveLength(1);
      expect(tagEvents[0]!.metadata.count).toBe(2);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('records NOTHING when the action was refused', async () => {
    asUser(SCOPED_ID, 'scoped@northwind.test');
    await bulkTags(
      post('/api/bulk/tags', {
        target: 'client',
        ids: [IDS.orgAcme, IDS.orgGlobex],
        tags: ['never-applied'],
      }),
    );

    const sql = superuserSql();
    try {
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM audit_log
        WHERE action = 'bulk.tag_add' AND metadata->>'tags' LIKE '%never-applied%'
      `;
      // The audit write shares the transaction, so a refusal rolls it back with
      // everything else. An audit row claiming a tag that was never applied is
      // worse than no row.
      expect(row!.n).toBe(0);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

describe('contacts', () => {
  const contacts: Record<'acme1' | 'acme2' | 'globex', string> = { acme1: '', acme2: '', globex: '' };
  const contactArchivedAt = async (id: string) => {
    const sql = superuserSql();
    try {
      const [row] = await sql<{ archived_at: Date | null }[]>`SELECT archived_at FROM contact WHERE id = ${id}::uuid`;
      return row?.archived_at ?? null;
    } finally {
      await sql.end({ timeout: 5 });
    }
  };

  beforeAll(async () => {
    const sql = superuserSql();
    try {
      for (const [key, org, last] of [
        ['acme1', IDS.orgAcme, 'One'], ['acme2', IDS.orgAcme, 'Two'], ['globex', IDS.orgGlobex, 'Three'],
      ] as const) {
        const [row] = await sql<{ id: string }[]>`
          INSERT INTO contact (tenant_id, organization_id, first_name, last_name)
          VALUES (${IDS.tenant1}::uuid, ${org}::uuid, 'Bulk', ${last}) RETURNING id`;
        contacts[key] = row!.id;
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('archives a selection of contacts, and restores it', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const ids = [contacts.acme1, contacts.acme2];
    const archived = await bulkArchive(post('/api/bulk/archive', { target: 'contact', ids, archived: true }));
    expect(archived.status).toBe(200);
    expect((await body(archived)).affected).toBe(2);
    expect(await contactArchivedAt(contacts.acme1)).not.toBeNull();
    expect(await contactArchivedAt(contacts.acme2)).not.toBeNull();

    const restored = await bulkArchive(post('/api/bulk/archive', { target: 'contact', ids, archived: false }));
    expect(restored.status).toBe(200);
    expect(await contactArchivedAt(contacts.acme1)).toBeNull();
  });

  it('refuses a selection reaching a contact the actor cannot see, and changes nothing', async () => {
    asUser(SCOPED_ID, 'scoped@northwind.test');
    const response = await bulkArchive(post('/api/bulk/archive', {
      target: 'contact', ids: [contacts.acme1, contacts.globex], archived: true,
    }));
    expect(response.status).toBe(403);
    expect(await contactArchivedAt(contacts.acme1)).toBeNull();
    expect(await contactArchivedAt(contacts.globex)).toBeNull();
  });

  it('tags a selection of contacts, lowercased, and takes a tag off again', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const tagged = await bulkTags(post('/api/bulk/tags', { target: 'contact', ids: [contacts.acme1, contacts.acme2], tags: ['VIP'] }));
    expect(tagged.status).toBe(200);
    const sql = superuserSql();
    try {
      const rows = await sql<{ tags: string[] }[]>`SELECT tags FROM contact WHERE id = ANY(${[contacts.acme1, contacts.acme2]}::uuid[])`;
      expect(rows.map((r) => r.tags)).toEqual([['vip'], ['vip']]);
      await bulkTags(post('/api/bulk/tags', { target: 'contact', ids: [contacts.acme1], tags: ['vip'], mode: 'remove' }));
      const [one] = await sql<{ tags: string[] }[]>`SELECT tags FROM contact WHERE id = ${contacts.acme1}::uuid`;
      expect(one!.tags).toEqual([]);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('exports a selection of contacts as one contacts-only bundle per client', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await bulkExport(post('/api/bulk/export', {
      target: 'contact', ids: [contacts.acme1, contacts.acme2, contacts.globex],
      reason: 'Contact list for the new account manager',
    }));
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await body(response)).clients).toBe(2);
    const sql = superuserSql();
    try {
      const jobs = await sql<{ scope: { contactIds?: string[] }; include_secrets: boolean }[]>`
        SELECT scope, include_secrets FROM export_job ORDER BY created_at`;
      expect(jobs.every((j) => !j.include_secrets)).toBe(true);
      expect(jobs.map((j) => [...(j.scope.contactIds ?? [])].sort()).sort()).toEqual(
        [[contacts.acme1, contacts.acme2].sort(), [contacts.globex]].sort(),
      );
    } finally {
      await sql.end({ timeout: 5 });
    }

    // What such a bundle collects: those contacts, and none of the estate.
    const collected = await withTenant(actor(IDS.tenant1, IDS.admin1), (tx) =>
      collectExport(tx, IDS.orgAcme, { contactIds: [contacts.acme1] }));
    expect(collected.contacts.map((c) => c.id)).toEqual([contacts.acme1]);
    expect(collected.assets).toEqual([]);
    expect(collected.credentials).toEqual([]);
  });

  it('copies a selection of contacts with every email and number, never as the primary', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const sql = superuserSql();
    try {
      await sql`UPDATE contact SET is_primary = true, is_technical = true, tags = '{vip}' WHERE id = ${contacts.acme1}::uuid`;
      await sql`INSERT INTO contact_email (tenant_id, contact_id, address, label, is_primary)
                VALUES (${IDS.tenant1}::uuid, ${contacts.acme1}::uuid, 'one@acme.test', 'work', true),
                       (${IDS.tenant1}::uuid, ${contacts.acme1}::uuid, 'one@home.test', 'personal', false)`;
      await sql`INSERT INTO contact_phone (tenant_id, contact_id, number, label, is_primary)
                VALUES (${IDS.tenant1}::uuid, ${contacts.acme1}::uuid, '555-0101', 'mobile', true)`;

      const response = await bulkCopy(post('/api/bulk/copy', { target: 'contact', ids: [contacts.acme1, contacts.acme2] }));
      expect(response.status, await response.clone().text()).toBe(200);
      const { copies } = (await body(response)) as { copies: { id: string; sourceId: string; name: string }[] };
      expect(copies).toHaveLength(2);
      const copy = copies.find((c) => c.sourceId === contacts.acme1)!;
      expect(copy.name).toBe('Bulk One (copy)');

      const [row] = await sql<{ is_primary: boolean; is_technical: boolean; tags: string[]; email: string; mobile: string }[]>`
        SELECT is_primary, is_technical, tags, email::text, mobile FROM contact WHERE id = ${copy.id}::uuid`;
      expect(row).toMatchObject({ is_primary: false, is_technical: true, tags: ['vip'], email: 'one@acme.test', mobile: '555-0101' });
      const emails = await sql<{ address: string }[]>`
        SELECT address::text FROM contact_email WHERE contact_id = ${copy.id}::uuid ORDER BY address`;
      expect(emails.map((e) => e.address)).toEqual(['one@acme.test', 'one@home.test']);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('refuses to copy a selection reaching a contact the actor cannot see, and copies nothing', async () => {
    asUser(SCOPED_ID, 'scoped@northwind.test');
    const sql = superuserSql();
    try {
      const [before] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM contact`;
      const response = await bulkCopy(post('/api/bulk/copy', { target: 'contact', ids: [contacts.acme2, contacts.globex] }));
      expect([403, 404]).toContain(response.status);
      const [after] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM contact`;
      expect(after!.n).toBe(before!.n);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
