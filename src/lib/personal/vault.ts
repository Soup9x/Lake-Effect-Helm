/**
 * The personal password vault (1030): a person's own passwords, readable by
 * them and nobody else.
 *
 * EVERY QUERY HERE RUNS UNDER THE OWNER POLICY. There is no "for somebody
 * else" path: a call made as an administrator about another person's entry
 * matches no row, which is the same answer as an entry that does not exist.
 *
 * ONE ENVELOPE PER ENTRY, holding a small JSON document — the password and,
 * when there is one, the one-time code seed with its parameters — sealed under
 * the tenant's active data key with the entry and its version in the AAD, so a
 * ciphertext copied onto another entry, or replayed from an older version,
 * fails to open rather than decrypting as the wrong thing.
 *
 * AUDITED WITHOUT ITS LABEL: 'personal_vault.revealed' names the entry's id
 * and why it was opened, never what it is called.
 */
import type { HelmTx } from '../db/client';
import { withTenant } from '../db/client';
import { openField, sealField, wipe, type SecretBinding } from '../crypto/envelope';
import { base32Decode, generateTotp, type TotpAlgorithm } from '../crypto/totp';
import { getDekCache } from '../services';
import { activeDataKey, dataKeyById } from '../secrets/keys';
import { parseTotpEnrolment, TotpEnrolmentError } from '../secrets/totp-enrolment';
import { ApiError } from '../api/errors';

const FIELD = 'personal_vault';

/** What is encrypted. Never leaves this module whole. */
interface Payload {
  password?: string;
  totp?: { seed: string; algorithm: TotpAlgorithm; digits: 6 | 7 | 8; periodSeconds: number };
}

export interface VaultEntry {
  id: string;
  name: string;
  username: string | null;
  url: string | null;
  notes: string | null;
  hasPassword: boolean;
  hasTotp: boolean;
  updatedAt: string;
}

interface Row {
  id: string;
  name: string;
  username: string | null;
  url: string | null;
  notes: string | null;
  has_password: boolean;
  has_totp: boolean;
  updated_at: Date;
}

interface EnvelopeRow {
  data_key_id: string | null;
  secret_version: number;
  secret_ciphertext: Buffer | null;
  secret_nonce: Buffer | null;
  secret_tag: Buffer | null;
  secret_aad: string | null;
}

const view = (r: Row): VaultEntry => ({
  id: r.id,
  name: r.name,
  username: r.username,
  url: r.url,
  notes: r.notes,
  hasPassword: r.has_password,
  hasTotp: r.has_totp,
  updatedAt: r.updated_at.toISOString(),
});

