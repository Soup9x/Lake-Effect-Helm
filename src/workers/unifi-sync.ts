/**
 * UniFi reconciliation.
 *
 * One job, unlike the alert and notification workers which split evaluation
 * from delivery. There is nothing to split here: a poll reads a controller and
 * writes what it read, and the two halves have no independent failure mode
 * worth separating.
 *
 * WHAT THIS MUST NEVER DO, and how it is prevented rather than remembered:
 *
 *   OVERWRITE A USER'S EDIT. helm.upsert_network_asset() does not name
 *   custom_name_enc, asset_tag, department, notes, maintenance_status or
 *   organization_id in its UPDATE branch — absent, not coalesced — and a
 *   migration guard fails if one appears. This file could not clobber them if
 *   it tried, which is the point: the guarantee does not depend on this file
 *   staying careful.
 *
 *   LET ONE TENANT BLOCK ANOTHER. Every mapping is claimed, polled and
 *   finished independently, and a throw is caught per mapping. A controller
 *   that is down backs off through next_poll_at without touching anybody
 *   else's schedule.
 *
 *   RACE ITSELF. helm.claim_unifi_poll() takes the row with FOR UPDATE SKIP
 *   LOCKED and pushes next_poll_at forward by a claim window, so a second
 *   worker skips instead of blocking and a worker that dies mid-poll leaves
 *   the claim standing until it lapses.
 *
 * The API key is revealed through helm.reveal_secret() with purpose
 * 'integration', which writes one audit row per poll naming the actor and the
 * credential. That is the whole reason the key lives in `secret` rather than in
 * a column on the mapping.
 */
import { withTenant, db } from '../lib/db/client';
import { seedTopologyFromPoll } from '../lib/topology/sync';
import type { Job, JobContext, JobResult } from './runtime';
import { describeError } from './runtime';
import { getBlindIndex, getDekCache, getSecretService } from '../lib/services';
import { activeDataKey } from '../lib/secrets/keys';
import { UnifiError, listClients, listDevices, type UnifiRecord } from '../lib/unifi/client';
import { normaliseIp, normaliseMac, sealAssetField } from '../lib/unifi/fields';

interface BacklogRow {
  mapping_id: string;
  tenant_id: string;
  tenant_name: string;
  worker_actor_id: string;
  organization_id: string;
  name: string;
  controller_url: string;
  unifi_site_id: string;
  api_key_secret_id: string;
  tls_verify: boolean;
  tls_pinned_sha256: string | null;
  poll_interval_seconds: number;
  consecutive_failures: number;
}

/**
 * How long a claim is held before another worker may retry the mapping.
 *
 * Long enough that a slow poll of a large site finishes inside it, short enough
 * that a worker killed mid-poll does not strand the mapping for an afternoon.
 * Not configurable: an operator who shortens it below the poll duration gets
 * two workers on one controller, which is the failure this exists to prevent.
 */
const CLAIM_SECONDS = 600;

/** Per-controller request budget. A site with 450 devices is three pages. */
const REQUEST_TIMEOUT_MS = 20_000;

export function unifiSyncJob(): Job {
  return {
    name: 'unifi.sync',
    // The scheduler ticks often; WHICH mappings are due is decided by
    // next_poll_at in the database, from each mapping's own interval. This
    // number is the granularity of "due", not the polling rate.
    everyMs: 30 * 1000,
    lockKey: 0x48_45_4c_4d_0a,
    run: syncUnifi,
  };
}

