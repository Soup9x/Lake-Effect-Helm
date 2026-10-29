/**
 * What the extension keeps, and where.
 *
 *   chrome.storage.local    the Helm address, the pairing (its token, expiry
 *                           and the names to show), and the settings.
 *   IndexedDB               the device key. The private half is a CryptoKey
 *                           made non-extractable, so script running in the
 *                           extension can sign with it and cannot read it out.
 *                           A CryptoKey cannot be put in chrome.storage, which
 *                           only holds JSON.
 *   chrome.storage.session  a pairing in progress: which tab, which state;
 *                           with a lock on, the unlocked token (lock.ts); and
 *                           a login just typed into a page, until the person
 *                           answers the save prompt (capture.ts). In memory,
 *                           gone when the browser closes.
 *
 * The token is stored, and that is acceptable only because it is half a
 * credential: Helm refuses it on any request not signed by the device key.
 */
import type { Theme } from './theme';

export interface Pairing {
  installId: string;
  token: string;
  expiresAt: string;
  tenantName: string;
  label: string;
}

export type TimeoutAction = 'lock' | 'signout';

export interface Settings {
  /** Seconds before a copied password is cleared from the clipboard; 0 is never. */
  clearClipboardSeconds: number;
  theme: Theme;
  /**
   * Minutes unused before the timeout action; 0 is when the browser restarts,
   * and -1 never (only for signing out: a lock always locks on a restart).
   */
  timeoutMinutes: number;
  /** Lock needs a PIN or password (lock.ts); signing out unpairs the browser. */
  timeoutAction: TimeoutAction;
  /** The Helm icon in sign-in fields, and its list of logins (content.ts). */
  inlineMenu: boolean;
  /** Offering to save a new login, and to update a changed password, after a sign-in. */
  offerToSave: boolean;
  /** Sites the person said never to offer a save on, by host. */
  neverSave: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  clearClipboardSeconds: 30,
  theme: 'system',
  timeoutMinutes: -1,
  timeoutAction: 'signout',
  inlineMenu: false,
  offerToSave: false,
  neverSave: [],
};

export interface PendingPairing {
  state: string;
  tabId: number;
  origin: string;
  label: string;
}

interface LocalShape {
  server?: string;
  pairing?: Pairing;
  settings?: Settings;
}

export async function getServer(): Promise<string | null> {
  const { server } = (await chrome.storage.local.get('server')) as LocalShape;
  return server ?? null;
}

export async function setServer(origin: string): Promise<void> {
  await chrome.storage.local.set({ server: origin });
}

export async function getPairing(): Promise<Pairing | null> {
  const { pairing } = (await chrome.storage.local.get('pairing')) as LocalShape;
  return pairing ?? null;
}

export async function setPairing(pairing: Pairing): Promise<void> {
  await chrome.storage.local.set({ pairing });
}

/** Forget the pairing, and any lock on it (lock.ts), whose sealed token was its. */
export async function clearPairing(): Promise<void> {
  await chrome.storage.local.remove(['pairing', 'lock', 'lastActive']);
  await chrome.storage.session.remove('unlocked');
  await deleteKey('device');
}

export async function getSettings(): Promise<Settings> {
  const { settings, lock } = (await chrome.storage.local.get(['settings', 'lock'])) as LocalShape & {
    lock?: { idleMinutes?: number };
  };
  // Before 0.5.0 the idle timeout lived with the lock and always locked.
  const fromLock: Partial<Settings> = lock && settings?.timeoutAction === undefined
    ? { timeoutAction: 'lock', timeoutMinutes: lock.idleMinutes ?? 0 }
    : {};
  return { ...DEFAULT_SETTINGS, ...fromLock, ...(settings ?? {}) };
}

/** Changes some settings and keeps the rest. */
export async function setSettings(changes: Partial<Settings>): Promise<void> {
  await chrome.storage.local.set({ settings: { ...(await getSettings()), ...changes } });
}

export async function getPending(): Promise<PendingPairing | null> {
  const { pending } = (await chrome.storage.session.get('pending')) as { pending?: PendingPairing };
  return pending ?? null;
}

export async function setPending(pending: PendingPairing | null): Promise<void> {
  if (pending) await chrome.storage.session.set({ pending });
  else await chrome.storage.session.remove('pending');
}

/* ------------------------------------------------------------------------- *
 * The device key
 * ------------------------------------------------------------------------- */

export interface DeviceKey {
  privateKey: CryptoKey;
  /** SubjectPublicKeyInfo DER, base64url: what Helm records. */
  publicKey: string;
}

/** 'pending' while a pairing is being approved; 'device' once it has been. */
type KeySlot = 'pending' | 'device';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('helm-extension', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('keys');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction('keys', mode);
      const request = fn(tx.objectStore('keys'));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function getKey(slot: KeySlot): Promise<DeviceKey | null> {
  const value = await withStore<DeviceKey | undefined>('readonly', (s) => s.get(slot));
  return value ?? null;
}

async function putKey(slot: KeySlot, key: DeviceKey): Promise<void> {
  await withStore('readwrite', (s) => s.put(key, slot));
}

async function deleteKey(slot: KeySlot): Promise<void> {
  await withStore('readwrite', (s) => s.delete(slot));
}

/** A fresh P-256 key for a pairing about to be approved. */
export async function makePendingKey(): Promise<DeviceKey> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const key = { privateKey: pair.privateKey, publicKey: toBase64Url(spki) };
  await putKey('pending', key);
  return key;
}

/** The approved pairing's key replaces whatever was there before. */
export async function promotePendingKey(): Promise<boolean> {
  const pending = await getKey('pending');
  if (!pending) return false;
  await putKey('device', pending);
  await deleteKey('pending');
  return true;
}

/* ------------------------------------------------------------------------- *
 * Encoding
 * ------------------------------------------------------------------------- */

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The first 16 hex digits of the key's SHA-256, grouped in fours: what Helm shows too. */
export async function fingerprint(publicKey: string): Promise<string> {
  const hex = (await sha256Hex(fromBase64Url(publicKey))).slice(0, 16);
  return (hex.match(/.{4}/g) ?? []).join(' ').toUpperCase();
}

/** Random, URL-safe, for the pairing's state. */
export function randomState(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(24)));
}
