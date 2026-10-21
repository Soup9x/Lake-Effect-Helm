/**
 * Reading another password manager's export into personal vault entries.
 *
 * IMPORTS NOTHING, so the import dialog (a client component) can parse the
 * file in the browser and show what it found before anything is sent, and the
 * route can parse nothing at all — it is handed entries, not a file.
 *
 * WHAT IT READS:
 *   * CSV from Bitwarden, Chrome / Edge, Firefox, 1Password, LastPass,
 *     KeePass / KeePassXC, Proton Pass — and any CSV whose header names its
 *     columns in words like those. The columns are found by name, not by
 *     position, which is why one reader covers all of them.
 *   * Bitwarden's unencrypted JSON export. An ENCRYPTED export is refused with
 *     a sentence saying so: it cannot be opened without the account's key.
 *
 * WHAT IT SKIPS, and counts: rows that are not logins (a Bitwarden card,
 * identity or SSH key), and rows with nothing to keep — no name, URL, username
 * or password at all.
 */

export interface ImportedEntry {
  name: string;
  username: string | null;
  url: string | null;
  password: string | null;
  /** An otpauth:// URI or a base32 seed, exactly as exported. */
  totp: string | null;
  notes: string | null;
}

export interface ParsedImport {
  format: string;
  entries: ImportedEntry[];
  /** Rows that were not logins, or held nothing worth keeping. */
  skipped: number;
}

export class ImportFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportFormatError';
  }
}

/** The most one import may carry. Generous for a person; a bound for the route. */
export const MAX_IMPORT_ENTRIES = 2000;

const LIMITS = { name: 200, username: 320, url: 2048, notes: 4000, password: 65_536, totp: 4096 } as const;

/** Read an export. Throws ImportFormatError with a sentence a person can act on. */
export function parseVaultImport(text: string): ParsedImport {
  const body = text.replace(/^﻿/, '');
  const trimmed = body.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return parseBitwardenJson(trimmed);
  return parseCsvExport(body);
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** Header aliases, lower-cased with spaces and punctuation removed. First match wins. */
const COLUMNS = {
  name: ['name', 'title', 'itemname', 'entry'],
  url: ['loginuri', 'url', 'uri', 'website', 'websiteaddress', 'loginurl', 'urls', 'webaddress'],
  username: ['loginusername', 'username', 'user', 'login', 'email', 'emailaddress', 'loginname'],
  password: ['loginpassword', 'password', 'pass'],
  totp: ['logintotp', 'totp', 'otpauth', 'otp', 'onetimepassword', 'twofactorsecret', 'otpsecret'],
  notes: ['notes', 'note', 'extra', 'comments', 'comment'],
  type: ['type'],
} as const;

type Column = keyof typeof COLUMNS;

const squash = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, '');

function parseCsvExport(text: string): ParsedImport {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new ImportFormatError('The file is empty.');

  const header = rows[0]!.map(squash);
  const index = {} as Record<Column, number>;
  for (const column of Object.keys(COLUMNS) as Column[]) {
    index[column] = -1;
    for (const alias of COLUMNS[column]) {
      const at = header.indexOf(alias);
      if (at >= 0) { index[column] = at; break; }
    }
  }
  if (index.password < 0 && index.username < 0) {
    throw new ImportFormatError(
      'That does not look like a password export: the first row should name the columns, '
      + 'and there is no username or password column.',
    );
  }

  const entries: ImportedEntry[] = [];
  let skipped = 0;
  for (const row of rows.slice(1)) {
    if (row.every((cell) => cell.trim() === '')) continue;
    const cell = (column: Column) => (index[column] >= 0 ? row[index[column]] ?? '' : '');
    // Bitwarden's CSV carries notes, cards and identities beside logins.
    const type = cell('type').trim().toLowerCase();
    if (type !== '' && type !== 'login' && type !== '1') { skipped += 1; continue; }

    const entry = toEntry({
      name: cell('name'),
      url: firstUrl(cell('url')),
      username: cell('username'),
      password: cell('password'),
      totp: cell('totp'),
      notes: cell('notes'),
    });
    if (entry) entries.push(entry); else skipped += 1;
  }
  return { format: describeCsv(header), entries, skipped };
}

