/**
 * Outbound notifications, end to end.
 *
 * 0400 removed two-person approval from credential exports on the stated
 * understanding that detection replaces prevention. These tests are what makes
 * that claim checkable, so they go all the way to a socket: an export is
 * requested through the real service, the fan-out reads the real audit row, the
 * worker opens the real envelope and POSTs to a receiver that records what it
 * was actually handed.
 *
 * Three things are established, and they are different in kind:
 *
 *   THE PIPELINE   an audit row becomes a message in a channel, once, with the
 *                  right words — and a second fan-out does not send it again.
 *
 *   THE ALLOW-LIST helm.notification_payload() names every field that leaves.
 *                  A metadata key nobody listed does not appear, and a payload
 *                  carrying a forbidden key is refused by the database.
 *
 *   CUSTODY        the webhook URL is a credential. helm_app cannot read it by
 *                  any column, and the AAD binds it to one endpoint of one
 *                  tenant.
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { useSessionResolver, type SessionUser } from '../../src/lib/auth/session';
import { resetServices, setKekProvider } from '../../src/lib/services';
import { withTenant } from '../../src/lib/db/client';
import { getExportService } from '../../src/lib/exports/service';
import { openWebhook, sealWebhook, digestOf, hostOf, isDeliverable } from '../../src/lib/notifications/config';
import { FakeWebhook } from '../support/fake-webhook';
import {
  buildHarness,
  connectPools,
  disconnectPools,
  IDS,
  resetDatabase,
  superuserSql,
  type Harness,
} from './harness';

import { GET as getNotifications, PUT as putNotification } from '../../src/app/api/notifications/route';

let h: Harness;
let currentUser: SessionUser | null = null;
const asUser = (id: string, email: string) => {
  currentUser = { id, email };
};

const running: FakeWebhook[] = [];
async function receiver(...args: Parameters<typeof FakeWebhook.start>): Promise<FakeWebhook> {
  const server = await FakeWebhook.start(...args);
  running.push(server);
  return server;
}

const request = (method: string, payload?: unknown) =>
  new NextRequest(
    new Request('https://helm.test/api/notifications', {
      method,
      headers: { 'content-type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    }),
  );

const body = async (response: Response) => (await response.json()) as Record<string, unknown>;

const WORKER = {
  tenantId: IDS.tenant1,
  actorId: '',
  actorType: 'service_account' as const,
};

/**
 * The worker identity the notification jobs run as.
 *
 * Read inside a tenant context, because service_account is RLS-protected and
 * helm.worker_actor() is not SECURITY DEFINER — called bare on the worker pool
 * it matches zero rows and returns NULL, which surfaces later as "unknown or
 * disabled service account <NULL>". In production the worker never calls it
 * directly; it comes back inside helm.notification_backlog(), which IS a
 * definer function.
 */
let cachedWorkerActor: string | null = null;
async function workerActor(): Promise<string> {
  if (cachedWorkerActor) return cachedWorkerActor;
  const rows = await withTenant(
    { tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' },
    async (tx) => tx<{ id: string }[]>`
      SELECT id FROM service_account WHERE is_system AND role_key = 'system_alerts'
    `,
  );
  cachedWorkerActor = rows[0]!.id;
  return cachedWorkerActor;
}

/** Run one fan-out pass as the worker, exactly as the job does. */
async function fanOut(): Promise<{ examined: number; queued: number }> {
  const actor = { ...WORKER, actorId: await workerActor() };
  const [row] = await withTenant(
    actor,
    async (tx) => tx<{ examined: number; queued: number }[]>`
      SELECT * FROM helm.fan_out_notifications(500)
    `,
    { role: 'worker' },
  );
  return { examined: Number(row?.examined ?? 0), queued: Number(row?.queued ?? 0) };
}

interface ClaimedRow {
  delivery_id: string;
  endpoint_id: string;
  format: string;
  event_type: string;
  subject: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  organization_name: string | null;
  wrap_provider: string;
  kek_id: string;
  wrapped_dek: Buffer;
  secret_ciphertext: Buffer;
  secret_nonce: Buffer;
  secret_tag: Buffer;
  secret_aad: string;
}

async function claim(): Promise<ClaimedRow[]> {
  const actor = { ...WORKER, actorId: await workerActor() };
  return withTenant(
    actor,
    async (tx) => tx<ClaimedRow[]>`SELECT * FROM helm.claim_notifications(50)`,
    { role: 'worker' },
  );
}

/**
 * Deliver one claimed row for real: open the envelope, format, POST.
 *
 * A trimmed copy of the worker's deliverOne, kept here rather than imported so
 * the test drives the parts that matter — the unwrap and the wire — without
 * pulling in the job runtime.
 */
async function deliver(row: ClaimedRow, tenantName = 'Northwind Managed Services'): Promise<number> {
  const { formatPayload } = await import('../../src/lib/notifications/format');
  const opened = await openWebhook(IDS.tenant1, row.endpoint_id, row);
  const response = await fetch(opened.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(
      formatPayload(row.format as 'generic', {
        event: row.event_type,
        subject: row.subject,
        payload: row.payload,
        occurredAt: row.occurred_at,
        organizationName: row.organization_name,
        tenantName,
      }),
    ),
  });

  const actor = { ...WORKER, actorId: await workerActor() };
  await withTenant(
    actor,
    async (tx) => tx`
      SELECT helm.record_notification_delivery(
        ${row.delivery_id}::uuid, ${response.ok}, ${response.status}, NULL)
    `,
    { role: 'worker' },
  );
  return response.status;
}

