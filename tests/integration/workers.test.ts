/**
 * Background worker behaviour, against the live cluster as the real roles.
 *
 * The properties under test are the ones whose absence is invisible until
 * something has been quietly wrong for a month: alerts that fire four times for
 * one certificate and train the team to ignore them, a sync that retries a dead
 * connection every five minutes, an anchor that certifies a chain nobody
 * verified, a worker identity that can read more than its job needs.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, withTenant } from '../../src/lib/db/client';
import { setKekProvider, resetServices, getSecretService } from '../../src/lib/services';
import { SecretAccessDeniedError } from '../../src/lib/secrets/errors';
import {
  IDS, actor, buildHarness, connectPools, disconnectPools, resetDatabase, superuserSql,
} from './harness';

const ADMIN = actor(IDS.tenant1, IDS.admin1);

interface WorkerIdentities {
  alerts: string;
  sync: string;
  audit: string;
  export: string;
}

let identities: WorkerIdentities;

const workerActor = (id: string) => ({
  tenantId: IDS.tenant1,
  actorId: id,
  actorType: 'service_account' as const,
});

describe('background workers', () => {
  beforeAll(async () => {
    resetDatabase();
    connectPools();
    const harness = buildHarness();
    setKekProvider(harness.kek);
    await harness.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'worker tests' });

    const rows = await withTenant(ADMIN, async (tx) => {
      return tx<{ role_key: string; id: string }[]>`
        SELECT role_key, id FROM service_account WHERE is_system
      `;
    });

    const byRole = new Map(rows.map((r) => [r.role_key, r.id]));
    identities = {
      alerts: byRole.get('system_alerts')!,
      sync: byRole.get('system_sync')!,
      audit: byRole.get('system_audit')!,
      export: byRole.get('system_export')!,
    };
  }, 120_000);

  afterAll(async () => {
    resetServices();
    await disconnectPools();
  });

  // -------------------------------------------------------------------------
  describe('worker identities', () => {
    it('provisions one identity per worker for every tenant', async () => {
      // Read as the superuser: service_account is RLS-protected and the worker
      // role has no tenant context here, so it would correctly see nothing.
      const sql = superuserSql();
      try {
        const [row] = await sql<{ count: string }[]>`
          SELECT count(*) FROM service_account WHERE is_system
        `;
        // Four workers across the two fixture tenants.
        expect(Number(row?.count)).toBe(8);
      } finally {
        await sql.end({ timeout: 5 });
      }
    });

    it('pins the sync identity to the integration purpose', async () => {
      const [row] = await withTenant(ADMIN, async (tx) => {
        return tx<{ allowed_reveal_purposes: string[] }[]>`
          SELECT allowed_reveal_purposes FROM service_account WHERE id = ${identities.sync}::uuid
        `;
      });
      expect(row?.allowed_reveal_purposes).toEqual(['integration']);
    });

    it('refuses to let an administrator widen a worker’s authorisation', async () => {
      await expect(
        withTenant(ADMIN, async (tx) => {
          await tx`
            UPDATE service_account SET allowed_reveal_purposes = NULL
            WHERE id = ${identities.sync}::uuid
          `;
        }),
      ).rejects.toThrow(/authorisation of built-in worker identity .* is fixed/);
    });

    it('refuses to delete a built-in identity', async () => {
      await expect(
        withTenant(ADMIN, async (tx) => {
          await tx`DELETE FROM service_account WHERE id = ${identities.alerts}::uuid`;
        }),
      ).rejects.toThrow(/cannot be deleted/);
    });

    it('keeps the cross-tenant enumerators away from the request role', async () => {
      // helm_app is what every HTTP request runs as. If it can call these, a
      // request can enumerate other tenants.
      await expect(db('app')`SELECT * FROM helm.sync_due()`).rejects.toThrow(/permission denied/);
      await expect(db('app')`SELECT * FROM helm.alert_backlog()`).rejects.toThrow(/permission denied/);
      await expect(db('app')`SELECT * FROM helm.export_backlog(1)`).rejects.toThrow(/permission denied/);
    });
  });

  // -------------------------------------------------------------------------
  describe('purpose restriction on machine identities', () => {
    let ordinarySecretId: string;

    beforeAll(async () => {
      const created = await getSecretService().create(
        ADMIN,
        {
          organizationId: IDS.orgAcme,
          kind: 'password',
          label: 'Acme file server local admin',
          sensitivity: 'standard',
        },
        'not-for-the-sync-worker',
      );
      ordinarySecretId = created.secretId;
    });

    it('refuses a sync worker asking for an ordinary secret', async () => {
      // The sync account holds secret:reveal at rank 80, so without the purpose
      // pin this would succeed. It is the pin, not the rank, doing the work.
      await expect(
        getSecretService().reveal(workerActor(identities.sync), ordinarySecretId, {
          purpose: 'view',
          role: 'worker',
        }),
      ).rejects.toMatchObject({ reason: 'purpose_not_permitted_for_actor' });
    });

    it('refuses a sync worker asking for a secret that is not an integration credential', async () => {
      await expect(
        getSecretService().reveal(workerActor(identities.sync), ordinarySecretId, {
          purpose: 'integration',
          role: 'worker',
        }),
      ).rejects.toMatchObject({ reason: 'not_an_integration_credential' });
    });

    it('refuses an export worker outside a live export', async () => {
      // The gate used to be "is this secret in an APPROVED export"; 0400
      // removed two-person approval and loosened it to "in a live export that
      // asked for credentials". The pin is unchanged in substance: an export
      // worker still cannot reach a secret just because it exists, which is the
      // property that stops the export identity being a vault-wide skeleton
      // key. Only the denial's name moved.
      await expect(
        getSecretService().reveal(workerActor(identities.export), ordinarySecretId, {
          purpose: 'export',
          role: 'worker',
        }),
      ).rejects.toMatchObject({ reason: 'not_in_a_live_export' });
    });

    it('records every refusal in the audit log', async () => {
      const rows = await withTenant(ADMIN, async (tx) => {
        return tx<{ metadata: Record<string, unknown> }[]>`
          SELECT metadata FROM audit_log
          WHERE action = 'secret.reveal_denied'
            AND metadata ->> 'cause' IN (
              'purpose_not_permitted_for_actor', 'not_an_integration_credential',
              'not_in_a_live_export')
        `;
      });
      expect(rows.length).toBeGreaterThanOrEqual(3);
    });

    it('lets the sync worker read a real integration credential', async () => {
      const credential = await getSecretService().create(
        ADMIN,
        {
          organizationId: IDS.orgAcme,
          kind: 'api_key',
          label: 'NinjaOne API key',
          sensitivity: 'standard',
        },
        'ninja-api-key-value',
      );

      await withTenant(ADMIN, async (tx) => {
        await tx`
          INSERT INTO integration_connection (
            tenant_id, organization_id, provider, display_name, base_url,
            credential_secret_ids, sync_enabled, config
          )
          VALUES (
            ${IDS.tenant1}::uuid, ${IDS.orgAcme}::uuid, 'ninja_one', 'Acme NinjaOne',
            'https://eu.ninjarmm.com',
            ${tx.json({ api_key: credential.secretId })}::jsonb, true,
            ${tx.json({ path: '/v2/devices' })}::jsonb
          )
        `;
      });

      const revealed = await getSecretService().reveal(
        workerActor(identities.sync),
        credential.secretId,
        { purpose: 'integration', role: 'worker' },
      );
      expect(revealed.value.expose()).toBe('ninja-api-key-value');
      revealed.value.dispose();
    });
  });

  // -------------------------------------------------------------------------
  describe('expiry alert evaluation', () => {
    let ruleId: string;

    beforeAll(async () => {
      await withTenant(ADMIN, async (tx) => {
        // A certificate that is ALREADY inside four lead windows. This is the
        // case that produces alert fatigue if every crossed threshold fires.
        await tx`
          INSERT INTO asset_node (id, tenant_id, organization_id, node_type, name)
          VALUES (${'1d000000-0000-0000-0000-0000000000a1'}::uuid, ${IDS.tenant1}::uuid,
                  ${IDS.orgAcme}::uuid, 'ssl_certificate', 'wildcard.acme.test')
        `;
        await tx`
          INSERT INTO ssl_certificate (id, tenant_id, common_name, issuer, not_after)
          VALUES (${'1d000000-0000-0000-0000-0000000000a1'}::uuid, ${IDS.tenant1}::uuid,
                  'wildcard.acme.test', 'Lets Encrypt', now() + interval '5 days')
        `;

        const [rule] = await tx<{ id: string }[]>`
          INSERT INTO alert_rule (tenant_id, name, channel, target, lead_days)
          VALUES (${IDS.tenant1}::uuid, 'All expiries', 'webhook',
                  'https://alerts.northwind.test/hook', ARRAY[90, 30, 14, 7, 1])
          RETURNING id
        `;
        ruleId = rule!.id;
      });
    });

    it('lists the tenant in the alert backlog with its worker identity', async () => {
      const rows = await db('worker')<
        { tenant_id: string; worker_actor_id: string; active_rules: string }[]
      >`SELECT * FROM helm.alert_backlog()`;

      const northwind = rows.find((r) => r.tenant_id === IDS.tenant1);
      expect(northwind?.worker_actor_id).toBe(identities.alerts);
      expect(Number(northwind?.active_rules)).toBe(1);
    });

    it('delivers only the most urgent crossed threshold and suppresses the rest', async () => {
      const [result] = await withTenant(
        workerActor(identities.alerts),
        async (tx) => tx<{ fired: string; suppressed: string }[]>`SELECT * FROM helm.evaluate_alert_rules()`,
        { role: 'worker' },
      );

      // Crossed: 90, 30, 14 and 7. Exactly one notification, for the 7-day
      // threshold, and three idempotency records so the others can never fire.
      expect(Number(result?.fired)).toBe(1);
      expect(Number(result?.suppressed)).toBe(3);

      const events = await withTenant(ADMIN, async (tx) => {
        return tx<{ lead_day: number; delivery_status: string; severity: string }[]>`
          SELECT lead_day, delivery_status, severity FROM alert_event
          WHERE rule_id = ${ruleId}::uuid ORDER BY lead_day
        `;
      });

      expect(events.map((e) => [e.lead_day, e.delivery_status])).toEqual([
        [7, 'pending'],
        [14, 'suppressed'],
        [30, 'suppressed'],
        [90, 'suppressed'],
      ]);
      expect(events[0]?.severity).toBe('critical');
    });

    it('is idempotent, so the nightly run does not re-alert', async () => {
      const [result] = await withTenant(
        workerActor(identities.alerts),
        async (tx) => tx<{ fired: string; suppressed: string }[]>`SELECT * FROM helm.evaluate_alert_rules()`,
        { role: 'worker' },
      );
      expect([Number(result?.fired), Number(result?.suppressed)]).toEqual([0, 0]);
    });

    it('hands the notifier everything it needs without a second query', async () => {
      const rows = await withTenant(
        workerActor(identities.alerts),
        async (tx) => tx<{ channel: string; target: string; payload: Record<string, unknown> }[]>`
          SELECT * FROM helm.pending_alerts(10)
        `,
        { role: 'worker' },
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.channel).toBe('webhook');
      expect(rows[0]?.payload).toMatchObject({ kind: 'ssl_certificate', label: 'wildcard.acme.test' });
      // The payload is built from the expiration projection, which has no route
      // to ciphertext; assert the shape carries nothing secret-shaped.
      expect(Object.keys(rows[0]?.payload ?? {})).not.toContain('secret_id');
    });

    it('records a delivery outcome exactly once', async () => {
      const [alert] = await withTenant(
        workerActor(identities.alerts),
        async (tx) => tx<{ alert_id: string }[]>`SELECT alert_id FROM helm.pending_alerts(1)`,
        { role: 'worker' },
      );

      const record = async (status: string) =>
        withTenant(
          workerActor(identities.alerts),
          async (tx) => {
            const [row] = await tx<{ ok: boolean }[]>`
              SELECT helm.record_alert_delivery(${alert!.alert_id}::uuid, ${status}) AS ok
            `;
            return row?.ok ?? false;
          },
          { role: 'worker' },
        );

      expect(await record('sent')).toBe(true);
      // Already delivered: a retry must not double-count or reset the timestamp.
      expect(await record('sent')).toBe(false);
    });

    it('fires the next threshold when the expiry moves closer', async () => {
      await withTenant(ADMIN, async (tx) => {
        await tx`
          UPDATE ssl_certificate SET not_after = now() + interval '1 day'
          WHERE id = ${'1d000000-0000-0000-0000-0000000000a1'}::uuid
        `;
      });

      const [result] = await withTenant(
        workerActor(identities.alerts),
        async (tx) => tx<{ fired: string; suppressed: string }[]>`SELECT * FROM helm.evaluate_alert_rules()`,
        { role: 'worker' },
      );
      expect(Number(result?.fired)).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('integration sync scheduling', () => {
    it('offers a newly-enabled connection immediately', async () => {
      const rows = await db('worker')<{ connection_id: string; worker_actor_id: string }[]>`
        SELECT * FROM helm.sync_due(10)
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.worker_actor_id).toBe(identities.sync);
    });

    it('will not offer a connection that already has a run in flight', async () => {
      const [due] = await db('worker')<{ connection_id: string }[]>`SELECT * FROM helm.sync_due(10)`;

      const runId = await withTenant(
        workerActor(identities.sync),
        async (tx) => {
          const [row] = await tx<{ run: string | null }[]>`
            SELECT helm.begin_sync_run(${due!.connection_id}::uuid, 'schedule') AS run
          `;
          return row?.run ?? null;
        },
        { role: 'worker' },
      );
      expect(runId).not.toBeNull();

      const stillDue = await db('worker')`SELECT * FROM helm.sync_due(10)`;
      expect(stillDue).toHaveLength(0);

      // A second runner racing on the same tick gets NULL, not an error: two
      // workers arriving together is normal operation.
      const second = await withTenant(
        workerActor(identities.sync),
        async (tx) => {
          const [row] = await tx<{ run: string | null }[]>`
            SELECT helm.begin_sync_run(${due!.connection_id}::uuid, 'schedule') AS run
          `;
          return row?.run ?? null;
        },
        { role: 'worker' },
      );
      expect(second).toBeNull();

      await withTenant(
        workerActor(identities.sync),
        async (tx) => tx`
          SELECT helm.finish_sync_run(${runId}::uuid, 'success'::sync_run_status, 12, 12, 0, 0, 0, 'cursor-2')
        `,
        { role: 'worker' },
      );
    });

    it('advances the cursor and clears the failure count on a clean run', async () => {
      const [row] = await withTenant(ADMIN, async (tx) => {
        return tx<{ sync_cursor: string | null; consecutive_failures: number; status: string }[]>`
          SELECT sync_cursor, consecutive_failures, status::text FROM integration_connection
        `;
      });
      expect(row).toMatchObject({ sync_cursor: 'cursor-2', consecutive_failures: 0, status: 'active' });
    });

    it('backs off exponentially after failures, instead of hammering the vendor', async () => {
      const connection = await withTenant(ADMIN, async (tx) => {
        const [c] = await tx<{ id: string }[]>`SELECT id FROM integration_connection`;
        return c!.id;
      });

      const failOnce = async () => {
        const runId = await withTenant(
          workerActor(identities.sync),
          async (tx) => {
            const [r] = await tx<{ run: string | null }[]>`
              SELECT helm.begin_sync_run(${connection}::uuid, 'schedule') AS run
            `;
            return r?.run ?? null;
          },
          { role: 'worker' },
        );
        await withTenant(
          workerActor(identities.sync),
          async (tx) => tx`
            SELECT helm.finish_sync_run(${runId}::uuid, 'failed'::sync_run_status,
                                        0, 0, 0, 0, 0, NULL, 'vendor returned 401')
          `,
          { role: 'worker' },
        );
      };

      // Make it due, then fail it. The default interval is 60 minutes; after one
      // failure the next attempt is 120 minutes out, so it is no longer due.
      await withTenant(ADMIN, async (tx) => {
        await tx`UPDATE integration_connection SET last_sync_at = now() - interval '2 hours'`;
      });
      await failOnce();

      const due = await db('worker')`SELECT * FROM helm.sync_due(10)`;
      expect(due).toHaveLength(0);

      const [health] = await withTenant(ADMIN, async (tx) => {
        return tx<{ consecutive_failures: number; status: string; last_error: string | null; sync_cursor: string | null }[]>`
          SELECT consecutive_failures, status::text, last_error, sync_cursor FROM integration_connection
        `;
      });

      expect(health?.consecutive_failures).toBe(1);
      expect(health?.status).toBe('degraded');
      expect(health?.last_error).toMatch(/401/);
      // A failed run must not advance the cursor: doing so silently skips
      // whatever it missed.
      expect(health?.sync_cursor).toBe('cursor-2');
    });

    it('marks a connection as errored once failures accumulate', async () => {
      const connection = await withTenant(ADMIN, async (tx) => {
        const [c] = await tx<{ id: string }[]>`SELECT id FROM integration_connection`;
        return c!.id;
      });

      for (let i = 0; i < 4; i += 1) {
        const runId = await withTenant(
          workerActor(identities.sync),
          async (tx) => {
            const [r] = await tx<{ run: string | null }[]>`
              SELECT helm.begin_sync_run(${connection}::uuid, 'manual') AS run
            `;
            return r?.run ?? null;
          },
          { role: 'worker' },
        );
        await withTenant(
          workerActor(identities.sync),
          async (tx) => tx`
            SELECT helm.finish_sync_run(${runId}::uuid, 'failed'::sync_run_status,
                                        0, 0, 0, 0, 0, NULL, 'still 401')
          `,
          { role: 'worker' },
        );
      }

      const [health] = await withTenant(ADMIN, async (tx) => {
        return tx<{ consecutive_failures: number; status: string }[]>`
          SELECT consecutive_failures, status::text FROM integration_connection
        `;
      });
      expect(health).toMatchObject({ consecutive_failures: 5, status: 'error' });
    });
  });

  // -------------------------------------------------------------------------
  describe('audit chain anchoring', () => {
    it('lists tenants whose chain has moved past its anchor', async () => {
      const rows = await db('worker')<
        { tenant_id: string; chain_seq: string; anchored_seq: string; worker_actor_id: string }[]
      >`SELECT * FROM helm.audit_anchor_backlog()`;

      const northwind = rows.find((r) => r.tenant_id === IDS.tenant1);
      expect(northwind).toBeDefined();
      expect(Number(northwind?.chain_seq)).toBeGreaterThan(0);
      expect(Number(northwind?.anchored_seq)).toBe(0);
      expect(northwind?.worker_actor_id).toBe(identities.audit);
    });

    it('verifies the chain before anchoring it', async () => {
      const [verification] = await withTenant(
        workerActor(identities.audit),
        async (tx) => tx<{ is_intact: boolean; verified_rows: string }[]>`
          SELECT * FROM helm.verify_audit_chain(${IDS.tenant1}::uuid)
        `,
        { role: 'worker' },
      );
      expect(verification?.is_intact).toBe(true);
      expect(Number(verification?.verified_rows)).toBeGreaterThan(0);
    });

    it('refuses a hash that never appeared in the chain', async () => {
      // The whole value of an anchor is that it names a real point in history.
      // A receipt for a hash the chain never had proves nothing, and the failure
      // would only surface when an auditor tried to rely on it.
      const [head] = await db('worker')<{ chain_seq: string }[]>`
        SELECT chain_seq FROM helm.audit_anchor_backlog() WHERE tenant_id = ${IDS.tenant1}::uuid
      `;
      await expect(
        db('worker')`
          SELECT helm.record_audit_anchor(
            ${IDS.tenant1}::uuid, ${Number(head!.chain_seq) - 1}::bigint,
            ${Buffer.alloc(32, 7)}, ${'forged'}
          )
        `,
      ).rejects.toThrow(/no audit row at sequence/);
    });

    it('records an anchor and refuses to move it backwards', async () => {
      // Through the backlog function, exactly as the worker does: reading
      // audit_chain_head directly without a tenant context returns nothing.
      const backlog = await db('worker')<{ tenant_id: string; chain_seq: string; head_hash: Buffer }[]>`
        SELECT * FROM helm.audit_anchor_backlog()
      `;
      const head = backlog.find((r) => r.tenant_id === IDS.tenant1);

      const recorded = await db('worker')<{ ok: boolean }[]>`
        SELECT helm.record_audit_anchor(
          ${IDS.tenant1}::uuid, ${head!.chain_seq}::bigint, ${head!.head_hash},
          ${'file:/var/lib/helm/anchors/2026-09-14.jsonl#abc123'}
        ) AS ok
      `;
      expect(recorded[0]?.ok).toBe(true);

      // Re-anchoring the same sequence usually means two workers are racing with
      // different views of the chain, which is worth a loud refusal.
      await expect(
        db('worker')`
          SELECT helm.record_audit_anchor(
            ${IDS.tenant1}::uuid, ${head!.chain_seq}::bigint, ${head!.head_hash}, ${'again'}
          )
        `,
      ).rejects.toThrow(/already anchored/);
    });

    it('refuses an anchor ahead of the chain', async () => {
      await expect(
        db('worker')`
          SELECT helm.record_audit_anchor(
            ${IDS.tenant1}::uuid, 999999::bigint,
            ${Buffer.alloc(32)}, ${'bogus'}
          )
        `,
      ).rejects.toThrow(/ahead of the chain head/);
    });

    it('refuses an anchor with no reference to where it was witnessed', async () => {
      await expect(
        db('worker')`
          SELECT helm.record_audit_anchor(${IDS.tenant1}::uuid, 1::bigint, ${Buffer.alloc(32)}, ${'  '})
        `,
      ).rejects.toThrow(/must name where it was witnessed/);
    });

    it('drops the tenant from the backlog once it is fully anchored', async () => {
      // Re-anchor at whatever the head is now: the tests above wrote audit rows
      // of their own, so the chain has moved since the first anchor.
      const [head] = await db('worker')<{ chain_seq: string; head_hash: Buffer }[]>`
        SELECT chain_seq, head_hash FROM helm.audit_anchor_backlog()
        WHERE tenant_id = ${IDS.tenant1}::uuid
      `;
      if (head) {
        await db('worker')`
          SELECT helm.record_audit_anchor(
            ${IDS.tenant1}::uuid, ${head.chain_seq}::bigint, ${head.head_hash}, ${'file:catch-up'}
          )
        `;
      }

      const rows = await db('worker')<{ tenant_id: string }[]>`SELECT * FROM helm.audit_anchor_backlog()`;
      expect(rows.find((r) => r.tenant_id === IDS.tenant1)).toBeUndefined();
    });
  });
});

/** Re-exported so the export suite can reuse the identity lookup shape. */
export type { WorkerIdentities };
export { SecretAccessDeniedError, randomUUID };