async function syncUnifi(ctx: JobContext): Promise<JobResult> {
  const blindIndex = getBlindIndex();
  if (!blindIndex) {
    /*
     * HARD REQUIREMENT, NOT A DEGRADED MODE.
     *
     * The upsert key IS the MAC blind index. Without HELM_BLIND_INDEX_KEY_B64
     * there is no key to compute it with, so there is no way to recognise a
     * device seen before — every poll would insert duplicates, or the job would
     * write nothing at all.
     *
     * Said loudly and once per run rather than silently skipped, because
     * "network inventory is empty" with no explanation is exactly the kind of
     * quiet nothing this project keeps trying not to ship.
     */
    ctx.log.error('unifi sync needs HELM_BLIND_INDEX_KEY_B64 and it is not set', {
      consequence: 'no controller will be polled until it is configured',
    });
    return { idle: true };
  }

  const backlog = await db('worker')<BacklogRow[]>`SELECT * FROM helm.unifi_poll_backlog(25)`;
  if (backlog.length === 0) return { idle: true };

  let polled = 0;
  let failed = 0;
  let skipped = 0;
  let inserted = 0;
  let updated = 0;
  let offline = 0;
  let topologyNodes = 0;
  let topologyLinks = 0;

  for (const mapping of backlog) {
    if (ctx.stopping()) break;

    const actor = {
      tenantId: mapping.tenant_id,
      actorId: mapping.worker_actor_id,
      actorType: 'service_account' as const,
    };
    const log = ctx.log.child({ tenant: mapping.tenant_name, mapping: mapping.name });

    // Claim before doing anything expensive. A peer that already holds this
    // mapping means there is nothing to do, not that something went wrong.
    const claimed = await withTenant(
      actor,
      async (tx) => {
        const [row] = await tx<{ claim_unifi_poll: boolean }[]>`
          SELECT helm.claim_unifi_poll(${mapping.mapping_id}::uuid, ${CLAIM_SECONDS})
        `;
        return row?.claim_unifi_poll === true;
      },
      { role: 'worker' },
    );

    if (!claimed) {
      skipped += 1;
      continue;
    }

    // Stamped BEFORE the poll. finish_unifi_poll marks anything not touched
    // since this instant as offline, so taking it after would race devices seen
    // during a slow poll and flip them off.
    const startedAt = new Date();

    try {
      const counts = await pollOne(mapping, actor, startedAt, log);
      polled += 1;
      inserted += counts.inserted;
      updated += counts.updated;

      const wentOffline = await withTenant(
        actor,
        async (tx) => {
          const [row] = await tx<{ finish_unifi_poll: number }[]>`
            SELECT helm.finish_unifi_poll(
              ${mapping.mapping_id}::uuid, true,
              ${counts.devices}, ${counts.clients}, NULL, ${startedAt})
          `;
          return Number(row?.finish_unifi_poll ?? 0);
        },
        { role: 'worker' },
      );
      offline += wentOffline;

      /*
       * The diagram, after the inventory it draws.
       *
       * AFTER finish_unifi_poll, not before: that call is what marks devices
       * the controller no longer reports as offline, and the seeder reads only
       * online ones. Seeding first would re-create a box for a device that had
       * just been retired, which is the one thing that makes deleting a synced
       * node feel broken.
       *
       * In its own transaction, and failure is logged rather than thrown. A
       * controller that polled cleanly has done its job; a topology that could
       * not be drawn is not a reason to mark the poll failed and back it off.
       */
      const seeded = await withTenant(
        actor,
        (tx) => seedTopologyFromPoll(tx, mapping.tenant_id, mapping.mapping_id),
        { role: 'worker' },
      ).catch((error: unknown) => {
        log.warn('topology could not be seeded', describeError(error));
        return null;
      });

      if (seeded?.siteId) {
        topologyNodes += seeded.nodes;
        topologyLinks += seeded.links;
      }

      log.info('polled', {
        devices: counts.devices,
        clients: counts.clients,
        inserted: counts.inserted,
        updated: counts.updated,
        wentOffline,
        ...(seeded?.siteId
          ? { topologyNodes: seeded.nodes, topologyLinks: seeded.links }
          : {}),
      });
    } catch (error) {
      failed += 1;

      // One controller's failure must not abandon the rest — the backoff lives
      // in finish_unifi_poll so this mapping waits longer and every other
      // mapping keeps its own schedule.
      const described = describeError(error);
      const message =
        error instanceof UnifiError
          ? `${error.message}${error.remedy ? ` — ${error.remedy}` : ''}`
          : String(described.error ?? 'poll failed');

      log.warn('poll failed', { kind: error instanceof UnifiError ? error.kind : 'unknown', ...described });

      await withTenant(
        actor,
        async (tx) => tx`
          SELECT helm.finish_unifi_poll(
            ${mapping.mapping_id}::uuid, false, NULL, NULL, ${message}, NULL)
        `,
        { role: 'worker' },
      ).catch((recordError) => {
        // The poll already failed; failing to record that must not take the
        // whole run down with it.
        log.error('could not record the failure', describeError(recordError));
      });
    }
  }

  return {
    counts: {
      mappings: backlog.length, polled, failed, skipped, inserted, updated, offline,
      topologyNodes, topologyLinks,
    },
    idle: polled === 0 && failed === 0,
  };
}

