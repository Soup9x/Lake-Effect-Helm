/**
 * The client page's five widgets, against a real database.
 *
 * WHAT IS WORTH TESTING HERE, and what is not. None of these widgets decides
 * who may see anything — every read is under an RLS policy that was already
 * written and already tested. Re-asserting "a rival tenant sees nothing" for
 * the fifth time would test postgres, not this group.
 *
 * What IS new, and what each test below is for:
 *
 *   1. the two derived widgets agree with the list beside them. Both are
 *      computed in the page from the credentials it already fetched, so the
 *      failure mode is a mismatch nobody notices until a client asks why the
 *      card says four and the table shows five.
 *   2. "most used" sorts numerically. access_count is a bigint, which arrives
 *      from postgres.js as a STRING; a default sort puts nine reads above ten.
 *   3. "most used" is derived from the audited path. The brief required it, and
 *      the check is that access_count equals the number of secret.revealed
 *      rows — not that some counter moved.
 *   4. the activity widget tells the truth about an empty list. An actor
 *      without audit:read gets zero rows from a query that SUCCEEDED, which is
 *      indistinguishable from a quiet client unless the page says which it is.
 *   5. the one RLS question the new queries DO raise. "Recently updated" reads
 *      `attachment` directly rather than through the documents card's folder
 *      tree, so a document inside an internal-only FOLDER is the case this
 *      could plausibly have got wrong — and an internal row's filename is
 *      most of what the flag hides. It is covered because 0560's trigger
 *      copies the flag down onto the attachment row, which is asserted rather
 *      than assumed.
 *
 * The bucket catalogue and the threshold are pure functions and live in
 * tests/unit/strength.test.ts, beside the one threshold they share — they need
 * no database and should not wait on one to fail.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withTenant } from '../../src/lib/db/client';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { listClientActivity, listRecentlyUpdated } from '../../src/lib/clients/activity';
import { listRecentInOrganization, recordView } from '../../src/lib/workspace/queries';
import { STRENGTH_BUCKETS } from '../../src/lib/ui/strength';
import { categoryBySource } from '../../src/lib/nav/org-categories';
import {
  actor, buildHarness, connectPools, disconnectPools, IDS, resetDatabase, superuserSql,
  type Harness,
} from './harness';

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

let h: Harness;
const admin = actor(IDS.tenant1, IDS.admin1);
const viewer = actor(IDS.tenant1, IDS.acmeViewer);

const USERS = {
  admin: { id: IDS.admin1, email: 'admin@northwind.test', name: 'Northwind Admin' },
  viewer: { id: IDS.acmeViewer, email: 'viewer@acme.test', name: 'Acme Viewer' },
  /*
   * client_admin, and it is here for one specific reason. It is the only
   * fixture actor that holds `secret:read` WITHOUT `secret:reveal`, so it is
   * the only one that can tell those two permissions apart. A sabotage run
   * gating the read counts on `secret:read` passed every test, because
   * client_read_only lacks both — the gate looked right and was checked
   * against an actor that could not see the difference.
   */
  clientAdmin: { id: IDS.acmeAdmin, email: 'it@acme.test', name: 'Acme IT Manager' },
} as const satisfies Record<string, SessionUser>;

/** Whose session the page render sees. Swapped per test, not per file. */
let currentUser: SessionUser = USERS.admin;

/** The three credentials this file builds, by label. */
const SECRETS: Record<string, { secretId: string; nodeId: string }> = {};

/** A credential: a secret, a node and the row that ties them together. */
async function makeCredential(label: string, value: string): Promise<void> {
  const created = await h.secrets.create(
    admin,
    { organizationId: IDS.orgAcme, kind: 'password', label },
    value,
  );
  const nodeId = await withTenant(admin, async (tx) => {
    const [node] = await tx<{ id: string }[]>`
      INSERT INTO asset_node (
        tenant_id, organization_id, node_type, name, criticality, created_by, updated_by
      ) VALUES (
        ${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, 'credential', ${label}, 3,
        ${IDS.admin1}::uuid, ${IDS.admin1}::uuid
      ) RETURNING id
    `;
    await tx`
      INSERT INTO credential (id, tenant_id, node_type, credential_type, secret_id)
      VALUES (${node!.id}::uuid, ${IDS.tenant1}::uuid, 'credential', 'local_admin',
              ${created.secretId}::uuid)
    `;
    return node!.id;
  });
  SECRETS[label] = { secretId: created.secretId, nodeId };
}

