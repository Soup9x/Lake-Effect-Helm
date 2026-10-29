/**
 * Reading a password manager's export into rows a client's Credentials can take.
 *
 * READ IN THE BROWSER, NOT THE SERVER. The import dialog parses the file in the
 * tab, lets the person check and correct which column is which, and sends only
 * the mapped rows. So this module imports nothing a client bundle cannot carry,
 * and the route that receives the rows never sees the file at all.
 *
 * TWO SHAPES OF FILE, ONE SHAPE OF RESULT. Every reader produces a table —
 * column names and rows of strings — because that is what the mapping step
 * shows. A CSV keeps its own header words, so a column the reader guessed wrong
 * is visibly wrong and can be pointed elsewhere. A JSON export is flattened into
 * Helm's own column names first, since its "columns" are nested keys nobody
 * would recognise in a dropdown.
 *
 * WHAT IT READS:
 *   * CSV from Bitwarden, 1Password, LastPass, Keeper (which writes no header
 *     row), Dashlane, NordPass, Proton Pass, KeePass / KeePassXC, IT Glue,
 *     Chrome, Edge, Firefox and Safari — and any CSV whose header names its
 *     columns in words like those.
 *   * JSON from Bitwarden (personal and organization exports), Keeper and
 *     Proton Pass, and any JSON list of flat objects.
 *   * 1Password's .1pux, and a Dashlane-style .zip holding a CSV, unpacked here
 *     with the browser's own inflate.
 *   * An ENCRYPTED export is refused with a sentence saying how to get a plain
 *     one. It cannot be opened without the account's key, and this is not the
 *     place to ask for it.
 *
 * WHAT IT LEAVES OUT, and counts: items that are not logins (secure notes,
 * cards, identities, SSH keys), archived 1Password items, and custom fields.
 * Custom fields are left out rather than poured into notes because notes are
 * stored in the clear and a hidden field is, as often as not, a second secret.
 * The count is shown so somebody can copy the ones that matter by hand.
 */
import { parseCsv } from '../personal/import';

/** What a column can be mapped to. The keys are the route's field keys. */
export const PASSWORD_TARGETS = [
  { key: 'name', label: 'Name' },
  { key: 'username', label: 'Username' },
  { key: 'password', label: 'Password' },
  { key: 'url', label: 'URL' },
  { key: 'totpSeed', label: 'One-time code' },
  { key: 'notes', label: 'Notes' },
  { key: 'folder', label: 'Folder (becomes a tag)' },
] as const;

export type PasswordTarget = (typeof PASSWORD_TARGETS)[number]['key'];
/** Target → column index, or null for "not in this file". */
export type ColumnMapping = Record<PasswordTarget, number | null>;

export interface PasswordTable {
  /** "Bitwarden JSON", "LastPass CSV", … — shown so a wrong guess is visible. */
  format: string;
  columns: string[];
  rows: string[][];
  /** Items left out because they are not logins, or are archived. */
  skipped: number;
  /** Sentences about what else was left out. */
  notices: string[];
  /** The mapping this reader would choose. JSON readers are always certain. */
  suggested: ColumnMapping;
  /** True when the first line was data, not column names (Keeper's CSV). */
  headerless: boolean;
}

export class PasswordExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordExportError';
  }
}

/**
 * The most one import may carry; matches the route's row ceiling. Checked
 * after mapping and filtering rather than on reading, so a larger export can
 * still come in one folder at a time.
 */
export const MAX_EXPORT_ROWS = 5000;

