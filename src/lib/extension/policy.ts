/**
 * The MSP's rules for the browser extension (1300): today one, that it must be
 * locked with a PIN or a password.
 *
 * HOW IT IS ENFORCED. The lock lives in the browser (extension/src/lock.ts):
 * Helm cannot see it. So the extension says, on every request, how it is
 * locked, in the X-Helm-Extension-Lock header: `pin`, `password` or `off`.
 * With the requirement on, a request from an extension token that does not
 * say `pin` or `password` is refused before its handler runs, by tenantRoute
 * and serviceRoute, whatever route it is. An extension older than 0.7.0 sends
 * no header and is refused too, with a message that says to update.
 *
 * Two routes stay open so the extension can explain itself and not fall out
 * of its pairing while its owner sets a lock: who am I / sign out, and renew.
 * Neither returns a credential.
 *
 * This is the extension's word, not proof. It makes every honest copy set a
 * lock; it does not stop somebody who edits the extension. See 1300.
 */
import type { NextRequest } from 'next/server';
import type { HelmTx } from '../db/client';
import { ApiError } from '../api/errors';
import type { RequestIdentity } from '../auth/identity';

export const EXTENSION_LOCK_HEADER = 'x-helm-extension-lock';

/** `details.reason` on the refusal, which is how the extension knows to offer its settings. */
export const LOCK_REQUIRED = 'lock_required';

/** The first extension version that reports its lock. */
export const LOCK_REPORTING_VERSION = '0.7.0';

export interface ExtensionPolicy {
  requireLock: boolean;
  updatedAt: Date | null;
}

export async function readExtensionPolicy(tx: HelmTx): Promise<ExtensionPolicy> {
  const [row] = await tx<{ require_lock: boolean; updated_at: Date | null }[]>`
    SELECT * FROM helm.extension_policy()
  `;
  return { requireLock: row?.require_lock ?? false, updatedAt: row?.updated_at ?? null };
}

export async function writeExtensionPolicy(tx: HelmTx, input: { requireLock: boolean }): Promise<void> {
  await tx`SELECT helm.set_extension_policy(${input.requireLock}::boolean)`;
}

const OPEN_WITHOUT_A_LOCK: readonly [method: string, path: string][] = [
  ['GET', '/api/extension/me'],
  ['DELETE', '/api/extension/me'],
  ['POST', '/api/extension/renew'],
];

/**
 * Refuse an extension that is not locked, when this MSP requires it. Only
 * requests made with an extension's own token are asked; a person's browser
 * session on the same routes is not an extension.
 */
export async function assertExtensionLock(
  tx: HelmTx,
  identity: RequestIdentity,
  request: NextRequest,
): Promise<void> {
  if (identity.tokenType !== 'browser_extension') return;
  const method = request.method.toUpperCase();
  const path = request.nextUrl.pathname;
  if (OPEN_WITHOUT_A_LOCK.some(([m, p]) => m === method && p === path)) return;

  const reported = request.headers.get(EXTENSION_LOCK_HEADER)?.trim().toLowerCase();
  if (reported === 'pin' || reported === 'password') return;
  if (!(await readExtensionPolicy(tx)).requireLock) return;

  throw ApiError.forbidden(
    reported === undefined
      ? `Your administrator requires the Helm extension to be locked. Update the extension to ${LOCK_REPORTING_VERSION} or later, then turn on a PIN or password under its settings.`
      : 'Your administrator requires the Helm extension to be locked. Open its settings and turn on a PIN or password under Lock.',
    { reason: LOCK_REQUIRED },
  );
}
