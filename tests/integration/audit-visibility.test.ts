/**
 * Who can see a secret's history in the audit log.
 *
 * THE BUG THIS FILE EXISTS FOR. Every helm.audit() call about a secret passes
 * the SECRET's id where helm.audit()'s sixth parameter, p_node_id, belongs:
 *
 *     helm.audit('secret.rotated', 'secret', v_secret.id, 'success',
 *                v_secret.organization_id, v_secret.id, ...)
 *                                          ^^^^^^^^^^^
 *
 * and the audit_log policy asked helm.node_visible(node_id) of it, which is
 * EXISTS (SELECT 1 FROM asset_node WHERE id = node_id AND NOT is_internal_only).
 * No asset_node has a secret's id. So for every reader who is not tenant-wide,
 * that predicate was false for every secret row, always — and a client_admin,
 * which holds audit:read on purpose, saw none of its own organisation's
 * credential history.
 *
 * It failed CLOSED, which is why nothing caught it: it hid rows rather than
 * leaking them. 0610 changes the predicate to ask
 * helm.secret_node_visible(entity_id) for secret.created and secret.rotated —
 * the question a row about a secret can actually answer.
 *
 * WHAT EACH TEST IS FOR:
 *
 *   1. the fix works: a scoped reader sees creations and rotations for its own
 *      organisation. This is the whole point, and it is asserted through the
 *      /audit page's own query shape rather than a hand-written one.
 *   2. it narrows nothing: an internal-only credential's history stays hidden
 *      from that same reader, which is what secret_node_visible buys over
 *      simply dropping the predicate.
 *   3. it does not reverse the preceding decision: secret.revealed is still
 *      hidden. The Most used credentials card was gated on secret:reveal so a
 *      customer would not learn how often their MSP read a credential;
 *      un-hiding reveal events here would hand that back with timestamps.
 *   4. non-secret rows are untouched, so the node_visible branch still does
 *      its job.
 *   5. tenant isolation is intact.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../../src/lib/db/client';
import { listClientActivity } from '../../src/lib/clients/activity';
import {
  actor, buildHarness, connectPools, disconnectPools, IDS, resetDatabase, superuserSql,
  type Harness,
} from './harness';

let h: Harness;
const admin = actor(IDS.tenant1, IDS.admin1);
/** client_admin, scoped to Acme. Holds audit:read; is NOT tenant-wide. */
const clientAdmin = actor(IDS.tenant1, IDS.acmeAdmin);
/** client_read_only, scoped to Acme. Holds no audit:read at all. */
const viewer = actor(IDS.tenant1, IDS.acmeViewer);
const rival = actor(IDS.tenant2, IDS.admin2);

let openSecret = '';
let internalSecret = '';

/** A credential node plus its secret, optionally marked internal-only. */
async function makeCredential(label: string, internal: boolean): Promise<string> {
  const created = await h.secrets.create(
    admin,
    { organizationId: IDS.orgAcme, kind: 'password', label },
    'initial-value-9271',
  );
  await withTenant(admin, async (tx) => {
    const [node] = await tx<{ id: string }[]>`
      INSERT INTO asset_node (
        tenant_id, organization_id, node_type, name, criticality,
        is_internal_only, created_by, updated_by
      ) VALUES (
        ${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, 'credential', ${label}, 3,
        ${internal}, ${IDS.admin1}::uuid, ${IDS.admin1}::uuid
      ) RETURNING id
    `;
    await tx`
      INSERT INTO credential (id, tenant_id, node_type, credential_type, secret_id)
      VALUES (${node!.id}::uuid, ${IDS.tenant1}::uuid, 'credential', 'local_admin',
              ${created.secretId}::uuid)
    `;
  });
  return created.secretId;
}

/** The /audit page's query, as that page writes it. */
async function auditRows(
  who: Parameters<typeof withTenant>[0],
): Promise<{ action: string; entity_id: string | null }[]> {
  return withTenant(who, (tx) => tx<{ action: string; entity_id: string | null }[]>`
    SELECT a.action, a.entity_id::text
    FROM audit_log a
    LEFT JOIN organization o ON o.id = a.organization_id
    ORDER BY a.occurred_at DESC
    LIMIT 200
  `);
}

beforeAll(async () => {
  resetDatabase();
  connectPools();
  h = buildHarness();
  await h.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'initial provisioning' });
  await h.keys.provision(IDS.tenant2, IDS.admin2, { reason: 'initial provisioning' });

  // The credential a co-managed customer is entitled to the history of, and
  // one the MSP has marked internal.
  openSecret = await makeCredential('Acme VPN service account', false);
  internalSecret = await makeCredential('Acme escalation break-glass', true);

  // A creation and a rotation on each, plus a reveal on the open one so test 3
  // has something it must NOT find.
  await h.secrets.rotate(admin, openSecret, 'rotated-value-4471', 'quarterly rotation');
  await h.secrets.rotate(admin, internalSecret, 'rotated-value-8812', 'quarterly rotation');
  const revealed = await h.secrets.reveal(admin, openSecret, { purpose: 'view' });
  revealed.value.dispose();
}, 180_000);

afterAll(async () => {
  await disconnectPools();
});