/** How many entries this person has, for the Personal page's card. */
export async function countVault(tx: HelmTx): Promise<number> {
  const [row] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM personal_credential`;
  return row?.n ?? 0;
}

export async function listVault(tx: HelmTx): Promise<VaultEntry[]> {
  const rows = await tx<Row[]>`
    SELECT id, name, username, url, notes, has_password, has_totp, updated_at
    FROM personal_credential
    ORDER BY lower(name), id
  `;
  return rows.map(view);
}

/* ------------------------------------------------------------------------- *
 * Sealing and opening
 * ------------------------------------------------------------------------- */

const binding = (tenantId: string, id: string, version: number): SecretBinding =>
  ({ tenantId, secretId: id, field: FIELD, version });

async function dekFor(key: { id: string; wrappedDek: Buffer; kekId: string; wrapContext: Record<string, string> }) {
  return getDekCache().get({ dataKeyId: key.id, wrappedDek: key.wrappedDek, kekId: key.kekId, context: key.wrapContext });
}

async function seal(tx: HelmTx, tenantId: string, id: string, version: number, payload: Payload) {
  const key = await activeDataKey(tx, tenantId);
  const dek = await dekFor(key);
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  try {
    const envelope = sealField(dek, bytes, binding(tenantId, id, version));
    return { dataKeyId: key.id, ...envelope };
  } finally {
    wipe(bytes);
  }
}

async function open(tx: HelmTx, tenantId: string, id: string, row: EnvelopeRow): Promise<Payload> {
  if (!row.secret_ciphertext || !row.data_key_id || !row.secret_nonce || !row.secret_tag || !row.secret_aad) {
    return {};
  }
  const key = await dataKeyById(tx, row.data_key_id);
  if (!key || key.status === 'destroyed') {
    throw ApiError.conflict('this entry was sealed under a key that no longer exists');
  }
  const dek = await dekFor(key);
  const bytes = openField(
    dek,
    { ciphertext: row.secret_ciphertext, nonce: row.secret_nonce, authTag: row.secret_tag, aad: row.secret_aad },
    binding(tenantId, id, row.secret_version),
  );
  try {
    return JSON.parse(bytes.toString('utf8')) as Payload;
  } finally {
    wipe(bytes);
  }
}

/** Write the payload back as the next version, or clear the envelope when it is empty. */
async function store(tx: HelmTx, tenantId: string, id: string, currentVersion: number, payload: Payload) {
  const hasPassword = typeof payload.password === 'string' && payload.password.length > 0;
  const hasTotp = payload.totp !== undefined;
  if (!hasPassword && !hasTotp) {
    await tx`
      UPDATE personal_credential SET
        data_key_id = NULL, secret_ciphertext = NULL, secret_nonce = NULL, secret_tag = NULL, secret_aad = NULL,
        has_password = false, has_totp = false, updated_at = now()
      WHERE id = ${id}::uuid
    `;
    return;
  }
  const next = currentVersion + 1;
  const sealed = await seal(tx, tenantId, id, next, payload);
  await tx`
    UPDATE personal_credential SET
      data_key_id = ${sealed.dataKeyId}::uuid, secret_version = ${next},
      secret_ciphertext = ${sealed.ciphertext}, secret_nonce = ${sealed.nonce},
      secret_tag = ${sealed.authTag}, secret_aad = ${sealed.aad},
      has_password = ${hasPassword}, has_totp = ${hasTotp}, updated_at = now()
    WHERE id = ${id}::uuid
  `;
}

function enrol(seed: string): NonNullable<Payload['totp']> {
  try {
    const e = parseTotpEnrolment(seed);
    return { seed: e.seed, algorithm: e.algorithm, digits: e.digits, periodSeconds: e.periodSeconds };
  } catch (error) {
    if (error instanceof TotpEnrolmentError) throw ApiError.invalid(error.message);
    throw error;
  }
}

/* ------------------------------------------------------------------------- *
 * Writing
 * ------------------------------------------------------------------------- */

export interface VaultInput {
  name?: string | undefined;
  username?: string | null | undefined;
  url?: string | null | undefined;
  notes?: string | null | undefined;
  /** Absent keeps it; '' or null removes it; a value replaces it. */
  password?: string | null | undefined;
  /** An otpauth:// URI or base32 seed. Absent keeps it; '' or null removes it. */
  totp?: string | null | undefined;
}

export async function createEntry(tx: HelmTx, tenantId: string, ownerId: string, input: VaultInput): Promise<VaultEntry> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO personal_credential (tenant_id, owner_user_id, name, username, url, notes)
    VALUES (${tenantId}::uuid, ${ownerId}::uuid, ${input.name!.trim()},
            ${input.username?.trim() || null}, ${input.url?.trim() || null}, ${input.notes?.trim() || null})
    RETURNING id
  `;
  const payload: Payload = {
    ...(input.password ? { password: input.password } : {}),
    ...(input.totp ? { totp: enrol(input.totp) } : {}),
  };
  await store(tx, tenantId, row!.id, 0, payload);
  return (await getEntry(tx, row!.id))!;
}

export async function getEntry(tx: HelmTx, id: string): Promise<VaultEntry | null> {
  const [row] = await tx<Row[]>`
    SELECT id, name, username, url, notes, has_password, has_totp, updated_at
    FROM personal_credential WHERE id = ${id}::uuid
  `;
  return row ? view(row) : null;
}