/**
 * A documented account with no stored material: a username, a URL, nothing to
 * reveal. Real, and neither weak nor unscored — it belongs in the card's
 * footnote. It exists in the fixture rather than inside one test because
 * without it the accounting assertion has nothing to account for: every count
 * is equal to every other count and a dropped filter balances anyway.
 */
async function makeCredentialWithoutSecret(label: string): Promise<string> {
  return withTenant(admin, async (tx) => {
    const [node] = await tx<{ id: string }[]>`
      INSERT INTO asset_node (
        tenant_id, organization_id, node_type, name, criticality, created_by, updated_by
      ) VALUES (
        ${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, 'credential', ${label}, 3,
        ${IDS.admin1}::uuid, ${IDS.admin1}::uuid
      ) RETURNING id
    `;
    await tx`
      INSERT INTO credential (id, tenant_id, node_type, credential_type, secret_id)
      VALUES (${node!.id}::uuid, ${IDS.tenant1}::uuid, 'credential', 'other', NULL)
    `;
    return node!.id;
  });
}

async function reveal(secretId: string, times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    const revealed = await h.secrets.reveal(admin, secretId, { purpose: 'view' });
    revealed.value.dispose();
  }
}

/** The client page, rendered as `currentUser`. */
async function renderClientPage(organizationId = IDS.orgAcme): Promise<unknown> {
  return (
    await import('../../src/app/(app)/organizations/[organizationId]/page')
  ).default({ params: Promise.resolve({ organizationId }) });
}

/**
 * Every object key anywhere in a rendered tree.
 *
 * JSON.stringify cannot do this: an element tree holds module objects that
 * close cycles, and it throws on the first one. The WeakSet is what makes the
 * walk terminate, and it has to be a walk rather than a text search because
 * the thing being proven absent is a key, not a word in some prose.
 */
function keysIn(node: unknown, seen = new WeakSet<object>()): Set<string> {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      found.add(key);
      walk(child);
    }
  };
  walk(node);
  return found;
}

/** The props a named component was handed, found anywhere in the tree. */
function propsOf(node: unknown, componentName: string): Record<string, unknown> | null {
  if (node === null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = propsOf(child, componentName);
      if (found) return found;
    }
    return null;
  }
  const element = node as { type?: unknown; props?: Record<string, unknown> };
  if (typeof element.type === 'function' && element.type.name === componentName) {
    return element.props ?? {};
  }
  return element.props ? propsOf(element.props.children, componentName) : null;
}

beforeAll(async () => {
  resetDatabase();
  connectPools();
  h = buildHarness();
  useSessionResolver(async () => currentUser);
  await h.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'initial provisioning' });

  // Three bands by construction, from scoreStrength()'s own arithmetic:
  //   'abcdefgh'           26^8  = 37 bits, less 12 for 'abc'  = 25 -> band 0
  //   'password1234'       62^12 = 71 bits, less 12 for '123'  = 59 -> band 2
  //   '7Kq!zR2m#Vb9wLx4'   95^16 = 105 bits, no penalties            -> band 4
  await makeCredential('Weak by construction', 'abcdefgh');
  await makeCredential('Fair by construction', 'password1234');
  await makeCredential('Strong by construction', '7Kq!zR2m#Vb9wLx4');
  await makeCredentialWithoutSecret('No secret stored');

  // Deliberately lopsided so a lexical sort gives a different answer from a
  // numeric one: '2' sorts after '10', so a broken sort puts Fair on top.
  await reveal(SECRETS['Fair by construction']!.secretId, 2);
  await reveal(SECRETS['Strong by construction']!.secretId, 10);
}, 180_000);

afterAll(async () => {
  currentUser = USERS.admin;
  await disconnectPools();
});

