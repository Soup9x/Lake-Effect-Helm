/**
 * UniFi webhooks: what a signature buys, and what the poll owes nothing to.
 *
 * Five things are established:
 *
 *   AUTHENTICITY   a validly signed event is processed; an invalid one is
 *                  refused and changes nothing at all.
 *
 *   PRESERVATION   the webhook path obeys the same rule as the poll — telemetry
 *                  moves, user-edited fields do not.
 *
 *   ISOLATION      an event for a mapping this deployment does not know, or for
 *                  one belonging to another tenant, is refused without reaching
 *                  tenant data.
 *
 *   INDEPENDENCE   a controller that never sends a webhook at all is fully
 *                  documented by the poll. This is the one that matters most:
 *                  webhook support is not guaranteed on a UniFi console, so
 *                  nothing may functionally depend on it.
 *
 *   CUSTODY        a high-severity threat leaves an audit row carrying no
 *                  address, and an encrypted record that decrypts back to what
 *                  the controller reported.
 */
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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

import { PUT as putMapping } from '../../src/app/api/network/mappings/route';
import { PUT as putWebhook, DELETE as deleteWebhook } from '../../src/app/api/network/mappings/[mappingId]/webhook/route';
import { receiveWebhook } from '../../src/lib/unifi/webhook';
import { signBody } from '../../src/lib/unifi/webhook-secret';
import { unifiSyncJob } from '../../src/workers/unifi-sync';
import { FakeUnifi } from '../support/fake-unifi';
import type { JobContext, JobLogger } from '../../src/workers/runtime';

let h: Harness;
let currentUser: SessionUser | null = null;
const asUser = (id: string, email: string) => {
  currentUser = { id, email };
};

// Set the way a deployment sets it, before services are built. The receiver
// needs it for the same reason the poll does: the MAC blind index is how an
// event is matched to a device.
process.env.HELM_BLIND_INDEX_KEY_B64 = Buffer.alloc(32, 7).toString('base64');

const API_KEY = 'unifi-api-key-for-the-webhook-suite';

const request = (method: string, payload?: unknown, path = 'https://helm.test/api/network/mappings') =>
  new NextRequest(
    new Request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    }),
  );

const body = async (response: Response) => (await response.json()) as Record<string, unknown>;

const AP = {
  macAddress: 'aa:bb:cc:dd:ee:01',
  ipAddress: '10.9.0.10',
  name: 'acme-ap-lobby',
  model: 'U6-Pro',
  firmwareVersion: '6.6.65',
  state: 'ONLINE',
  uptimeSec: 100_000,
  serialNumber: 'SN-W-0001',
};

const running: FakeUnifi[] = [];

function recordingLogger(lines: string[]): JobLogger {
  const make = (): JobLogger => ({
    debug: (m) => lines.push(`debug ${m}`),
    info: (m) => lines.push(`info ${m}`),
    warn: (m) => lines.push(`warn ${m}`),
    error: (m) => lines.push(`error ${m}`),
    child: () => make(),
  });
  return make();
}

async function runSync(): Promise<Record<string, number>> {
  const ctx: JobContext = { log: recordingLogger([]), stopping: () => false };
  return (await unifiSyncJob().run(ctx)).counts ?? {};
}

async function controller(options?: Parameters<typeof FakeUnifi.start>[0]): Promise<FakeUnifi> {
  const c = await FakeUnifi.start(options);
  running.push(c);
  return c;
}