async function lockEnvelope(tx: HelmTx, id: string): Promise<EnvelopeRow> {
  const [row] = await tx<EnvelopeRow[]>`
    SELECT data_key_id, secret_version, secret_ciphertext, secret_nonce, secret_tag, secret_aad
    FROM personal_credential WHERE id = ${id}::uuid
    FOR UPDATE
  `;
  if (!row) throw ApiError.notFound('no such entry');
  return row;
}

export async function updateEntry(tx: HelmTx, tenantId: string, id: string, input: VaultInput): Promise<VaultEntry> {
  const envelope = await lockEnvelope(tx, id);
  await tx`
    UPDATE personal_credential SET
      name     = ${input.name === undefined ? tx`name` : input.name.trim()},
      username = ${input.username === undefined ? tx`username` : input.username?.trim() || null},
      url      = ${input.url === undefined ? tx`url` : input.url?.trim() || null},
      notes    = ${input.notes === undefined ? tx`notes` : input.notes?.trim() || null},
      updated_at = now()
    WHERE id = ${id}::uuid
  `;
  if (input.password !== undefined || input.totp !== undefined) {
    const payload = await open(tx, tenantId, id, envelope);
    try {
      if (input.password !== undefined) {
        if (input.password) payload.password = input.password;
        else delete payload.password;
      }
      if (input.totp !== undefined) {
        if (input.totp) payload.totp = enrol(input.totp);
        else delete payload.totp;
      }
      await store(tx, tenantId, id, envelope.secret_version, payload);
    } finally {
      delete payload.password;
    }
  }
  return (await getEntry(tx, id))!;
}

export async function deleteEntry(tx: HelmTx, id: string): Promise<boolean> {
  const rows = await tx`DELETE FROM personal_credential WHERE id = ${id}::uuid RETURNING id`;
  return rows.length > 0;
}

/**
 * Many entries at once, from another password manager's export
 * (src/lib/personal/import.ts reads the file; this stores what it found).
 *
 * ONE TRANSACTION: an import lands whole or not at all, so a failure halfway
 * never leaves half a vault to tidy by hand.
 *
 * TWO THINGS ARE LEFT OUT RATHER THAN REFUSED, and counted so the person is
 * told: an entry identical to one already stored (same name, username and
 * website — so importing the same file twice does not double the vault), and
 * a one-time code seed that cannot be read (Steam's, a typo), which costs that
 * entry its code and not its password.
 *
 * ONE AUDIT ROW for the whole import, with the counts and no names.
 */
export async function importEntries(
  tx: HelmTx, tenantId: string, ownerId: string, entries: readonly VaultInput[],
): Promise<{ imported: number; duplicates: number; codesDropped: number }> {
  const existing = await tx<{ k: string }[]>`
    SELECT lower(name) || chr(31) || coalesce(lower(username), '') || chr(31) || coalesce(lower(url), '') AS k
    FROM personal_credential
  `;
  const seen = new Set(existing.map((r) => r.k));
  let imported = 0;
  let duplicates = 0;
  let codesDropped = 0;
  for (const entry of entries) {
    const key = [entry.name, entry.username ?? '', entry.url ?? '']
      .map((part) => (part ?? '').trim().toLowerCase()).join(String.fromCharCode(31));
    if (seen.has(key)) { duplicates += 1; continue; }
    seen.add(key);
    let totp = entry.totp ?? null;
    if (totp) {
      try { parseTotpEnrolment(totp); } catch (error) {
        if (!(error instanceof TotpEnrolmentError)) throw error;
        totp = null;
        codesDropped += 1;
      }
    }
    await createEntry(tx, tenantId, ownerId, { ...entry, totp });
    imported += 1;
  }
  await tx`
    SELECT helm.audit('personal_vault.imported', 'personal_credential', NULL, 'success',
                      NULL, NULL, NULL, ${tx.json({ imported, duplicates, codesDropped })}::jsonb)
  `;
  return { imported, duplicates, codesDropped };
}

