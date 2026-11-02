/**
 * Field view sessions (1250): what a phone session may do, and the flag that
 * says a session is one.
 *
 * READ-ONLY IS ENFORCED HERE, NOT BY THE PAGES. Field view's pages only link to
 * reads, but a page is a suggestion: anybody holding the cookie can call any
 * route. So resolveSessionIdentity() asks fieldMayCall() before a field
 * session reaches a handler, and everything not on the list below is refused
 * whatever page sent it. GET and HEAD pass: they are the reads, the same
 * convention the cross-site guard (lib/api/cross-site.ts) is built on.
 *
 * Leaving Field view is the UPGRADE route, which re-runs the password (and the
 * authenticator code, when one is enrolled) before clearing the flag. A phone
 * left unlocked on a desk can show what it was already showing; it cannot
 * change, export or delete anything without the password.
 *
 * The flag lives on auth_session, which only helm_auth reaches, so neither the
 * browser nor helm_app can clear it.
 */
import { db } from '../db/client';

const UUID = '[0-9a-fA-F-]{36}';

/**
 * The writes a field session may make. Each is either an audited read (a
 * reveal, a copy, a TOTP code), or the session managing itself.
 */
const FIELD_WRITES: readonly [method: string, pattern: RegExp][] = [
  ['POST', new RegExp(`^/api/secrets/${UUID}/reveal$`)],
  ['POST', new RegExp(`^/api/secrets/${UUID}/copy$`)],
  ['POST', new RegExp(`^/api/assets/${UUID}/totp/code$`)],
  ['POST', new RegExp(`^/api/personal/vault/${UUID}/reveal$`)],
  ['POST', new RegExp(`^/api/personal/vault/${UUID}/code$`)],
  // Step-up before a sensitive reveal, which is itself a read.
  ['POST', /^\/api\/auth\/step-up$/],
  // Into and out of Field view. Out re-checks the password.
  ['POST', /^\/api\/auth\/field\/enter$/],
  ['POST', /^\/api\/auth\/field\/upgrade$/],
  ['POST', /^\/api\/auth\/local\/logout$/],
];

export function fieldMayCall(method: string, pathname: string): boolean {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD') return true;
  return FIELD_WRITES.some(([routeMethod, pattern]) => routeMethod === m && pattern.test(pathname));
}

/**
 * Prefixed to the user agent a field session's requests carry into the
 * session context, so every audit row it writes — reveals and copies above
 * all — says it came from Field view. The audit page shows it as "from phone".
 */
export const FIELD_USER_AGENT_MARK = 'Helm-Field-View; ';

export function markFieldUserAgent(userAgent: string | undefined): string {
  return `${FIELD_USER_AGENT_MARK}${userAgent ?? ''}`;
}

export function isFieldUserAgent(userAgent: string | null | undefined): boolean {
  return Boolean(userAgent?.startsWith(FIELD_USER_AGENT_MARK));
}

/** Whether this session token is a Field view session. Unknown tokens are not. */
export async function sessionIsField(sessionToken: string): Promise<boolean> {
  const sql = db('auth');
  const [row] = await sql<{ field_mode: boolean }[]>`
    SELECT field_mode FROM auth_session WHERE session_token = ${sessionToken}
  `;
  return row?.field_mode ?? false;
}

/** Into or out of Field view. The caller has already decided it may. */
export async function setSessionField(sessionToken: string, field: boolean): Promise<void> {
  const sql = db('auth');
  await sql`UPDATE auth_session SET field_mode = ${field} WHERE session_token = ${sessionToken}`;
}

export interface UserFieldPolicy {
  enabled: boolean;
  idleMinutes: number;
  absoluteHours: number;
}

/** The strictest Field view limits across a person's tenants. */
export async function fieldPolicyForUser(userId: string): Promise<UserFieldPolicy> {
  const sql = db('auth');
  const [row] = await sql<{ enabled: boolean; idle_minutes: number; absolute_hours: number }[]>`
    SELECT enabled, idle_minutes, absolute_hours FROM helm.field_policy_for_user(${userId}::uuid)
  `;
  return {
    enabled: row?.enabled ?? true,
    idleMinutes: row?.idle_minutes ?? 10,
    absoluteHours: row?.absolute_hours ?? 12,
  };
}
