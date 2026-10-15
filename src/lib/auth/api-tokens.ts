/**
 * Personal API tokens: what the account page lists and the routes write.
 *
 * The rules — a person, from a session, scopes they hold, an expiry within a
 * year — live in helm.issue_my_api_token() (db/sql/0750). This module is the
 * typed surface over those three functions plus the one decision the database
 * cannot make: minting the secret, which happens here with mintToken() so the
 * database only ever sees the hash.
 */
import type { HelmTx } from '../db/client';
import { mintToken } from './tokens';

/** A row of helm.my_api_tokens(), as the page and the list route render it. */
export interface PersonalTokenRow {
  id: string;
  name: string;
  /** The public half, `helm_pa_XXXXXXXX`: what a leak is reported by. */
  prefix: string;
  scopes: string[];
  expiresAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  useCount: number;
  createdAt: string;
  /** Live: neither revoked nor expired. Derived once, here, so two renderers agree. */
  live: boolean;
}

interface RawRow {
  id: string;
  name: string;
  token_prefix: string;
  scopes: string[];
  expires_at: Date | null;
  revoked_at: Date | null;
  revoked_reason: string | null;
  last_used_at: Date | null;
  last_used_ip: string | null;
  use_count: number | string;
  created_at: Date;
}

/** The longest a personal token may live, matching the function's check. */
export const TOKEN_MAX_DAYS = 366;
export const TOKEN_DEFAULT_DAYS = 90;

export async function listMyTokens(tx: HelmTx): Promise<PersonalTokenRow[]> {
  const rows = await tx<RawRow[]>`SELECT * FROM helm.my_api_tokens()`;
  const now = Date.now();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.token_prefix,
    scopes: r.scopes,
    // The function never issues one without an expiry; the column allows null
    // for service-account tokens, which this list does not return.
    expiresAt: (r.expires_at ?? new Date(0)).toISOString(),
    revokedAt: r.revoked_at?.toISOString() ?? null,
    revokedReason: r.revoked_reason,
    lastUsedAt: r.last_used_at?.toISOString() ?? null,
    lastUsedIp: r.last_used_ip,
    useCount: Number(r.use_count),
    createdAt: r.created_at.toISOString(),
    live: r.revoked_at === null && (r.expires_at === null || r.expires_at.getTime() > now),
  }));
}

export interface IssuedToken {
  id: string;
  prefix: string;
  /** Shown exactly once. Not stored anywhere, not even hashed in the audit row. */
  token: string;
  expiresAt: string;
}

export async function issueMyToken(
  tx: HelmTx,
  input: { name: string; scopes: string[]; expiresInDays: number },
): Promise<IssuedToken> {
  const minted = mintToken('user_pat');
  const expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000);
  const [row] = await tx<{ id: string }[]>`
    SELECT helm.issue_my_api_token(
      ${input.name}, ${minted.prefix}, ${minted.hash}, ${input.scopes}::text[], ${expiresAt}
    ) AS id
  `;
  if (!row) throw new Error('helm.issue_my_api_token returned no id');
  return { id: row.id, prefix: minted.prefix, token: minted.token, expiresAt: expiresAt.toISOString() };
}

export async function revokeMyToken(tx: HelmTx, id: string, reason?: string): Promise<boolean> {
  const [row] = await tx<{ revoked: boolean }[]>`
    SELECT helm.revoke_my_api_token(${id}::uuid, ${reason ?? null}) AS revoked
  `;
  return row?.revoked ?? false;
}
