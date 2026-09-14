/**
 * API tokens for service accounts and the browser extension.
 *
 * Format: `helm_<kind>_<prefix>.<secret>`
 *
 *   helm_sa_A7f3Kp2Q.9dLm4xR8vQ2wN6bT1cY5hJ0sF3gK7pZ...
 *   └──── prefix ───┘ └──────────── secret ──────────┘
 *
 * The prefix is stored in the clear and indexed, so verification is one indexed
 * lookup rather than a scan comparing every hash. The secret half is never
 * stored — only SHA-256 of the whole token — so a database dump does not yield
 * usable credentials.
 *
 * Why a visible prefix at all: it makes a leaked token identifiable. When one
 * turns up in a public repository or a support ticket, `helm_sa_A7f3Kp2Q` can be
 * revoked without anyone having to work out which token it was, and secret
 * scanners can be taught the pattern.
 *
 * SHA-256 rather than Argon2/bcrypt is correct *here*, and the reasoning matters
 * because it is the opposite of the right answer for passwords: these tokens are
 * 256 bits of CSPRNG output, so there is no dictionary to attack and a slow hash
 * would buy nothing while making every API request cost 100ms.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { HelmTx } from '../db/client';

/** Matches the CHECK on api_token.token_prefix. */
const PREFIX_PATTERN = /^helm_(sa|pa|be)_[A-Za-z0-9]{8}$/;
const TOKEN_PATTERN = /^(helm_(?:sa|pa|be)_[A-Za-z0-9]{8})\.([A-Za-z0-9_-]{32,})$/;

/** URL-safe base64 alphabet, so a token survives a query string and a shell. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export type TokenKind = 'service_account' | 'user_pat' | 'browser_extension';

const KIND_TAG: Record<TokenKind, string> = {
  service_account: 'sa',
  user_pat: 'pa',
  browser_extension: 'be',
};

export interface MintedToken {
  /** The full token. Shown to the user exactly once and never recoverable. */
  token: string;
  prefix: string;
  hash: Buffer;
}

/**
 * Generate a token.
 *
 * The prefix is drawn from the same CSPRNG as the secret, not derived from it —
 * a prefix that leaked information about the secret would undo the point of
 * storing only a hash.
 */
