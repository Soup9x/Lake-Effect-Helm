/**
 * Authenticator-app codes for local sign-in (0960).
 *
 * Everything here runs on the helm_auth pool, beside local_credential, because
 * a code is checked before anybody is signed in and helm_app may not read a
 * seed at all. The seed is enveloped as the RADIUS secret is: a fresh DEK per
 * row, wrapped by the KEK, the seed sealed under it with the AAD naming this
 * person, so a seed copied onto another account fails to open.
 *
 * A code is accepted once: the step it belongs to is written to last_step in
 * the same statement that checks it, so two requests racing with one code
 * cannot both succeed. A recovery code is accepted once, by the same means.
 */
import { createHash, randomBytes } from 'node:crypto';
import { db } from '../db/client';
import { openField, sealField, wipe, type SecretBinding } from '../crypto/envelope';
import type { EncryptionContext } from '../crypto/kek';
import { getKekProvider } from '../services';
import { base32Encode, buildOtpAuthUri, verifyTotp } from '../crypto/totp';

const ISSUER = 'Lake Effect Helm';
const PERIOD_SECONDS = 30;
const RECOVERY_CODES = 10;
/** A sign-in that shows a new seed reuses it for this long, so a resubmission matches. */
const PENDING_REUSE_MINUTES = 15;

const context = (userId: string): EncryptionContext =>
  ({ 'helm:purpose': 'local-totp-seed', 'helm:user': userId });
const binding = (userId: string): SecretBinding =>
  ({ tenantId: 'user', secretId: userId, field: 'totp_seed', version: 1 });

interface Row {
  wrap_provider: string;
  kek_id: string;
  wrapped_dek: Buffer;
  seed_ciphertext: Buffer;
  seed_nonce: Buffer;
  seed_tag: Buffer;
  seed_aad: string;
  confirmed_at: Date | null;
  last_step: string | null;
  created_at: Date;
}

export interface Enrolment {
  /** The seed in base32, for typing in by hand. */
  secret: string;
  /** The otpauth:// URI an authenticator app scans. */
  uri: string;
}

async function readRow(userId: string): Promise<Row | null> {
  const [row] = await db('auth')<Row[]>`SELECT * FROM local_totp WHERE user_id = ${userId}::uuid`;
  return row ?? null;
}

async function openSeed(userId: string, row: Row): Promise<Buffer> {
  const dek = await getKekProvider().unwrapDek(row.wrapped_dek, row.kek_id, context(userId));
  try {
    return openField(dek, {
      ciphertext: row.seed_ciphertext, nonce: row.seed_nonce, authTag: row.seed_tag, aad: row.seed_aad,
    }, binding(userId));
  } finally {
    wipe(dek);
  }
}

function enrolmentFor(seed: Buffer, email: string): Enrolment {
  const secret = base32Encode(seed);
  return {
    secret,
    uri: buildOtpAuthUri({
      secret, issuer: ISSUER, account: email, algorithm: 'SHA1', digits: 6, periodSeconds: PERIOD_SECONDS,
    }),
  };
}

export async function totpStatus(userId: string): Promise<{ enrolled: boolean; recoveryRemaining: number }> {
  const [row] = await db('auth')<{ enrolled: boolean; remaining: number }[]>`
    SELECT EXISTS (SELECT 1 FROM local_totp WHERE user_id = ${userId}::uuid AND confirmed_at IS NOT NULL) AS enrolled,
           (SELECT count(*)::int FROM local_totp_recovery
             WHERE user_id = ${userId}::uuid AND used_at IS NULL) AS remaining
  `;
  return { enrolled: row?.enrolled ?? false, recoveryRemaining: row?.remaining ?? 0 };
}

/**
 * Begin (or, at sign-in, resume) an enrolment: a new seed, not yet confirmed.
 *
 * `reuse` is for the sign-in path: the person is shown a seed, scans it and
 * submits the form again with a code, and that second request must check the
 * code against the SAME seed, not a fresh one. The account page always starts
 * over, which is what "set it up again" should mean.
 */
