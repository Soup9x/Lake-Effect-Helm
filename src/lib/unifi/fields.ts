/**
 * Sealing and opening the encrypted columns on a network asset.
 *
 * WHAT IS ENCRYPTED, AND WHAT IS NOT
 *
 * Per field, not per table. MAC, IP, hostname, serial and a user's custom name
 * identify a machine and often a person — a MAC follows hardware between
 * networks, a hostname is routinely "james-laptop", a serial is what a warranty
 * claim is made against. Uptime, signal, switch port, firmware and model are
 * telemetry with no confidentiality requirement.
 *
 * Blanket-encrypting the telemetry is the tempting shortcut and it buys
 * nothing: it protects data that needs no protection, at the cost of a DEK
 * unwrap per row per read and of every query that would have made the inventory
 * useful — "which access points are on old firmware" stops being answerable in
 * SQL the moment firmware is ciphertext.
 *
 * ONE COLUMN PER FIELD, PACKED
 *
 * Each encrypted column holds nonce || tag || ciphertext in a single bytea.
 * secret_version spreads these across three columns because it stores exactly
 * one field; a network asset stores five, and fifteen columns to say the same
 * thing is not clearer. The AAD is rebuilt from (tenant, asset, field) rather
 * than stored, because the binding is deterministic and a stored copy is one
 * more thing that can disagree with reality.
 */
import {
  NONCE_BYTES,
  TAG_BYTES,
  buildAad,
  openField,
  sealField,
  type Envelope,
} from '../crypto/envelope';
import { HelmCryptoError } from '../crypto/errors';

/**
 * The fields that get sealed.
 *
 * `custom_name` is listed beside the controller fields but is written by a
 * DIFFERENT actor — a person, never the sync. They share this module and
 * nothing else; 0430 keeps them in separate columns precisely so a poll cannot
 * touch the one a user wrote.
 */
export type AssetField = 'mac_address' | 'ip_address' | 'hostname' | 'serial' | 'custom_name';

function binding(tenantId: string, assetId: string, field: AssetField) {
  return { tenantId, secretId: assetId, field, version: 1 };
}

/** nonce || tag || ciphertext. */
export function packEnvelope(envelope: Envelope): Buffer {
  return Buffer.concat([envelope.nonce, envelope.authTag, envelope.ciphertext]);
}

export function unpackEnvelope(packed: Buffer, aad: string): Envelope {
  if (packed.length < NONCE_BYTES + TAG_BYTES + 1) {
    throw new HelmCryptoError('invalid_envelope', 'packed field is too short to be one');
  }
  return {
    nonce: packed.subarray(0, NONCE_BYTES),
    authTag: packed.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES),
    ciphertext: packed.subarray(NONCE_BYTES + TAG_BYTES),
    aad,
  };
}

/**
 * Seal one field. Returns null for an absent value rather than encrypting an
 * empty string, so a device the controller reports no hostname for gets a NULL
 * column instead of ciphertext that decrypts to nothing.
 */
export function sealAssetField(
  dek: Buffer,
  tenantId: string,
  assetId: string,
  field: AssetField,
  value: string | null | undefined,
): Buffer | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const envelope = sealField(dek, Buffer.from(trimmed, 'utf8'), binding(tenantId, assetId, field));
  return packEnvelope(envelope);
}

/**
 * Open one field.
 *
 * Passing the expected binding makes openField refuse a ciphertext whose AAD
 * names a different tenant, asset or field — so a column copied between rows
 * fails here rather than showing one device's hostname under another's name.
 */
export function openAssetField(
  dek: Buffer,
  tenantId: string,
  assetId: string,
  field: AssetField,
  packed: Buffer | null | undefined,
): string | null {
  if (!packed || packed.length === 0) return null;
  // The AAD is REBUILT, not read back from a column. The binding is
  // deterministic, so a stored copy would be one more thing that can disagree
  // with reality — and openField compares what it reconstructs against the
  // expected binding anyway, so a mismatch fails rather than passing.
  const expected = binding(tenantId, assetId, field);
  const plaintext = openField(dek, unpackEnvelope(packed, buildAad(expected)), expected);
  return plaintext.toString('utf8');
}

/**
 * Normalise a MAC before it is indexed or sealed.
 *
 * THE BLIND INDEX ONLY WORKS IF THIS IS EXACT. UniFi has reported MACs as
 * "aa:bb:cc:dd:ee:ff", "AA-BB-CC-DD-EE-FF" and "aabbccddeeff" across versions
 * and endpoints, and an HMAC over two spellings of one address produces two
 * different indexes — which would silently create a second row for a device
 * that already exists, on every poll, forever.
 *
 * Lowercase, colon-separated, is the canonical form. Anything that is not
 * twelve hex digits returns null and is skipped rather than guessed at.
 */
export function normaliseMac(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const hex = raw.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (hex.length !== 12) return null;
  return (hex.match(/.{2}/g) ?? []).join(':');
}

/**
 * Normalise an IP before it is indexed.
 *
 * Same reasoning as the MAC: "10.2.0.7" and "10.02.00.07" are one address and
 * must produce one index. IPv6 is lowercased but not otherwise canonicalised —
 * abbreviating a v6 address correctly is its own problem, and a controller
 * reports it consistently within a version, so the cost of getting it wrong is
 * an extra history row rather than a duplicate asset.
 */
export function normaliseIp(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (v4) {
    const parts = v4.slice(1).map((p) => Number(p));
    if (parts.some((p) => p > 255)) return null;
    return parts.join('.');
  }

  if (value.includes(':')) return value.toLowerCase();
  return null;
}
