/**
 * Calling Helm as the paired extension.
 *
 * Every request carries the pairing's token AND a signature by the device key
 * over the method, path, time and body (src/lib/extension/signature.ts). The
 * request is sent without cookies: if the person is also signed in to Helm in
 * this browser, that session must not ride along on the extension's calls.
 *
 * A 401 means the pairing is gone — removed in Helm, lapsed, or the person
 * offboarded — so the local pairing is forgotten and the popup says so.
 *
 * Locked (lock.ts), there is no token to send, and nothing is sent.
 */
import { canonicalRequest } from '../../src/lib/extension/signature';
import { currentToken, getLock, replaceToken } from './lock';
import { clearPairing, getKey, getPairing, getServer, sha256Hex, toBase64Url } from './store';

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string };

const NETWORK = 'Helm did not answer. Check the address in settings and your connection.';

export async function call<T>(
  path: string,
  options: { method?: 'GET' | 'POST' | 'DELETE'; json?: unknown } = {},
): Promise<Result<T>> {
  const [server, pairing, key] = await Promise.all([getServer(), getPairing(), getKey('device')]);
  if (!server || !pairing || !key) {
    return { ok: false, status: 401, code: 'not_paired', message: 'This browser is not paired with Helm.' };
  }
  const token = await currentToken();
  if (!token) {
    return { ok: false, status: 423, code: 'locked', message: 'Helm is locked. Unlock it with your PIN or password.' };
  }

  const method = options.method ?? (options.json === undefined ? 'GET' : 'POST');
  const body = options.json === undefined ? '' : JSON.stringify(options.json);
  const bodyBytes = new TextEncoder().encode(body);
  const timestamp = String(Date.now());
  const data = canonicalRequest({
    method,
    pathAndQuery: path,
    timestamp,
    bodySha256: await sha256Hex(bodyBytes),
  });
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, new TextEncoder().encode(data)),
  );

  let response: Response;
  try {
    response = await fetch(`${server}${path}`, {
      method,
      credentials: 'omit',
      cache: 'no-store',
      headers: {
        authorization: `Bearer ${token}`,
        'x-helm-device-timestamp': timestamp,
        'x-helm-device-signature': toBase64Url(signature),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body } : {}),
    });
  } catch {
    return { ok: false, status: 0, code: 'network', message: NETWORK };
  }

  const payload = await response.json().catch(() => null);
  if (response.ok) return { ok: true, value: payload as T };

  if (response.status === 401) {
    await clearPairing();
    return {
      ok: false,
      status: 401,
      code: 'not_paired',
      message: 'Helm no longer accepts this browser. Pair it again from the extension settings.',
    };
  }

  const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;
  return {
    ok: false,
    status: response.status,
    code: error?.code ?? 'http',
    message: error?.message ?? `Helm answered ${response.status}.`,
  };
}

/** Renew the token once it is in its last week. Quiet on failure: the next call says why. Not while locked. */
export async function renewIfDue(): Promise<void> {
  const pairing = await getPairing();
  if (!pairing) return;
  if ((await getLock()) && !(await currentToken())) return;
  const left = new Date(pairing.expiresAt).getTime() - Date.now();
  if (left > 7 * 24 * 60 * 60 * 1000) return;
  const result = await call<{ token: string; expiresAt: string }>('/api/extension/renew', { method: 'POST', json: {} });
  if (result.ok) await replaceToken(result.value.token, result.value.expiresAt);
}