describe('a scoped reader and its own credential history', () => {
  it('sees secret.created and secret.rotated — the bug this fixes', async () => {
    const rows = await auditRows(clientAdmin);
    const mine = rows.filter((r) => r.entity_id === openSecret);
    expect(mine.map((r) => r.action).sort()).toEqual(['secret.created', 'secret.rotated']);
  });

  it('...and the client page activity card shows them too', async () => {
    // The same policy, reached through the reader the client page uses, so the
    // fix is asserted where a person would actually notice it.
    const events = await withTenant(clientAdmin, (tx) =>
      listClientActivity(tx, IDS.orgAcme, 200));
    const actions = events.map((e) => e.action);
    expect(actions).toContain('secret.created');
    expect(actions).toContain('secret.rotated');
  });

  it('still cannot see an internal-only credential"s history', async () => {
    // What secret_node_visible() buys over dropping the predicate: the MSP's
    // own break-glass account stays invisible, name and existence included.
    const rows = await auditRows(clientAdmin);
    expect(rows.map((r) => r.entity_id)).not.toContain(internalSecret);
  });

  it('still cannot see secret.revealed', async () => {
    /*
     * DELIBERATE, and the reason is one commit upstream. The Most used
     * credentials card was gated on secret:reveal precisely so a customer is
     * not shown how often their MSP read a credential. secret.revealed carries
     * the same broken node_id and the same one-line change would un-hide it,
     * which would hand that information back with an actor and a timestamp
     * attached. 0610's CASE names created and rotated only.
     *
     * If that is ever widened, this test fails by name and whoever widens it
     * has to decide about the card as well.
     */
    const rows = await auditRows(clientAdmin);
    expect(rows.map((r) => r.action)).not.toContain('secret.revealed');

    // And a tenant-wide reader does see it, so the assertion above is about
    // the policy rather than about the event never having been written.
    const theirs = await auditRows(admin);
    expect(theirs.map((r) => r.action)).toContain('secret.revealed');
  });

  it('sees nothing without audit:read, fix or no fix', async () => {
    // client_read_only holds neither audit:read nor anything else that would
    // reach these rows. The fix is inside the scoped branch; the permission
    // check sits in front of it and is unchanged.
    const rows = await auditRows(viewer);
    expect(rows).toEqual([]);
  });
});

describe('what the fix does not touch', () => {
  it('still hides a non-secret row naming an internal-only node', async () => {
    // The ELSE branch, which is the original predicate. If the CASE were
    // written so that everything took the secret path, this is what would
    // break — an asset event would stop consulting node_visible.
    const sql = superuserSql();
    try {
      await sql.begin(async (tx) => {
        await tx`
          SELECT helm.set_session_context(
            ${IDS.tenant1}::uuid, ${IDS.admin1}::uuid, 'user'::actor_type,
            NULL, NULL::inet, NULL, NULL::uuid)
        `;
        await tx`
          UPDATE asset_node SET is_internal_only = true
          WHERE id = ${IDS.domainController}::uuid
        `;
        await tx`
          SELECT helm.audit('asset.touched_for_a_test', 'asset_node',
                            ${IDS.domainController}::uuid, 'success'::audit_outcome,
                            ${IDS.orgAcme}::uuid, ${IDS.domainController}::uuid)
        `;
      });

      const rows = await auditRows(clientAdmin);
      expect(rows.map((r) => r.action)).not.toContain('asset.touched_for_a_test');

      const theirs = await auditRows(admin);
      expect(theirs.map((r) => r.action)).toContain('asset.touched_for_a_test');
    } finally {
      await sql`
        UPDATE asset_node SET is_internal_only = false
        WHERE id = ${IDS.domainController}::uuid
      `;
      await sql.end();
    }
  });

  it('keeps the hash chain intact — nothing was rewritten', async () => {
    /*
     * The reason 0610 changes the POLICY and not the data. node_id is inside
     * helm.audit_canonical_form(), so it is covered by row_hash and by the
     * per-tenant chain. A migration that "fixed" the stored node_id would
     * invalidate every hash after it, which is the one property that makes
     * this table evidence rather than a log.
     */
    /*
     * helm.verify_audit_chain(), not a hash recomputed here. The first draft of
     * this test rolled its own —
     * `digest(helm.audit_canonical_form(a.*), 'sha256')` — and reported all
     * seven of the tenant's rows as broken, because the real link is
     * `digest(prev_hash || canonical_form, 'sha256')` and the draft left out
     * the prev_hash. A test that re-implements the thing it is checking
     * verifies its own copy of the arithmetic; this one asks the function the
     * anchor worker asks before it anchors.
     */
    const [result] = await withTenant(admin, (tx) => tx<{
      verified_rows: string; is_intact: boolean; broken_at_seq: string | null; detail: string | null;
    }[]>`
      SELECT verified_rows, is_intact, broken_at_seq, detail
      FROM helm.verify_audit_chain(${IDS.tenant1}::uuid)
    `);
    expect(result!.is_intact, result!.detail ?? 'chain reported broken').toBe(true);
    expect(result!.broken_at_seq).toBeNull();
    // And it actually walked something, so "intact" is not a verdict on zero
    // rows: this file writes creations, rotations and a reveal in beforeAll.
    expect(Number(result!.verified_rows)).toBeGreaterThan(5);
  });

  it('leaves another tenant"s rows invisible', async () => {
    const rows = await auditRows(rival);
    expect(rows.map((r) => r.entity_id)).not.toContain(openSecret);
  });
});
