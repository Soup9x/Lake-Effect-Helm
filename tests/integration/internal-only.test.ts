/**
 * The two internal-only paths that SQL assertions cannot reach.
 *
 * db/tests/security.sql §32–34 covers every direct query path, but two things
 * need privileges that suite does not have. It runs as helm_app, deliberately,
 * because that is the role the request path uses — and helm_app can neither
 * edit the permission catalogue nor render an export.
 *
 *   1. The reveal ladder. Proving the visibility rung is load-bearing means
 *      granting a client role `secret:reveal`, which the shipped catalogue does
 *      not include. Without that grant the refusal comes back as
 *      `missing_permission` and proves nothing about visibility.
 *
 *   2. The export bundle, which is the most serious path of the set and the one
 *      no policy could close: the worker renders as its own tenant-wide service
 *      account, so it PASSED asset_node's policy and handed the result to
 *      whoever asked. A co-managed client administrator holds export:create.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import { withTenant } from '../../src/lib/db/client';
import { getExportService } from '../../src/lib/exports/service';
import { collectExport } from '../../src/lib/exports/collect';
import { NextRequest } from 'next/server';
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
import { FilesystemExportStorage, setExportStorage } from '../../src/lib/exports/storage';

let h: Harness;
let currentUser: SessionUser | null = null;

/**
 * Created through the real POST /api/secrets rather than inserted by hand, so
 * the rows under test are the two a credential actually is — the encrypted
 * material and the asset node documenting the account it belongs to.
 *
 * The integration fixtures carry no credentials at all, which is why these are
 * built here instead of taken from IDS.
 */
let exportRoot = '';
let credentialNode = '';
let secretWithCredential = '';
let secretWithoutCredential = '';