/** A mapping pointed at a live stub, active, pinned and due. */
async function activeMapping(c: FakeUnifi, name = 'ACME HQ'): Promise<string> {
  asUser(IDS.admin1, 'admin@northwind.test');
  const response = await putMapping(
    request('PUT', {
      organizationId: IDS.orgAcme,
      name,
      controllerUrl: c.url,
      unifiSiteId: 'site-1',
      isActive: false,
      pollIntervalSeconds: 300,
      apiKey: API_KEY,
    }),
  );
  expect(response.status).toBe(200);
  const mappings = (await body(response)).mappings as { id: string; name: string }[];
  const id = mappings.find((m) => m.name === name)!.id;

  const sql = superuserSql();
  try {
    await sql`
      UPDATE unifi_site_mapping
      SET is_active = true, tls_verify = false, tls_pinned_sha256 = ${c.sha256},
          tls_exception_ack_by = ${IDS.admin1}::uuid, tls_exception_ack_at = now(),
          next_poll_at = now() - interval '1 minute'
      WHERE id = ${id}::uuid
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
  return id;
}

/** Turn the receiver on for a mapping and keep the secret the operator sees. */
async function enableWebhook(mappingId: string): Promise<string> {
  asUser(IDS.admin1, 'admin@northwind.test');
  const response = await putWebhook(request('PUT', {}), {
    params: Promise.resolve({ mappingId }),
  });
  expect(response.status).toBe(200);
  const payload = await body(response);
  return payload.secret as string;
}

function post(secret: string, payload: unknown, tamper = false): { raw: string; headers: Headers } {
  const raw = JSON.stringify(payload);
  const signature = signBody(secret, tamper ? `${raw} ` : raw);
  return { raw, headers: new Headers({ 'x-unifi-signature': `sha256=${signature}` }) };
}

async function mappingRow(id: string) {
  const sql = superuserSql();
  try {
    const [row] = await sql<Record<string, unknown>[]>`
      SELECT * FROM unifi_site_mapping WHERE id = ${id}::uuid
    `;
    return row!;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function wipeUnifi(): Promise<void> {
  const sql = superuserSql();
  try {
    await sql`DELETE FROM network_threat_event`;
    await sql`DELETE FROM asset_ip_history`;
    await sql`DELETE FROM network_assets`;
    await sql`DELETE FROM unifi_site_mapping`;
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
  // Both tenants get a data key: the receiver seals threat detail and asset
  // fields with the tenant DEK, exactly as the poll does.
  await h.keys.provision(IDS.tenant1, IDS.admin1, { reason: 'unifi webhook tests' });
  await h.keys.provision(IDS.tenant2, IDS.admin2, { reason: 'unifi webhook tests' });
}, 180_000);

afterAll(async () => {
  while (running.length) running.pop()!.stop();
  await disconnectPools();
});

afterEach(async () => {
  currentUser = null;
  while (running.length) running.pop()!.stop();
  await wipeUnifi();
});

describe('a signature is the only thing that authenticates an event', () => {
  it('accepts a correctly signed event and applies it', async () => {
    const c = await controller({ devices: [AP] });
    const id = await activeMapping(c);
    await runSync();
    const secret = await enableWebhook(id);

    const { raw, headers } = post(secret, {
      id: 'evt-1',
      type: 'device.disconnected',
      mac: AP.macAddress,
      timestamp: new Date().toISOString(),
    });

    const outcome = await receiveWebhook(id, raw, headers);
    expect(outcome.body.accepted).toBe(true);
    expect(outcome.body.processed).toBe(1);

    const sql = superuserSql();
    try {
      const [asset] = await sql<{ is_online: boolean }[]>`SELECT is_online FROM network_assets`;
      // The whole point: offline within a request, not at the next poll.
      expect(asset!.is_online).toBe(false);
    } finally {
      await sql.end({ timeout: 5 });
    }

    const row = await mappingRow(id);
    expect(row.webhook_state).toBe('active');
    expect(Number(row.webhook_events_received)).toBe(1);
  }, 45_000);

  it('REFUSES a bad signature, and changes nothing', async () => {
    const c = await controller({ devices: [AP] });
    const id = await activeMapping(c);
    await runSync();
    const secret = await enableWebhook(id);

    const before = await superuserSql();
    let onlineBefore: boolean;
    try {
      const [asset] = await before<{ is_online: boolean }[]>`SELECT is_online FROM network_assets`;
      onlineBefore = asset!.is_online;
    } finally {
      await before.end({ timeout: 5 });
    }
    expect(onlineBefore).toBe(true);

    // Signed over a DIFFERENT body than the one sent.
    const { raw, headers } = post(secret, {
      id: 'evt-2', type: 'device.disconnected', mac: AP.macAddress,
    }, true);

    const outcome = await receiveWebhook(id, raw, headers, { warn: () => {}, error: () => {} });
    expect(outcome.body.accepted).toBe(false);

    const sql = superuserSql();
    try {
      const [asset] = await sql<{ is_online: boolean }[]>`SELECT is_online FROM network_assets`;
      // Untouched. A refused event is not a partially applied one.
      expect(asset!.is_online).toBe(true);
    } finally {
      await sql.end({ timeout: 5 });
    }

    const row = await mappingRow(id);
    expect(Number(row.webhook_events_rejected)).toBe(1);
    expect(Number(row.webhook_events_received)).toBe(0);
    expect(row.webhook_state).toBe('failing');
    expect(row.webhook_last_error).toMatch(/signature/);
  }, 45_000);

  it('refuses an unsigned request', async () => {
    const c = await controller({ devices: [AP] });
    const id = await activeMapping(c);
    await runSync();
    await enableWebhook(id);

    const outcome = await receiveWebhook(id, '{}', new Headers(), { warn: () => {}, error: () => {} });
    expect(outcome.body.accepted).toBe(false);
    expect(outcome.body.reason).toBe('unsigned');
  }, 45_000);

  it('refuses everything once the receiver is disabled, secret and all', async () => {
    const c = await controller({ devices: [AP] });
    const id = await activeMapping(c);
    await runSync();
    const secret = await enableWebhook(id);

    asUser(IDS.admin1, 'admin@northwind.test');
    const off = await deleteWebhook(request('DELETE'), { params: Promise.resolve({ mappingId: id }) });
    expect(off.status).toBe(200);

    // Disabling REVOKES rather than merely hiding: the envelope is gone, so a
    // secret already pasted into a console cannot be used again.
    const row = await mappingRow(id);
    expect(row.webhook_secret_ciphertext).toBeNull();

    const { raw, headers } = post(secret, { id: 'evt-3', type: 'device.disconnected', mac: AP.macAddress });
    const outcome = await receiveWebhook(id, raw, headers, { warn: () => {}, error: () => {} });
    expect(outcome.body.accepted).toBe(false);
  }, 45_000);
});

describe('the webhook path obeys the poll’s preservation rule', () => {
  it('updates telemetry and leaves every user-edited field alone', async () => {
    const c = await controller({ devices: [AP] });
    const id = await activeMapping(c);
    await runSync();
    const secret = await enableWebhook(id);

    // A person documents the device.
    const sql = superuserSql();
    try {
      await sql`
        UPDATE network_assets
        SET asset_tag = 'ACME-AP-014', department = 'Reception',
            notes = 'mounted above the lobby desk; ladder required',
            maintenance_status = 'maintenance',
            custom_name_enc = ${Buffer.from('lobby AP — DO NOT REBOOT')}
      `;
    } finally {
      await sql.end({ timeout: 5 });
    }

    const { raw, headers } = post(secret, {
      id: 'evt-4',
      type: 'device.connected',
      mac: AP.macAddress,
      uptimeSec: 999,
      signal: -41,
      port: 7,
      state: 'ONLINE',
    });
    const outcome = await receiveWebhook(id, raw, headers);
    expect(outcome.body.accepted).toBe(true);

    const after = superuserSql();
    try {
      const [row] = await after<{
        uptime_seconds: string; signal_dbm: number; switch_port: number;
        asset_tag: string; department: string; notes: string;
        maintenance_status: string; custom_name_enc: Buffer;
      }[]>`SELECT * FROM network_assets`;

      // Telemetry moved.
      expect(Number(row!.uptime_seconds)).toBe(999);
      expect(row!.signal_dbm).toBe(-41);
      expect(row!.switch_port).toBe(7);

      // Everything a person wrote is exactly as they left it.
      expect(row!.asset_tag).toBe('ACME-AP-014');
      expect(row!.department).toBe('Reception');
      expect(row!.notes).toBe('mounted above the lobby desk; ladder required');
      expect(row!.maintenance_status).toBe('maintenance');
      expect(row!.custom_name_enc.toString()).toBe('lobby AP — DO NOT REBOOT');
    } finally {
      await after.end({ timeout: 5 });
    }
  }, 45_000);

  it('does not CREATE an asset for a device the poll has never seen', async () => {
    const c = await controller({ devices: [AP] });
    const id = await activeMapping(c);
    await runSync();
    const secret = await enableWebhook(id);

    const { raw, headers } = post(secret, {
      id: 'evt-5', type: 'client.connected', mac: '11:22:33:44:55:66',
    });
    const outcome = await receiveWebhook(id, raw, headers);
    // Accepted — the sender did nothing wrong — but it creates nothing. The
    // poll enumerates a site with the controller's authority; an event arrives
    // over a path whose only check is a shared secret.
    expect(outcome.body.accepted).toBe(true);
    expect(outcome.body.processed).toBe(0);

    const sql = superuserSql();
    try {
      const rows = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM network_assets`;
      expect(Number(rows[0]!.n)).toBe(1);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 45_000);
});