export async function startEnrolment(
  userId: string, email: string, options: { reuse?: boolean } = {},
): Promise<Enrolment> {
  const existing = await readRow(userId);
  if (existing?.confirmed_at) throw new Error('an authenticator is already set up for this account');

  if (options.reuse && existing
      && Date.now() - existing.created_at.getTime() < PENDING_REUSE_MINUTES * 60_000) {
    const seed = await openSeed(userId, existing);
    try { return enrolmentFor(seed, email); } finally { wipe(seed); }
  }

  const seed = randomBytes(20);
  const provider = getKekProvider();
  const dek = await provider.generateDek(context(userId));
  try {
    const envelope = sealField(dek.plaintext, seed, binding(userId));
    await db('auth')`
      INSERT INTO local_totp (user_id, wrap_provider, kek_id, wrapped_dek,
                              seed_ciphertext, seed_nonce, seed_tag, seed_aad)
      VALUES (${userId}::uuid, ${provider.provider}, ${dek.kekId}, ${dek.wrapped},
              ${envelope.ciphertext}, ${envelope.nonce}, ${envelope.authTag}, ${envelope.aad})
      ON CONFLICT (user_id) DO UPDATE SET
        wrap_provider = EXCLUDED.wrap_provider, kek_id = EXCLUDED.kek_id,
        wrapped_dek = EXCLUDED.wrapped_dek, seed_ciphertext = EXCLUDED.seed_ciphertext,
        seed_nonce = EXCLUDED.seed_nonce, seed_tag = EXCLUDED.seed_tag, seed_aad = EXCLUDED.seed_aad,
        confirmed_at = NULL, last_step = NULL, created_at = now()
      WHERE local_totp.confirmed_at IS NULL
    `;
    return enrolmentFor(seed, email);
  } finally {
    wipe(seed, dek.plaintext);
  }
}

/** The time step a code belongs to, if it is a valid one for this seed now. */
function stepOf(seed: Buffer, code: string): number | null {
  const now = Date.now();
  const result = verifyTotp(seed, code, { periodSeconds: PERIOD_SECONDS, window: 1 }, now);
  if (!result.valid || result.drift === null) return null;
  return Math.floor(now / 1000 / PERIOD_SECONDS) + result.drift;
}

/**
 * Prove an enrolment with a first code. Returns the recovery codes — shown
 * once, never again — or null when the code is wrong or there is nothing to
 * confirm.
 */
export async function confirmEnrolment(userId: string, code: string): Promise<string[] | null> {
  const row = await readRow(userId);
  if (!row || row.confirmed_at) return null;

  const seed = await openSeed(userId, row);
  let step: number | null;
  try { step = stepOf(seed, code); } finally { wipe(seed); }
  if (step === null) return null;

  const [confirmed] = await db('auth')`
    UPDATE local_totp SET confirmed_at = now(), last_step = ${step}
    WHERE user_id = ${userId}::uuid AND confirmed_at IS NULL
    RETURNING user_id
  `;
  if (!confirmed) return null;
  return issueRecoveryCodes(userId);
}

/** A fresh set of recovery codes; the old ones stop working. */
export async function issueRecoveryCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODES }, () => {
    const raw = base32Encode(randomBytes(10)).toLowerCase().slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  const sql = db('auth');
  await sql.begin(async (tx) => {
    await tx`DELETE FROM local_totp_recovery WHERE user_id = ${userId}::uuid`;
    for (const code of codes) {
      await tx`
        INSERT INTO local_totp_recovery (user_id, code_hash)
        VALUES (${userId}::uuid, ${hashRecovery(code)})
      `;
    }
  });
  return codes;
}

const RECOVERY_FORMAT = /^[a-z2-7]{5}-?[a-z2-7]{5}$/;

function hashRecovery(code: string): Buffer {
  const normal = code.trim().toLowerCase().replace(/-/g, '');
  return createHash('sha256').update(`${normal.slice(0, 5)}-${normal.slice(5)}`).digest();
}

/**
 * Check a second factor at sign-in: a code from the app, or a recovery code.
 * Each is good once.
 */
export async function verifySecondFactor(userId: string, submitted: string): Promise<boolean> {
  const code = submitted.trim().toLowerCase();

  if (RECOVERY_FORMAT.test(code)) {
    const [used] = await db('auth')`
      UPDATE local_totp_recovery SET used_at = now()
      WHERE user_id = ${userId}::uuid AND code_hash = ${hashRecovery(code)} AND used_at IS NULL
      RETURNING user_id
    `;
    return Boolean(used);
  }

  const row = await readRow(userId);
  if (!row?.confirmed_at) return false;
  const seed = await openSeed(userId, row);
  let step: number | null;
  try { step = stepOf(seed, code); } finally { wipe(seed); }
  if (step === null) return false;

  // Replay: only a step later than the last one accepted.
  const [accepted] = await db('auth')`
    UPDATE local_totp SET last_step = ${step}
    WHERE user_id = ${userId}::uuid AND confirmed_at IS NOT NULL
      AND (last_step IS NULL OR last_step < ${step})
    RETURNING user_id
  `;
  return Boolean(accepted);
}

/** Turn it off: the seed and every recovery code go. */
export async function removeTotp(userId: string): Promise<void> {
  await db('auth').begin(async (tx) => {
    await tx`DELETE FROM local_totp_recovery WHERE user_id = ${userId}::uuid`;
    await tx`DELETE FROM local_totp WHERE user_id = ${userId}::uuid`;
  });
}