const squash = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Header words per target, already squashed. Earlier aliases win. */
const ALIASES: Record<PasswordTarget, readonly string[]> = {
  name: ['name', 'title', 'itemname', 'entry', 'account', 'accountname', 'label'],
  username: ['loginusername', 'username', 'user', 'login', 'loginname', 'email', 'emailaddress', 'username1'],
  password: ['loginpassword', 'password', 'pass', 'secret'],
  url: ['loginuri', 'url', 'uri', 'website', 'websiteaddress', 'loginurl', 'urls', 'webaddress', 'link', 'resourceurl'],
  totpSeed: [
    'logintotp', 'totp', 'otpauth', 'otp', 'otpsecret', 'otpsecretkey', 'totpsecret', 'totpuri',
    'onetimepassword', 'onetimecode', 'twofactorsecret', 'authkey', 'mfa',
  ],
  notes: ['notes', 'note', 'extra', 'comments', 'comment'],
  folder: ['folder', 'group', 'grouping', 'collection', 'collections', 'vault', 'passwordcategory', 'category'],
};

/** Keeper's CSV has no header: Folder, Title, Login, Password, Website, Notes, Shared folder, custom… */
const KEEPER_LAYOUT: ColumnMapping = {
  folder: 0, name: 1, username: 2, password: 3, url: 4, notes: 5, totpSeed: null,
};

/** The column names a flattened JSON export is given, in this order. */
const FLAT_COLUMNS = ['Name', 'Username', 'Password', 'URL', 'One-time code', 'Notes', 'Folder'];
const FLAT_MAPPING: ColumnMapping = {
  name: 0, username: 1, password: 2, url: 3, totpSeed: 4, notes: 5, folder: 6,
};

/** Row types that are not logins, in the words the CSV exporters use. */
const NOT_A_LOGIN = new Set([
  'note', 'securenote', 'card', 'creditcard', 'paymentcard', 'identity', 'sshkey',
  'personalinfo', 'address', 'document', 'bankaccount', '2', '3', '4', '5',
]);

export function emptyMapping(): ColumnMapping {
  return { name: null, username: null, password: null, url: null, totpSeed: null, notes: null, folder: null };
}

/** The mapping a header row implies. A column is given to at most one target. */
export function suggestMapping(columns: readonly string[]): ColumnMapping {
  const header = columns.map(squash);
  const mapping = emptyMapping();
  const taken = new Set<number>();
  for (const target of PASSWORD_TARGETS) {
    for (const alias of ALIASES[target.key]) {
      const at = header.findIndex((h, i) => h === alias && !taken.has(i));
      if (at >= 0) {
        mapping[target.key] = at;
        taken.add(at);
        break;
      }
    }
  }
  return mapping;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Read an uploaded file. Async only for the zip formats (.1pux, Dashlane, IT Glue), which inflate through
 * DecompressionStream.
 */
export async function readPasswordFile(
  bytes: Uint8Array,
  options: { headerless?: boolean } = {},
): Promise<PasswordTable> {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return readZip(bytes, options);
  }
  return readPasswordText(new TextDecoder().decode(bytes), options);
}