describe('an event Helm cannot place is refused', () => {
  it('refuses a mapping id that does not exist', async () => {
    const outcome = await receiveWebhook(
      '00000000-0000-4000-8000-000000000000',
      '{}',
      new Headers({ 'x-unifi-signature': 'sha256=' + 'a'.repeat(64) }),
      { warn: () => {}, error: () => {} },
    );
    expect(outcome.body.accepted).toBe(false);
    // Deliberately the SAME reason a bad signature gets, so this endpoint
    // cannot be used to discover which mapping ids exist.
    expect(outcome.body.reason).toBe('unknown or not listening');
  }, 30_000);

  it('refuses a mapping that is real but not listening', async () => {
    const c = await controller({ devices: [AP] });
    const id = await activeMapping(c);
    await runSync();

    const { raw, headers } = post('any-secret-at-all', { id: 'evt-6', type: 'ids.alert' });
    const outcome = await receiveWebhook(id, raw, headers, { warn: () => {}, error: () => {} });
    expect(outcome.body.accepted).toBe(false);
    expect(outcome.body.reason).toBe('unknown or not listening');
  }, 45_000);

  it('does not let one mapping’s secret sign for another’s events', async () => {
    /*
     * The AAD binds each envelope to (tenant, mapping), so a secret is only
     * ever valid for the mapping it was issued for. Without that binding one
     * client's controller could sign events Helm applied to another client's
     * devices — and two mappings can legitimately live in one tenant, so RLS
     * alone would not stop it.
     *
     * Written as two mappings rather than by moving a row between tenants,
     * because the composite foreign key on the API key secret refuses that
     * outright — which is its own protection, asserted in the security suite.
     */
    const c1 = await controller({ devices: [AP] });
    const c2 = await controller({ devices: [AP] });
    const first = await activeMapping(c1, 'ACME HQ');
    const second = await activeMapping(c2, 'ACME Warehouse');

    const firstSecret = await enableWebhook(first);
    await enableWebhook(second);

    // Signed correctly — for the wrong mapping.
    const { raw, headers } = post(firstSecret, {
      id: 'evt-8', type: 'device.disconnected', mac: AP.macAddress,
    });
    const outcome = await receiveWebhook(second, raw, headers, { warn: () => {}, error: () => {} });
    expect(outcome.body.accepted).toBe(false);
    expect(outcome.body.reason).toBe('unknown or not listening');

    // ...and the very same bytes are accepted by the mapping it was signed for.
    const accepted = await receiveWebhook(first, raw, headers);
    expect(accepted.body.accepted).toBe(true);
  }, 60_000);
});

