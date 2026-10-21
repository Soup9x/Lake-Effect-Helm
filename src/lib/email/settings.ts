/**
 * Reading and writing the relay's configuration from the request path.
 *
 * NEITHER FUNCTION TOUCHES THE ENVELOPE COLUMNS, and neither could: 0690
 * revokes them from helm_app per column. Reading goes through
 * `helm.smtp_settings()` and writing through `helm.set_smtp_setting()`, which
 * checks `tenant:write` itself — so a caller that forgot the route's gate is
 * still refused by the database.
 *
 * THE PASSWORD IS SEALED HERE, in the request process, because that is where
 * the KEK provider lives. The sealed bytes go to the database and the plaintext
 * never does.
 */
import type { HelmTx } from '../db/client';
import { sealSmtpPassword } from './secret';
import { fingerprintOfPem } from './transport';

export type SmtpSecurity = 'starttls' | 'tls' | 'plaintext';

/** How mail leaves (1010): the relay below, or the MSP's Microsoft 365. */
export type EmailDelivery = 'smtp' | 'microsoft_graph';

export interface SmtpSettingView {
  configured: boolean;
  enabled: boolean;
  delivery: EmailDelivery;
  /** The MSP's own Microsoft 365 connection, when delivery is microsoft_graph. */
  graphConnectionId: string | null;
  host: string;
  port: number;
  security: SmtpSecurity;
  tlsVerify: boolean;
  /** Present when a certificate is pinned; the PEM itself is not returned. */
  pinnedFingerprint: string | null;
  plaintextAcknowledgedAt: string | null;
  username: string | null;
  passwordSet: boolean;
  fromAddress: string;
  fromName: string | null;
  allowedRecipientDomains: string[];
  lastSendAt: string | null;
  lastSendOk: boolean | null;
  lastSendError: string | null;
  consecutiveFailures: number;
}

/** What a tenant that has never configured mail looks like. */
const SMTP_DEFAULTS: SmtpSettingView = {
  configured: false,
  enabled: false,
  delivery: 'smtp',
  graphConnectionId: null,
  host: '',
  port: 587,
  security: 'starttls',
  tlsVerify: true,
  pinnedFingerprint: null,
  plaintextAcknowledgedAt: null,
  username: null,
  passwordSet: false,
  fromAddress: '',
  fromName: null,
  allowedRecipientDomains: [],
  lastSendAt: null,
  lastSendOk: null,
  lastSendError: null,
  consecutiveFailures: 0,
};

interface SettingRow {
  enabled: boolean;
  host: string | null;
  port: number;
  security: SmtpSecurity;
  tls_verify: boolean;
  tls_pinned_certificate: string | null;
  plaintext_acknowledged_at: Date | null;
  username: string | null;
  password_set: boolean;
  from_address: string;
  from_name: string | null;
  allowed_recipient_domains: string[];
  last_send_at: Date | null;
  last_send_ok: boolean | null;
  last_send_error: string | null;
  consecutive_failures: number;
}

export async function readSmtpSetting(tx: HelmTx): Promise<SmtpSettingView> {
  const [row] = await tx<SettingRow[]>`SELECT * FROM helm.smtp_settings()`;
  if (!row) return { ...SMTP_DEFAULTS };
  const [mode] = await tx<{ delivery: EmailDelivery; graph_connection_id: string | null }[]>`
    SELECT delivery::text AS delivery, graph_connection_id FROM helm.email_delivery_setting()
  `;

  return {
    configured: true,
    enabled: row.enabled,
    delivery: mode?.delivery ?? 'smtp',
    graphConnectionId: mode?.graph_connection_id ?? null,
    // Null when this tenant has only ever sent through Microsoft 365.
    host: row.host ?? '',
    port: Number(row.port),
    security: row.security,
    tlsVerify: row.tls_verify,
    /*
     * The FINGERPRINT, derived from the stored certificate — never the PEM.
     *
     * A pinned certificate is not secret, so returning it would leak nothing;
     * the reason to derive a fingerprint instead is that a fingerprint is what
     * an operator can compare against what their relay reports, and a wall of
     * base64 on a settings page is something people scroll past. Derived rather
     * than stored so the two cannot disagree.
     */
    pinnedFingerprint: row.tls_pinned_certificate
      ? safeFingerprint(row.tls_pinned_certificate)
      : null,
    plaintextAcknowledgedAt: row.plaintext_acknowledged_at?.toISOString() ?? null,
    username: row.username,
    passwordSet: row.password_set,
    fromAddress: row.from_address,
    fromName: row.from_name,
    allowedRecipientDomains: row.allowed_recipient_domains,
    lastSendAt: row.last_send_at?.toISOString() ?? null,
    lastSendOk: row.last_send_ok,
    lastSendError: row.last_send_error,
    consecutiveFailures: Number(row.consecutive_failures),
  };
}

/**
 * A fingerprint, or null if the stored certificate cannot be parsed.
 *
 * Null rather than throwing: a settings page that will not render because one
 * stored certificate is malformed is worse than one that cannot show its
 * fingerprint, and the column CHECK already refuses the obvious cases.
 */
function safeFingerprint(pem: string): string | null {
  try {
    return fingerprintOfPem(pem);
  } catch {
    return null;
  }
}

export interface SmtpSettingInput {
  enabled: boolean;
  host: string;
  port: number;
  security: SmtpSecurity;
  tlsVerify: boolean;
  tlsPinnedCertificate?: string | null | undefined;
  username?: string | null | undefined;
  /** Absent keeps what is stored; '' clears it; a value replaces it. */
  password?: string | undefined;
  fromAddress: string;
  fromName?: string | null | undefined;
  allowedRecipientDomains?: string[] | undefined;
}