describe('the strength card and the list below it', () => {
  it('counts the three bands the fixtures built', async () => {
    const card = propsOf(await renderClientPage(), 'CredentialStrengthWidget');
    expect(card, 'the client page should render a CredentialStrengthWidget').toBeTruthy();

    const counts = card!.counts as Record<string, number>;
    expect(counts.weak).toBe(1);
    expect(counts.fair).toBe(1);
    expect(counts.strong).toBe(1);
    expect(counts.unscored).toBe(0);
  });

  it('totals exactly the credentials the Credentials section lists', async () => {
    const rendered = await renderClientPage();
    const card = propsOf(rendered, 'CredentialStrengthWidget')!;
    const counts = card.counts as Record<string, number>;
    const total = STRENGTH_BUCKETS.reduce((sum, key) => sum + counts[key]!, 0);

    /*
     * Both halves, counted independently in the database.
     *
     * The first draft asserted only `total + withoutSecret === all`, which is
     * self-consistent: dropping the secret_id filter makes the bands absorb the
     * footnote's rows and the sum still balances. A sabotage run proved it, so
     * each side is now pinned to its own count.
     */
    const [counted] = await withTenant(admin, (tx) => tx<{ all: number; stored: number }[]>`
      SELECT count(*)::int AS all,
             count(c.secret_id)::int AS stored
      FROM credential c JOIN asset_node n ON n.id = c.id
      WHERE n.organization_id = ${IDS.orgAcme}::uuid AND n.archived_at IS NULL
    `);
    expect(total, 'the bands must count credentials that have a stored secret')
      .toBe(counted!.stored);
    expect(card.withoutSecret, 'the footnote must count the rest')
      .toBe(counted!.all - counted!.stored);
  });

  it('puts a credential with no stored secret in the footnote, not in a band', async () => {
    const card = propsOf(await renderClientPage(), 'CredentialStrengthWidget')!;
    expect(card.withoutSecret).toBe(1);
    // It must NOT land in `unscored`, which is where it goes if the page stops
    // filtering on secret_id: its strength_score is NULL because there is no
    // secret to score, not because scoring was skipped.
    const counts = card.counts as Record<string, number>;
    expect(counts.unscored).toBe(0);
    expect(STRENGTH_BUCKETS.reduce((sum, key) => sum + counts[key]!, 0)).toBe(3);
  });

  it('calls a NULL score unscored rather than weak', async () => {
    const sql = superuserSql();
    const secretId = SECRETS['Fair by construction']!.secretId;
    try {
      await sql`
        UPDATE secret SET current_strength_score = NULL WHERE id = ${secretId}::uuid
      `;
      const card = propsOf(await renderClientPage(), 'CredentialStrengthWidget')!;
      const counts = card.counts as Record<string, number>;
      expect(counts.unscored).toBe(1);
      expect(counts.fair).toBe(0);
      // The point of the separate bucket: key material the scorer cannot rate
      // must not be badged as a weak password.
      expect(counts.weak).toBe(1);
    } finally {
      await sql`
        UPDATE secret SET current_strength_score = 2 WHERE id = ${secretId}::uuid
      `;
      await sql.end();
    }
  });
});