function describeCsv(header: string[]): string {
  if (header.includes('loginuri') && header.includes('loginpassword')) return 'Bitwarden CSV';
  if (header.includes('httprealm')) return 'Firefox CSV';
  if (header.includes('grouping')) return 'LastPass CSV';
  if (header.includes('otpauth')) return '1Password CSV';
  if (header.includes('group') && header.includes('title')) return 'KeePass CSV';
  return 'CSV';
}

/**
 * RFC 4180: commas or semicolons, quoted fields with doubled quotes, and line
 * breaks inside quotes — notes routinely carry them. The delimiter is whichever
 * of the two the header line uses more of, for exports from a locale that
 * writes semicolons.
 */
export function parseCsv(text: string): string[][] {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (quoted) throw new ImportFormatError('The file ends inside a quoted field — it may have been cut short.');
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// ---------------------------------------------------------------------------
// Bitwarden JSON
// ---------------------------------------------------------------------------

interface BitwardenItem {
  type?: number;
  name?: string;
  notes?: string | null;
  login?: {
    username?: string | null;
    password?: string | null;
    totp?: string | null;
    uris?: { uri?: string | null }[] | null;
  } | null;
}

function parseBitwardenJson(text: string): ParsedImport {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ImportFormatError('That file is not valid JSON.');
  }
  const root = data as { encrypted?: boolean; items?: unknown };
  if (root && typeof root === 'object' && root.encrypted === true) {
    throw new ImportFormatError(
      'That is an encrypted Bitwarden export, which cannot be opened without your Bitwarden key. '
      + 'Export again choosing ".json" (not ".json (Encrypted)"), or ".csv".',
    );
  }
  if (!root || typeof root !== 'object' || !Array.isArray(root.items)) {
    throw new ImportFormatError('That JSON is not a Bitwarden export: it has no "items" list.');
  }

  const entries: ImportedEntry[] = [];
  let skipped = 0;
  for (const raw of root.items as BitwardenItem[]) {
    // 1 is a login; 2 a secure note, 3 a card, 4 an identity, 5 an SSH key.
    if (raw?.type !== 1) { skipped += 1; continue; }
    const login = raw.login ?? {};
    const entry = toEntry({
      name: raw.name ?? '',
      url: (login.uris ?? []).map((u) => u?.uri ?? '').find((u) => u.trim() !== '') ?? '',
      username: login.username ?? '',
      password: login.password ?? '',
      totp: login.totp ?? '',
      notes: raw.notes ?? '',
    });
    if (entry) entries.push(entry); else skipped += 1;
  }
  return { format: 'Bitwarden JSON', entries, skipped };
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** One of several URLs some exports pack into a cell ("a.com, b.com" or one per line). */
function firstUrl(cell: string): string {
  return cell.split(/[\r\n,]+/).map((u) => u.trim()).find(Boolean) ?? '';
}

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`);
    return parsed.hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

const clip = (value: string, limit: number) => value.slice(0, limit);
const orNull = (value: string) => (value.trim() === '' ? null : value.trim());

function toEntry(raw: {
  name: string; url: string; username: string; password: string; totp: string; notes: string;
}): ImportedEntry | null {
  const url = orNull(raw.url);
  const username = orNull(raw.username);
  // A password is kept exactly as exported: leading spaces can be part of one.
  const password = raw.password === '' ? null : raw.password;
  // Firefox exports have no name column; the site is the natural one.
  const name = orNull(raw.name) ?? (url ? hostOf(url) : null) ?? username;
  if (!name && !password) return null;
  return {
    name: clip(name ?? 'Imported login', LIMITS.name),
    username: username ? clip(username, LIMITS.username) : null,
    url: url ? clip(url, LIMITS.url) : null,
    password: password ? clip(password, LIMITS.password) : null,
    totp: orNull(raw.totp) ? clip(raw.totp.trim(), LIMITS.totp) : null,
    notes: orNull(raw.notes) ? clip(raw.notes.trim(), LIMITS.notes) : null,
  };
}