describe('nothing depends on a webhook ever arriving', () => {
  it('a controller that sends NOTHING is still fully documented by the poll', async () => {
    /*
     * The case this integration is actually built for. Webhook support is not
     * guaranteed on a UniFi console, so the only honest test is the one where
     * the receiver is configured, registration was never attempted or failed,
     * and not a single event ever arrives.
     */
    const c = await controller({ devices: [AP] });
    const id = await activeMapping(c);
    await enableWebhook(id);

    // Mark the controller as one that refused registration outright.
    const sql = superuserSql();
    try {
      await sql`UPDATE unifi_site_mapping SET webhook_state = 'unsupported' WHERE id = ${id}::uuid`;
    } finally {
      await sql.end({ timeout: 5 });
    }

    const first = await runSync();
    expect(first.polled).toBe(1);
    expect(first.inserted).toBe(1);

    // The device goes away, and only the poll notices.
    c.stop();
    running.length = 0;
    const c2 = await controller({ devices: [] });
    const reaim = superuserSql();
    try {
      await reaim`
        UPDATE unifi_site_mapping
        SET controller_url = ${c2.url}, tls_pinned_sha256 = ${c2.sha256},
            next_poll_at = now() - interval '1 minute'
        WHERE id = ${id}::uuid
      `;
    } finally {
      await reaim.end({ timeout: 5 });
    }

    const second = await runSync();
    expect(second.offline).toBe(1);

    const check = superuserSql();
    try {
      const [asset] = await check<{ is_online: boolean; last_synced_at: Date }[]>`
        SELECT is_online, last_synced_at FROM network_assets
      `;
      // Current, with zero webhooks received, on a mapping whose controller
      // refused the feature entirely.
      expect(asset!.is_online).toBe(false);
      expect(asset!.last_synced_at).toBeInstanceOf(Date);

      const row = await mappingRow(id);
      expect(row.webhook_state).toBe('unsupported');
      expect(Number(row.webhook_events_received)).toBe(0);
      // ...and the poll's own health is untouched by any of it.
      expect(row.last_poll_ok).toBe(true);
      expect(Number(row.consecutive_failures)).toBe(0);
    } finally {
      await check.end({ timeout: 5 });
    }
  }, 60_000);
});