describe('most used credentials', () => {
  it('ranks ten reads above two, which a string sort does not', async () => {
    const card = propsOf(await renderClientPage(), 'PopularCredentialsWidget');
    expect(card, 'the client page should render a PopularCredentialsWidget').toBeTruthy();

    const rows = card!.credentials as { name: string; accessCount: number }[];
    expect(rows.map((r) => r.name)).toEqual([
      'Strong by construction',
      'Fair by construction',
    ]);
    expect(rows[0]!.accessCount).toBe(10);
    expect(rows[1]!.accessCount).toBe(2);
    // A number, not the string postgres.js hands back for a bigint. If this is
    // a string the sort above passed by luck of the digits.
    expect(typeof rows[0]!.accessCount).toBe('number');
  });

  it('ships no read count at all to an actor without secret:reveal', async () => {
    /*
     * ASSERTED ON THE PAYLOAD, not on what is drawn. This is a server
     * component, so anything it hands a child is serialised and travels to the
     * browser whether or not a card renders it — building the list and then
     * hiding it would deliver every count to exactly the actor it was being
     * withheld from. So the assertion is that the array is EMPTY, and the
     * search below is the stronger version of the same claim: the specific
     * number ten must not appear anywhere in the tree this page returns.
     *
     * client_read_only is the actor because RLS does NOT withhold these
     * columns from it — secret_rls_select consults org scope and
     * helm.secret_node_visible(), not secret:read — so this gate is the only
     * thing standing between it and the counts.
     */
    currentUser = USERS.viewer;
    try {
      const rendered = await renderClientPage();
      const card = propsOf(rendered, 'PopularCredentialsWidget');
      expect(card, 'the card should still render, saying which kind of empty').toBeTruthy();
      expect(card!.canSeeAccessCounts).toBe(false);
      expect(card!.credentials).toEqual([]);

      // 'Strong by construction' was revealed ten times. Neither key may be
      // anywhere in the tree this page returns — not merely absent from the
      // card that would have drawn it.
      expect(keysIn(rendered)).not.toContain('accessCount');
      expect(keysIn(rendered)).not.toContain('lastAccessedAt');
    } finally {
      currentUser = USERS.admin;
    }
  });

  it('withholds them from client_admin, which may read but not reveal', async () => {
    // The role the gate is actually about: a co-managed customer's own
    // administrator. It holds secret:read and audit:read and NOT
    // secret:reveal, so it can see that a credential exists, can read its own
    // organisation's audit trail, and cannot learn how many times the MSP
    // revealed the domain admin password.
    currentUser = USERS.clientAdmin;
    try {
      const rendered = await renderClientPage();
      const card = propsOf(rendered, 'PopularCredentialsWidget');
      expect(card!.canSeeAccessCounts).toBe(false);
      expect(card!.credentials).toEqual([]);
      expect(keysIn(rendered)).not.toContain('accessCount');

      // And the audit card IS available to it, so this is a gate on the counts
      // rather than on the role seeing anything at all.
      const activity = propsOf(rendered, 'ActivityFeedWidget');
      expect(activity!.canReadAudit).toBe(true);
    } finally {
      currentUser = USERS.admin;
    }
  });

  it('...and still shows them to a role that can reveal', async () => {
    // The other half, so the test above cannot pass because the page broke.
    // super_admin holds secret:reveal.
    const card = propsOf(await renderClientPage(), 'PopularCredentialsWidget')!;
    expect(card.canSeeAccessCounts).toBe(true);
    expect((card.credentials as unknown[]).length).toBeGreaterThan(0);
  });

  it('omits credentials nobody has read', async () => {
    const card = propsOf(await renderClientPage(), 'PopularCredentialsWidget')!;
    const names = (card.credentials as { name: string }[]).map((r) => r.name);
    expect(names).not.toContain('Weak by construction');
  });

  it('counts exactly the audited reveals, not a separate tally', async () => {
    // The brief's constraint, made checkable: access_count is incremented
    // inside helm.reveal_secret() right after it writes secret.revealed, so the
    // two must agree. If anything ever bumps the counter without auditing — or
    // audits without counting — this is where it shows up.
    const sql = superuserSql();
    try {
      const rows = await sql<{ label: string; access_count: string; audited: string }[]>`
        SELECT s.label, s.access_count,
               (SELECT count(*) FROM audit_log a
                 WHERE a.action = 'secret.revealed' AND a.entity_id = s.id
                   AND a.outcome = 'success') AS audited
        FROM secret s
        WHERE s.organization_id = ${IDS.orgAcme}::uuid AND s.access_count > 0
      `;
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.access_count, `${row.label} counted a read it did not audit`)
          .toBe(row.audited);
      }
    } finally {
      await sql.end();
    }
  });
});