/**
 * Takes no actor id, deliberately. helm.set_smtp_setting() reads
 * helm.current_actor_id() itself for updated_by and for the plaintext
 * acknowledgement, so a caller cannot attribute the change to somebody else —
 * the same rule helm.audit() follows.
 */
/**
 * The pinned certificate the save should end with.
 *
 * Three states, the same contract as the password: undefined keeps what is
 * stored, an empty string or null clears it, a PEM replaces it. The function
 * underneath cannot tell "absent" from "clear" — it writes whatever it is
 * handed — so "keep" is resolved here by reading the stored PEM back through
 * helm.smtp_settings(). Before this, every save that did not re-paste the PEM
 * silently dropped the pin, and a relay with verification off then refused
 * every later save, because the pin was the only thing permitting it.
 *
 * A move to plaintext drops the pin whatever was sent: no certificate is ever
 * presented on that connection, and a stored one would be a claim nothing
 * checks.
 */
export async function resolvePinnedCertificate(
  tx: HelmTx,
  input: Pick<SmtpSettingInput, 'tlsPinnedCertificate' | 'security'>,
): Promise<string | null> {
  if (input.security === 'plaintext') return null;
  if (input.tlsPinnedCertificate !== undefined) return input.tlsPinnedCertificate || null;
  const [row] = await tx<{ tls_pinned_certificate: string | null }[]>`
    SELECT tls_pinned_certificate FROM helm.smtp_settings()
  `;
  return row?.tls_pinned_certificate ?? null;
}

export async function writeSmtpSetting(
  tx: HelmTx,
  input: SmtpSettingInput,
): Promise<SmtpSettingView> {
  const clearPassword = input.password === '';
  const pin = await resolvePinnedCertificate(tx, input);
  const sealed = input.password && input.password.length > 0
    // Sealed against the tenant, which is also the row's key — see
    // src/lib/email/secret.ts for why the binding differs from a webhook's.
    ? await sealSmtpPassword(await currentTenant(tx), input.password)
    : null;

  await tx`
    SELECT helm.set_smtp_setting(
      ${input.enabled},
      ${input.host},
      ${input.port},
      ${input.security}::smtp_security,
      ${input.tlsVerify},
      ${pin},
      ${input.username ?? null},
      ${input.fromAddress},
      ${input.fromName ?? null},
      ${input.allowedRecipientDomains ?? []},
      ${sealed?.wrapProvider ?? null},
      ${sealed?.kekId ?? null},
      ${sealed?.wrappedDek ?? null},
      ${sealed?.ciphertext ?? null},
      ${sealed?.nonce ?? null},
      ${sealed?.tag ?? null},
      ${sealed?.aad ?? null},
      ${clearPassword}
    )
  `;
  // Saving the relay is choosing it: set_smtp_setting() leaves `delivery` alone.
  await tx`SELECT helm.use_smtp_delivery()`;

  // Read back rather than echoing the input: the function normalises domains to
  // lower case and decides what happened to the password, and a caller that
  // believes the input is what was stored will be wrong about both.
  return readSmtpSetting(tx);
}

export interface GraphEmailInput {
  enabled: boolean;
  connectionId: string;
  fromAddress: string;
  allowedRecipientDomains?: string[] | undefined;
}

/**
 * Send through Microsoft 365. The function refuses a connection that is not
 * on the MSP's own organisation, and leaves the relay's fields as they were.
 */
export async function writeGraphEmail(tx: HelmTx, input: GraphEmailInput): Promise<SmtpSettingView> {
  await tx`
    SELECT helm.set_graph_email(
      ${input.enabled}, ${input.connectionId}::uuid, ${input.fromAddress},
      ${input.allowedRecipientDomains ?? []}
    )
  `;
  return readSmtpSetting(tx);
}

/** A Microsoft 365 connection mail can go out through: the MSP's own. */
export interface SendingConnection {
  id: string;
  organizationName: string;
  tenant: string;
  tenantName: string | null;
  secretSet: boolean;
}

/**
 * The connections the settings page offers. Read under RLS, so only somebody
 * who can see integrations sees any; the function checks the organisation
 * again on save.
 */
export async function listSendingConnections(tx: HelmTx): Promise<SendingConnection[]> {
  const rows = await tx<{
    id: string; organization_name: string; tenant: string | null; tenant_name: string | null; secret_set: boolean;
  }[]>`
    SELECT c.id, o.name AS organization_name, c.config ->> 'tenant_id' AS tenant,
           c.config ->> 'tenant_name' AS tenant_name, c.credential_secret_ids ? 'client_secret' AS secret_set
    FROM integration_connection c
    JOIN organization o ON o.id = c.organization_id
    WHERE c.provider = 'microsoft_graph' AND o.is_msp_internal
    ORDER BY c.created_at
  `;
  return rows.map((r) => ({
    id: r.id,
    organizationName: r.organization_name,
    tenant: r.tenant ?? '',
    tenantName: r.tenant_name,
    secretSet: r.secret_set,
  }));
}

/**
 * The tenant this transaction is inside.
 *
 * Asked of the database rather than threaded through from the identity,
 * because the AAD has to bind to the tenant the ROW will land in — and that is
 * whatever the session context says, not whatever the caller passed.
 */
async function currentTenant(tx: HelmTx): Promise<string> {
  const [row] = await tx<{ tenant_id: string }[]>`
    SELECT helm.current_tenant_id() AS tenant_id
  `;
  if (!row?.tenant_id) throw new Error('no tenant context');
  return row.tenant_id;
}
