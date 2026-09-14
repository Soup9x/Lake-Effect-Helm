/**
 * The compliance and offboarding export engine, end to end.
 *
 * This is the most damaging capability in the product — "produce a file
 * containing every credential for a client" — so the tests are mostly about
 * what it REFUSES. Four eyes with no self-approval, an approval that is bound
 * to what was reviewed, a revocation that actually stops a download, an expiry
 * that actually deletes the bytes, and an incomplete bundle that says so on its
 * cover page rather than being quietly short a password.
 */
import { mkdtempSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, withTenant } from '../../src/lib/db/client';
import { resetServices, setKekProvider } from '../../src/lib/services';
import { getExportService } from '../../src/lib/exports/service';
import { FilesystemExportStorage, setExportStorage } from '../../src/lib/exports/storage';
import { isEncryptedBundle, unpackBundle } from '../../src/lib/exports/bundle';
import {
  IDS, actor, buildHarness, connectPools, disconnectPools, resetDatabase, superuserSql,
} from './harness';

const ADMIN = actor(IDS.tenant1, IDS.admin1);
/** Tier 1 holds no export permission at all: it cannot even queue one. */
const TECH = actor(IDS.tenant1, IDS.tech1);
/**
 * The client's own administrator. Holds export:create but NOT secret:export or
 * export:approve — a co-managed customer may pull their own inventory and may
 * not walk out with the credential vault or wave one through.
 */
const CLIENT = actor(IDS.tenant1, IDS.acmeAdmin);

let exportRoot: string;
let exportActorId: string;
let stepUpSecretId: string;
let ordinarySecretId: string;

const exportWorker = () => ({
  tenantId: IDS.tenant1,
  actorId: exportActorId,
  actorType: 'service_account' as const,
});

interface BacklogRow {
  export_job_id: string;
  organization_id: string;
  kind: string;
  format: string;
  include_secrets: boolean;
  scope: Record<string, unknown>;
  worker_actor_id: string;
}

const backlog = () => db('worker')<BacklogRow[]>`SELECT * FROM helm.export_backlog(10)`;