/**
 * Reset between tests — but ADVANCE the cursor rather than deleting it.
 *
 * Deleting it was the first attempt and it was wrong in a way worth recording:
 * the audit log is append-only and is not cleared between tests, so a cursor
 * back at zero makes the next fan-out replay every earlier test's export. Both
 * multi-event tests passed alone and failed in the suite.
 *
 * Advancing to the current chain head is also what production does — the cursor
 * moves forward and never rewinds — so the tests now exercise the real
 * behaviour instead of one no deployment ever sees.
 */
async function wipeNotifications(): Promise<void> {
  const sql = superuserSql();
  try {
    await sql`DELETE FROM webhook_delivery`;
    await sql`DELETE FROM webhook_endpoint`;
    await sql`
      INSERT INTO notification_cursor (tenant_id, last_chain_seq)
      SELECT ${IDS.tenant1}::uuid, coalesce(max(chain_seq), 0)
      FROM audit_log WHERE tenant_id = ${IDS.tenant1}::uuid
      ON CONFLICT (tenant_id) DO UPDATE SET last_chain_seq = EXCLUDED.last_chain_seq
    `;
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
  // Start from the current head, so the first test does not fan out the audit
  // rows the fixtures and the key provisioning above already wrote.
  await wipeNotifications();
}, 120_000);

afterEach(async () => {
  currentUser = null;
  while (running.length) running.pop()!.stop();
  await wipeNotifications();
});

afterAll(async () => {
  await disconnectPools();
});

/**
 * Seed a destination pointing at a local receiver.
 *
 * Inserted directly rather than through the API, for one reason: the API
 * requires https and is RIGHT to — a notification names which client has which
 * expiring asset and who exported what, and an internal network is not a reason
 * to put that on the wire in clear. That check is exercised on its own below
 * ("refuses a plaintext destination"); weakening it so a test could use a
 * plaintext stub would be testing the wrong thing.
 *
 * Everything else here is real: the URL is sealed with the real KEK provider,
 * bound by the real AAD, and the worker opens it the same way in production.
 */