describe('recently updated', () => {
  it('surfaces the most recent edit first, with who made it', async () => {
    await withTenant(admin, (tx) => tx`
      UPDATE asset_node SET name = 'acme-fw-01 (renamed)', updated_by = ${IDS.admin1}::uuid
      WHERE id = ${IDS.firewall}::uuid
    `);

    const items = await withTenant(admin, (tx) => listRecentlyUpdated(tx, IDS.orgAcme));
    expect(items[0]?.name).toBe('acme-fw-01 (renamed)');
    expect(items[0]?.source).toBe('device');
    expect(items[0]?.by).toBe('Northwind Admin');
  });

  it('reads sites, contacts and documents as well as assets', async () => {
    const sql = superuserSql();
    try {
      await sql`
        INSERT INTO site (id, tenant_id, organization_id, name, updated_by)
        VALUES (gen_random_uuid(), ${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid,
                'Buffalo HQ', ${IDS.admin1}::uuid)
      `;
      await sql`
        INSERT INTO contact (id, tenant_id, organization_id, first_name, last_name, updated_by)
        VALUES (gen_random_uuid(), ${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid,
                'Dana', 'Whitfield', ${IDS.admin1}::uuid)
      `;

      const items = await withTenant(admin, (tx) => listRecentlyUpdated(tx, IDS.orgAcme, 50));
      const sources = new Set(items.map((i) => i.source));
      expect(sources.has('site')).toBe(true);
      expect(sources.has('contact')).toBe(true);
      // concat_ws, not ||: a NULL last_name must not blank the whole name.
      expect(items.find((i) => i.source === 'contact')?.name).toBe('Dana Whitfield');
    } finally {
      await sql.end();
    }
  });

  it('would still name a contact if last_name ever became nullable', async () => {
    // It is NOT NULL today — this test was written expecting otherwise and the
    // database said so. It stays, inverted: concat_ws() is in the query because
    // `first_name || ' ' || last_name` returns NULL for a missing surname, and
    // if this constraint is ever relaxed the widget must not start rendering
    // blank lines. The guard is cheap; knowing which way round it is, is not.
    const [row] = await withTenant(admin, (tx) => tx<{ notnull: boolean }[]>`
      SELECT attnotnull AS notnull FROM pg_attribute
      WHERE attrelid = 'public.contact'::regclass AND attname = 'last_name'
    `);
    expect(row!.notnull).toBe(true);
    // And the query is written so the answer above does not matter.
    const [built] = await withTenant(admin, (tx) => tx<{ name: string }[]>`
      SELECT concat_ws(' ', 'Prince'::text, NULL::text) AS name
    `);
    expect(built!.name).toBe('Prince');
  });

  it('is scoped to the one client', async () => {
    const items = await withTenant(admin, (tx) => listRecentlyUpdated(tx, IDS.orgAcme, 100));
    const sql = superuserSql();
    try {
      const names = new Set(items.map((i) => i.name));
      const others = await sql<{ name: string }[]>`
        SELECT name FROM asset_node WHERE organization_id = ${IDS.orgGlobex}::uuid
      `;
      expect(others.length).toBeGreaterThan(0);
      for (const other of others) expect(names.has(other.name)).toBe(false);
    } finally {
      await sql.end();
    }
  });

  it('leaves out the organisation row itself', async () => {
    // Deliberate: "this client was updated" on the client's own page is not
    // news, and quick-notes edits would otherwise crowd out the estate.
    const items = await withTenant(admin, (tx) => listRecentlyUpdated(tx, IDS.orgAcme, 100));
    expect(items.map((i) => i.source)).not.toContain('organization');
  });

  it('leaves out archived assets', async () => {
    const sql = superuserSql();
    try {
      await sql`
        UPDATE asset_node SET archived_at = now() WHERE id = ${IDS.crmApp}::uuid
      `;
      const items = await withTenant(admin, (tx) => listRecentlyUpdated(tx, IDS.orgAcme, 100));
      expect(items.map((i) => i.id)).not.toContain(IDS.crmApp);
    } finally {
      await sql`UPDATE asset_node SET archived_at = NULL WHERE id = ${IDS.crmApp}::uuid`;
      await sql.end();
    }
  });

  it('hides an internal-only asset from a co-managed client actor', async () => {
    /*
     * The widget adds a new path onto asset_node and attachment, and an
     * internal-only row's NAME is most of what the flag hides — 0390 exists
     * because v_expiration_dashboard was leaking hostnames the same way. RLS
     * is what stops it (asset_node_rls_select consults is_internal_only
     * directly), so this asserts the new query inherits that rather than
     * needing its own filter.
     */
    const sql = superuserSql();
    try {
      await sql`
        UPDATE asset_node SET is_internal_only = true, name = 'internal-escalation-notes'
        WHERE id = ${IDS.domainController}::uuid
      `;
      const mine = await withTenant(viewer, (tx) => listRecentlyUpdated(tx, IDS.orgAcme, 100));
      expect(mine.map((i) => i.name)).not.toContain('internal-escalation-notes');
      expect(mine.map((i) => i.id)).not.toContain(IDS.domainController);

      // ...and a tenant-wide actor still sees it, or the test above would pass
      // for an unrelated reason (an empty list, a broken query).
      const theirs = await withTenant(admin, (tx) => listRecentlyUpdated(tx, IDS.orgAcme, 100));
      expect(theirs.map((i) => i.name)).toContain('internal-escalation-notes');
    } finally {
      await sql`
        UPDATE asset_node SET is_internal_only = false, name = 'ACME-DC01'
        WHERE id = ${IDS.domainController}::uuid
      `;
      await sql.end();
    }
  });

  it('hides a document whose FOLDER is internal-only', async () => {
    /*
     * The case that is not obvious, and the one this query could plausibly have
     * got wrong. It reads `attachment` directly rather than going through the
     * documents card's folder tree, so if the flag lived only on the folder, a
     * co-managed client actor would see the filename of a document sitting
     * inside the MSP's internal subtree.
     *
     * It does not, and this is the proof rather than a comment claiming so:
     * 0560's trigger copies is_internal_only DOWN onto the attachment row on
     * insert, so attachment_rls_select — which consults the column on the row
     * — filters it. Written as a test because "the trigger handles it" is the
     * kind of thing that is true until a later migration adds a write path
     * that sets folder_id without firing it.
     */
    const sql = superuserSql();
    try {
      const [folder] = await sql<{ id: string }[]>`
        INSERT INTO document_folder (
          tenant_id, organization_id, name, is_internal_only
        ) VALUES (
          ${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, 'Escalation politics', true
        ) RETURNING id
      `;
      await sql`
        INSERT INTO attachment (
          tenant_id, organization_id, folder_id, is_document, filename,
          content_type, byte_size, storage_key, content_sha256,
          is_internal_only, uploaded_by
        ) VALUES (
          ${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, ${folder!.id}::uuid, true,
          'who-to-never-call.pdf', 'application/pdf', 1024,
          -- A parameter, not a SQL literal. Building 32 zero bytes with
          -- repeat() inside the statement puts an actual NUL in the query
          -- text, and postgres.js answers that with "insufficient data left
          -- in message" rather than anything that points at the cause.
          ${`internal/${folder!.id}`}, ${Buffer.alloc(32)},
          -- Deliberately FALSE. The trigger must be what makes it true; if the
          -- test set it itself the assertion below would prove nothing.
          false, ${IDS.admin1}::uuid
        )
      `;

      const [stored] = await sql<{ is_internal_only: boolean }[]>`
        SELECT is_internal_only FROM attachment WHERE filename = 'who-to-never-call.pdf'
      `;
      expect(stored!.is_internal_only, 'the folder\'s flag should have been inherited')
        .toBe(true);

      const mine = await withTenant(viewer, (tx) => listRecentlyUpdated(tx, IDS.orgAcme, 100));
      expect(mine.map((i) => i.name)).not.toContain('who-to-never-call.pdf');

      const theirs = await withTenant(admin, (tx) => listRecentlyUpdated(tx, IDS.orgAcme, 100));
      expect(theirs.map((i) => i.name)).toContain('who-to-never-call.pdf');
    } finally {
      /*
       * One transaction, with a session context set first. Deleting a
       * document_folder fires 0560's audit trigger, and helm.audit() refuses
       * to write an event with no tenant context — the superuser connection
       * has none until it is given one, and it has to be the SAME connection,
       * hence begin() rather than two statements off the pool.
       */
      await sql.begin(async (tx) => {
        await tx`
          SELECT helm.set_session_context(
            ${IDS.tenant1}::uuid, ${IDS.admin1}::uuid, 'user'::actor_type,
            NULL, NULL::inet, NULL, NULL::uuid)
        `;
        await tx`DELETE FROM attachment WHERE filename = 'who-to-never-call.pdf'`;
        await tx`DELETE FROM document_folder WHERE name = 'Escalation politics'`;
      });
      await sql.end();
    }
  });

  it('returns nothing for a client this actor is not scoped to', async () => {
    // acmeViewer's membership names orgAcme only. No filter in the query says
    // so — helm.org_in_scope() does, on every arm of the UNION.
    const items = await withTenant(viewer, (tx) => listRecentlyUpdated(tx, IDS.orgGlobex, 100));
    expect(items).toEqual([]);
  });

  it('labels every source the widget can be handed', async () => {
    // The widget prefers the sidebar's own wording and falls back to
    // humanise(). This asserts the preferred path actually resolves for what
    // the query emits, so the page does not quietly read "Ssl certificate"
    // beside a sidebar that says "SSL Tracker".
    const items = await withTenant(admin, (tx) => listRecentlyUpdated(tx, IDS.orgAcme, 100));
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      if (item.source === 'flexible_asset') continue; // no single category; documented
      expect(categoryBySource(item.source), `no category for ${item.source}`).toBeTruthy();
    }
  });
});

