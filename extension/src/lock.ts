/**
 * Locking the extension behind a PIN or a password.
 *
 * WHAT A LOCK DOES. With a lock on, the pairing's token is not kept in
 * chrome.storage.local at all. It is kept there encrypted, under an AES-GCM
 * key derived from the PIN or password (PBKDF2-SHA-256, 600,000 rounds), and
 * the plaintext token lives only in chrome.storage.session while unlocked.
 * Session storage is held in memory and emptied when the browser closes, so
 * a browser restart or a reboot always locks; the idle timeout locks sooner.
 * Nothing in the extension can call Helm while it is locked, because it has
 * no token to call with.
 *
 * THE TIMEOUT. Settings choose how long unused before what happens: lock
 * (with a PIN or password set) or sign out, which unpairs the browser in Helm
 * and forgets it here, as Bitwarden's "timeout action" does. Use is any call
 * to Helm. Signing out is api.ts's, since it calls Helm; this only says when.
 *
 * WHAT IT DOES NOT DO. The PIN or password never leaves this browser, and
 * Helm does not know whether a browser is locked. Somebody holding a copy of
 * the browser profile has the encrypted token and the device key, and can
 * guess a short PIN offline; a password resists that much longer. The local
 * limit of five wrong tries stops a person at the keyboard, not a copy.
 *
 * RENEWAL. A renewed token is encrypted again with the key the unlock
 * derived, which waits in session storage beside the token for that reason.
 * A locked browser does not renew; a pairing locked for more than its last
 * week lapses, and is paired again.
 */
import { clearPairing, fromBase64Url, getPairing, getSettings, setPairing, toBase64Url, type TimeoutAction } from './store';

export type LockMethod = 'pin' | 'password';

interface Sealed {
  salt: string;
  iv: string;
  ciphertext: string;
  iterations: number;
}

export interface LockConfig {
  method: LockMethod;
  /** Before 0.5.0, the idle timeout; settings hold it now (store.ts). */
  idleMinutes?: number;
  failures: number;
  sealed: Sealed;
}

interface Unlocked {
  token: string;
  /** The derived AES key, raw and base64url, for sealing a renewed token. */
  key: string;
  lastActive: number;
}

const ITERATIONS = 600_000;
export const MAX_FAILURES = 5;

export async function getLock(): Promise<LockConfig | null> {
  const { lock } = (await chrome.storage.local.get('lock')) as { lock?: LockConfig };
  return lock ?? null;
}

async function setLock(lock: LockConfig | null): Promise<void> {
  if (lock) await chrome.storage.local.set({ lock });
  else await chrome.storage.local.remove('lock');
}

async function getUnlocked(): Promise<Unlocked | null> {
  const { unlocked } = (await chrome.storage.session.get('unlocked')) as { unlocked?: Unlocked };
  return unlocked ?? null;
}

async function setUnlocked(unlocked: Unlocked | null): Promise<void> {
  if (unlocked) await chrome.storage.session.set({ unlocked });
  else await chrome.storage.session.remove('unlocked');
}

export type LockState = 'off' | 'locked' | 'unlocked';

export async function lockState(): Promise<LockState> {
  const lock = await getLock();
  if (!lock) return 'off';
  await lockIfIdle();
  return (await getUnlocked()) ? 'unlocked' : 'locked';
}

/** What a PIN or password must look like, or why it does not. */
export function checkSecret(method: LockMethod, secret: string): string | null {
  if (method === 'pin') return /^\d{4,12}$/.test(secret) ? null : 'A PIN is 4 to 12 digits.';
  return secret.length >= 8 ? null : 'A password is at least 8 characters.';
}

async function deriveKey(secret: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

async function seal(key: CryptoKey, token: string, salt: string, iterations: number): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(token)));
  return { salt, iv: toBase64Url(iv), ciphertext: toBase64Url(ciphertext), iterations };
}

const rawKey = async (key: CryptoKey) => toBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', key)));

/** Turn the lock on. The browser must be paired, and unlocked if a lock is already on. */
export async function enableLock(method: LockMethod, secret: string): Promise<void> {
  const token = await currentToken();
  const pairing = await getPairing();
  if (!token || !pairing) throw new Error('pair this browser, or unlock it, first');
  const salt = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const key = await deriveKey(secret, fromBase64Url(salt), ITERATIONS);
  await setLock({ method, failures: 0, sealed: await seal(key, token, salt, ITERATIONS) });
  await setUnlocked({ token, key: await rawKey(key), lastActive: Date.now() });
  // Last, so a failure above leaves the plain token where it was.
  await setPairing({ ...pairing, token: '' });
}

export type UnlockResult = 'unlocked' | 'wrong' | 'forgotten';

/**
 * Try a PIN or password. Five wrong in a row and the pairing is forgotten, as
 * Bitwarden does, so the browser has to be paired again with the Helm
 * password.
 */
