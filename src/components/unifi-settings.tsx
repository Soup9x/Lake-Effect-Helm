'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  CheckCircle2,
  Loader2,
  Plus,
  Radio,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Wifi,
} from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { FieldHint, Input, Label, Select } from './ui/field';
import { Badge, type BadgeTone } from './ui/badge';
import { formatDateTime } from '@/lib/ui/format';

export interface UnifiMapping {
  id: string;
  organizationId: string;
  organizationName: string;
  name: string;
  controllerUrl: string;
  unifiSiteId: string;
  isActive: boolean;
  apiKeySet: boolean;
  tlsVerify: boolean;
  tlsPinnedSha256: string | null;
  tlsExceptionAckAt: string | null;
  tlsExceptionAckByName: string | null;
  pollIntervalSeconds: number;
  lastPollAt: string | null;
  lastPollOk: boolean | null;
  lastPollError: string | null;
  consecutiveFailures: number;
  nextPollAt: string;
  lastDeviceCount: number | null;
  lastClientCount: number | null;
  assetCount: number;
}

export interface OrganizationOption {
  id: string;
  name: string;
}

/**
 * What a connection test came back with.
 *
 * `certificate` arrives only on the stage that needs a human decision, which is
 * the one case where the operator is being asked to accept something rather
 * than told what happened.
 */
interface TestResult {
  ok: boolean;
  stage: 'tls' | 'credential' | 'sites' | 'api';
  message: string;
  remedy?: string | null;
  stillUnproven?: string | null;
  certificate?: {
    sha256: string;
    subject?: string;
    issuer?: string;
    validTo?: string;
    selfSigned?: boolean;
    pinned?: boolean;
  };
}

const BLANK = {
  organizationId: '',
  name: '',
  controllerUrl: '',
  unifiSiteId: 'default',
  isActive: false,
  pollIntervalSeconds: 900,
};

type Feedback = { ok: boolean; message: string } | null;

function healthTone(mapping: UnifiMapping): BadgeTone {
  if (!mapping.isActive) return 'neutral';
  if (mapping.lastPollOk === null) return 'neutral';
  if (mapping.lastPollOk) return 'ok';
  return mapping.consecutiveFailures > 3 ? 'danger' : 'warning';
}

function healthLabel(mapping: UnifiMapping): string {
  if (!mapping.isActive) return 'Paused';
  if (mapping.lastPollOk === null) return 'Never polled';
  return mapping.lastPollOk ? 'Polling' : 'Failing';
}

/** Group the fingerprint so a human can actually compare it against a console. */
function readableFingerprint(hex: string): string {
  return (hex.match(/.{2}/g) ?? []).join(':');
}

/**
 * UniFi Network controllers.
 *
 * THE API KEY IS WRITE-ONLY HERE, and that is the server's doing rather than
 * this component's discretion: the key is a row in `secret`, helm_app cannot
 * read secret material, and the shape this page receives has no field that
 * could carry it. An empty key box on a saved mapping means "leave the stored
 * one alone", which is why the placeholder says so — the alternative is an
 * operator re-pasting a credential to change a poll interval, and a credential
 * re-pasted often enough ends up in a team note.
 *
 * PINNING IS NOT DISABLING VERIFICATION, and the copy works hard on that
 * distinction because the two look identical from the outside and are not.
 * A local UniFi console presents a self-signed certificate; refusing outright
 * would push operators towards a global "ignore TLS" switch, which is the
 * outcome this design exists to avoid. So: verification stays on by default,
 * the exception is per mapping, it names one fingerprint, and accepting it is a
 * deliberate act that the database records against the person who performed it.
 *
 * The fingerprint is therefore never pinned from a saved form. It is shown only
 * by a connection test — which reads the certificate WITHOUT sending the API
 * key — and accepted by its own button. An operator cannot pin a certificate
 * they have not been shown.
 */