describe('recently viewed, within one client', () => {
  it('lists an asset the actor opened', async () => {
    await withTenant(admin, async (tx) => {
      await recordView(tx, { nodeId: IDS.firewall });
    });
    const items = await withTenant(admin, (tx) => listRecentInOrganization(tx, IDS.orgAcme));
    expect(items.map((i) => i.id)).toContain(IDS.firewall);
    expect(items[0]?.href).toBe(`/assets/${IDS.firewall}`);
  });

  it('does not lead with the client whose page this is', async () => {
    /*
     * recordView() runs for the organisation at the top of the client page, so
     * a query shaped like listRecent() — which UNIONs a client half with an
     * asset half — would make the first row "the page you are on".
     *
     * What actually excludes it is the INNER JOIN onto asset_node: a
     * user_recent_view row for an organisation has node_id NULL, and NULL
     * matches no id. The `r.node_id IS NOT NULL` beside it is redundant with
     * that join and states the intent; a sabotage run removing it changed
     * nothing, which is how that was established rather than assumed.
     */
    await withTenant(admin, async (tx) => {
      await recordView(tx, { organizationId: IDS.orgAcme });
    });
    const items = await withTenant(admin, (tx) => listRecentInOrganization(tx, IDS.orgAcme));
    expect(items.map((i) => i.id)).not.toContain(IDS.orgAcme);
    expect(items.every((i) => i.kind === 'asset')).toBe(true);
  });

  it('shows one actor nothing of another actor"s history', async () => {
    await withTenant(admin, async (tx) => {
      await recordView(tx, { nodeId: IDS.network });
    });
    const mine = await withTenant(viewer, (tx) => listRecentInOrganization(tx, IDS.orgAcme));
    expect(mine.map((i) => i.id)).not.toContain(IDS.network);
  });

  it('excludes another client"s assets', async () => {
    await withTenant(admin, async (tx) => {
      await recordView(tx, { nodeId: IDS.globexServer });
    });
    const items = await withTenant(admin, (tx) => listRecentInOrganization(tx, IDS.orgAcme, 50));
    expect(items.map((i) => i.id)).not.toContain(IDS.globexServer);
  });
});

