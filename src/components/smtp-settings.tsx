'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Loader2, Mail, ShieldAlert } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { FieldHint, Input, Label, Select, Textarea } from './ui/field';
import { Badge } from './ui/badge';
import { formatDateTime } from '@/lib/ui/format';
import { apiFetch, type Feedback } from '@/lib/ui/api';
import type { SmtpSecurity, SmtpSettingView } from '@/lib/email/settings';

/** The port each mode is normally on, for the nudge when the mode changes. */
const CONVENTIONAL_PORT: Record<SmtpSecurity, number> = {
  starttls: 587,
  tls: 465,
  plaintext: 25,
};

const SECURITY_COPY: Record<SmtpSecurity, string> = {
  starttls: 'Connect in the clear, then upgrade with STARTTLS. What almost every relay wants.',
  tls: 'TLS from the first byte — implicit TLS, usually on 465.',
  plaintext: 'No encryption at all. The password and every notification cross the network readable.',
};

/**
 * The tenant's mail relay.
 *
 * THE PASSWORD IS WRITE-ONLY HERE, and that is the server's doing rather than
 * this component's: helm_app has no privilege on smtp_setting's envelope
 * columns, so there is nothing for the page to have been sent. An empty
 * password box on a configured relay means "leave it alone" — which is what
 * somebody changing a port wants, and why the placeholder says so instead of
 * looking like a field they forgot.
 *
 * THERE IS NO TEST BUTTON, deliberately. A relay is proved by a real send, and
 * a real send already exists: add an email destination below and press its Test
 * button. The outcome lands on this card, because every send through this relay
 * records its result here whoever triggered it. A second sending path in the
 * request process would need the worker's role in a request handler to reach
 * the password, and would be a second thing that can disagree with the one that
 * actually delivers.
 *
 * PLAINTEXT NEEDS A TICK, NOT A WARNING. Saving `plaintext` without
 * acknowledging it is refused by the route AND by a CHECK that records who
 * accepted it and when; moving back to STARTTLS clears that record, so it
 * always describes the setting in force rather than one somebody accepted once.
 *
 * THE PINNED CERTIFICATE IS A CERTIFICATE, NOT A FINGERPRINT. Node skips
 * `checkServerIdentity` when `rejectUnauthorized` is false and refuses a
 * self-signed chain before reaching it when true, so a fingerprint cannot be
 * enforced — the PEM becomes the only acceptable CA instead. 0690's header has
 * the measurements. What comes back here is a fingerprint derived from it,
 * because that is the part an operator can compare against what their relay
 * reports.
 */
