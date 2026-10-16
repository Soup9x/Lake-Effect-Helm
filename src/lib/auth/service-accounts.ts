/**
 * Service accounts and their tokens: the typed surface over 0760.
 *
 * Every rule — who may create one, which roles, which scope, what a token may
 * carry, how long it lives — is in the SQL functions, because a route is one
 * caller and a maintenance script is another. This module shapes rows for the
 * page and mints the token secret, which is the one thing the database must
 * not see: it stores the hash.
 */
import type { HelmTx } from '../db/client';
import { mintToken } from './tokens';
import { TOKEN_DEFAULT_DAYS, TOKEN_MAX_DAYS } from './api-tokens';

export { TOKEN_DEFAULT_DAYS, TOKEN_MAX_DAYS };

export interface ServiceAccountRow {
  id: string;
  name: string;
  description: string | null;
  roleKey: string;
  roleName: string;
  roleRank: number;
  orgScopeAll: boolean;
  orgScope: string[];
  orgNames: string[];
  disabledAt: string | null;
  createdAt: string;
  createdByName: string | null;
  liveTokens: number;
  lastUsedAt: string | null;
}

export interface GrantableRole {
  key: string;
  name: string;
  rank: number;
  isTenantWide: boolean;
  permissions: string[];
}

export interface ServiceTokenRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  ipAllowlist: string[];
  expiresAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  useCount: number;
  createdAt: string;
  createdByName: string | null;
  live: boolean;
}

interface RawAccount {
  id: string; name: string; description: string | null; role_key: string; role_name: string;
  role_rank: number; org_scope_all: boolean; org_scope: string[] | null; org_names: string[] | null;
  disabled_at: Date | null; created_at: Date; created_by_name: string | null;
  live_tokens: number; last_used_at: Date | null;
}

interface RawRole {
  key: string; name: string; rank: number; is_tenant_wide: boolean; permissions: string[];
}

interface RawToken {
  id: string; name: string; token_prefix: string; scopes: string[]; ip_allowlist: string[] | null;
  expires_at: Date | null; revoked_at: Date | null; revoked_reason: string | null;
  last_used_at: Date | null; last_used_ip: string | null; use_count: number | string;
  created_at: Date; created_by_name: string | null;
}

export async function listServiceAccounts(tx: HelmTx): Promise<ServiceAccountRow[]> {
  const rows = await tx<RawAccount[]>`SELECT * FROM helm.service_accounts()`;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    roleKey: r.role_key,
    roleName: r.role_name,
    roleRank: r.role_rank,
    orgScopeAll: r.org_scope_all,
    orgScope: r.org_scope ?? [],
    orgNames: r.org_names ?? [],
    disabledAt: r.disabled_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
    createdByName: r.created_by_name,
    liveTokens: Number(r.live_tokens),
    lastUsedAt: r.last_used_at?.toISOString() ?? null,
  }));
}

/** The roles the current actor may give a service account, with their permissions. */
export async function listGrantableRoles(tx: HelmTx): Promise<GrantableRole[]> {
  const rows = await tx<RawRole[]>`SELECT * FROM helm.grantable_service_roles()`;
  return rows.map((r) => ({
    key: r.key, name: r.name, rank: r.rank, isTenantWide: r.is_tenant_wide, permissions: r.permissions,
  }));
}

export interface CreateServiceAccountInput {
  name: string;
  description?: string | null | undefined;
  roleKey: string;
  orgScopeAll: boolean;
  orgScope: string[];
}

export async function createServiceAccount(tx: HelmTx, input: CreateServiceAccountInput): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    SELECT helm.create_service_account(
      ${input.name}, ${input.description ?? null}, ${input.roleKey},
      ${input.orgScopeAll}, ${input.orgScopeAll ? null : input.orgScope}::uuid[]
    ) AS id
  `;
  if (!row) throw new Error('helm.create_service_account returned no id');
  return row.id;
}

export async function setServiceAccountDisabled(tx: HelmTx, id: string, disabled: boolean): Promise<boolean> {
  const [row] = await tx<{ ok: boolean }[]>`
    SELECT helm.set_service_account_disabled(${id}::uuid, ${disabled}) AS ok
  `;
  return row?.ok ?? false;
}

export interface IssuedServiceToken {
  id: string;
  prefix: string;
  /** Shown once. */
  token: string;
  expiresAt: string;
}

export async function issueServiceAccountToken(
  tx: HelmTx,
  input: { serviceAccountId: string; name: string; scopes: string[]; expiresInDays: number; ipAllowlist: string[] },
): Promise<IssuedServiceToken> {
  const minted = mintToken('service_account');
  const expiresAt = new Date(Date.now() + input.expiresInDays * 86_400_000);
  const [row] = await tx<{ id: string }[]>`
    SELECT helm.issue_service_account_token(
      ${input.serviceAccountId}::uuid, ${input.name}, ${minted.prefix}, ${minted.hash},
      ${input.scopes}::text[], ${expiresAt}, ${input.ipAllowlist}::inet[]
    ) AS id
  `;
  if (!row) throw new Error('helm.issue_service_account_token returned no id');
  return { id: row.id, prefix: minted.prefix, token: minted.token, expiresAt: expiresAt.toISOString() };
}

export async function listServiceAccountTokens(tx: HelmTx, serviceAccountId: string): Promise<ServiceTokenRow[]> {
  const rows = await tx<RawToken[]>`
    SELECT * FROM helm.service_account_tokens(${serviceAccountId}::uuid)
  `;
  const now = Date.now();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.token_prefix,
    scopes: r.scopes,
    ipAllowlist: r.ip_allowlist ?? [],
    expiresAt: (r.expires_at ?? new Date(0)).toISOString(),
    revokedAt: r.revoked_at?.toISOString() ?? null,
    revokedReason: r.revoked_reason,
    lastUsedAt: r.last_used_at?.toISOString() ?? null,
    lastUsedIp: r.last_used_ip,
    useCount: Number(r.use_count),
    createdAt: r.created_at.toISOString(),
    createdByName: r.created_by_name,
    live: r.revoked_at === null && (r.expires_at === null || r.expires_at.getTime() > now),
  }));
}

export async function revokeServiceAccountToken(tx: HelmTx, tokenId: string, reason?: string): Promise<boolean> {
  const [row] = await tx<{ ok: boolean }[]>`
    SELECT helm.revoke_service_account_token(${tokenId}::uuid, ${reason ?? null}) AS ok
  `;
  return row?.ok ?? false;
}