describe('the activity feed', () => {
  it('returns this client"s audited events, newest first', async () => {
    const events = await withTenant(admin, (tx) => listClientActivity(tx, IDS.orgAcme));
    expect(events.length).toBeGreaterThan(0);
    expect(events.map((e) => e.action)).toContain('secret.revealed');

    const times = events.map((e) => e.occurredAt.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(events[0]?.actorLabel.length).toBeGreaterThan(0);
  });

  it('carries no other client"s events', async () => {
    const events = await withTenant(admin, (tx) => listClientActivity(tx, IDS.orgGlobex, 50));
    const acme = await withTenant(admin, (tx) => listClientActivity(tx, IDS.orgAcme, 50));
    const globexUids = new Set(events.map((e) => e.eventUid));
    for (const event of acme) expect(globexUids.has(event.eventUid)).toBe(false);
  });

  it('comes back empty for an actor without audit:read', async () => {
    // client_read_only holds organization:read and asset:read and not
    // audit:read, so the policy filters every row and the query still succeeds.
    const events = await withTenant(viewer, (tx) => listClientActivity(tx, IDS.orgAcme, 50));
    expect(events).toEqual([]);
  });

  it('...and the page says so rather than "nothing happened"', async () => {
    // The distinction the brief asked for, asserted on the props the page
    // hands the widget. Without canReadAudit the two cases are one empty array.
    currentUser = USERS.viewer;
    try {
      const card = propsOf(await renderClientPage(), 'ActivityFeedWidget');
      expect(card, 'the client page should render an ActivityFeedWidget').toBeTruthy();
      expect(card!.canReadAudit).toBe(false);
      expect(card!.activity).toEqual([]);
    } finally {
      currentUser = USERS.admin;
    }

    const asAdmin = propsOf(await renderClientPage(), 'ActivityFeedWidget')!;
    expect(asAdmin.canReadAudit).toBe(true);
    expect((asAdmin.activity as unknown[]).length).toBeGreaterThan(0);
  });
});