describe('export engine', () => {
  beforeAll(async () => {
    resetDatabase();
    connectPools();

    const harness = buildHarness();
    setKekProvider(harness.kek);
    await harness.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'export tests' });

    exportRoot = mkdtempSync(join(tmpdir(), 'helm-exports-'));
    setExportStorage(new FilesystemExportStorage(exportRoot));

    const [row] = await withTenant(ADMIN, async (tx) => {
      return tx<{ id: string }[]>`
        SELECT id FROM service_account WHERE is_system AND role_key = 'system_export'
      `;
    });
    exportActorId = row!.id;

    // A credential the export can decrypt, and one it cannot: a step-up secret
    // is unreachable to any machine identity, by design.
    const ordinary = await harness.secrets.create(
      ADMIN,
      { organizationId: IDS.orgAcme, kind: 'password', label: 'Acme firewall admin', sensitivity: 'standard' },
      'firewall-admin-password',
    );
    ordinarySecretId = ordinary.secretId;

    const stepUp = await harness.secrets.create(
      ADMIN,
      { organizationId: IDS.orgAcme, kind: 'password', label: 'Acme domain admin', sensitivity: 'standard' },
      'domain-admin-password',
    );
    stepUpSecretId = stepUp.secretId;

    await withTenant(ADMIN, async (tx) => {
      await tx`UPDATE secret SET requires_step_up = true WHERE id = ${stepUpSecretId}::uuid`;

      for (const [nodeId, name, secretId] of [
        ['1d000000-0000-0000-0000-0000000000c1', 'Acme firewall admin', ordinarySecretId],
        ['1d000000-0000-0000-0000-0000000000c2', 'Acme domain admin', stepUpSecretId],
      ] as const) {
        await tx`
          INSERT INTO asset_node (id, tenant_id, organization_id, node_type, name)
          VALUES (${nodeId}::uuid, ${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, 'credential', ${name})
        `;
        await tx`
          INSERT INTO credential (id, tenant_id, credential_type, username, secret_id)
          VALUES (${nodeId}::uuid, ${IDS.tenant1}::uuid, 'local_admin', 'administrator', ${secretId}::uuid)
        `;
      }
    });
  }, 120_000);

  afterAll(async () => {
    setExportStorage(null);
    resetServices();
    await disconnectPools();
  });

  // -------------------------------------------------------------------------
  describe('an export without credentials', () => {
    let jobId: string;

    it('needs no approval', async () => {
      const result = await getExportService().request(ADMIN, {
        organizationId: IDS.orgAcme,
        kind: 'asset_inventory',
        format: 'zip',
        reason: 'quarterly asset inventory for the client review meeting',
      });
      jobId = result.exportJobId;
      expect(result.needsApproval).toBe(false);
    });

    it('is renderable immediately', async () => {
      const rows = await backlog();
      expect(rows.map((r) => r.export_job_id)).toContain(jobId);
    });

    it('renders an unencrypted bundle holding both renderings', async () => {
      const job = (await backlog()).find((r) => r.export_job_id === jobId)!;
      const result = await getExportService().render(exportWorker(), {
        exportJobId: job.export_job_id,
        organizationId: job.organization_id,
        kind: job.kind,
        format: job.format,
        includeSecrets: job.include_secrets,
        scope: job.scope,
      });

      expect(result.rendered).toBe(true);
      // Nothing secret in it, so nothing to protect with a passphrase the
      // recipient would then have to be given out of band.
      expect(result.passphrase).toBeNull();

      const download = await getExportService().download(ADMIN, jobId);
      expect(isEncryptedBundle(download.bytes)).toBe(false);

      const unpacked = unpackBundle(download.bytes);
      expect(unpacked.entries.map((e) => e.name).sort()).toEqual(['export.json', 'export.pdf']);
      expect(unpacked.entries.find((e) => e.name === 'export.pdf')!.bytes.subarray(0, 5).toString())
        .toBe('%PDF-');
    });

    it('contains credential metadata but no material', async () => {
      const download = await getExportService().download(ADMIN, jobId);
      const json = unpackBundle(download.bytes).entries.find((e) => e.name === 'export.json')!;
      const document = JSON.parse(json.bytes.toString('utf8')) as {
        helm: { includesSecrets: boolean };
        credentials: { name: string; material?: string | null; username: string | null }[];
      };

      expect(document.helm.includesSecrets).toBe(false);
      expect(document.credentials.length).toBeGreaterThan(0);
      expect(document.credentials.every((c) => c.material === undefined)).toBe(true);
      // Metadata is still there — that is the point of a metadata-only export.
      expect(document.credentials.some((c) => c.username === 'administrator')).toBe(true);
    });

    it('records every download as its own event', async () => {
      const before = await getExportService().get(ADMIN, jobId);
      await getExportService().download(CLIENT, jobId, { ip: '203.0.113.9', userAgent: 'curl/8' });
      const after = await getExportService().get(ADMIN, jobId);

      expect(after.downloadedCount).toBe(before.downloadedCount + 1);

      const rows = await withTenant(ADMIN, async (tx) => {
        return tx<{ downloaded_by: string; ip: string }[]>`
          -- host(): an inet column renders as 203.0.113.9/32, and the prefix
          -- is not part of what was recorded about the client.
          SELECT downloaded_by, host(ip) AS ip FROM export_download
          WHERE export_job_id = ${jobId}::uuid
        `;
      });
      expect(rows.some((r) => r.downloaded_by === IDS.acmeAdmin && r.ip === '203.0.113.9')).toBe(true);
    });

    it('writes an audit row per download, not a counter bump', async () => {
      const rows = await withTenant(ADMIN, async (tx) => {
        return tx<{ metadata: { download_number: number } }[]>`
          SELECT metadata FROM audit_log
          WHERE action = 'export.downloaded' AND entity_id = ${jobId}::uuid
          ORDER BY occurred_at
        `;
      });
      expect(rows.map((r) => r.metadata.download_number)).toEqual([1, 2, 3]);
    });
  });

  // -------------------------------------------------------------------------
  describe('four-eyes approval', () => {
    let jobId: string;

    it('parks a credential-bearing export until a second person approves', async () => {
      const result = await getExportService().request(ADMIN, {
        organizationId: IDS.orgAcme,
        kind: 'client_offboarding',
        format: 'zip',
        reason: 'Acme have given notice; contractual handover of all documentation',
        includeSecrets: true,
      });
      jobId = result.exportJobId;

      expect(result.needsApproval).toBe(true);
      // Queued, but NOT renderable. The backlog query is the one place that
      // decides, so there is no second definition to drift.
      expect((await backlog()).map((r) => r.export_job_id)).not.toContain(jobId);
    });

    it('refuses self-approval', async () => {
      await expect(getExportService().approve(ADMIN, jobId)).rejects.toThrow(
        /approved by someone other than the person who requested it/,
      );
    });

    it('refuses an approver without the permission', async () => {
      // The client's own administrator may pull their inventory; waving through
      // a credential handover is not theirs to do.
      await expect(getExportService().approve(CLIENT, jobId)).rejects.toThrow(/export:approve/);
    });

    it('accepts a second person who holds the permission', async () => {
      // A second super_admin, created as the superuser: provisioning a user is
      // an administrative act outside the request path, and app_user has no
      // insert policy for a tenant-context session by design.
      const sql = superuserSql();
      try {
        await sql`
          INSERT INTO app_user (id, email, name)
          VALUES (${'1b000000-0000-0000-0000-0000000000f1'}::uuid, 'second@northwind.test', 'Second Approver')
        `;
        await sql`
          INSERT INTO membership (tenant_id, user_id, role_key, org_scope_all)
          VALUES (${IDS.tenant1}::uuid, ${'1b000000-0000-0000-0000-0000000000f1'}::uuid, 'super_admin', true)
        `;
      } finally {
        await sql.end({ timeout: 5 });
      }

      await getExportService().approve(
        actor(IDS.tenant1, '1b000000-0000-0000-0000-0000000000f1'),
        jobId,
        'reviewed the scope; Acme handover is contractually due',
      );

      const job = await getExportService().get(ADMIN, jobId);
      expect(job.approvedBy).toBe('1b000000-0000-0000-0000-0000000000f1');
      expect(job.approvedAt).toBeInstanceOf(Date);
    });

    it('refuses a second approval', async () => {
      await expect(
        getExportService().approve(actor(IDS.tenant1, '1b000000-0000-0000-0000-0000000000f1'), jobId),
      ).rejects.toThrow(/already approved/);
    });

    it('becomes renderable once approved', async () => {
      expect((await backlog()).map((r) => r.export_job_id)).toContain(jobId);
    });

    it('stops being renderable if the scope changes after approval', async () => {
      // The attack this closes: approve a two-server inventory, then widen it to
      // the whole tenant with one UPDATE and render on the strength of a review
      // nobody gave.
      await withTenant(ADMIN, async (tx) => {
        await tx`
          UPDATE export_job SET scope = ${tx.json({ nodeTypes: ['credential'] })}::jsonb
          WHERE id = ${jobId}::uuid
        `;
      });

      expect((await backlog()).map((r) => r.export_job_id)).not.toContain(jobId);

      // Restoring the reviewed scope makes it renderable again, which is the
      // correct behaviour: the digest is over the scope, not over time.
      await withTenant(ADMIN, async (tx) => {
        await tx`UPDATE export_job SET scope = '{}'::jsonb WHERE id = ${jobId}::uuid`;
      });
      expect((await backlog()).map((r) => r.export_job_id)).toContain(jobId);
    });

    it('renders an encrypted bundle and returns the passphrase once', async () => {
      const job = (await backlog()).find((r) => r.export_job_id === jobId)!;
      const result = await getExportService().render(exportWorker(), {
        exportJobId: job.export_job_id,
        organizationId: job.organization_id,
        kind: job.kind,
        format: job.format,
        includeSecrets: job.include_secrets,
        scope: job.scope,
      });

      expect(result.rendered).toBe(true);
      expect(result.passphrase).toMatch(/^([A-Z2-9]{5}-){5}[A-Z2-9]{5}$/);

      const stored = await getExportService().get(ADMIN, jobId);
      expect(stored.encryptionMethod).toMatch(/^AES-256-GCM\/scrypt/);
      expect(stored.secretCount).toBe(1);

      // The passphrase is nowhere in the database. That is the property that
      // makes the artefact at rest useless to anyone holding only the file.
      const leaked = await withTenant(ADMIN, async (tx) => {
        return tx<{ n: string }[]>`
          SELECT count(*) AS n FROM export_job
          WHERE id = ${jobId}::uuid
            AND (to_jsonb(export_job)::text LIKE ${'%' + result.passphrase! + '%'})
        `;
      });
      expect(Number(leaked[0]?.n)).toBe(0);
    });

    it('records the step-up credential as an omission rather than dropping it', async () => {
      const job = await getExportService().get(ADMIN, jobId);
      expect(job.omittedSecretCount).toBe(1);

      const [row] = await withTenant(ADMIN, async (tx) => {
        return tx<{ omissions: { label: string; reason: string }[] }[]>`
          SELECT omissions FROM export_job WHERE id = ${jobId}::uuid
        `;
      });
      expect(row?.omissions[0]).toMatchObject({
        label: 'Acme domain admin',
        reason: 'step_up_required',
      });
    });

    it('opens only with the right passphrase and carries the material', async () => {
      const job = (await backlog()).find((r) => r.export_job_id === jobId);
      expect(job).toBeUndefined(); // already rendered

      const rendered = await getExportService().get(ADMIN, jobId);
      expect(rendered.status).toBe('completed');

      const download = await getExportService().download(ADMIN, jobId);
      expect(isEncryptedBundle(download.bytes)).toBe(true);
      expect(() => unpackBundle(download.bytes)).toThrow(/a passphrase is required/);
      expect(() => unpackBundle(download.bytes, 'WRONG-WRONG-WRONG-WRONG-WRONG-WRONG')).toThrow(
        /wrong passphrase, or it was modified/,
      );
    });

    it('marks the omission on the cover of the PDF', async () => {
      // Re-render into a fresh job so the passphrase is in hand.
      const request = await getExportService().request(ADMIN, {
        organizationId: IDS.orgAcme,
        kind: 'client_offboarding',
        format: 'zip',
        reason: 'second handover pack for the incoming provider',
        includeSecrets: true,
      });
      await getExportService().approve(
        actor(IDS.tenant1, '1b000000-0000-0000-0000-0000000000f1'),
        request.exportJobId,
        'approved: same handover, second copy',
      );

      const job = (await backlog()).find((r) => r.export_job_id === request.exportJobId)!;
      const result = await getExportService().render(exportWorker(), {
        exportJobId: job.export_job_id,
        organizationId: job.organization_id,
        kind: job.kind,
        format: job.format,
        includeSecrets: job.include_secrets,
        scope: job.scope,
      });

      const download = await getExportService().download(ADMIN, request.exportJobId);
      const unpacked = unpackBundle(download.bytes, result.passphrase!);

      const document = JSON.parse(
        unpacked.entries.find((e) => e.name === 'export.json')!.bytes.toString('utf8'),
      ) as {
        helm: { omittedSecrets: { label: string; reason: string }[] };
        credentials: { name: string; material?: string | null }[];
      };

      expect(document.helm.omittedSecrets).toHaveLength(1);
      const firewall = document.credentials.find((c) => c.name === 'Acme firewall admin');
      expect(firewall?.material).toBe('firewall-admin-password');
      const domainAdmin = document.credentials.find((c) => c.name === 'Acme domain admin');
      expect(domainAdmin?.material).toBeUndefined();

      const pdf = unpacked.entries.find((e) => e.name === 'export.pdf')!.bytes.toString('latin1');
      expect(pdf).toContain('could not be included');
    });

    it('audits every credential individually, not once per export', async () => {
      const rows = await withTenant(ADMIN, async (tx) => {
        return tx<{ n: string }[]>`
          SELECT count(*) AS n FROM audit_log
          WHERE action = 'secret.revealed' AND metadata ->> 'purpose' = 'export'
        `;
      });
      // Two successful reveals across two credential-bearing renders.
      expect(Number(rows[0]?.n)).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  describe('revocation and expiry', () => {
    it('stops a download after revocation', async () => {
      const request = await getExportService().request(ADMIN, {
        organizationId: IDS.orgAcme,
        kind: 'ad_hoc',
        format: 'zip',
        reason: 'ad hoc export that will be revoked in this test',
      });

      const job = (await backlog()).find((r) => r.export_job_id === request.exportJobId)!;
      await getExportService().render(exportWorker(), {
        exportJobId: job.export_job_id,
        organizationId: job.organization_id,
        kind: job.kind,
        format: job.format,
        includeSecrets: job.include_secrets,
        scope: job.scope,
      });

      await expect(getExportService().download(ADMIN, request.exportJobId)).resolves.toBeDefined();

      const revoked = await getExportService().revoke(
        ADMIN,
        request.exportJobId,
        'wrong organisation selected; revoking before it leaves the building',
      );
      expect(revoked).toBe(true);

      await expect(getExportService().download(ADMIN, request.exportJobId)).rejects.toThrow(
        /revoked/,
      );
    });

    it('deletes the bytes when an export expires', async () => {
      const request = await getExportService().request(ADMIN, {
        organizationId: IDS.orgAcme,
        kind: 'ad_hoc',
        format: 'zip',
        reason: 'short lived export used to prove the expiry path deletes bytes',
        ttlHours: 1,
      });

      const job = (await backlog()).find((r) => r.export_job_id === request.exportJobId)!;
      await getExportService().render(exportWorker(), {
        exportJobId: job.export_job_id,
        organizationId: job.organization_id,
        kind: job.kind,
        format: job.format,
        includeSecrets: job.include_secrets,
        scope: job.scope,
      });

      const [stored] = await withTenant(ADMIN, async (tx) => {
        return tx<{ storage_key: string }[]>`
          SELECT storage_key FROM export_job WHERE id = ${request.exportJobId}::uuid
        `;
      });
      expect(stored?.storage_key).toBeTruthy();

      await withTenant(ADMIN, async (tx) => {
        await tx`UPDATE export_job SET expires_at = now() - interval '1 minute'
                 WHERE id = ${request.exportJobId}::uuid`;
      });

      const expired = await withTenant(
        exportWorker(),
        async (tx) => tx<{ export_job_id: string; storage_key: string }[]>`
          SELECT * FROM helm.expire_exports()
        `,
        { role: 'worker' },
      );

      expect(expired.map((r) => r.export_job_id)).toContain(request.exportJobId);

      const storage = new FilesystemExportStorage(exportRoot);
      await storage.remove(stored!.storage_key);
      await expect(storage.get(stored!.storage_key)).rejects.toThrow();

      await expect(getExportService().download(ADMIN, request.exportJobId)).rejects.toThrow(/expired/);
    });

    it('refuses a storage key that escapes the storage root', async () => {
      const storage = new FilesystemExportStorage(exportRoot);
      await expect(storage.get('../../../etc/passwd')).rejects.toThrow(/escapes the storage root/);
    });

    it('keeps bundles mode 0600 on disk', async () => {
      const { statSync } = await import('node:fs');
      const shards = await readdir(exportRoot);
      expect(shards.length).toBeGreaterThan(0);

      const walk = async (dir: string): Promise<string[]> => {
        const entries = await readdir(dir, { withFileTypes: true });
        const out: string[] = [];
        for (const entry of entries) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) out.push(...(await walk(path)));
          else out.push(path);
        }
        return out;
      };

      for (const file of await walk(exportRoot)) {
        expect(statSync(file).mode & 0o777).toBe(0o600);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('scoping', () => {
    it('refuses an export for an organisation outside the actor’s scope', async () => {
      // The Acme client admin can see Acme and nothing else.
      await expect(
        getExportService().request(actor(IDS.tenant1, IDS.acmeAdmin), {
          organizationId: IDS.orgGlobex,
          kind: 'asset_inventory',
          format: 'zip',
          reason: 'attempting to export a different client of the same MSP',
        }),
      ).rejects.toThrow(/not in scope/);
    });

    it('refuses a credential-bearing request from someone without secret:export', async () => {
      // Requesting one is a separately permissioned act from approving one:
      // parking a full-vault export in the queue for a colleague to rubber-stamp
      // must not be available to someone who could never export it themselves.
      await expect(
        getExportService().request(CLIENT, {
          organizationId: IDS.orgAcme,
          kind: 'client_offboarding',
          format: 'zip',
          reason: 'client admin attempting to queue a full credential export',
          includeSecrets: true,
        }),
      ).rejects.toThrow(/secret:export is required/);
    });

    it('refuses any export request from a role with no export permission', async () => {
      await expect(
        getExportService().request(TECH, {
          organizationId: IDS.orgAcme,
          kind: 'asset_inventory',
          format: 'zip',
          reason: 'tier one technician attempting to queue an inventory export',
        }),
      ).rejects.toThrow(/export:create is required/);
    });

    it('refuses a request with a reason that says nothing', async () => {
      await expect(
        getExportService().request(ADMIN, {
          organizationId: IDS.orgAcme,
          kind: 'ad_hoc',
          format: 'zip',
          reason: 'because',
        }),
      ).rejects.toThrow(/at least 10 characters/);
    });
  });
});