async function seedDestination(
  url: string,
  format: 'generic' | 'slack' | 'discord' | 'teams' = 'generic',
  events: string[] = ['export.requested'],
  signingSecret?: string,
): Promise<string> {
  const id = randomUUID();
  const sealed = await sealWebhook(IDS.tenant1, id, url, signingSecret);
  const sql = superuserSql();
  try {
    await sql`
      INSERT INTO webhook_endpoint (
        id, tenant_id, name, format, is_active, events, max_attempts, timeout_ms,
        url_host, url_digest, signing_secret_set,
        wrap_provider, kek_id, wrapped_dek,
        secret_ciphertext, secret_nonce, secret_tag, secret_aad)
      VALUES (${id}::uuid, ${IDS.tenant1}::uuid, ${`probe-${format}-${id.slice(0, 8)}`},
              ${format}::webhook_format, true, ${events}::text[], 3, 2000,
              ${sealed.urlHost}, ${sealed.urlDigest}, ${sealed.signingSecretSet},
              ${sealed.wrapProvider}, ${sealed.kekId}, ${sealed.wrappedDek},
              ${sealed.ciphertext}, ${sealed.nonce}, ${sealed.tag}, ${sealed.aad})
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
  return id;
}

describe('an export becomes a message in a channel', () => {
  it('carries the request all the way to the wire, once', async () => {
    const hook = await receiver('ok');
    await seedDestination(hook.url, 'discord');

    asUser(IDS.admin1, 'admin@northwind.test');
    await getExportService().request(
      { tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' },
      {
        organizationId: IDS.orgAcme,
        kind: 'client_offboarding',
        format: 'zip',
        reason: 'contractual handover of all documentation',
        includeSecrets: true,
      },
    );

    const first = await fanOut();
    expect(first.queued).toBe(1);

    const [claimed] = await claim();
    expect(await deliver(claimed!)).toBe(204);

    expect(hook.received).toHaveLength(1);
    const sent = hook.received[0]!.body as { content: string; embeds: unknown[] };
    // The words a human reads, and the shape Discord requires.
    expect(sent.content).toContain('CREDENTIAL-BEARING export');
    expect(sent.content).toContain('Acme');
    expect(sent.embeds).toHaveLength(1);

    // A second pass must not send it again — the cursor advanced and the
    // (endpoint, event_uid) constraint would refuse a duplicate anyway.
    expect((await fanOut()).queued).toBe(0);
    expect(await claim()).toHaveLength(0);
  });

  it('sends nothing for an event nobody subscribed to', async () => {
    const hook = await receiver('ok');
    await seedDestination(hook.url, 'generic', ['expiration.warning']);

    asUser(IDS.admin1, 'admin@northwind.test');
    await getExportService().request(
      { tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' },
      {
        organizationId: IDS.orgAcme,
        kind: 'client_offboarding',
        format: 'zip',
        reason: 'a reason long enough to pass',
      },
    );

    const result = await fanOut();
    expect(result.examined).toBeGreaterThan(0);
    expect(result.queued).toBe(0);
  });

  it('fans one event out to every subscribed destination', async () => {
    const discordHook = await receiver('ok');
    const teamsHook = await receiver('ok');
    await seedDestination(discordHook.url, 'discord');
    await seedDestination(teamsHook.url, 'teams');

    asUser(IDS.admin1, 'admin@northwind.test');
    await getExportService().request(
      { tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' },
      {
        organizationId: IDS.orgAcme,
        kind: 'client_offboarding',
        format: 'zip',
        reason: 'a reason long enough to pass',
      },
    );

    expect((await fanOut()).queued).toBe(2);
    for (const row of await claim()) await deliver(row);

    expect(discordHook.received).toHaveLength(1);
    expect(teamsHook.received).toHaveLength(1);

    // Same event, same words, different shapes.
    const asDiscord = discordHook.received[0]!.body as { embeds: unknown[] };
    const asTeams = teamsHook.received[0]!.body as { type: string; attachments: unknown[] };
    expect(asDiscord.embeds).toBeDefined();
    expect(asTeams.type).toBe('message');
    expect(JSON.stringify(asTeams)).toContain('AdaptiveCard');
  });

  it('records a refusal with the platform’s own words, and retries', async () => {
    // Discord answers 400 with a message naming the problem. Keeping it is the
    // difference between "delivery failed" and "Cannot send an empty message".
    const hook = await receiver('bad-request');
    await seedDestination(hook.url, 'discord');

    asUser(IDS.admin1, 'admin@northwind.test');
    await getExportService().request(
      { tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' },
      {
        organizationId: IDS.orgAcme,
        kind: 'client_offboarding',
        format: 'zip',
        reason: 'a reason long enough to pass',
      },
    );
    await fanOut();

    const [claimed] = await claim();
    expect(await deliver(claimed!)).toBe(400);

    const sql = superuserSql();
    try {
      const [row] = await sql<{ status: string; attempts: number; response_code: number }[]>`
        SELECT status, attempts, response_code FROM webhook_delivery
        WHERE id = ${claimed!.delivery_id}::uuid
      `;
      // Still pending: max_attempts is 3 and this was the first.
      expect(row!.status).toBe('pending');
      expect(row!.attempts).toBe(1);
      expect(row!.response_code).toBe(400);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

describe('the payload allow-list', () => {
  it('sends only the fields helm.notification_payload names', async () => {
    const hook = await receiver('ok');
    await seedDestination(hook.url, 'generic');

    asUser(IDS.admin1, 'admin@northwind.test');
    await getExportService().request(
      { tenantId: IDS.tenant1, actorId: IDS.admin1, actorType: 'user' },
      {
        organizationId: IDS.orgAcme,
        kind: 'client_offboarding',
        format: 'zip',
        reason: 'a reason long enough to pass',
        // `scope` is in the audit metadata and is deliberately NOT allow-listed.
        scope: { nodeIds: ['1d000000-0000-0000-0000-000000000001'] },
      },
    );
    await fanOut();
    const [claimed] = await claim();
    await deliver(claimed!);

    const sent = hook.received[0]!.body as { data: Record<string, unknown> };
    expect(Object.keys(sent.data).sort()).toEqual(
      ['expires_in_hours', 'format', 'include_secrets', 'kind'],
    );
    // The scope reached the audit log and stopped there.
    expect(hook.received[0]!.raw).not.toContain('nodeIds');
  });

  it('refuses a payload carrying a secret-shaped key, at any depth', async () => {
    // The database is the second line behind the allow-list. 0110's version
    // tested top-level keys only, so a nested password passed.
    const sql = superuserSql();
    try {
      await sql`
        INSERT INTO webhook_endpoint (id, tenant_id, name, format, events,
                                      url_host, url_digest, wrap_provider, kek_id,
                                      wrapped_dek, secret_ciphertext, secret_nonce,
                                      secret_tag, secret_aad)
        VALUES ('cc000000-0000-0000-0000-0000000000ff', ${IDS.tenant1}::uuid,
                'probe', 'generic', ARRAY['export.requested'],
                'example.test', 'abcdef012345', 'local', 'k1',
                '\\x00'::bytea, '\\x01'::bytea, gen_random_bytes(12),
                gen_random_bytes(16), 'aad')
      `;

      for (const payload of [
        { password: 'hunter2' },
        { detail: { password: 'hunter2' } },
        { items: [{ ok: 1 }, { wrapped_dek: 'x' }] },
      ]) {
        await expect(
          sql`
            INSERT INTO webhook_delivery (tenant_id, endpoint_id, event_type, event_uid,
                                          payload, subject)
            VALUES (${IDS.tenant1}::uuid, 'cc000000-0000-0000-0000-0000000000ff'::uuid,
                    'export.requested', gen_random_uuid(),
                    ${sql.json(payload)}::jsonb, 'probe')
          `,
        ).rejects.toThrow(/must not contain/);
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

describe('custody of the webhook URL', () => {
  it('helm_app cannot read the endpoint table, by any column', async () => {
    const sql = superuserSql();
    try {
      const rows = await sql<{ column_name: string; allowed: boolean }[]>`
        SELECT column_name,
               has_column_privilege('helm_app', 'webhook_endpoint', column_name, 'SELECT') AS allowed
        FROM information_schema.columns WHERE table_name = 'webhook_endpoint'
      `;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.filter((r) => r.allowed)).toEqual([]);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('never returns the URL to the browser, only a host and a digest', async () => {
    const hook = await receiver('ok');
    await seedDestination(hook.url, 'generic');

    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await getNotifications(request('GET'));
    const payload = JSON.stringify(await body(response));

    expect(payload).not.toContain(hook.url);
    expect(payload).toContain(digestOf(hook.url));
    expect(payload).toContain(hostOf(hook.url));
  });

  it('refuses an endpoint whose envelope names another endpoint', async () => {
    // The AAD binds to the ENDPOINT, not just the tenant — unlike RADIUS and
    // OIDC, a tenant has many destinations, so tenant-only binding would let a
    // row be copied between two of its own.
    const sealed = await sealWebhook(IDS.tenant1, 'cc000000-0000-0000-0000-000000000001', 'https://a.test/hook');
    const sql = superuserSql();
    try {
      await sql`
        INSERT INTO webhook_endpoint (id, tenant_id, name, format, events,
                                      url_host, url_digest, wrap_provider, kek_id,
                                      wrapped_dek, secret_ciphertext, secret_nonce,
                                      secret_tag, secret_aad)
        VALUES ('cc000000-0000-0000-0000-000000000002'::uuid, ${IDS.tenant1}::uuid,
                'stolen', 'generic', ARRAY['export.requested'],
                ${sealed.urlHost}, ${sealed.urlDigest}, ${sealed.wrapProvider},
                ${sealed.kekId}, ${sealed.wrappedDek}, ${sealed.ciphertext},
                ${sealed.nonce}, ${sealed.tag}, ${sealed.aad})
      `;
    } finally {
      await sql.end({ timeout: 5 });
    }

    await expect(
      openWebhook(IDS.tenant1, 'cc000000-0000-0000-0000-000000000002', {
        wrap_provider: sealed.wrapProvider,
        kek_id: sealed.kekId,
        wrapped_dek: sealed.wrappedDek,
        secret_ciphertext: sealed.ciphertext,
        secret_nonce: sealed.nonce,
        secret_tag: sealed.tag,
        secret_aad: sealed.aad,
      }),
    ).rejects.toThrow();
  });

  it('round-trips the URL and an optional signing secret through one envelope', async () => {
    const sealed = await sealWebhook(IDS.tenant1, IDS.orgAcme, 'https://a.test/hook', 'a-signing-secret-long-enough');
    const opened = await openWebhook(IDS.tenant1, IDS.orgAcme, {
      wrap_provider: sealed.wrapProvider,
      kek_id: sealed.kekId,
      wrapped_dek: sealed.wrappedDek,
      secret_ciphertext: sealed.ciphertext,
      secret_nonce: sealed.nonce,
      secret_tag: sealed.tag,
      secret_aad: sealed.aad,
    });
    expect(opened.url).toBe('https://a.test/hook');
    expect(opened.signingSecret).toBe('a-signing-secret-long-enough');
    expect(sealed.signingSecretSet).toBe(true);
  });

  it('refuses a plaintext destination', async () => {
    expect(isDeliverable('http://insecure.test/hook')).toBe(false);
    expect(isDeliverable('https://fine.test/hook')).toBe(true);

    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await putNotification(
      request('PUT', {
        name: 'insecure',
        format: 'generic',
        isActive: true,
        events: ['export.requested'],
        maxAttempts: 3,
        timeoutMs: 2000,
        url: 'http://insecure.test/hook',
      }),
    );
    expect(response.status).toBe(400);
  });
});

describe('who may point Helm at a channel', () => {
  it('refuses a role without integration:manage', async () => {
    const sql = superuserSql();
    try {
      await sql`
        UPDATE membership SET role_key = 'tier1'
        WHERE tenant_id = ${IDS.tenant1}::uuid AND user_id = ${IDS.tech1}::uuid
      `;
    } finally {
      await sql.end({ timeout: 5 });
    }

    asUser(IDS.tech1, 'tech@northwind.test');
    const response = await putNotification(
      request('PUT', {
        name: 'sneaky',
        format: 'generic',
        isActive: true,
        events: ['secret.revealed'],
        maxAttempts: 3,
        timeoutMs: 2000,
        url: 'https://elsewhere.test/hook',
      }),
    );
    expect(response.status).toBe(403);

    const restore = superuserSql();
    try {
      await restore`
        UPDATE membership SET role_key = 'tier2'
        WHERE tenant_id = ${IDS.tenant1}::uuid AND user_id = ${IDS.tech1}::uuid
      `;
    } finally {
      await restore.end({ timeout: 5 });
    }
  });

  it('refuses an event name Helm cannot raise', async () => {
    asUser(IDS.admin1, 'admin@northwind.test');
    const response = await putNotification(
      request('PUT', {
        name: 'typo',
        format: 'generic',
        isActive: true,
        events: ['export.requestd'],
        maxAttempts: 3,
        timeoutMs: 2000,
        url: 'https://fine.test/hook',
      }),
    );
    // A typo here is otherwise a channel that is simply never written to.
    expect(response.status).toBe(400);
  });
});
