/**
 * Pairing, renewing and unpairing the browser extension: the typed surface
 * over db/sql/1120's functions, plus the one thing the database cannot do,
 * which is mint the token, so it only ever sees the hash.
 */
import type { HelmTx } from '../db/client';
import { mintToken } from '../auth/tokens';

/** How long an extension token lives. The extension renews it while in use. */
export const EXTENSION_TOKEN_DAYS = 30;

const expiry = () => new Date(Date.now() + EXTENSION_TOKEN_DAYS * 24 * 60 * 60 * 1000);

export interface PairInput {
  label: string;
  browser: string | null;
  extensionVersion: string | null;
  publicKey: Buffer;
}

export interface Paired {
  installId: string;
  token: string;
  expiresAt: string;
  scopes: string[];
}

export async function pairExtension(tx: HelmTx, input: PairInput): Promise<Paired> {
  const minted = mintToken('browser_extension');
  const expiresAt = expiry();
  const [row] = await tx<{ install_id: string; scopes: string[] }[]>`
    SELECT install_id, scopes FROM helm.pair_browser_extension(
      ${input.label}, ${input.browser}, ${input.extensionVersion}, ${input.publicKey},
      ${minted.prefix}, ${minted.hash}, ${expiresAt}
    )
  `;
  if (!row) throw new Error('pair_browser_extension returned no row');
  return { installId: row.install_id, token: minted.token, expiresAt: expiresAt.toISOString(), scopes: row.scopes };
}

export async function renewExtensionToken(tx: HelmTx): Promise<{ token: string; expiresAt: string }> {
  const minted = mintToken('browser_extension');
  const expiresAt = expiry();
  await tx`SELECT helm.renew_browser_extension_token(${minted.prefix}, ${minted.hash}, ${expiresAt})`;
  return { token: minted.token, expiresAt: expiresAt.toISOString() };
}

/** A row of helm.my_browser_extensions(), as the account page renders it. */
export interface PairedBrowserRow {
  id: string;
  label: string;
  browser: string | null;
  extensionVersion: string | null;
  /** The first 16 hex digits of the key's SHA-256: what the extension shows too. */
  fingerprint: string;
  pairedAt: string;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  /** Neither unpaired nor lapsed. */
  live: boolean;
  /** The pairing this request came from. */
  current: boolean;
}

interface RawRow {
  id: string;
  device_label: string;
  browser: string | null;
  extension_version: string | null;
  key_sha256: string;
  paired_at: Date;
  last_used_at: Date | null;
  last_used_ip: string | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  is_current: boolean;
}

/** The first 16 hex digits, grouped in fours, as both sides display it. */
export function formatFingerprint(sha256Hex: string): string {
  return (sha256Hex.slice(0, 16).match(/.{4}/g) ?? []).join(' ').toUpperCase();
}

export async function listMyBrowsers(tx: HelmTx): Promise<PairedBrowserRow[]> {
  const rows = await tx<RawRow[]>`SELECT * FROM helm.my_browser_extensions()`;
  const now = Date.now();
  return rows.map((r) => ({
    id: r.id,
    label: r.device_label,
    browser: r.browser,
    extensionVersion: r.extension_version,
    fingerprint: formatFingerprint(r.key_sha256),
    pairedAt: r.paired_at.toISOString(),
    lastUsedAt: r.last_used_at?.toISOString() ?? null,
    lastUsedIp: r.last_used_ip,
    expiresAt: r.expires_at?.toISOString() ?? null,
    revokedAt: r.revoked_at?.toISOString() ?? null,
    live: r.revoked_at === null && r.expires_at !== null && r.expires_at.getTime() > now,
    current: r.is_current,
  }));
}

export async function revokeMyBrowser(tx: HelmTx, id: string): Promise<boolean> {
  const [row] = await tx<{ revoked: boolean }[]>`SELECT helm.revoke_my_browser_extension(${id}::uuid) AS revoked`;
  return row?.revoked === true;
}

export async function renameMyBrowser(tx: HelmTx, id: string, label: string): Promise<boolean> {
  const [row] = await tx<{ renamed: boolean }[]>`
    SELECT helm.rename_my_browser_extension(${id}::uuid, ${label}) AS renamed
  `;
  return row?.renamed === true;
}

/** Clear a removed or lapsed pairing from your list, or all of them when `id` is null. */
export async function clearMyBrowsers(tx: HelmTx, id: string | null): Promise<number> {
  const [row] = await tx<{ cleared: number }[]>`
    SELECT helm.clear_my_browser_extensions(${id}::uuid) AS cleared
  `;
  return row?.cleared ?? 0;
}

/** A row of helm.tenant_browser_extensions(): somebody's pairing, for an administrator. */
export interface TenantBrowserRow extends Omit<PairedBrowserRow, 'current'> {
  userId: string;
  userName: string;
  userEmail: string;
}

export async function listTenantBrowsers(tx: HelmTx): Promise<TenantBrowserRow[]> {
  const rows = await tx<(Omit<RawRow, 'is_current'> & { user_id: string; user_name: string; user_email: string })[]>`
    SELECT * FROM helm.tenant_browser_extensions()
  `;
  const now = Date.now();
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    userName: r.user_name,
    userEmail: r.user_email,
    label: r.device_label,
    browser: r.browser,
    extensionVersion: r.extension_version,
    fingerprint: formatFingerprint(r.key_sha256),
    pairedAt: r.paired_at.toISOString(),
    lastUsedAt: r.last_used_at?.toISOString() ?? null,
    lastUsedIp: r.last_used_ip,
    expiresAt: r.expires_at?.toISOString() ?? null,
    revokedAt: r.revoked_at?.toISOString() ?? null,
    live: r.revoked_at === null && r.expires_at !== null && r.expires_at.getTime() > now,
  }));
}

export async function revokeBrowser(tx: HelmTx, id: string): Promise<boolean> {
  const [row] = await tx<{ revoked: boolean }[]>`SELECT helm.revoke_browser_extension(${id}::uuid) AS revoked`;
  return row?.revoked === true;
}