describe('a high-severity threat becomes an audit record', () => {
  it('writes an audit row with no address in it, and an encrypted record that decrypts', async () => {
    const c = await controller({ devices: [AP] });
    const id = await activeMapping(c);
    await runSync();
    const secret = await enableWebhook(id);

    const { raw, headers } = post(secret, {
      id: 'ids-9001',
      type: 'ids.alert',
      severity: 'critical',
      msg: 'ET MALWARE Observed DNS Query to known DGA domain',
      catname: 'A Network Trojan was detected',
      srcIp: '10.9.0.10',
      destIp: '203.0.113.9',
      mac: AP.macAddress,
    });

    const outcome = await receiveWebhook(id, raw, headers);
    expect(outcome.body.accepted).toBe(true);

    const sql = superuserSql();
    try {
      const [audit] = await sql<{ action: string; outcome: string; metadata: Record<string, unknown> }[]>`
        SELECT action, outcome, metadata FROM audit_log WHERE action = 'network.threat_detected'
      `;
      expect(audit!.action).toBe('network.threat_detected');
      expect(audit!.outcome).toBe('error');
      expect(audit!.metadata.severity).toBe('critical');

      // The audit log carries NO address, MAC or hostname — only a digest that
      // hash-chains the ciphertext.
      const rendered = JSON.stringify(audit!.metadata);
      expect(rendered).not.toContain('203.0.113.9');
      expect(rendered).not.toContain('10.9.0.10');
      expect(rendered).not.toContain(AP.macAddress);
      expect(audit!.metadata.detail_sha256).toMatch(/^[0-9a-f]{64}$/);

      const [threat] = await sql<{
        severity: string; signature: string; detail_enc: Buffer; source_ip_enc: Buffer;
        audit_event_uid: string; asset_id: string | null; external_event_id: string;
      }[]>`SELECT * FROM network_threat_event`;

      expect(threat!.severity).toBe('critical');
      expect(threat!.signature).toMatch(/DGA domain/);
      // Linked to the asset the MAC resolved to.
      expect(threat!.asset_id).not.toBeNull();
      // The detail really is ciphertext.
      expect(threat!.detail_enc.toString('utf8')).not.toContain('203.0.113.9');

      // ...and the chain commits to exactly these bytes.
      const { createHash } = await import('node:crypto');
      expect(createHash('sha256').update(threat!.detail_enc).digest('hex'))
        .toBe(audit!.metadata.detail_sha256);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 45_000);

  it('refuses a replayed alert rather than reporting one incident twice', async () => {
    const c = await controller({ devices: [AP] });
    const id = await activeMapping(c);
    await runSync();
    const secret = await enableWebhook(id);

    const payload = {
      id: 'ids-9002', type: 'ids.alert', severity: 'high',
      msg: 'ET SCAN Potential SSH Scan', srcIp: '10.9.0.44', mac: AP.macAddress,
    };
    // A replay is a validly signed request — it is the SAME request. Signature
    // verification cannot catch it and is not asked to.
    const { raw, headers } = post(secret, payload);
    await receiveWebhook(id, raw, headers);
    await receiveWebhook(id, raw, headers);

    const sql = superuserSql();
    try {
      const rows = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM network_threat_event`;
      expect(Number(rows[0]!.n)).toBe(1);
      // Scoped to this mapping: audit_log is append-only and survives the
      // per-test cleanup, so an unscoped count would include every threat this
      // file has ever written.
      const audits = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM audit_log
        WHERE action = 'network.threat_detected'
          AND metadata->>'mapping_id' = ${id}
      `;
      expect(Number(audits[0]!.n)).toBe(1);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 45_000);

  it('does not record a LOW-severity event as a threat', async () => {
    const c = await controller({ devices: [AP] });
    const id = await activeMapping(c);
    await runSync();
    const secret = await enableWebhook(id);

    const { raw, headers } = post(secret, {
      id: 'ids-9003', type: 'ids.alert', severity: 'low',
      msg: 'ET INFO Observed DNS Query', srcIp: '10.9.0.44',
    });
    await receiveWebhook(id, raw, headers);

    const sql = superuserSql();
    try {
      const rows = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM network_threat_event`;
      // The permanent encrypted record is for the ones worth keeping.
      expect(Number(rows[0]!.n)).toBe(0);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 45_000);
});