/** Read an export's text. Throws PasswordExportError with a sentence a person can act on. */
export function readPasswordText(text: string, options: { headerless?: boolean } = {}): PasswordTable {
  const body = text.replace(/^﻿/, '');
  const trimmed = body.trimStart();
  if (trimmed === '') throw new PasswordExportError('The file is empty.');
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return readJson(trimmed);
  return readCsv(body, options.headerless);
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function describeCsv(header: string[]): string {
  const has = (h: string) => header.includes(h);
  if (has('loginuri') && has('loginpassword')) return 'Bitwarden CSV';
  if (has('httprealm')) return 'Firefox CSV';
  if (has('grouping') && has('extra')) return 'LastPass CSV';
  if (has('otpauth')) return '1Password CSV';
  if (has('username2') || (has('otpsecret') && has('category'))) return 'Dashlane CSV';
  if (has('passwordcategory') || has('resourceid')) return 'IT Glue CSV';
  if (has('vault') && has('totp')) return 'Proton Pass CSV';
  if (has('group') && has('title')) return 'KeePass CSV';
  if (has('cardholdername')) return 'NordPass CSV';
  return 'CSV';
}

function readCsv(text: string, headerless: boolean | undefined): PasswordTable {
  let raw: string[][];
  try {
    raw = parseCsv(text);
  } catch (error) {
    throw new PasswordExportError(error instanceof Error ? error.message : 'The file could not be read.');
  }
  raw = raw.filter((row) => row.some((cell) => cell.trim() !== ''));
  if (raw.length === 0) throw new PasswordExportError('The file is empty.');

  const first = raw[0]!;
  const recognised = Object.values(suggestMapping(first)).filter((v) => v !== null).length;
  /*
   * Keeper writes no header. A first row in which nothing is a known column
   * name, five or more cells wide, is that or something like it; either way it
   * is data, and the person can turn the checkbox off if the guess is wrong.
   */
  const keeperLike = recognised === 0 && first.length >= 5;
  const noHeader = headerless ?? keeperLike;

  const width = Math.max(...raw.map((r) => r.length));
  const columns = noHeader
    ? Array.from({ length: width }, (_, i) => `Column ${i + 1}`)
    : first.map((h, i) => h.trim() || `Column ${i + 1}`);
  while (columns.length < width) columns.push(`Column ${columns.length + 1}`);

  const header = noHeader ? [] : first.map(squash);
  const typeAt = header.indexOf('type');
  // LastPass writes secure notes as rows whose URL is the literal "http://sn".
  const lastPass = header.includes('grouping') && header.includes('extra');
  const urlAt = suggestMapping(first).url;

  const rows: string[][] = [];
  let skipped = 0;
  for (const row of noHeader ? raw : raw.slice(1)) {
    if (typeAt >= 0 && NOT_A_LOGIN.has(squash(row[typeAt] ?? ''))) { skipped += 1; continue; }
    if (lastPass && urlAt !== null && (row[urlAt] ?? '').trim() === 'http://sn') { skipped += 1; continue; }
    rows.push(columns.map((_, i) => row[i] ?? ''));
  }
  return {
    format: noHeader ? (keeperLike ? 'Keeper CSV' : 'CSV without a header row') : describeCsv(header),
    columns,
    rows,
    skipped,
    notices: [],
    suggested: noHeader ? (keeperLike ? { ...KEEPER_LAYOUT } : emptyMapping()) : suggestMapping(first),
    headerless: noHeader,
  };
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

interface Flat {
  name: string; username: string; password: string; url: string; totp: string; notes: string; folder: string;
}

const str = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function flatTable(format: string, items: Flat[], skipped: number, customFields: number): PasswordTable {
  const notices: string[] = [];
  if (customFields > 0) {
    notices.push(
      `${customFields} custom ${customFields === 1 ? 'field was' : 'fields were'} left out. `
      + 'Custom fields often hold a second secret, and notes are not encrypted, so copy any you need by hand.',
    );
  }
  return {
    format,
    columns: [...FLAT_COLUMNS],
    rows: items.map((i) => [i.name, i.username, i.password, i.url, i.totp, i.notes, i.folder]),
    skipped,
    notices,
    suggested: { ...FLAT_MAPPING },
    headerless: false,
  };
}

function readJson(text: string): PasswordTable {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new PasswordExportError('That file is not valid JSON.');
  }
  if (isObject(data) && data.encrypted === true) {
    throw new PasswordExportError(
      'That export is encrypted, and cannot be opened without the password manager\'s own key. '
      + 'Export again choosing the unencrypted JSON (Bitwarden calls it ".json", not ".json (Encrypted)"), or CSV.',
    );
  }
  if (isObject(data) && Array.isArray(data.items)) return readBitwarden(data);
  if (isObject(data) && Array.isArray(data.accounts)) return readOnePux(data);
  if (isObject(data) && Array.isArray(data.records)) return readKeeper(data);
  if (isObject(data) && isObject(data.vaults)) return readProton(data);
  if (Array.isArray(data)) return readGenericJson(data);
  throw new PasswordExportError(
    'That JSON is not an export this importer knows: it has no list of items, records or vaults.',
  );
}

/** Bitwarden: `items`, with folders by id and, in an organization export, collections. */
function readBitwarden(root: Record<string, unknown>): PasswordTable {
  const names = new Map<string, string>();
  for (const list of [root.folders, root.collections]) {
    if (!Array.isArray(list)) continue;
    for (const f of list) if (isObject(f)) names.set(str(f.id), str(f.name));
  }

  const items: Flat[] = [];
  let skipped = 0;
  let customFields = 0;
  for (const raw of root.items as unknown[]) {
    // 1 is a login; 2 a secure note, 3 a card, 4 an identity, 5 an SSH key.
    if (!isObject(raw) || raw.type !== 1) { skipped += 1; continue; }
    const login = isObject(raw.login) ? raw.login : {};
    const uris = Array.isArray(login.uris) ? login.uris : [];
    const collectionIds = Array.isArray(raw.collectionIds) ? raw.collectionIds : [];
    if (Array.isArray(raw.fields)) customFields += raw.fields.length;
    items.push({
      name: str(raw.name),
      username: str(login.username),
      password: str(login.password),
      url: uris.map((u) => (isObject(u) ? str(u.uri) : '')).find((u) => u.trim() !== '') ?? '',
      totp: str(login.totp),
      notes: str(raw.notes),
      folder: names.get(str(raw.folderId)) ?? names.get(str(collectionIds[0])) ?? '',
    });
  }
  return flatTable(Array.isArray(root.collections) ? 'Bitwarden organization JSON' : 'Bitwarden JSON',
    items, skipped, customFields);
}

/**
 * 1Password's .1pux, whose `export.data` is accounts → vaults → items. A Login
 * (category 001) or Password (005) is kept; everything else is counted.
 */
function readOnePux(root: Record<string, unknown>): PasswordTable {
  const items: Flat[] = [];
  let skipped = 0;
  let customFields = 0;
  for (const account of root.accounts as unknown[]) {
    if (!isObject(account) || !Array.isArray(account.vaults)) continue;
    for (const vault of account.vaults) {
      if (!isObject(vault) || !Array.isArray(vault.items)) continue;
      const vaultName = isObject(vault.attrs) ? str(vault.attrs.name) : '';
      for (const item of vault.items) {
        if (!isObject(item)) { skipped += 1; continue; }
        const category = str(item.categoryUuid);
        if ((category !== '001' && category !== '005') || str(item.state) === 'archived') {
          skipped += 1;
          continue;
        }
        const overview = isObject(item.overview) ? item.overview : {};
        const details = isObject(item.details) ? item.details : {};
        const loginFields = Array.isArray(details.loginFields) ? details.loginFields.filter(isObject) : [];
        const designated = (d: string) => str(loginFields.find((f) => f.designation === d)?.value);

        let totp = '';
        for (const section of Array.isArray(details.sections) ? details.sections : []) {
          if (!isObject(section) || !Array.isArray(section.fields)) continue;
          for (const field of section.fields) {
            const value = isObject(field) && isObject(field.value) ? field.value : null;
            if (value && typeof value.totp === 'string' && totp === '') totp = value.totp;
            else customFields += 1;
          }
        }
        const urls = Array.isArray(overview.urls) ? overview.urls : [];
        items.push({
          name: str(overview.title),
          username: designated('username'),
          password: designated('password') || str(details.password),
          url: str(overview.url) || (urls.map((u) => (isObject(u) ? str(u.url) : '')).find(Boolean) ?? ''),
          totp,
          notes: str(details.notesPlain),
          folder: vaultName,
        });
      }
    }
  }
  return flatTable('1Password 1PUX', items, skipped, customFields);
}

/** Keeper's JSON: `records`, with folders inline and the one-time code among custom fields. */
function readKeeper(root: Record<string, unknown>): PasswordTable {
  const items: Flat[] = [];
  let skipped = 0;
  let customFields = 0;
  for (const raw of root.records as unknown[]) {
    if (!isObject(raw)) { skipped += 1; continue; }
    // Older exports carry no $type. Of the typed ones, a login is kept, and so
    // is anything else holding a password (server and database credentials);
    // cards, addresses and contacts are not.
    const type = squash(str(raw.$type));
    if (type !== '' && type !== 'login' && !str(raw.password)) { skipped += 1; continue; }
    let totp = '';
    const custom = isObject(raw.custom_fields) ? raw.custom_fields : {};
    for (const [key, value] of Object.entries(custom)) {
      const text = str(value);
      if (totp === '' && (text.startsWith('otpauth://') || key === 'TFC:Keeper' || key === '$oneTimeCode')) {
        totp = text;
      } else {
        customFields += 1;
      }
    }
    const folders = Array.isArray(raw.folders) ? raw.folders.filter(isObject) : [];
    const folder = folders.map((f) => str(f.folder) || str(f.shared_folder)).find(Boolean) ?? '';
    items.push({
      name: str(raw.title),
      username: str(raw.login),
      password: str(raw.password),
      url: str(raw.login_url),
      totp,
      notes: str(raw.notes),
      folder,
    });
  }
  return flatTable('Keeper JSON', items, skipped, customFields);
}

/** Proton Pass: `vaults` keyed by id, each with `items` whose `data.type` says what it is. */
function readProton(root: Record<string, unknown>): PasswordTable {
  const items: Flat[] = [];
  let skipped = 0;
  let customFields = 0;
  for (const vault of Object.values(root.vaults as Record<string, unknown>)) {
    if (!isObject(vault) || !Array.isArray(vault.items)) continue;
    for (const item of vault.items) {
      const data = isObject(item) && isObject(item.data) ? item.data : null;
      if (!data?.content || data.type !== 'login') { skipped += 1; continue; }
      const metadata = isObject(data.metadata) ? data.metadata : {};
      const content = isObject(data.content) ? data.content : {};
      const urls = Array.isArray(content.urls) ? content.urls : [];
      if (Array.isArray(data.extraFields)) customFields += data.extraFields.length;
      items.push({
        name: str(metadata.name),
        username: str(content.itemUsername) || str(content.username) || str(content.itemEmail),
        password: str(content.password),
        url: urls.map(str).find(Boolean) ?? '',
        totp: str(content.totpUri),
        notes: str(metadata.note),
        folder: str(vault.name),
      });
    }
  }
  return flatTable('Proton Pass JSON', items, skipped, customFields);
}

/**
 * A JSON list of flat objects — a script's output, an API dump. Its keys become
 * columns and the mapping step does the rest, exactly as for a CSV.
 */
function readGenericJson(list: unknown[]): PasswordTable {
  const objects = list.filter(isObject);
  if (objects.length === 0) throw new PasswordExportError('That JSON list has no entries in it.');
  const columns: string[] = [];
  for (const o of objects) {
    for (const [key, value] of Object.entries(o)) {
      // Nested objects and lists have no cell to show; a column of them would be empty.
      if (!columns.includes(key) && (typeof value !== 'object' || value === null)) columns.push(key);
    }
  }
  return {
    format: 'JSON',
    columns,
    rows: objects.map((o) => columns.map((c) => str(o[c]))),
    skipped: list.length - objects.length,
    notices: [],
    suggested: suggestMapping(columns),
    headerless: false,
  };
}

// ---------------------------------------------------------------------------
// Zip (.1pux, Dashlane)
// ---------------------------------------------------------------------------

/**
 * Just enough of the zip format to find one file and inflate it: the central
 * directory gives each entry's name, method and offset. Written here for the
 * same reason the CSV parser is — these bytes are a client's passwords.
 */
async function readZip(bytes: Uint8Array, options: { headerless?: boolean }): Promise<PasswordTable> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new PasswordExportError('That zip file is damaged or incomplete.');

  const entries: { name: string; method: number; size: number; offset: number }[] = [];
  let at = view.getUint32(end + 16, true);
  const count = view.getUint16(end + 10, true);
  for (let n = 0; n < count && view.getUint32(at, true) === 0x02014b50; n += 1) {
    const nameLength = view.getUint16(at + 28, true);
    entries.push({
      method: view.getUint16(at + 10, true),
      size: view.getUint32(at + 20, true),
      offset: view.getUint32(at + 42, true),
      name: new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength)),
    });
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }

  const wanted = entries.find((e) => e.name === 'export.data')
    ?? entries.find((e) => /(^|\/)credentials\.csv$/i.test(e.name))
    // IT Glue's account export: one CSV per kind of record, passwords among them.
    ?? entries.find((e) => /(^|\/)passwords\.csv$/i.test(e.name))
    ?? (entries.filter((e) => /\.(csv|json)$/i.test(e.name)).length === 1
      ? entries.find((e) => /\.(csv|json)$/i.test(e.name))
      : undefined);
  if (!wanted) {
    throw new PasswordExportError(
      'That zip does not hold a password export this importer recognises (a 1Password export.data, or one CSV or JSON file).',
    );
  }

  const local = wanted.offset;
  const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
  const compressed = bytes.subarray(start, start + wanted.size);
  let content: Uint8Array;
  if (wanted.method === 0) {
    content = compressed;
  } else if (wanted.method === 8) {
    const stream = new Blob([compressed as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    content = new Uint8Array(await new Response(stream).arrayBuffer());
  } else {
    throw new PasswordExportError('That zip uses a compression this importer cannot open.');
  }
  return readPasswordText(new TextDecoder().decode(content), options);
}

// ---------------------------------------------------------------------------
// Rows for the route
// ---------------------------------------------------------------------------

export interface ImportRowFilter {
  column: number;
  value: string;
}

/** A row as the route's password spec reads it. */
export type MappedRow = Partial<Record<PasswordTarget, string>>;

function hostOf(url: string): string {
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Apply a mapping. A row with nothing in any mapped column is dropped; a row
 * with no name is named after its site, then its username — Firefox and
 * Safari write no name column at all.
 */
export function mapPasswordRows(
  table: PasswordTable,
  mapping: ColumnMapping,
  filter?: ImportRowFilter | null,
): MappedRow[] {
  const out: MappedRow[] = [];
  for (const row of table.rows) {
    if (filter && (row[filter.column] ?? '').trim() !== filter.value) continue;
    const mapped: MappedRow = {};
    for (const target of PASSWORD_TARGETS) {
      const index = mapping[target.key];
      if (index === null) continue;
      const cell = row[index] ?? '';
      // A password keeps its whitespace: leading spaces can be part of one.
      mapped[target.key] = target.key === 'password' ? cell : cell.trim();
    }
    if (Object.values(mapped).every((v) => v === '' || v === undefined)) continue;
    if (!mapped.name) {
      const url = (mapped.url ?? '').split(/[\r\n,]+/)[0]!.trim();
      mapped.name = (url ? hostOf(url) : '') || mapped.username || '';
    }
    if (mapped.url) mapped.url = mapped.url.split(/[\r\n,]+/).map((u) => u.trim()).find(Boolean) ?? '';
    out.push(mapped);
  }
  return out;
}

/** The distinct values of one column, for the "only rows where…" filter. Capped. */
export function distinctValues(table: PasswordTable, column: number, limit = 200): string[] {
  const seen = new Set<string>();
  for (const row of table.rows) {
    const value = (row[column] ?? '').trim();
    if (value !== '') seen.add(value);
    if (seen.size > limit) break;
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}
