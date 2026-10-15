/**
 * Sealing and opening the relay's password.
 *
 * THE FOURTH INSTANCE OF THE PATTERN in 0360 (RADIUS), 0410 (OIDC) and 0420
 * (the webhook URL), and the differences are the only part worth reading:
 *
 *   ONE ROW PER TENANT, so the AAD binds to the tenant and nothing else —
 *   unlike a webhook destination, of which a tenant has many and which
 *   therefore has to bind to the endpoint id as well.
 *
 *   A BARE STRING, not a JSON document. The webhook seals {url, signingSecret}
 *   together because they are useless apart; an SMTP password has no companion
 *   that is rewritten with it — the host, port and username are ordinary
 *   configuration an administrator reads back on the settings page.
 *
 *   READ BY helm_worker, not helm_auth. Sending a notification is background
 *   work. The pre-authentication role has no business here, and 0690's column
 *   grants say so: helm_app cannot SELECT these columns at all, and a password
 *   reset — which DOES happen before sign-in — uses its own channel for exactly
 *   that reason. See src/lib/auth/reset-delivery.ts.
 */
import { openField, sealField, wipe, type Envelope, type SecretBinding } from '../crypto/envelope';
import type { EncryptionContext } from '../crypto/kek';
import { getKekProvider } from '../services';

/**
 * The encryption context this DEK is bound to.
 *
 * Distinct from the tenant, RADIUS, OIDC and webhook contexts, so a wrapped DEK
 * copied between tables fails to unwrap rather than quietly working.
 */
function smtpKeyContext(tenantId: string): EncryptionContext {
  return { 'helm:purpose': 'smtp-relay-password', 'helm:tenant': tenantId };
}

/**
 * The AAD binding.
 *
 * `secretId` is the tenant id because smtp_setting is keyed by tenant — the
 * RADIUS and OIDC shape rather than the webhook one. A row copied between
 * deployments fails to open rather than letting one tenant's relay credentials
 * authenticate another tenant's mail.
 */
function smtpBinding(tenantId: string): SecretBinding {
  return { tenantId, secretId: tenantId, field: 'smtp_password', version: 1 };
}

export interface SealedPassword {
  wrapProvider: string;
  kekId: string;
  wrappedDek: Buffer;
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
  aad: string;
}

export async function sealSmtpPassword(
  tenantId: string,
  password: string,
): Promise<SealedPassword> {
  if (password.length === 0) {
    // An empty password with password_set true would be a relay Helm believes
    // it can authenticate to and cannot. The caller clears instead.
    throw new Error('refusing to seal an empty SMTP password; clear it instead');
  }

  const provider = getKekProvider();
  const dek = await provider.generateDek(smtpKeyContext(tenantId));
  const plaintext = Buffer.from(password, 'utf8');

  try {
    const envelope = sealField(dek.plaintext, plaintext, smtpBinding(tenantId));
    return {
      wrapProvider: provider.provider,
      kekId: dek.kekId,
      wrappedDek: dek.wrapped,
      ciphertext: envelope.ciphertext,
      nonce: envelope.nonce,
      tag: envelope.authTag,
      aad: envelope.aad,
    };
  } finally {
    wipe(plaintext, dek.plaintext);
  }
}

/** The envelope columns as helm.smtp_transport() returns them. */
export interface SealedPasswordColumns {
  wrap_provider: string | null;
  kek_id: string | null;
  wrapped_dek: Buffer | null;
  secret_ciphertext: Buffer | null;
  secret_nonce: Buffer | null;
  secret_tag: Buffer | null;
  secret_aad: string | null;
}

/**
 * Open it. Returns the plaintext to the caller, which holds it for one
 * connection and writes it nowhere.
 */
export async function openSmtpPassword(
  tenantId: string,
  row: SealedPasswordColumns,
): Promise<string | null> {
  if (!row.secret_ciphertext || !row.wrapped_dek || !row.kek_id
      || !row.secret_nonce || !row.secret_tag || !row.secret_aad) {
    // No password configured. A relay on a trusted network may legitimately
    // need none, so this is a state rather than an error.
    return null;
  }

  const provider = getKekProvider();
  const dek = await provider.unwrapDek(row.wrapped_dek, row.kek_id, smtpKeyContext(tenantId));

  try {
    const envelope: Envelope = {
      ciphertext: row.secret_ciphertext,
      nonce: row.secret_nonce,
      authTag: row.secret_tag,
      aad: row.secret_aad,
    };
    const plaintext = openField(dek, envelope, smtpBinding(tenantId));
    try {
      return plaintext.toString('utf8');
    } finally {
      wipe(plaintext);
    }
  } finally {
    wipe(dek);
  }
}
