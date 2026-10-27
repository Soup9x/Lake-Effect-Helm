/**
 * Checking the device signature on a browser extension's request.
 *
 * The extension token says who; the signature says the request came from the
 * browser that person paired. See src/lib/extension/signature.ts for what is
 * signed and why, and db/sql/1120 for where the key comes from.
 *
 * ECDSA P-256 with SHA-256, the signature in the IEEE P1363 form (r || s, 64
 * bytes) that WebCrypto produces, and the public key as the SubjectPublicKeyInfo
 * DER that WebCrypto exports as 'spki'.
 */
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { readBodyBounded } from '../api/body';
import {
  canonicalRequest,
  SIGNATURE_HEADER,
  SIGNATURE_WINDOW_MS,
  TIMESTAMP_HEADER,
} from '../extension/signature';

/** The largest body an extension sends is a search; this is generous. */
const SIGNED_BODY_MAX_BYTES = 64 * 1024;

export type DeviceSignatureRejection =
  | 'missing'
  | 'stale'
  | 'body_too_large'
  | 'bad_key'
  | 'bad_signature';

/**
 * Parse a device public key, or null when it is not a P-256 key.
 *
 * Used when pairing, so a key the server could never verify against is refused
 * at the door rather than stored and found out on the first request.
 */
export function parseDevicePublicKey(der: Buffer): KeyObject | null {
  try {
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec') return null;
    if (key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return null;
    return key;
  } catch {
    return null;
  }
}

/** Lowercase hex SHA-256 of a device key, the fingerprint both sides show. */
export function deviceKeyFingerprint(der: Buffer): string {
  return createHash('sha256').update(der).digest('hex');
}

/**
 * Verify the request's signature against the pairing's key.
 *
 * Reads the body from a CLONE, so the route can still read it afterwards.
 */
export async function verifyDeviceSignature(
  request: Request,
  pathAndQuery: string,
  publicKeyDer: Buffer,
  now: number = Date.now(),
): Promise<{ ok: true } | { ok: false; reason: DeviceSignatureRejection }> {
  const signature = request.headers.get(SIGNATURE_HEADER)?.trim();
  const timestamp = request.headers.get(TIMESTAMP_HEADER)?.trim();
  if (!signature || !timestamp || !/^\d{1,16}$/.test(timestamp)) {
    return { ok: false, reason: 'missing' };
  }
  if (Math.abs(now - Number(timestamp)) > SIGNATURE_WINDOW_MS) {
    return { ok: false, reason: 'stale' };
  }

  const key = parseDevicePublicKey(publicKeyDer);
  if (!key) return { ok: false, reason: 'bad_key' };

  const body = await readBodyBounded(request.clone(), SIGNED_BODY_MAX_BYTES);
  if (body === null) return { ok: false, reason: 'body_too_large' };

  const data = Buffer.from(
    canonicalRequest({
      method: request.method,
      pathAndQuery,
      timestamp,
      bodySha256: createHash('sha256').update(body).digest('hex'),
    }),
    'utf8',
  );

  let raw: Buffer;
  try {
    raw = Buffer.from(signature, 'base64url');
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }
  if (raw.length !== 64) return { ok: false, reason: 'bad_signature' };

  const valid = verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, raw);
  return valid ? { ok: true } : { ok: false, reason: 'bad_signature' };
}