interface PollCounts {
  devices: number;
  clients: number;
  inserted: number;
  updated: number;
}

async function pollOne(
  mapping: BacklogRow,
  actor: { tenantId: string; actorId: string; actorType: 'service_account' },
  startedAt: Date,
  log: JobContext['log'],
): Promise<PollCounts> {
  /*
   * The API key, through the audited reveal path.
   *
   * purpose 'integration' is what the sync service account is pinned to, and
   * helm.is_integration_credential() was extended in 0430 to recognise a
   * mapping's key — without that this call is refused on every poll with
   * 'not_an_integration_credential'.
   */
  const revealed = await getSecretService().reveal(actor, mapping.api_key_secret_id, {
    purpose: 'integration',
    role: 'worker',
    reason: `UniFi inventory sync for ${mapping.name}`,
  });

  let devices: UnifiRecord[];
  let clients: UnifiRecord[];

  try {
    const target = {
      controllerUrl: mapping.controller_url,
      // .expose() is the deliberate, greppable path out of a SecretValue. The
      // plaintext lives for the two requests below and is disposed in the
      // finally, so a controller that hangs does not leave a key in memory for
      // the length of the timeout and beyond.
      apiKey: revealed.value.expose(),
      pinnedSha256: mapping.tls_pinned_sha256,
      timeoutMs: REQUEST_TIMEOUT_MS,
    };

    [devices, clients] = await Promise.all([
      listDevices(target, mapping.unifi_site_id),
      listClients(target, mapping.unifi_site_id),
    ]);
  } finally {
    revealed.value.dispose();
  }

  let inserted = 0;
  let updated = 0;

  // Devices first, then clients. A UniFi AP appears in both lists on some
  // versions; taking the device record second would overwrite the richer one
  // with the thinner one, so the device pass wins by going first and the client
  // pass skips a MAC it has already seen this run.
  const seen = new Set<string>();

  for (const record of [
    ...devices.map((r) => ({ record: r, type: 'unifi_device' as const })),
    ...clients.map((r) => ({ record: r, type: 'client_device' as const })),
  ]) {
    const mac = normaliseMac(pick(record.record, 'macAddress', 'mac', 'hwaddr'));
    if (!mac) {
      // A record with no usable MAC cannot be matched on the next poll, so
      // storing it would create a duplicate every time. Counted by its absence
      // rather than guessed at.
      continue;
    }
    if (seen.has(mac)) continue;
    seen.add(mac);

    const result = await upsertOne(mapping, actor, record.record, record.type, mac, startedAt);
    if (result === 'inserted') inserted += 1;
    else if (result === 'updated') updated += 1;
  }

  if (seen.size === 0 && devices.length + clients.length > 0) {
    // Everything the controller returned was unusable, which is a shape problem
    // rather than an empty site and is worth saying.
    log.warn('the controller returned records with no recognisable MAC address', {
      devices: devices.length,
      clients: clients.length,
    });
  }

  return { devices: devices.length, clients: clients.length, inserted, updated };
}

