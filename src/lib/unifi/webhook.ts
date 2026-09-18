/**
 * The inbound webhook receiver.
 *
 * WHAT THIS IS FOR, AND WHAT IT IS NOT
 *
 * A supplement to the poll, never a replacement. Everything here writes state
 * the sync worker would have written anyway, a few minutes sooner. If no
 * webhook ever arrives — because the console does not support them, because the
 * registration call 404s, because a firewall eats them — the inventory stays
 * correct and nothing anywhere reports a problem, because there is none.
 *
 * That shapes the error handling throughout: a failure in here is logged and
 * counted and never retried, because the poll is the retry.
 *
 * ORDER OF OPERATIONS, WHICH IS THE SECURITY PROPERTY
 *
 *   1. Read the raw body as BYTES. The signature covers exactly what was sent,
 *      and JSON.parse followed by re-serialisation does not reproduce it.
 *   2. Look the mapping up by the id in the path. One row, by primary key.
 *   3. Verify the signature. Nothing is parsed, decoded or written before this.
 *   4. Only then open a tenant context and act.
 *
 * A request that fails step 2 or 3 reaches no tenant data at all, and the
 * response says nothing about which of the two it failed — an unknown mapping
 * and a bad secret are deliberately indistinguishable from outside, so this
 * endpoint cannot be used to discover which mapping ids exist.
 */
import { createHash } from 'node:crypto';
import { db, withTenant } from '../db/client';
import { getBlindIndex, getKekProvider } from '../services';
import { activeDataKey } from '../secrets/keys';
import { sealAssetField } from './fields';
import { openWebhookSecret, signatureFrom, verifySignature } from './webhook-secret';
import { isHighSeverity, parseEvents, type UnifiEvent } from './events';
import { sealField, wipe } from '../crypto/envelope';

export interface WebhookOutcome {
  readonly status: number;
  readonly body: { accepted: boolean; reason?: string; processed?: number };
}

interface TargetRow {
  tenant_id: string;
  organization_id: string;
  unifi_site_id: string;
  webhook_state: string;
  worker_actor_id: string;
  wrap_provider: string;
  kek_id: string;
  wrapped_dek: Buffer;
  secret_ciphertext: Buffer;
  secret_nonce: Buffer;
  secret_tag: Buffer;
  secret_aad: string;
}

/**
 * One refusal shape for every rejection.
 *
 * 202 rather than 4xx on a refusal is deliberate. A controller that receives an
 * error retries, and a controller retrying a request Helm will never accept is
 * a loop neither side can break. "Received, not acted on" is the truthful
 * answer and the one that stops.
 */
function refuse(reason: string): WebhookOutcome {
  return { status: 202, body: { accepted: false, reason } };
}

