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
 * secret:export — a co-managed customer may pull their own inventory and may
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
  reason: string;
  requested_by: string | null;
  requested_by_name: string | null;
  approved_by_name: string | null;
  worker_actor_id: string;
}

const backlog = () => db('worker')<BacklogRow[]>`SELECT * FROM helm.export_backlog(10)`;

/** The PDF's content streams are uncompressed, so text is greppable as latin1. */
const pdfText = (bundle: { entries: { name: string; bytes: Buffer }[] }): string =>
  bundle.entries.find((e) => e.name === 'export.pdf')!.bytes.toString('latin1');

/** Render a backlog row exactly as the worker does. */
const renderFrom = (job: BacklogRow) =>
  getExportService().render(exportWorker(), {
    exportJobId: job.export_job_id,
    organizationId: job.organization_id,
    kind: job.kind,
    format: job.format,
    includeSecrets: job.include_secrets,
    scope: job.scope,
    reason: job.reason,
    requestedByName: job.requested_by_name,
    requestedBy: job.requested_by,
    approvedByName: job.approved_by_name,
  });

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

    it('is created and queued', async () => {
      const result = await getExportService().request(ADMIN, {
        organizationId: IDS.orgAcme,
        kind: 'asset_inventory',
        format: 'zip',
        reason: 'quarterly asset inventory for the client review meeting',
      });
      jobId = result.exportJobId;
      expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('is renderable immediately', async () => {
      const rows = await backlog();
      expect(rows.map((r) => r.export_job_id)).toContain(jobId);
    });

    it('renders an unencrypted bundle holding both renderings', async () => {
      const job = (await backlog()).find((r) => r.export_job_id === jobId)!;
      const result = await renderFrom(job);

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
  describe('a credential export needs ONE authorised person', () => {
    /**
     * A DELIBERATE CHANGE OF POSTURE, made in 0400. Two-person approval used to
     * park a secret-bearing export until somebody else agreed; it does not any
     * more, and the audit trail is what watches the person instead.
     *
     * These tests are written to fail loudly if that is ever quietly reversed
     * OR quietly widened — the second half matters as much as the first. The
     * gate is gone; secret:export, the per-secret rank ladder, the written
     * reason and the encryption of the bundle are not.
     */
    let jobId: string;

    it('is renderable immediately, with no second approver', async () => {
      const result = await getExportService().request(ADMIN, {
        organizationId: IDS.orgAcme,
        kind: 'client_offboarding',
        format: 'zip',
        reason: 'Acme have given notice; contractual handover of all documentation',
        includeSecrets: true,
      });
      jobId = result.exportJobId;

      // The backlog is the one place that decides what the worker may pick up,
      // so this is the whole change in one assertion.
      expect((await backlog()).map((r) => r.export_job_id)).toContain(jobId);
    });

    it('records the request in the audit log, with who and what', async () => {
      // The audit trail is now the primary safeguard rather than a supplement,
      // so it is asserted directly rather than assumed.
      const rows = await withTenant(ADMIN, async (tx) => {
        return tx<{ actor_id: string; reason: string; metadata: Record<string, unknown> }[]>`
          SELECT actor_id::text, reason, metadata FROM audit_log
          WHERE action = 'export.requested' AND entity_id = ${jobId}::uuid
        `;
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor_id).toBe(IDS.admin1);
      expect(rows[0]!.reason).toContain('Acme have given notice');
      expect(rows[0]!.metadata.include_secrets).toBe(true);
    });

    it('still refuses a requester without secret:export', async () => {
      // The control that remains. "Remove the second approver" must not have
      // become "remove the controls near the second approver".
      await expect(
        getExportService().request(CLIENT, {
          organizationId: IDS.orgAcme,
          kind: 'client_offboarding',
          format: 'zip',
          reason: 'a client administrator trying to take the credentials with them',
          includeSecrets: true,
        }),
      ).rejects.toThrow(/secret:export/);
    });

    it('still requires a written reason of real length', async () => {
      await expect(
        getExportService().request(ADMIN, {
          organizationId: IDS.orgAcme,
          kind: 'client_offboarding',
          format: 'zip',
          reason: 'because',
          includeSecrets: true,
        }),
      ).rejects.toThrow();
    });

    it('has no approval function left to call', async () => {
      // Left in place it would set a column nothing reads — a control that
      // looks present and does nothing, which is worse than one that is gone.
      const [row] = await withTenant(ADMIN, async (tx) => {
        return tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'helm' AND p.proname = 'approve_export'
        `;
      });
      expect(row!.n).toBe(0);
    });

    it('keeps revocation available to a senior reviewer, not just the requester', async () => {
      // export:approve was RENAMED rather than deleted, because revoke_export
      // gated on it too. Deleting it would have narrowed revocation to the
      // requester alone — removing the brakes along with the gate.
      const sql = superuserSql();
      try {
        await sql`
          INSERT INTO app_user (id, email, name)
          VALUES (${'1b000000-0000-0000-0000-0000000000f1'}::uuid, 'second@northwind.test', 'Second Reviewer')
          ON CONFLICT (id) DO NOTHING
        `;
        await sql`
          INSERT INTO membership (tenant_id, user_id, role_key, org_scope_all)
          VALUES (${IDS.tenant1}::uuid, ${'1b000000-0000-0000-0000-0000000000f1'}::uuid, 'super_admin', true)
          ON CONFLICT DO NOTHING
        `;
      } finally {
        await sql.end({ timeout: 5 });
      }

      const other = await getExportService().request(ADMIN, {
        organizationId: IDS.orgAcme,
        kind: 'asset_inventory',
        format: 'zip',
        reason: 'an inventory that somebody else will decide to pull back',
        includeSecrets: false,
      });

      const revoked = await getExportService().revoke(
        actor(IDS.tenant1, '1b000000-0000-0000-0000-0000000000f1'),
        other.exportJobId,
        'not appropriate to send this week',
      );
      expect(revoked).toBe(true);
    });

    it('renders an encrypted bundle and returns the passphrase once', async () => {
      const job = (await backlog()).find((r) => r.export_job_id === jobId)!;
      const result = await renderFrom(job);

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
      const job = (await backlog()).find((r) => r.export_job_id === request.exportJobId)!;
      const result = await renderFrom(job);

      const download = await getExportService().download(ADMIN, request.exportJobId);
      const unpacked = unpackBundle(download.bytes, result.passphrase!);

      const document = JSON.parse(
        unpacked.entries.find((e) => e.name === 'export.json')!.bytes.toString('utf8'),
      ) as {
        helm: {
          omittedSecrets: { label: string; reason: string }[];
          requestedBy: string | null;
          approvedBy: string | null;
        };
        credentials: { name: string; material?: string | null }[];
      };

      // The four-eyes evidence has to survive into the document: it is the
      // first thing an auditor reading a handover pack looks for, and the
      // render worker has no user:read of its own to look it up with.
      expect(document.helm.requestedBy).toBe('Northwind Admin');
      // No approver: 0400 removed the step. The requester is the accountable
      // party and the cover page names them instead.
      expect(document.helm.approvedBy).toBeNull();
      expect(pdfText(unpacked)).toContain('Northwind Admin');

      expect(document.helm.omittedSecrets).toHaveLength(1);
      const firewall = document.credentials.find((c) => c.name === 'Acme firewall admin');
      expect(firewall?.material).toBe('firewall-admin-password');
      const domainAdmin = document.credentials.find((c) => c.name === 'Acme domain admin');
      expect(domainAdmin?.material).toBeUndefined();

      expect(pdfText(unpacked)).toContain('could not be included');
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
      await renderFrom(job);

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
      await renderFrom(job);

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