/* ------------------------------------------------------------------------- *
 * Reading
 * ------------------------------------------------------------------------- */

async function audit(tx: HelmTx, id: string, purpose: string): Promise<string | null> {
  // The id and the purpose, never the name: see the header.
  const [row] = await tx<{ uid: string | null }[]>`
    SELECT helm.audit('personal_vault.revealed', 'personal_credential', ${id}::uuid, 'success',
                      NULL, NULL, NULL, ${tx.json({ purpose })}::jsonb) AS uid
  `;
  return row?.uid ?? null;
}

/** The password, for the owner, with one audit row. */
export async function revealPassword(
  tx: HelmTx, tenantId: string, id: string, purpose: 'view' | 'copy' | 'autofill',
): Promise<{ value: string; auditEventUid: string | null }> {
  const [row] = await tx<EnvelopeRow[]>`
    SELECT data_key_id, secret_version, secret_ciphertext, secret_nonce, secret_tag, secret_aad
    FROM personal_credential WHERE id = ${id}::uuid
  `;
  if (!row) throw ApiError.notFound('no such entry');
  const payload = await open(tx, tenantId, id, row);
  if (!payload.password) throw ApiError.notFound('this entry has no password');
  const auditEventUid = await audit(tx, id, purpose);
  return { value: payload.password, auditEventUid };
}

/** The current one-time code, generated here from the seed, which never leaves. */
export async function currentCode(
  tx: HelmTx, tenantId: string, id: string,
): Promise<{ code: string; secondsRemaining: number; periodSeconds: number; digits: number; auditEventUid: string | null }> {
  const [row] = await tx<EnvelopeRow[]>`
    SELECT data_key_id, secret_version, secret_ciphertext, secret_nonce, secret_tag, secret_aad
    FROM personal_credential WHERE id = ${id}::uuid
  `;
  if (!row) throw ApiError.notFound('no such entry');
  const payload = await open(tx, tenantId, id, row);
  if (!payload.totp) throw ApiError.notFound('this entry has no one-time code');
  const seed = base32Decode(payload.totp.seed);
  try {
    const code = generateTotp(seed, payload.totp);
    const auditEventUid = await audit(tx, id, 'totp');
    return {
      code: code.code, secondsRemaining: code.secondsRemaining,
      periodSeconds: payload.totp.periodSeconds, digits: payload.totp.digits, auditEventUid,
    };
  } finally {
    wipe(seed);
  }
}

/* ------------------------------------------------------------------------- *
 * Data-key rotation
 * ------------------------------------------------------------------------- */

/**
 * Re-seal every vault entry still under a retiring or retired data key with
 * the active one, as a key administrator — the one reader besides the owner,
 * and it shows the plaintext to nobody. helm.retire_data_key() refuses while
 * any entry is left behind (1030).
 */
export async function reEncryptPersonalVault(
  actor: { tenantId: string; actorId: string },
): Promise<{ reEncrypted: number }> {
  return withTenant(actor, async (tx) => {
    const rows = await tx<(EnvelopeRow & { id: string })[]>`
      SELECT p.id, p.data_key_id, p.secret_version, p.secret_ciphertext, p.secret_nonce, p.secret_tag, p.secret_aad
      FROM personal_credential p
      JOIN tenant_data_key k ON k.id = p.data_key_id
      WHERE k.status IN ('retiring', 'retired')
      FOR UPDATE OF p
    `;
    for (const row of rows) {
      const payload = await open(tx, actor.tenantId, row.id, row);
      try {
        await store(tx, actor.tenantId, row.id, row.secret_version, payload);
      } finally {
        delete payload.password;
      }
    }
    if (rows.length > 0) {
      await tx`
        SELECT helm.audit('personal_vault.reencrypted', NULL, NULL, 'success', NULL, NULL,
                          'data key rotation', ${tx.json({ entries: rows.length })}::jsonb)
      `;
    }
    return { reEncrypted: rows.length };
  }, { role: 'keyAdmin' });
}