async function upsertOne(
  mapping: BacklogRow,
  actor: { tenantId: string; actorId: string; actorType: 'service_account' },
  record: UnifiRecord,
  assetType: 'unifi_device' | 'client_device',
  mac: string,
  seenAt: Date,
): Promise<'inserted' | 'updated' | 'skipped'> {
  const blindIndex = getBlindIndex();
  if (!blindIndex) return 'skipped';

  const macIndex = blindIndex.compute(mapping.tenant_id, Buffer.from(mac, 'utf8'));

  const ip = normaliseIp(pick(record, 'ipAddress', 'ip', 'lastIp'));
  const hostname = str(pick(record, 'hostname', 'name', 'displayName'));
  const serial = str(pick(record, 'serialNumber', 'serial'));
  const uplinkMac = normaliseMac(pick(record, 'uplinkMac', 'uplinkMacAddress', 'apMac'));

  return withTenant(
    actor,
    async (tx) => {
      // The tenant's current data key, read inside the transaction so a
      // rotation between poll and write cannot leave a row sealed under a key
      // the row does not name. activeDataKey is the same helper SecretService
      // uses, so this path cannot drift from the one that writes credentials.
      const key = await activeDataKey(tx, mapping.tenant_id);
      const dek = await getDekCache().get({
        dataKeyId: key.id,
        wrappedDek: key.wrappedDek,
        kekId: key.kekId,
        context: key.wrapContext,
      });

      // The DEK below is NOT wiped by this function. DekCache hands back the
      // buffer it holds rather than a copy, so zeroing it would blank the
      // cached entry and every later caller would decrypt to garbage. The
      // cache owns that lifetime and clears it on eviction.
      // The asset id is part of the AAD, so it has to exist before the fields
      // are sealed. Taken from the existing row when there is one, and minted
      // here when there is not — the same value then goes into the insert.
      const [existing] = await tx<{ id: string }[]>`
        SELECT id FROM network_assets
        WHERE tenant_id = ${mapping.tenant_id}::uuid AND mac_blind_index = ${macIndex}
      `;
      const assetId = existing?.id ?? crypto.randomUUID();

      const upsert = async (id: string) => {
        const seal = (field: Parameters<typeof sealAssetField>[3], value: string | null) =>
          sealAssetField(dek, mapping.tenant_id, id, field, value);

        const [row] = await tx<{ asset_id: string; was_insert: boolean }[]>`
        SELECT * FROM helm.upsert_network_asset(
          ${id}::uuid,
          ${mapping.mapping_id}::uuid,
          ${mapping.organization_id}::uuid,
          ${assetType}::network_asset_type,
          ${macIndex},
          ${key.id}::uuid,
          ${seal('mac_address', mac)},
          ${seal('ip_address', ip)},
          ${seal('hostname', hostname)},
          ${seal('serial', serial)},
          ${str(pick(record, 'model', 'modelName'))},
          ${str(pick(record, 'firmwareVersion', 'version'))},
          ${str(pick(record, 'state', 'status'))},
          ${num(pick(record, 'uptimeSec', 'uptime'))},
          ${smallNum(pick(record, 'signalDbm', 'signal', 'rssi'))},
          ${num(pick(record, 'switchPort', 'swPort', 'port'))},
          ${uplinkMac ? blindIndex.compute(mapping.tenant_id, Buffer.from(uplinkMac, 'utf8')) : null},
          ${num(pick(record, 'vlanId', 'vlan', 'networkId'))},
          ${str(pick(record, 'ssid', 'essid'))},
          ${bool(pick(record, 'isWired', 'wired'))},
          ${seenAt})
      `;
        return row;
      };

      let row = await upsert(assetId);
      if (!row) return 'skipped';

      /*
       * The id the database settled on, which is not always the one we sealed
       * against. A peer inserting the same MAC between the SELECT above and
       * this insert wins the ON CONFLICT, and the row comes back carrying ITS
       * id — leaving the columns just written bound to an AAD naming an id no
       * row has, which is unreadable ciphertext that looks like a clean write.
       *
       * Rare, and it is precisely the case two concurrent polls produce, so it
       * is handled rather than hoped about: re-seal against the id that won and
       * write once more. The second call takes the UPDATE branch and is
       * idempotent.
       */
      if (row.asset_id !== assetId) {
        const settled = await upsert(row.asset_id);
        if (settled) row = settled;
      }

      if (ip) {
        await tx`
          SELECT helm.record_asset_ip(
            ${row.asset_id}::uuid, ${key.id}::uuid,
            ${sealAssetField(dek, mapping.tenant_id, row.asset_id, 'ip_address', ip)},
            ${blindIndex.compute(mapping.tenant_id, Buffer.from(ip, 'utf8'))},
            ${seenAt})
        `;
      }

      return row.was_insert ? 'inserted' : 'updated';
    },
    { role: 'worker' },
  );
}

/** First present value among several spellings the controller has used. */
function pick(record: UnifiRecord, ...names: string[]): unknown {
  for (const name of names) {
    const value = record[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function str(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number') return String(value);
  return null;
}

function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * A smallint column, clamped to what it can hold.
 *
 * signal_dbm has a CHECK of -120..0 and a controller reporting 0 for "not
 * applicable" is common. Out-of-range becomes null rather than failing the
 * whole upsert over a telemetry field nobody reads.
 */
function smallNum(value: unknown): number | null {
  const n = num(value);
  if (n === null) return null;
  return n >= -120 && n <= 0 ? n : null;
}

function bool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}