const asMsp = { tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' as const };
const asClient = { tenantId: IDS.tenant1, actorId: IDS.acmeAdmin, actorType: 'user' as const };

async function su<T>(fn: (sql: ReturnType<typeof superuserSql>) => Promise<T>): Promise<T> {
  const sql = superuserSql();
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const markInternal = (nodeId: string, internal: boolean) =>
  su((sql) => sql`UPDATE asset_node SET is_internal_only = ${internal} WHERE id = ${nodeId}::uuid`);

beforeAll(async () => {
  resetDatabase();
  connectPools();
  h = buildHarness();
  resetServices();
  setKekProvider(h.kek);
  useSessionResolver(async () => currentUser);
  exportRoot = mkdtempSync(join(tmpdir(), 'helm-internal-only-'));
  setExportStorage(new FilesystemExportStorage(exportRoot));
  await h.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'test provisioning' });

  currentUser = { id: IDS.admin1, email: 'admin@northwind.test' };
  const created = (await (
    await postSecret(
      new NextRequest(
        new Request('http://helm.test/api/secrets', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            organizationId: IDS.orgAcme,
            label: 'ACME Domain Admin',
            kind: 'password',
            value: 'a-domain-admin-password',
            credentialType: 'domain_admin',
            username: 'ACME\\Administrator',
          }),
        }),
      ),
    )
  ).json()) as { credentialId: string; secretId: string };
  credentialNode = created.credentialId;
  secretWithCredential = created.secretId;

  // Material with no documented account behind it. The secret service writes
  // the `secret` row; nothing points a credential at it.
  secretWithoutCredential = await withTenant(asMsp, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO secret (tenant_id, organization_id, kind, label, sensitivity, min_role_rank)
      VALUES (${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, 'generic', 'Loose material',
              'standard', 10)
      RETURNING id
    `;
    return row!.id;
  });
}, 120_000);

beforeEach(async () => {
  await su(async (sql) => {
    await sql`UPDATE asset_node SET is_internal_only = false`;
    await sql`DELETE FROM role_permission WHERE role_key = 'client_admin' AND permission_key = 'secret:reveal'`;
    await sql`UPDATE secret SET min_role_rank = 60 WHERE id = ${secretWithCredential}::uuid`;
  });
});

afterAll(async () => {
  setExportStorage(null);
  if (exportRoot) rmSync(exportRoot, { recursive: true, force: true });
  await disconnectPools();
});

// ---------------------------------------------------------------------------

describe('the reveal ladder', () => {
  /**
   * The grant is the whole point. Before it, a co-managed client is refused
   * every secret for reasons that have nothing to do with visibility, so a test
   * without it would pass against the broken code too.
   */
  async function grantReveal(): Promise<void> {
    await su(async (sql) => {
      await sql`
        INSERT INTO role_permission (role_key, permission_key)
        VALUES ('client_admin', 'secret:reveal') ON CONFLICT DO NOTHING
      `;
      // Rank out of the way as well, so `insufficient_role_rank` cannot be the
      // answer either. Both incidental refusals removed, only the flag left.
      await sql`UPDATE secret SET min_role_rank = 10 WHERE id = ${secretWithCredential}::uuid`;
    });
  }

  async function reveal(): Promise<{ granted: boolean; denial_reason: string | null }> {
    return withTenant(asClient, async (tx) => {
      const [row] = await tx<{ granted: boolean; denial_reason: string | null }[]>`
        SELECT granted, denial_reason
        FROM helm.reveal_secret(${secretWithCredential}::uuid,
                                'an explicit reason of sufficient length', 'view')
      `;
      return row!;
    });
  }

  it('REFUSES a credential on an internal asset, naming visibility', async () => {
    await grantReveal();
    await markInternal(credentialNode, true);

    const result = await reveal();
    expect(result.granted).toBe(false);
    expect(result.denial_reason).toBe('internal_only');
  });

  it('grants the same secret to the same actor once the asset is not internal', async () => {
    // The other half. Without it the test above is satisfied by a ladder that
    // refuses everybody.
    await grantReveal();
    await markInternal(credentialNode, false);

    expect((await reveal()).granted).toBe(true);
  });

  it('would have been granted before the fix — the flag, not a coincidence', async () => {
    // Establishes that the refusal above is NOT the shipped catalogue doing the
    // work: with the permission and the rank in place, and only the flag
    // separating the two cases, the answer flips.
    await grantReveal();

    await markInternal(credentialNode, false);
    expect((await reveal()).granted).toBe(true);

    await markInternal(credentialNode, true);
    expect((await reveal()).granted).toBe(false);
  });

  it('leaves a secret with no credential row to the controls that always governed it', async () => {
    await grantReveal();
    await markInternal(credentialNode, true);

    // Material without a documented account: never part of the credential
    // model, and it must not be swept up by a flag nobody set on it.
    const visible = await withTenant(asClient, async (tx) => {
      const [row] = await tx<{ v: boolean }[]>`
        SELECT helm.secret_node_visible(${secretWithoutCredential}::uuid) AS v
      `;
      return row!.v;
    });
    expect(visible).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('the export bundle', () => {
  /**
   * The severe path. The render worker collects as its own tenant-wide service
   * account, so it passes every policy the client would fail — and then hands
   * the file to the client. Fixed by collecting under the REQUESTER's context,
   * which is the only way RLS can answer a question about an audience that is
   * not the reader.
   */
  it('EXCLUDES internal-only assets when a client requested it', async () => {
    await markInternal(IDS.firewall, true);

    const collected = await withTenant(asClient, (tx) =>
      collectExport(tx, IDS.orgAcme, {}),
    );

    expect(collected.assets.map((a) => a.id)).not.toContain(IDS.firewall);
    // Not vacuous: their other assets are still in the bundle.
    expect(collected.assets.length).toBeGreaterThan(0);
  });

  it('INCLUDES them when the MSP requested it — it is the MSP\'s own record', async () => {
    await markInternal(IDS.firewall, true);

    const collected = await withTenant(asMsp, (tx) => collectExport(tx, IDS.orgAcme, {}));
    expect(collected.assets.map((a) => a.id)).toContain(IDS.firewall);
  });

  it('carries the requester through the backlog, which is what makes that possible', async () => {
    // The worker has no user:read and cannot look the requester up. If the id
    // stops travelling with the job, the collection silently falls back to the
    // worker's own context and the leak returns with nothing failing.
    const { exportJobId } = await getExportService().request(asClient, {
      organizationId: IDS.orgAcme,
      kind: 'ad_hoc',
      format: 'zip',
      reason: 'a documentation handover for the client',
      includeSecrets: false,
    });

    const row = await su(async (sql) => {
      const [job] = await sql<{ requested_by: string | null }[]>`
        SELECT requested_by FROM helm.export_backlog(50)
        WHERE export_job_id = ${exportJobId}::uuid
      `;
      return job;
    });

    expect(row?.requested_by).toBe(IDS.acmeAdmin);
  });

  it('excludes an internal asset from a bundle rendered end to end', async () => {
    // Through the real render path rather than by calling the collector, so a
    // future refactor that stops passing `requestedBy` fails here.
    await markInternal(IDS.firewall, true);

    const { exportJobId } = await getExportService().request(asClient, {
      organizationId: IDS.orgAcme,
      kind: 'ad_hoc',
      format: 'zip',
      reason: 'a documentation handover for the client',
      includeSecrets: false,
    });

    const job = await su(async (sql) => {
      const [row] = await sql<
        {
          worker_actor_id: string;
          organization_id: string;
          kind: string;
          format: string;
          include_secrets: boolean;
          scope: Record<string, unknown>;
          reason: string;
          requested_by: string | null;
          requested_by_name: string | null;
          approved_by_name: string | null;
        }[]
      >`SELECT * FROM helm.export_backlog(50) WHERE export_job_id = ${exportJobId}::uuid`;
      return row!;
    });

    await getExportService().render(
      { tenantId: IDS.tenant1, actorId: job.worker_actor_id, actorType: 'service_account' },
      {
        exportJobId,
        organizationId: job.organization_id,
        kind: job.kind,
        format: job.format,
        includeSecrets: job.include_secrets,
        scope: job.scope,
        reason: job.reason,
        requestedBy: job.requested_by,
        requestedByName: job.requested_by_name,
        approvedByName: job.approved_by_name,
      },
    );

    const recorded = await su(async (sql) => {
      const [row] = await sql<{ record_count: number | null; status: string }[]>`
        SELECT record_count, status::text FROM export_job WHERE id = ${exportJobId}::uuid
      `;
      return row!;
    });

    expect(recorded.status).toBe('completed');

    // The count is the observable: the same export with the asset unmarked
    // contains one more record.
    await markInternal(IDS.firewall, false);
    const openCount = await withTenant(asClient, async (tx) => {
      const collected = await collectExport(tx, IDS.orgAcme, {});
      return collected.assets.length;
    });
    await markInternal(IDS.firewall, true);
    const closedCount = await withTenant(asClient, async (tx) => {
      const collected = await collectExport(tx, IDS.orgAcme, {});
      return collected.assets.length;
    });

    expect(closedCount).toBe(openCount - 1);
  });
});