export interface ReceiverLog {
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const consoleLog: ReceiverLog = {
  warn: (m, f) => console.warn(JSON.stringify({ level: 'warn', msg: m, ...f })),
  error: (m, f) => console.error(JSON.stringify({ level: 'error', msg: m, ...f })),
};

/** A body larger than this is refused unread. A console sends kilobytes. */
const MAX_BODY_BYTES = 1_000_000;

export async function receiveWebhook(
  mappingId: string,
  rawBody: string,
  headers: Headers,
  log: ReceiverLog = consoleLog,
): Promise<WebhookOutcome> {
  if (rawBody.length > MAX_BODY_BYTES) {
    return refuse('body too large');
  }

  const [target] = await db('app')<TargetRow[]>`
    SELECT * FROM helm.unifi_webhook_target(${mappingId}::uuid)
  `;

  // Unknown, disabled, or a controller that refused registration. Counted where
  // possible and otherwise dropped — note_unifi_webhook is safe to call for an
  // id that does not exist, and updates nothing.
  if (!target) {
    await db('app')`SELECT helm.note_unifi_webhook(${mappingId}::uuid, false, ${'no such listening mapping'})`;
    log.warn('unifi webhook for an unknown or non-listening mapping', { mappingId });
    return refuse('unknown or not listening');
  }

  const presented = signatureFrom(headers);
  if (!presented) {
    await db('app')`SELECT helm.note_unifi_webhook(${mappingId}::uuid, false, ${'no signature header'})`;
    log.warn('unifi webhook with no signature', { mappingId });
    return refuse('unsigned');
  }

  let secret: Buffer;
  try {
    secret = await openWebhookSecret(target.tenant_id, mappingId, target);
  } catch (error) {
    // The envelope will not open: a KEK that moved, a rotated key, a row copied
    // between deployments. An operational fault, not a caller's mistake.
    log.error('unifi webhook secret could not be opened', {
      mappingId,
      error: error instanceof Error ? error.message : String(error),
    });
    await db('app')`SELECT helm.note_unifi_webhook(${mappingId}::uuid, false, ${'signing secret could not be opened'})`;
    return refuse('receiver misconfigured');
  }

  try {
    if (!verifySignature(secret, rawBody, presented)) {
      // NOTHING has been parsed or written at this point, and nothing will be.
      await db('app')`SELECT helm.note_unifi_webhook(${mappingId}::uuid, false, ${'signature did not verify'})`;
      log.warn('unifi webhook failed signature verification', { mappingId });
      return refuse('unknown or not listening');
    }
  } finally {
    wipe(secret);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    await db('app')`SELECT helm.note_unifi_webhook(${mappingId}::uuid, false, ${'body is not JSON'})`;
    return refuse('not json');
  }

  const events = parseEvents(parsed);
  if (events.length === 0) {
    await db('app')`SELECT helm.note_unifi_webhook(${mappingId}::uuid, true, NULL)`;
    return { status: 202, body: { accepted: true, processed: 0 } };
  }

  let processed = 0;
  try {
    processed = await applyEvents(mappingId, target, events, log);
  } catch (error) {
    // Deliberately swallowed past this point. The signature was valid, so the
    // sender did its job; a failure applying the event is Helm's problem and
    // the poll will correct it. Telling the controller to retry would achieve
    // nothing except a loop.
    log.error('unifi webhook accepted but could not be applied', {
      mappingId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  await db('app')`SELECT helm.note_unifi_webhook(${mappingId}::uuid, true, NULL)`;
  return { status: 202, body: { accepted: true, processed } };
}

/**
 * Apply verified events inside the mapping's tenant.
 *
 * As `system_sync`, the identity the poll runs as. The same rows are written
 * for the same reasons, so a second machine identity would only make the audit
 * trail harder to read.
 */
async function applyEvents(
  mappingId: string,
  target: TargetRow,
  events: UnifiEvent[],
  log: ReceiverLog,
): Promise<number> {
  const blindIndex = getBlindIndex();
  if (!blindIndex) {
    // Same hard requirement as the poll: with no key there is no way to find
    // the asset an event is about. Said once, loudly, rather than silently
    // doing nothing.
    log.error('unifi webhook needs HELM_BLIND_INDEX_KEY_B64 and it is not set', {
      mappingId,
      consequence: 'events cannot be matched to a device; the poll is unaffected',
    });
    return 0;
  }

  return withTenant(
    {
      tenantId: target.tenant_id,
      actorId: target.worker_actor_id,
      actorType: 'service_account',
    },
    async (tx) => {
      const key = await activeDataKey(tx, target.tenant_id);
      const dek = await getKekProvider().unwrapDek(
        key.wrappedDek,
        key.kekId,
        key.wrapContext,
      );

      let applied = 0;
      try {
        for (const event of events) {
          if (await applyOne(tx, mappingId, target, event, blindIndex, key.id, dek)) {
            applied += 1;
          }
        }
      } finally {
        wipe(dek);
      }
      return applied;
    },
  );
}

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];
type BlindIndexer = NonNullable<ReturnType<typeof getBlindIndex>>;

async function applyOne(
  tx: Tx,
  mappingId: string,
  target: TargetRow,
  event: UnifiEvent,
  blindIndex: BlindIndexer,
  dataKeyId: string,
  dek: Buffer,
): Promise<boolean> {
  let assetId: string | null = null;
  let telemetryApplied = false;

  if (event.mac) {
    const macIndex = blindIndex.compute(target.tenant_id, Buffer.from(event.mac, 'utf8'));

    /*
     * THE ID IS RESOLVED BEFORE ANYTHING IS SEALED, and that ordering is not
     * incidental.
     *
     * ip_address_enc is bound by AAD to the ASSET's id — that is how 0430's
     * upsert seals it and how openAssetField reads it back. An earlier draft of
     * this function sealed against the blind index instead, because the update
     * returns the id and the ciphertext has to exist before the update runs.
     * The result would have been a column the interface could not decrypt at
     * all: written successfully, unreadable until the next poll overwrote it,
     * and silent in between. One extra SELECT is the whole cost of not doing
     * that.
     */
    const [existing] = await tx<{ id: string }[]>`
      SELECT id FROM network_assets WHERE mac_blind_index = ${macIndex}
    `;
    assetId = existing?.id ?? null;

    // An event about a device the poll has never enumerated updates nothing.
    // The webhook is not a creation path; see the migration for why.
    if (assetId !== null && event.online !== null) {
      const ipEnc = event.ip && event.online
        ? sealAssetField(dek, target.tenant_id, assetId, 'ip_address', event.ip)
        : null;

      const [row] = await tx<{ apply_webhook_telemetry: string | null }[]>`
        SELECT helm.apply_webhook_telemetry(
          ${macIndex},
          ${event.online},
          ${ipEnc},
          ${ipEnc ? dataKeyId : null}::uuid,
          ${event.deviceState},
          ${event.uptimeSeconds},
          ${event.signalDbm},
          ${event.switchPort},
          ${event.occurredAt ?? null})
      `;
      telemetryApplied = row?.apply_webhook_telemetry !== null && row?.apply_webhook_telemetry !== undefined;
    }
  }

  if (event.kind !== 'threat' || !isHighSeverity(event.severity)) {
    return telemetryApplied;
  }

  // The whole original goes in sealed: a controller's event can carry addresses
  // and hostnames anywhere in its structure, and picking over it field by field
  // would mean deciding, for every future firmware, which new key is sensitive.
  const detail = Buffer.from(JSON.stringify(event.raw), 'utf8');
  const detailEnc = sealThreatField(dek, target.tenant_id, mappingId, 'detail', detail);
  wipe(detail);

  await tx`
    SELECT helm.record_network_threat(
      ${mappingId}::uuid,
      ${target.organization_id}::uuid,
      ${assetId}::uuid,
      ${event.severity},
      ${event.signature},
      ${event.category},
      ${event.occurredAt ?? null},
      ${dataKeyId}::uuid,
      ${event.sourceIp ? sealThreatField(dek, target.tenant_id, mappingId, 'source_ip', Buffer.from(event.sourceIp, 'utf8')) : null},
      ${event.destinationIp ? sealThreatField(dek, target.tenant_id, mappingId, 'dest_ip', Buffer.from(event.destinationIp, 'utf8')) : null},
      ${detailEnc},
      ${event.sourceIp ? blindIndex.compute(target.tenant_id, Buffer.from(event.sourceIp, 'utf8')) : null},
      ${event.externalId})
  `;
  return true;
}

/**
 * The AAD for a threat record's fields.
 *
 * Bound to the mapping rather than to the threat row, because the row's id is
 * generated by the insert and the ciphertext has to exist before it. 0430
 * learned that the hard way with network_assets and solved it by passing the id
 * in; here there is nothing that needs to be found by id later, so binding one
 * level up is simpler and loses nothing — a threat row's detail still cannot be
 * moved to another tenant or another mapping and opened.
 */
function sealThreatField(
  dek: Buffer,
  tenantId: string,
  mappingId: string,
  field: string,
  value: Buffer,
): Buffer {
  const envelope = sealField(dek, value, {
    tenantId,
    secretId: mappingId,
    field: `threat_${field}`,
    version: 1,
  });
  return Buffer.concat([envelope.nonce, envelope.authTag, envelope.ciphertext]);
}

/** A stable digest of a body, for logging a rejection without logging the body. */
export function bodyDigest(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 12);
}
