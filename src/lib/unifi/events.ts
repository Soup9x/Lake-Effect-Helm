/**
 * Parsing what a UniFi console posts.
 *
 * TOLERANT ON PURPOSE, for the same reason src/lib/unifi/client.ts spells field
 * names several ways: UniFi has renamed things between versions and between
 * endpoints, and an integration that only understands one spelling reports "no
 * events" on a console that is sending plenty.
 *
 * Tolerance stops at the signature. Anything here runs only after the body has
 * been verified against the mapping's secret, so a malformed payload is a
 * parsing problem rather than an attack — but nothing in this file trusts a
 * field's TYPE, because a verified sender can still send nonsense.
 */
import { normaliseIp, normaliseMac } from './fields';

export type ThreatSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface UnifiEvent {
  /** The controller's own id, when it sends one. Used to refuse replays. */
  readonly externalId: string | null;
  readonly kind: 'threat' | 'connection' | 'unknown';
  readonly type: string;
  readonly occurredAt: Date | null;
  /** Normalised, lowercase, colon-separated. Null when the event names no device. */
  readonly mac: string | null;
  readonly online: boolean | null;
  readonly ip: string | null;
  readonly severity: ThreatSeverity;
  readonly signature: string | null;
  readonly category: string | null;
  readonly sourceIp: string | null;
  readonly destinationIp: string | null;
  readonly deviceState: string | null;
  readonly uptimeSeconds: number | null;
  readonly signalDbm: number | null;
  readonly switchPort: number | null;
  /** The whole original, sealed verbatim — it can carry addresses anywhere. */
  readonly raw: Record<string, unknown>;
}

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** First present value among several spellings, searching one level of nesting. */
function pick(record: Rec, ...names: string[]): unknown {
  for (const name of names) {
    const value = record[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  for (const nested of ['data', 'payload', 'event', 'detail']) {
    const inner = record[nested];
    if (isRecord(inner)) {
      for (const name of names) {
        const value = inner[name];
        if (value !== undefined && value !== null && value !== '') return value;
      }
    }
  }
  return undefined;
}

function str(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number') return String(value);
  return null;
}

function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function bounded(value: unknown, min: number, max: number): number | null {
  const n = num(value);
  if (n === null || n < min || n > max) return null;
  return n;
}

/**
 * When it happened.
 *
 * Milliseconds, seconds and ISO strings have all appeared. A value that parses
 * to something absurd is discarded rather than stored: a device reporting 1970
 * would sort to the bottom of every list forever.
 */
function when(value: unknown): Date | null {
  if (value === undefined || value === null || value === '') return null;
  let date: Date;
  if (typeof value === 'number') {
    date = new Date(value > 1e11 ? value : value * 1000);
  } else if (typeof value === 'string') {
    const asNumber = Number(value);
    date = Number.isFinite(asNumber) && value.trim() !== ''
      ? new Date(asNumber > 1e11 ? asNumber : asNumber * 1000)
      : new Date(value);
  } else {
    return null;
  }
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getUTCFullYear();
  return year >= 2000 && year <= 2200 ? date : null;
}

/**
 * Severity, normalised.
 *
 * UniFi has used words, and Suricata-style numeric priorities where 1 is the
 * MOST severe — the inversion is the trap, and getting it backwards would file
 * every critical alert as informational while looking like it worked.
 */
export function normaliseSeverity(value: unknown): ThreatSeverity {
  const text = str(value)?.toLowerCase();
  if (!text) return 'info';

  if (/^\d+$/.test(text)) {
    const priority = Number(text);
    if (priority <= 1) return 'critical';
    if (priority === 2) return 'high';
    if (priority === 3) return 'medium';
    return 'low';
  }

  if (/crit|emerg|severe/.test(text)) return 'critical';
  if (/high|major|alert/.test(text)) return 'high';
  if (/med|moderate|warn/.test(text)) return 'medium';
  if (/low|minor/.test(text)) return 'low';
  return 'info';
}

/** High and critical are what get a permanent, encrypted record. */
export function isHighSeverity(severity: ThreatSeverity): boolean {
  return severity === 'high' || severity === 'critical';
}

const THREAT_HINT = /(ids|ips|threat|alert|intrusion|malware|botnet|honeypot|block)/i;
const OFFLINE_HINT = /(disconnect|offline|lost|unreachable|down|gone)/i;
const ONLINE_HINT = /(connect|online|restored|adopt|up)/i;

/**
 * Whether the event says a device is up or down.
 *
 * Order matters: "disconnected" contains "connect", so offline is tested first.
 * An explicit boolean field beats the name of the event either way.
 */
function onlineFrom(record: Rec, type: string): boolean | null {
  const explicit = pick(record, 'isOnline', 'online', 'connected');
  if (typeof explicit === 'boolean') return explicit;

  const state = str(pick(record, 'state', 'status'))?.toLowerCase();
  if (state) {
    if (OFFLINE_HINT.test(state)) return false;
    if (ONLINE_HINT.test(state)) return true;
  }

  if (OFFLINE_HINT.test(type)) return false;
  if (ONLINE_HINT.test(type)) return true;
  return null;
}

function parseOne(record: Rec): UnifiEvent {
  const type = str(pick(record, 'type', 'eventType', 'event', 'key', 'name')) ?? 'unknown';
  const isThreat = THREAT_HINT.test(type) || pick(record, 'severity', 'priority', 'catname') !== undefined;
  const online = onlineFrom(record, type);

  return {
    externalId: str(pick(record, 'id', 'eventId', 'uuid', '_id')),
    kind: isThreat ? 'threat' : online !== null ? 'connection' : 'unknown',
    type,
    occurredAt: when(pick(record, 'timestamp', 'time', 'occurredAt', 'datetime', 'ts')),
    mac: normaliseMac(pick(record, 'mac', 'macAddress', 'deviceMac', 'clientMac', 'srcMac')),
    online,
    ip: normaliseIp(pick(record, 'ip', 'ipAddress', 'clientIp')),
    severity: normaliseSeverity(pick(record, 'severity', 'priority', 'level')),
    signature: str(pick(record, 'signature', 'msg', 'message', 'rule', 'catname')),
    category: str(pick(record, 'category', 'catname', 'class', 'appProto')),
    sourceIp: normaliseIp(pick(record, 'srcIp', 'sourceIp', 'src_ip', 'source')),
    destinationIp: normaliseIp(pick(record, 'destIp', 'dstIp', 'dest_ip', 'destination')),
    deviceState: str(pick(record, 'state', 'status')),
    uptimeSeconds: num(pick(record, 'uptimeSec', 'uptime')),
    signalDbm: bounded(pick(record, 'signalDbm', 'signal', 'rssi'), -120, 0),
    switchPort: bounded(pick(record, 'switchPort', 'swPort', 'port'), 0, 4096),
    raw: record,
  };
}

/**
 * Pull events out of whatever envelope arrived.
 *
 * A bare object, an array, or `{events: [...]}` — all three have been seen from
 * webhook senders, and which one a console uses is not worth a support call.
 * A cap because a verified sender can still post a million events in one body,
 * and this runs inside a request.
 */
const MAX_EVENTS = 200;

export function parseEvents(body: unknown): UnifiEvent[] {
  const list: unknown[] = Array.isArray(body)
    ? body
    : isRecord(body)
      ? Array.isArray(body.events)
        ? body.events
        : Array.isArray(body.data)
          ? body.data
          : [body]
      : [];

  return list.filter(isRecord).slice(0, MAX_EVENTS).map(parseOne);
}