export function mintToken(kind: TokenKind): MintedToken {
  const prefix = `helm_${KIND_TAG[kind]}_${randomString(8)}`;
  // 32 bytes of entropy, base64url-encoded.
  const secret = randomBytes(32).toString('base64url');
  const token = `${prefix}.${secret}`;

  return { token, prefix, hash: hashToken(token) };
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export interface ParsedToken {
  prefix: string;
  full: string;
}

/** Split a presented token without revealing, by timing, where it failed. */
export function parseToken(raw: string): ParsedToken | null {
  const match = TOKEN_PATTERN.exec(raw.trim());
  if (!match) return null;
  const [, prefix] = match as unknown as [string, string, string];
  if (!PREFIX_PATTERN.test(prefix)) return null;
  return { prefix, full: raw.trim() };
}

/** Pull a bearer token out of the Authorization header. */
export function bearerFrom(headers: Headers): string | null {
  const header = headers.get('authorization');
  if (!header) return null;
  const [scheme, ...rest] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer') return null;
  const value = rest.join(' ').trim();
  return value.length > 0 ? value : null;
}

export interface TokenIdentity {
  tokenId: string;
  tenantId: string;
  tokenType: TokenKind;
  serviceAccountId: string | null;
  userId: string | null;
  scopes: string[];
}

export type TokenRejection =
  | 'malformed'
  | 'unknown'
  | 'revoked'
  | 'expired'
  | 'ip_not_allowed'
  | 'subject_disabled'
  | 'tenant_inactive';

export type TokenVerification =
  | { ok: true; identity: TokenIdentity }
  | { ok: false; reason: TokenRejection };

interface RawTokenRow {
  token_id: string;
  tenant_id: string;
  token_hash: Buffer;
  token_type: TokenKind;
  service_account_id: string | null;
  user_id: string | null;
  scopes: string[];
  ip_allowlist: string[] | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  subject_disabled: boolean;
  tenant_active: boolean;
}

/**
 * A fixed buffer to compare against when no token row is found.
 *
 * Without this, an unknown prefix returns before any hash comparison and a known
 * one returns after — a measurable difference that lets an attacker confirm
 * which prefixes exist. Doing the same work either way costs microseconds.
 */
const DUMMY_HASH = createHash('sha256').update('helm-nonexistent-token').digest();

/**
 * Verify a presented token.
 *
 * Runs WITHOUT a tenant context — it is the call that establishes which tenant
 * we are in. It therefore goes through helm.authenticate_api_token(), the
 * SECURITY DEFINER authentication boundary (db/sql/0270_authentication.sql).
 *
 * The rejection reason is for server-side logging only. The API must return a
 * flat 401 for every case: telling a caller that their token is *expired*
 * rather than *unknown* confirms the token was real.
 */
export async function verifyToken(
  tx: HelmTx,
  raw: string,
  requestIp: string | null,
): Promise<TokenVerification> {
  const parsed = parseToken(raw);
  if (!parsed) {
    // Still burn a comparison so a malformed token is not faster than a wrong one.
    timingSafeEqual(DUMMY_HASH, DUMMY_HASH);
    return { ok: false, reason: 'malformed' };
  }

  const rows = await tx<RawTokenRow[]>`
    SELECT * FROM helm.authenticate_api_token(${parsed.prefix})
  `;
  const row = rows[0];

  const presented = hashToken(parsed.full);
  // Compare in every branch, against a fixed buffer when there is no row.
  const matches = timingSafeEqual(presented, row ? row.token_hash : DUMMY_HASH);

  if (!row || !matches) return { ok: false, reason: 'unknown' };
  if (row.revoked_at !== null) return { ok: false, reason: 'revoked' };
  if (row.expires_at !== null && row.expires_at.getTime() <= Date.now()) {
    return { ok: false, reason: 'expired' };
  }
  if (row.subject_disabled) return { ok: false, reason: 'subject_disabled' };
  if (!row.tenant_active) return { ok: false, reason: 'tenant_inactive' };

  if (row.ip_allowlist && row.ip_allowlist.length > 0) {
    if (!requestIp || !ipAllowed(requestIp, row.ip_allowlist)) {
      return { ok: false, reason: 'ip_not_allowed' };
    }
  }

  return {
    ok: true,
    identity: {
      tokenId: row.token_id,
      tenantId: row.tenant_id,
      tokenType: row.token_type,
      serviceAccountId: row.service_account_id,
      userId: row.user_id,
      scopes: row.scopes,
    },
  };
}

/**
 * Exact-match IP allowlisting.
 *
 * Deliberately not CIDR: a hand-written CIDR in an admin form is how an
 * allowlist silently becomes `0.0.0.0/0`. RMM and PSA integrations publish
 * fixed egress addresses, so exact matching is what they actually need. Widen
 * this only with a real netmask library and a UI that shows the resulting host
 * count.
 */
export function ipAllowed(requestIp: string, allowlist: string[]): boolean {
  const normalised = normaliseIp(requestIp);
  return allowlist.some((entry) => normaliseIp(entry) === normalised);
}

function normaliseIp(value: string): string {
  const trimmed = value.trim().toLowerCase();
  // Postgres renders a host inet without a mask, but tolerate /32 and /128.
  const withoutMask = trimmed.replace(/\/(32|128)$/, '');
  // An IPv4-mapped IPv6 address and its IPv4 form are the same host.
  return withoutMask.replace(/^::ffff:/, '');
}

function randomString(length: number): string {
  // Rejection-free because 62 does not divide 256 evenly, but the bias here is
  // ~1.5% across an 8-character non-secret prefix and does not matter. The
  // secret half uses randomBytes directly and has no such bias.
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}