export function SmtpSettingsCard({
  initial,
  canManage,
}: {
  initial: SmtpSettingView;
  canManage: boolean;
}) {
  const router = useRouter();
  const [form, setForm] = useState<SmtpSettingView>(initial);
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [pin, setPin] = useState('');
  const [acknowledge, setAcknowledge] = useState(false);
  const [domainText, setDomainText] = useState(initial.allowedRecipientDomains.join(', '));
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const set = <K extends keyof SmtpSettingView>(key: K, value: SmtpSettingView[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  /**
   * Changing the mode moves the port WHEN IT IS STILL A CONVENTIONAL ONE.
   * Somebody who typed 2525 means it; somebody who left 587 and switched to
   * implicit TLS almost certainly wants 465 and would otherwise find out from a
   * timeout.
   */
  function changeSecurity(security: SmtpSecurity) {
    setForm((f) => ({
      ...f,
      security,
      port: Object.values(CONVENTIONAL_PORT).includes(f.port)
        ? CONVENTIONAL_PORT[security]
        : f.port,
    }));
    if (security !== 'plaintext') setAcknowledge(false);
  }

  const domains = domainText
    .split(/[,\s]+/)
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);

  // Mirrors the route's three refusals, so the button does not offer a save
  // whose only outcome is a 400. The route checks again — this only decides
  // what is enabled.
  const needsAcknowledgement = form.security === 'plaintext' && !acknowledge
    && form.plaintextAcknowledgedAt === null;
  const pinOnPlaintext = form.security === 'plaintext' && (pin.length > 0 || !!form.pinnedFingerprint);
  const unverifiedWithNoPin = !form.tlsVerify && form.security !== 'plaintext'
    && pin.length === 0 && form.pinnedFingerprint === null;

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFeedback(null);
    try {
      const result = await apiFetch<SmtpSettingView | undefined>('/api/tenant/smtp', {
        method: 'PUT',
        json: {
          enabled: form.enabled,
          host: form.host.trim(),
          port: form.port,
          security: form.security,
          tlsVerify: form.tlsVerify,
          // Three states, as the route documents: absent keeps what is stored,
          // '' clears it, a value replaces it.
          ...(pin ? { tlsPinnedCertificate: pin } : {}),
          username: form.username?.trim() || null,
          ...(clearPassword ? { password: '' } : password ? { password } : {}),
          fromAddress: form.fromAddress.trim(),
          fromName: form.fromName?.trim() || null,
          allowedRecipientDomains: domains,
          ...(form.security === 'plaintext' ? { acknowledgePlaintext: true } : {}),
        },
      });

      if (!result.ok) {
        setFeedback({ ok: false, message: result.message });
        return;
      }

      const payload = result.value;
      if (payload) {
        setForm(payload);
        setDomainText(payload.allowedRecipientDomains.join(', '));
      }
      setPassword('');
      setClearPassword(false);
      setPin('');
      setFeedback({
        ok: true,
        message: form.enabled
          ? 'Saved. Add an email destination below and press Test to prove it sends.'
          : 'Saved, and switched off. Nothing will be sent until you enable it.',
      });
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="size-4 text-ink-faint" aria-hidden /> Mail relay
          {form.configured && (
            <Badge tone={form.enabled ? 'ok' : 'neutral'}>
              {form.enabled ? 'Enabled' : 'Off'}
            </Badge>
          )}
          {form.consecutiveFailures > 0 && (
            <Badge tone="danger">{form.consecutiveFailures} failed in a row</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="max-w-3xl text-sm text-ink-muted">
          Helm sends no mail until you point it at a relay of your own — there is no
          hosted sender behind this, which is the same air-gapped default the external
          checks have. Once configured it carries checklist reminders to whoever a step
          is assigned to, and any notification destination you choose to send by email.
        </p>

        {!canManage ? (
          <div className="space-y-1.5 rounded-md border border-border bg-surface-sunken p-3 text-sm">
            {form.configured ? (
              <>
                <div className="text-ink">
                  {form.host}:{form.port} · {form.security}
                </div>
                <div className="text-xs text-ink-faint">
                  Sending as {form.fromAddress}
                  {form.enabled ? '' : ' — switched off'}
                </div>
              </>
            ) : (
              <div className="text-ink-muted">No relay is configured.</div>
            )}
            <FieldHint>
              Changing this needs <code>tenant:write</code>. Shown because whether mail
              works at all explains why a reminder did or did not arrive.
            </FieldHint>
          </div>
        ) : (
          <form onSubmit={save} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="smtp-host">Server</Label>
                <Input
                  id="smtp-host"
                  value={form.host}
                  onChange={(e) => set('host', e.target.value)}
                  placeholder="smtp.example.internal"
                  required
                  maxLength={253}
                />
                <FieldHint>Hostname or IP address of your SMTP relay.</FieldHint>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="smtp-port">Port</Label>
                <Input
                  id="smtp-port"
                  type="number"
                  min={1}
                  max={65535}
                  value={form.port}
                  onChange={(e) => set('port', Number(e.target.value))}
                  required
                />
                <FieldHint>
                  {CONVENTIONAL_PORT[form.security]} is conventional for this mode.
                </FieldHint>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="smtp-security">Encryption</Label>
                <Select
                  id="smtp-security"
                  value={form.security}
                  onChange={(e) => changeSecurity(e.target.value as SmtpSecurity)}
                >
                  <option value="starttls">STARTTLS</option>
                  <option value="tls">TLS (implicit)</option>
                  <option value="plaintext">None</option>
                </Select>
                <FieldHint>{SECURITY_COPY[form.security]}</FieldHint>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="smtp-from">Sending address</Label>
                <Input
                  id="smtp-from"
                  type="email"
                  value={form.fromAddress}
                  onChange={(e) => set('fromAddress', e.target.value)}
                  placeholder="helm@example.com"
                  required
                  maxLength={320}
                />
                <FieldHint>
                  Your relay has to be willing to send as this. Its domain is also the
                  default of the one list below.
                </FieldHint>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="smtp-from-name">Sending name (optional)</Label>
                <Input
                  id="smtp-from-name"
                  value={form.fromName ?? ''}
                  onChange={(e) => set('fromName', e.target.value || null)}
                  placeholder="Lake Effect Helm"
                  maxLength={120}
                />
                <FieldHint>What appears before the address in a mail client.</FieldHint>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="smtp-username">Username (optional)</Label>
                <Input
                  id="smtp-username"
                  autoComplete="off"
                  value={form.username ?? ''}
                  onChange={(e) => set('username', e.target.value || null)}
                  maxLength={320}
                />
                <FieldHint>
                  Leave both this and the password empty for a relay that accepts this
                  host without authenticating.
                </FieldHint>
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="smtp-password">Password</Label>
                <Input
                  id="smtp-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (e.target.value) setClearPassword(false);
                  }}
                  placeholder={
                    form.passwordSet ? 'Stored — leave blank to keep it' : 'If your relay needs one'
                  }
                  maxLength={1024}
                  disabled={clearPassword}
                />
                <FieldHint>
                  Encrypted with this deployment&rsquo;s master key, sealed against this
                  tenant, and readable only by the worker that sends. Never returned to
                  this page, and never written to a log or an error message.
                </FieldHint>
                {form.passwordSet && (
                  <label className="flex items-start gap-2.5 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4"
                      checked={clearPassword}
                      onChange={(e) => {
                        setClearPassword(e.target.checked);
                        if (e.target.checked) setPassword('');
                      }}
                    />
                    <span>
                      <span className="text-ink">Remove the stored password</span>
                      <FieldHint>
                        For a relay that no longer needs one. Leaves nothing encrypted
                        behind for a credential that is out of use.
                      </FieldHint>
                    </span>
                  </label>
                )}
              </div>

              {form.security !== 'plaintext' && (
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="smtp-pin">Relay certificate (optional)</Label>
                  <Textarea
                    id="smtp-pin"
                    value={pin}
                    onChange={(e) => setPin(e.target.value)}
                    rows={3}
                    placeholder={
                      form.pinnedFingerprint
                        ? 'Stored — paste a new one to replace it'
                        : '-----BEGIN CERTIFICATE-----'
                    }
                    maxLength={16384}
                    className="font-mono text-xs"
                  />
                  <FieldHint>
                    For a relay with a private or self-signed certificate. Paste the PEM
                    and Helm will accept <em>that certificate and no other</em> — which is
                    stronger than turning verification off, and the only mechanism that
                    actually works: a fingerprint cannot be enforced, because Node either
                    never checks it or refuses the chain before it would.
                  </FieldHint>
                  {form.pinnedFingerprint && (
                    <FieldHint>
                      Pinned:{' '}
                      <code className="text-ink">{form.pinnedFingerprint}</code> — compare
                      this against what your relay reports.
                    </FieldHint>
                  )}
                </div>
              )}

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="smtp-domains">Send notifications only to</Label>
                <Input
                  id="smtp-domains"
                  value={domainText}
                  onChange={(e) => setDomainText(e.target.value)}
                  placeholder={
                    form.fromAddress.includes('@')
                      ? form.fromAddress.split('@')[1]
                      : 'example.com'
                  }
                />
                <FieldHint>
                  Domains, separated by commas. Empty means the sending address&rsquo;s own
                  domain and nothing else. This is a disclosure boundary rather than a
                  convenience: a notification names which client has which expiring
                  credential, so an address outside the business is a feed of that to
                  whoever owns it. Checked when a destination is added <em>and</em> again
                  when something is about to be sent, because this list can be narrowed
                  afterwards.
                </FieldHint>
                {domains.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {domains.map((domain) => (
                      <Badge key={domain} tone="neutral">{domain}</Badge>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {form.security !== 'plaintext' && (
              <label className="flex items-start gap-2.5 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4"
                  checked={form.tlsVerify}
                  onChange={(e) => set('tlsVerify', e.target.checked)}
                />
                <span>
                  <span className="text-ink">Verify the relay&rsquo;s certificate</span>
                  <FieldHint>
                    Leave this on. Turning it off accepts any certificate at all, which is
                    an interceptable connection that looks encrypted — pin the certificate
                    above instead, which is both stronger and specific.
                  </FieldHint>
                </span>
              </label>
            )}

            {form.security === 'plaintext' && (
              <div className="space-y-2 rounded-md border border-danger/30 bg-danger/5 p-3">
                <p className="text-sm text-danger">
                  With no encryption, the relay password and the full text of every
                  notification — client names, asset names, credential labels — cross your
                  network readable by anything on the path.
                </p>
                {form.plaintextAcknowledgedAt ? (
                  <p className="text-xs text-ink-muted">
                    Accepted {formatDateTime(form.plaintextAcknowledgedAt)}. Moving back to
                    STARTTLS or TLS clears that record.
                  </p>
                ) : (
                  <label className="flex items-start gap-2.5 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4"
                      checked={acknowledge}
                      onChange={(e) => setAcknowledge(e.target.checked)}
                    />
                    <span className="text-ink">
                      I accept that, and Helm should record that I did.
                    </span>
                  </label>
                )}
              </div>
            )}

            <label className="flex items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 size-4"
                checked={form.enabled}
                onChange={(e) => set('enabled', e.target.checked)}
              />
              <span>
                <span className="text-ink">Send mail</span>
                <FieldHint>
                  Off means nothing is sent and nothing is queued against this relay —
                  reminders wait rather than failing once a minute, so turning it on later
                  delivers what has come due.
                </FieldHint>
              </span>
            </label>

            {pinOnPlaintext && (
              <p className="text-xs text-danger">
                A pinned certificate cannot be checked on a plaintext connection, because
                no certificate is ever presented. Remove the pin or choose an encrypted
                mode.
              </p>
            )}

            {unverifiedWithNoPin && (
              <p className="text-xs text-danger">
                Turning verification off with no pinned certificate accepts any certificate
                at all. Paste the relay&rsquo;s certificate above, or leave verification on.
              </p>
            )}

            {feedback && (
              <div
                role="status"
                className={
                  feedback.ok
                    ? 'flex items-start gap-2 rounded-md border border-ok/30 bg-ok/5 p-2.5 text-xs text-ok'
                    : 'flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 p-2.5 text-xs text-danger'
                }
              >
                {feedback.ok ? (
                  <CheckCircle2 aria-hidden className="mt-px size-3.5 shrink-0" />
                ) : (
                  <ShieldAlert aria-hidden className="mt-px size-3.5 shrink-0" />
                )}
                {feedback.message}
              </div>
            )}

            {!feedback && form.lastSendAt && (
              <p className="text-xs text-ink-faint">
                Last send {formatDateTime(form.lastSendAt)} —{' '}
                {form.lastSendOk ? (
                  <span className="text-ok">accepted by the relay</span>
                ) : (
                  <span className="text-danger">{form.lastSendError ?? 'failed'}</span>
                )}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="submit"
                variant="primary"
                disabled={saving || needsAcknowledgement || pinOnPlaintext || unverifiedWithNoPin}
              >
                {saving && <Loader2 aria-hidden className="animate-spin" />}
                Save
              </Button>
              {needsAcknowledgement && (
                <span className="text-xs text-ink-faint">
                  Tick the acknowledgement to save an unencrypted relay.
                </span>
              )}
            </div>

            <FieldHint>
              There is no test button here on purpose: a relay is proved by a real send.
              Add an email destination under Notifications and press its Test — the result
              appears above, because every send records its outcome here.
            </FieldHint>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