export function UnifiSettingsCard({
  mappings,
  organizations,
  canManage,
}: {
  mappings: UnifiMapping[];
  organizations: OrganizationOption[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<typeof BLANK & { id?: string }>(BLANK);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [tested, setTested] = useState<Record<string, TestResult>>({});

  function startNew() {
    setForm({ ...BLANK, organizationId: organizations[0]?.id ?? '' });
    setApiKey('');
    setEditing('new');
    setFeedback(null);
  }

  function startEdit(mapping: UnifiMapping) {
    setForm({
      id: mapping.id,
      organizationId: mapping.organizationId,
      name: mapping.name,
      controllerUrl: mapping.controllerUrl,
      unifiSiteId: mapping.unifiSiteId,
      isActive: mapping.isActive,
      pollIntervalSeconds: mapping.pollIntervalSeconds,
    });
    setApiKey('');
    setEditing(mapping.id);
    setFeedback(null);
  }

  async function save(submitEvent: FormEvent) {
    submitEvent.preventDefault();
    setBusy(true);
    setFeedback(null);

    try {
      const response = await fetch('/api/network/mappings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(form.id ? { id: form.id } : {}),
          organizationId: form.organizationId,
          name: form.name,
          controllerUrl: form.controllerUrl.replace(/\/+$/, ''),
          unifiSiteId: form.unifiSiteId,
          isActive: form.isActive,
          pollIntervalSeconds: form.pollIntervalSeconds,
          ...(apiKey ? { apiKey } : {}),
        }),
      });

      const payload = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) {
        setFeedback({
          ok: false,
          message: payload.error?.message ?? `Save failed (${response.status}).`,
        });
        return;
      }

      setEditing(null);
      setApiKey('');
      setFeedback({
        ok: true,
        message: 'Saved. Run a connection test before relying on it.',
      });
      router.refresh();
    } catch {
      setFeedback({ ok: false, message: 'Could not reach the server.' });
    } finally {
      setBusy(false);
    }
  }

  async function test(id: string) {
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/network/mappings/${id}/test`, { method: 'POST' });
      const payload = (await response.json()) as TestResult & { error?: { message?: string } };
      if (!response.ok) {
        setFeedback({
          ok: false,
          message: payload.error?.message ?? `The test could not run (${response.status}).`,
        });
        return;
      }
      setTested((prior) => ({ ...prior, [id]: payload }));
      router.refresh();
    } catch {
      setFeedback({ ok: false, message: 'Could not reach the server.' });
    } finally {
      setBusy(false);
    }
  }

  /**
   * Accept the certificate the test just showed.
   *
   * Sends the fingerprint from THAT RESULT rather than anything typed, so the
   * value pinned is provably the one on screen when the operator decided.
   */
  async function acceptCertificate(mapping: UnifiMapping, sha256: string) {
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch('/api/network/mappings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: mapping.id,
          organizationId: mapping.organizationId,
          name: mapping.name,
          controllerUrl: mapping.controllerUrl,
          unifiSiteId: mapping.unifiSiteId,
          isActive: mapping.isActive,
          pollIntervalSeconds: mapping.pollIntervalSeconds,
          tlsPinnedSha256: sha256,
        }),
      });
      if (!response.ok) {
        const payload = (await response.json()) as { error?: { message?: string } };
        setFeedback({
          ok: false,
          message: payload.error?.message ?? `Could not pin it (${response.status}).`,
        });
        return;
      }
      setTested((prior) => {
        const next = { ...prior };
        delete next[mapping.id];
        return next;
      });
      setFeedback({
        ok: true,
        message: 'Certificate pinned against your name. Run the test again to finish it.',
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/network/mappings/${id}`, { method: 'DELETE' });
      if (!response.ok) {
        setFeedback({ ok: false, message: `Could not remove it (${response.status}).` });
        return;
      }
      setEditing(null);
      setFeedback({
        ok: true,
        message: 'Controller removed. The devices it found, and anything written on them, stayed.',
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wifi className="size-4 text-ink-faint" aria-hidden /> UniFi Network controllers
          {mappings.length > 0 && <Badge tone="neutral">{mappings.length}</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="max-w-3xl text-sm text-ink-muted">
          Poll a client&rsquo;s UniFi Network controller and keep their switches, access points
          and connected devices documented without anybody typing them in. Helm reads; it never
          writes to the controller.
        </p>

        {mappings.length === 0 && (
          <p className="text-sm text-ink-faint">No controllers configured.</p>
        )}

        <div className="space-y-3">
          {mappings.map((mapping) => {
            const result = tested[mapping.id];
            return (
              <div key={mapping.id} className="rounded-md border border-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-ink">{mapping.name}</span>
                  <Badge tone={healthTone(mapping)}>{healthLabel(mapping)}</Badge>
                  <span className="text-xs text-ink-faint">{mapping.organizationName}</span>
                  {mapping.tlsPinnedSha256 ? (
                    <Badge tone="warning">Certificate pinned</Badge>
                  ) : (
                    <Badge tone="ok">CA verified</Badge>
                  )}
                  {!mapping.apiKeySet && <Badge tone="danger">No API key</Badge>}
                </div>

                <div className="mt-1 font-mono text-xs text-ink-faint">
                  {mapping.controllerUrl} &middot; site {mapping.unifiSiteId}
                </div>

                <div className="mt-2 grid gap-1 text-xs text-ink-muted sm:grid-cols-2">
                  <div>
                    {mapping.assetCount} device{mapping.assetCount === 1 ? '' : 's'} documented
                    {mapping.lastDeviceCount !== null && (
                      <>
                        {' '}&middot; last poll saw {mapping.lastDeviceCount} infrastructure and{' '}
                        {mapping.lastClientCount ?? 0} client
                      </>
                    )}
                  </div>
                  <div>
                    Polled {formatDateTime(mapping.lastPollAt)} &middot; every{' '}
                    {Math.round(mapping.pollIntervalSeconds / 60)} min
                    {mapping.isActive && (
                      <> &middot; next {formatDateTime(mapping.nextPollAt)}</>
                    )}
                  </div>
                </div>

                {mapping.lastPollError && (
                  <div className="mt-2 rounded border border-danger/40 bg-danger/5 p-2 text-xs text-danger">
                    {mapping.lastPollError}
                    {mapping.consecutiveFailures > 1 && (
                      <>
                        {' '}&mdash; {mapping.consecutiveFailures} in a row, so retries are backing
                        off.
                      </>
                    )}
                  </div>
                )}

                {mapping.tlsPinnedSha256 && (
                  <div className="mt-2 text-xs text-ink-faint">
                    <ShieldAlert className="mr-1 inline size-3" aria-hidden />
                    Accepting this certificate was {mapping.tlsExceptionAckByName ?? 'recorded'}
                    {mapping.tlsExceptionAckAt && (
                      <>, {formatDateTime(mapping.tlsExceptionAckAt)}</>
                    )}
                    . Helm will accept this certificate and no other.
                  </div>
                )}

                {result && (
                  <div
                    className={`mt-2 rounded border p-2 text-xs ${
                      result.ok
                        ? 'border-ok/40 bg-ok/5 text-ink'
                        : 'border-warning/40 bg-warning/5 text-ink'
                    }`}
                  >
                    <div className="flex items-start gap-1.5">
                      {result.ok ? (
                        <CheckCircle2 className="mt-0.5 size-3 shrink-0 text-ok" aria-hidden />
                      ) : (
                        <ShieldAlert className="mt-0.5 size-3 shrink-0 text-warning" aria-hidden />
                      )}
                      <div className="space-y-1">
                        <div>{result.message}</div>
                        {result.remedy && <div className="text-ink-muted">{result.remedy}</div>}
                        {result.stillUnproven && (
                          <div className="text-ink-faint">{result.stillUnproven}</div>
                        )}

                        {result.certificate && !result.ok && (
                          <div className="space-y-1 pt-1">
                            <div className="font-mono break-all text-[11px] text-ink-muted">
                              SHA-256 {readableFingerprint(result.certificate.sha256)}
                            </div>
                            {result.certificate.subject && (
                              <div className="text-ink-faint">
                                {result.certificate.subject}
                                {result.certificate.selfSigned && ' — self-signed'}
                                {result.certificate.validTo &&
                                  ` — expires ${result.certificate.validTo}`}
                              </div>
                            )}
                            {canManage && (
                              <Button
                                type="button"
                                size="sm"
                                variant="secondary"
                                disabled={busy}
                                onClick={() =>
                                  acceptCertificate(mapping, result.certificate!.sha256)
                                }
                              >
                                <ShieldCheck aria-hidden /> Accept this certificate
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {canManage && editing !== mapping.id && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="ghost" onClick={() => startEdit(mapping)}>
                      Edit
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => test(mapping.id)}
                    >
                      {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Radio aria-hidden />}
                      Test connection
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => remove(mapping.id)}
                    >
                      <Trash2 aria-hidden /> Remove
                    </Button>
                  </div>
                )}

                {editing === mapping.id && (
                  <MappingForm
                    form={form}
                    setForm={setForm}
                    apiKey={apiKey}
                    setApiKey={setApiKey}
                    organizations={organizations}
                    busy={busy}
                    existing
                    onSubmit={save}
                    onCancel={() => setEditing(null)}
                  />
                )}
              </div>
            );
          })}
        </div>

        {canManage && editing === 'new' && (
          <div className="rounded-md border border-border p-3">
            <MappingForm
              form={form}
              setForm={setForm}
              apiKey={apiKey}
              setApiKey={setApiKey}
              organizations={organizations}
              busy={busy}
              existing={false}
              onSubmit={save}
              onCancel={() => setEditing(null)}
            />
          </div>
        )}

        {canManage && editing === null && (
          <Button type="button" variant="secondary" size="sm" onClick={startNew}>
            <Plus aria-hidden /> Add a controller
          </Button>
        )}

        {!canManage && (
          <FieldHint>
            You can see how these are doing but not change them — that needs{' '}
            <code className="font-mono">integration:network:manage</code>.
          </FieldHint>
        )}

        {feedback && (
          <p className={`text-sm ${feedback.ok ? 'text-ok' : 'text-danger'}`}>{feedback.message}</p>
        )}
      </CardContent>
    </Card>
  );
}

function MappingForm({
  form,
  setForm,
  apiKey,
  setApiKey,
  organizations,
  busy,
  existing,
  onSubmit,
  onCancel,
}: {
  form: typeof BLANK & { id?: string };
  setForm: (updater: (f: typeof BLANK & { id?: string }) => typeof BLANK & { id?: string }) => void;
  apiKey: string;
  setApiKey: (value: string) => void;
  organizations: OrganizationOption[];
  busy: boolean;
  existing: boolean;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
}) {
  return (
    <form onSubmit={onSubmit} className="mt-3 space-y-3 border-t border-border pt-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="unifi-org">Client</Label>
          <Select
            id="unifi-org"
            value={form.organizationId}
            onChange={(e) => setForm((f) => ({ ...f, organizationId: e.target.value }))}
            required
          >
            <option value="" disabled>
              Choose a client
            </option>
            {organizations.map((organization) => (
              <option key={organization.id} value={organization.id}>
                {organization.name}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <Label htmlFor="unifi-name">Name</Label>
          <Input
            id="unifi-name"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Head office UDM"
            maxLength={80}
            required
          />
        </div>

        <div>
          <Label htmlFor="unifi-url">Controller URL</Label>
          <Input
            id="unifi-url"
            value={form.controllerUrl}
            onChange={(e) => setForm((f) => ({ ...f, controllerUrl: e.target.value }))}
            placeholder="https://10.0.0.1"
            required
          />
          <FieldHint>
            The console origin only — no path. Helm appends the Integration API path itself.
          </FieldHint>
        </div>

        <div>
          <Label htmlFor="unifi-site">Site id</Label>
          <Input
            id="unifi-site"
            value={form.unifiSiteId}
            onChange={(e) => setForm((f) => ({ ...f, unifiSiteId: e.target.value }))}
            required
          />
          <FieldHint>
            A controller can host several sites. A connection test lists the real ones if this is
            wrong.
          </FieldHint>
        </div>

        <div>
          <Label htmlFor="unifi-key">API key</Label>
          <Input
            id="unifi-key"
            type="password"
            value={apiKey}
            autoComplete="off"
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={existing ? 'Leave blank to keep the stored key' : ''}
            required={!existing}
          />
          <FieldHint>
            Made in the console under Settings → Control Plane → Integrations. Stored in the vault
            with every other credential, so reading it back is audited like any reveal.
          </FieldHint>
        </div>

        <div>
          <Label htmlFor="unifi-interval">Poll every</Label>
          <Select
            id="unifi-interval"
            value={String(form.pollIntervalSeconds)}
            onChange={(e) =>
              setForm((f) => ({ ...f, pollIntervalSeconds: Number(e.target.value) }))
            }
          >
            <option value="300">5 minutes</option>
            <option value="900">15 minutes</option>
            <option value="1800">30 minutes</option>
            <option value="3600">1 hour</option>
            <option value="21600">6 hours</option>
            <option value="86400">1 day</option>
          </Select>
          <FieldHint>A busy site and a quiet one do not want the same number.</FieldHint>
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={form.isActive}
          onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
        />
        Poll this controller on a schedule
      </label>

      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={busy}>
          {busy && <Loader2 className="animate-spin" aria-hidden />}
          Save
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