export async function unlock(secret: string): Promise<UnlockResult> {
  const lock = await getLock();
  if (!lock) return 'unlocked';
  const { sealed } = lock;
  const key = await deriveKey(secret, fromBase64Url(sealed.salt), sealed.iterations);
  let token: string;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64Url(sealed.iv) }, key, fromBase64Url(sealed.ciphertext),
    );
    token = new TextDecoder().decode(plain);
  } catch {
    const failures = lock.failures + 1;
    if (failures >= MAX_FAILURES) {
      await clearPairing();
      return 'forgotten';
    }
    await setLock({ ...lock, failures });
    return 'wrong';
  }
  await setLock({ ...lock, failures: 0 });
  await setUnlocked({ token, key: await rawKey(key), lastActive: Date.now() });
  return 'unlocked';
}

export async function lockNow(): Promise<void> {
  await setUnlocked(null);
}

/** Turn the lock off, after the PIN or password once more. */
export async function disableLock(secret: string): Promise<UnlockResult> {
  const result = await unlock(secret);
  if (result !== 'unlocked') return result;
  const [pairing, unlocked] = await Promise.all([getPairing(), getUnlocked()]);
  if (pairing && unlocked) await setPairing({ ...pairing, token: unlocked.token });
  await setLock(null);
  await setUnlocked(null);
  return 'unlocked';
}

/* ------------------------------------------------------------------------- *
 * The timeout
 * ------------------------------------------------------------------------- */

/** When Helm was last used from this browser, for signing out; local, so it survives a restart. */
async function lastActive(): Promise<number | null> {
  const { lastActive: at } = (await chrome.storage.local.get('lastActive')) as { lastActive?: number };
  return at ?? null;
}

/** Note a use. Written at most twice a minute, since every call to Helm is one. */
export async function noteActivity(): Promise<void> {
  const now = Date.now();
  const at = await lastActive();
  if (at === null || now - at > 30_000) await chrome.storage.local.set({ lastActive: now });
}

/** What the timeout says should happen now, if anything. */
export async function timeoutDue(): Promise<TimeoutAction | null> {
  const settings = await getSettings();
  if (settings.timeoutMinutes <= 0) return null;
  const limit = settings.timeoutMinutes * 60_000;
  if (settings.timeoutAction === 'lock') {
    if (!(await getLock())) return null;
    const unlocked = await getUnlocked();
    return unlocked && Date.now() - unlocked.lastActive > limit ? 'lock' : null;
  }
  if (!(await getPairing())) return null;
  const at = await lastActive();
  return at !== null && Date.now() - at > limit ? 'signout' : null;
}

/** Lock if the timeout says so; a sign-out due is returned for the caller, which can reach Helm. */
export async function lockIfIdle(): Promise<TimeoutAction | null> {
  const due = await timeoutDue();
  if (due === 'lock') await lockNow();
  return due;
}

/**
 * The token to call Helm with: the stored one with no lock, the unlocked one
 * with a lock, and null while locked. Each use counts as activity, unless it
 * is a page asking (touch false). Null too once a sign-out is due, which
 * api.ts carries out.
 */
export async function currentToken(touch = true): Promise<string | null> {
  if ((await lockIfIdle()) === 'signout') return null;
  const lock = await getLock();
  if (!lock) {
    const token = (await getPairing())?.token ?? null;
    if (token && touch) await noteActivity();
    return token;
  }
  const unlocked = await getUnlocked();
  if (!unlocked) return null;
  if (touch) {
    await setUnlocked({ ...unlocked, lastActive: Date.now() });
    await noteActivity();
  }
  return unlocked.token;
}

/** The token, without counting it as a use: for signing out. */
export async function tokenForSignOut(): Promise<string | null> {
  if (!(await getLock())) return (await getPairing())?.token ?? null;
  return (await getUnlocked())?.token ?? null;
}

/** Store a renewed token, sealed again when there is a lock. */
export async function replaceToken(token: string, expiresAt: string): Promise<void> {
  const pairing = await getPairing();
  if (!pairing) return;
  const lock = await getLock();
  if (!lock) {
    await setPairing({ ...pairing, token, expiresAt });
    return;
  }
  const unlocked = await getUnlocked();
  if (!unlocked) return;
  const key = await crypto.subtle.importKey('raw', fromBase64Url(unlocked.key), 'AES-GCM', true, ['encrypt', 'decrypt']);
  await setLock({ ...lock, sealed: await seal(key, token, lock.sealed.salt, lock.sealed.iterations) });
  await setUnlocked({ ...unlocked, token });
  await setPairing({ ...pairing, expiresAt });
}

/** A new pairing, or none: whatever lock there was sealed a token that is gone. */
export async function clearLock(): Promise<void> {
  await setLock(null);
  await setUnlocked(null);
}
