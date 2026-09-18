'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, CheckCircle2, Loader2, Plus, Send, ShieldAlert, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { FieldHint, Input, Label } from './ui/field';
import { Badge, type BadgeTone } from './ui/badge';
import { formatDateTime } from '@/lib/ui/format';

export interface NotificationDestination {
  id: string;
  name: string;
  format: 'generic' | 'slack' | 'discord' | 'teams';
  isActive: boolean;
  organizationId: string | null;
  organizationName: string | null;
  events: string[];
  urlHost: string;
  urlDigest: string;
  signingSecretSet: boolean;
  maxAttempts: number;
  timeoutMs: number;
  lastDeliveryAt: string | null;
  lastDeliveryOk: boolean | null;
  lastDeliveryError: string | null;
  consecutiveFailures: number;
  pendingCount: number;
  deadCount: number;
}

export interface NotificationDelivery {
  id: string;
  destination: string;
  event: string;
  subject: string;
  status: string;
  attempts: number;
  responseCode: number | null;
  error: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

/**
 * What each event means, in the words somebody choosing a channel needs.
 *
 * The export ones are first and say why they matter: two-person approval was
 * removed in 0400 on the understanding that these notifications replace it, and
 * a settings page that lists them as nine equal checkboxes hides that.
 */
const EVENT_COPY: Record<string, { label: string; detail: string }> = {
  'export.requested': {
    label: 'Export requested',
    detail: 'Who asked, for which client, and whether it carries credentials. Since credential exports no longer need a second approver, this is the main way anyone finds out.',
  },
  'export.rendered': { label: 'Export ready', detail: 'What was produced: record and credential counts.' },
  'export.downloaded': { label: 'Export downloaded', detail: 'Every retrieval, numbered.' },
  'export.revoked': { label: 'Export revoked', detail: 'Somebody pulled an export back.' },
  'secret.revealed': { label: 'Credential revealed', detail: 'Which credential, by whom, for what purpose. Busy on an active team.' },
  'access.denied': { label: 'Access refused', detail: 'A reveal, write or download turned down. Repeated refusals are worth a look.' },
  'expiration.warning': { label: 'Expiring soon', detail: 'Certificates, warranties, domains and contracts, at your configured lead times.' },
  'integration.failed': { label: 'Integration failing', detail: 'A sync that keeps failing means documentation going quietly stale.' },
  'key.rotated': { label: 'Encryption key moved', detail: 'A tenant data key was rotated or retired.' },
};

const FORMAT_COPY: Record<string, string> = {
  generic: 'Helm’s own JSON. For a receiver you wrote yourself.',
  slack: 'Slack incoming webhook.',
  discord: 'Discord webhook — an embed, which is what Discord accepts.',
  teams: 'Microsoft Teams via a Power Automate Workflow (not the retired Office 365 connector).',
};

type DestinationFormat = NotificationDestination['format'];

const BLANK: {
  name: string;
  format: DestinationFormat;
  isActive: boolean;
  events: string[];
  maxAttempts: number;
  timeoutMs: number;
} = {
  name: '',
  format: 'discord',
  isActive: true,
  events: ['export.requested', 'export.downloaded'],
  maxAttempts: 6,
  timeoutMs: 5000,
};

type Feedback = { ok: boolean; message: string } | null;

function statusTone(status: string): BadgeTone {
  switch (status) {
    case 'delivered':
      return 'ok';
    case 'pending':
      return 'neutral';
    case 'dead':
      return 'danger';
    default:
      return 'warning';
  }
}

/**
 * Outbound notification destinations.
 *
 * THE WEBHOOK URL IS WRITE-ONLY HERE, and that is a property of the server
 * rather than a choice this component makes: helm_app cannot read the column,
 * so there is nothing for the page to have sent. What comes back is a host and
 * a twelve-character digest — enough to tell three Discord webhooks apart,
 * nothing like enough to be one. An empty URL box on a saved destination means
 * "leave it alone", which is why the placeholder says so.
 *
 * The test button QUEUES rather than sends; the result appears in the log
 * below. See the route for why that is the honest test.
 */
export function NotificationSettingsCard({
  destinations,
  history,
  events,
}: {
  destinations: NotificationDestination[];
  history: NotificationDelivery[];
  events: readonly string[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<typeof BLANK & { id?: string }>(BLANK);
  const [url, setUrl] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  function startNew() {
    setForm(BLANK);
    setUrl('');
    setSigningSecret('');
    setEditing('new');
    setFeedback(null);
  }

  function startEdit(destination: NotificationDestination) {
    setForm({
      id: destination.id,
      name: destination.name,
      format: destination.format,
      isActive: destination.isActive,
      events: destination.events,
      maxAttempts: destination.maxAttempts,
      timeoutMs: destination.timeoutMs,
    });
    setUrl('');
    setSigningSecret('');
    setEditing(destination.id);
    setFeedback(null);
  }

  function toggleEvent(event: string) {
    setForm((f) => ({
      ...f,
      events: f.events.includes(event)
        ? f.events.filter((e) => e !== event)
        : [...f.events, event],
    }));
  }

  async function save(submitEvent: FormEvent) {
    submitEvent.preventDefault();
    setBusy(true);
    setFeedback(null);

    try {
      const response = await fetch('/api/notifications', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(form.id ? { id: form.id } : {}),
          name: form.name,
          format: form.format,
          isActive: form.isActive,
          events: form.events,
          maxAttempts: form.maxAttempts,
          timeoutMs: form.timeoutMs,
          ...(url ? { url } : {}),
          ...(signingSecret ? { signingSecret } : {}),
        }),
      });

      const payload = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) {
        setFeedback({ ok: false, message: payload.error?.message ?? `Save failed (${response.status}).` });
        return;
      }

      setEditing(null);
      setUrl('');
      setSigningSecret('');
      setFeedback({ ok: true, message: 'Saved. Send a test to prove it reaches the channel.' });
      router.refresh();
    } catch {
      setFeedback({ ok: false, message: 'Could not reach the server.' });
    } finally {
      setBusy(false);
    }
  }

  async function sendTest(id: string) {
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/notifications/${id}/test`, { method: 'POST' });
      const payload = (await response.json()) as { message?: string; error?: { message?: string } };
      setFeedback({
        ok: response.ok,
        message: response.ok
          ? payload.message ?? 'Queued.'
          : payload.error?.message ?? `Could not queue a test (${response.status}).`,
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
      const response = await fetch(`/api/notifications/${id}`, { method: 'DELETE' });
      if (!response.ok) {
        setFeedback({ ok: false, message: `Could not remove it (${response.status}).` });
        return;
      }
      setEditing(null);
      setFeedback({ ok: true, message: 'Destination removed, and its webhook URL with it.' });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="size-4 text-ink-faint" aria-hidden /> Notifications
          {destinations.length > 0 && (
            <Badge tone="neutral">{destinations.length}</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="max-w-3xl text-sm text-ink-muted">
          Send events to Discord, Teams, Slack, or anything that accepts an incoming
          webhook. Credential exports no longer require a second approver, so an export
          notification is the main way anyone finds out one happened — point at least one
          destination at a channel somebody reads.
        </p>

        <p className="max-w-3xl rounded-md border border-border bg-surface-sunken p-2.5 text-xs text-ink-muted">
          Notifications name <span className="text-ink">clients, assets and credentials</span> —
          &ldquo;ACME Domain Admin was revealed for export&rdquo; — but never their contents.
          No password, key or ciphertext can reach a webhook payload. Choose a channel you
          would be comfortable seeing those names in.
        </p>

        {destinations.length > 0 && (
          <div className="divide-y divide-border rounded-md border border-border">
            {destinations.map((destination) => (
              <div key={destination.id} className="space-y-2 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-ink">{destination.name}</span>
                  <Badge tone="neutral">{destination.format}</Badge>
                  {!destination.isActive && <Badge tone="neutral">Off</Badge>}
                  {destination.consecutiveFailures > 0 && (
                    <Badge tone="danger">
                      {destination.consecutiveFailures} failed in a row
                    </Badge>
                  )}
                  {destination.deadCount > 0 && (
                    <Badge tone="danger">{destination.deadCount} gave up</Badge>
                  )}
                  <span className="ml-auto flex gap-1.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => sendTest(destination.id)}
                    >
                      <Send aria-hidden />
                      Test
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => startEdit(destination)}
                    >
                      Edit
                    </Button>
                  </span>
                </div>

                <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink-faint">
                  <div>
                    {destination.urlHost}
                    <span className="ml-1 font-mono text-ink-muted">
                      …{destination.urlDigest}
                    </span>
                  </div>
                  <div>{destination.organizationName ?? 'Every client'}</div>
                  {destination.signingSecretSet && <div>Signed</div>}
                  {destination.lastDeliveryAt && (
                    <div>
                      Last{' '}
                      {destination.lastDeliveryOk ? (
                        <span className="text-ok">delivered</span>
                      ) : (
                        <span className="text-danger">
                          {destination.lastDeliveryError ?? 'failed'}
                        </span>
                      )}{' '}
                      {formatDateTime(destination.lastDeliveryAt)}
                    </div>
                  )}
                </dl>

                <div className="flex flex-wrap gap-1">
                  {destination.events.map((event) => (
                    <Badge key={event} tone="neutral">
                      {EVENT_COPY[event]?.label ?? event}
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {editing === null && (
          <Button type="button" variant="secondary" onClick={startNew} disabled={busy}>
            <Plus aria-hidden />
            Add a destination
          </Button>
        )}

        {editing !== null && (
          <form onSubmit={save} className="space-y-4 rounded-md border border-border p-3">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="destination-name">Name</Label>
                <Input
                  id="destination-name"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Security channel"
                  required
                  maxLength={80}
                />
                <FieldHint>What this channel is, for whoever reads this page next.</FieldHint>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="destination-format">Platform</Label>
                <select
                  id="destination-format"
                  value={form.format}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, format: e.target.value as DestinationFormat }))
                  }
                  className="h-9 w-full rounded-md border border-border bg-surface px-2.5 text-sm text-ink"
                >
                  <option value="discord">Discord</option>
                  <option value="teams">Microsoft Teams</option>
                  <option value="slack">Slack</option>
                  <option value="generic">Generic JSON</option>
                </select>
                <FieldHint>{FORMAT_COPY[form.format]}</FieldHint>
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="destination-url">Webhook URL</Label>
                <Input
                  id="destination-url"
                  type="password"
                  autoComplete="off"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder={
                    form.id ? 'Stored — leave blank to keep it' : 'https://…'
                  }
                  maxLength={2048}
                />
                <FieldHint>
                  https only. Treated as a credential and stored the way one is: encrypted
                  with this deployment&rsquo;s master key, readable only by the background
                  worker that delivers, and never sent back to this page. For Discord and
                  Teams the URL <em>is</em> the authentication — anyone holding it can post
                  to that channel as Helm.
                </FieldHint>
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="destination-signing">Signing secret (optional)</Label>
                <Input
                  id="destination-signing"
                  type="password"
                  autoComplete="off"
                  value={signingSecret}
                  onChange={(e) => setSigningSecret(e.target.value)}
                  placeholder="At least 16 characters"
                  maxLength={256}
                />
                <FieldHint>
                  For a receiver you wrote yourself. Helm sends{' '}
                  <code>x-helm-signature</code> as an HMAC-SHA256 over the timestamp and the
                  body, so a receiver can tell a real notification from anyone who found the
                  URL. Discord, Teams and Slack ignore it.
                </FieldHint>
              </div>
            </div>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-ink">Send these events</legend>
              <div className="space-y-1.5">
                {events.map((event) => (
                  <label key={event} className="flex items-start gap-2.5 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={form.events.includes(event)}
                      onChange={() => toggleEvent(event)}
                    />
                    <span>
                      <span className="font-medium text-ink">
                        {EVENT_COPY[event]?.label ?? event}
                      </span>
                      <span className="mt-0.5 block text-xs text-ink-muted">
                        {EVENT_COPY[event]?.detail}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <label className="flex items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={form.isActive}
                onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
              />
              <span>
                <span className="font-medium text-ink">Active</span>
                <span className="mt-0.5 block text-xs text-ink-muted">
                  Leave off while you set it up. A test send works either way.
                </span>
              </span>
            </label>

            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" variant="primary" disabled={busy || form.events.length === 0}>
                {busy && <Loader2 aria-hidden className="animate-spin" />}
                Save
              </Button>
              <Button type="button" variant="ghost" onClick={() => setEditing(null)} disabled={busy}>
                Cancel
              </Button>
              {form.id && (
                <Button
                  type="button"
                  variant="ghost"
                  className="ml-auto text-danger"
                  disabled={busy}
                  onClick={() => remove(form.id!)}
                >
                  <Trash2 aria-hidden />
                  Remove
                </Button>
              )}
            </div>
          </form>
        )}

        {feedback && (
          <div
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

        {history.length > 0 && (
          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-ink-muted">Recent deliveries</h3>
            <div className="divide-y divide-border rounded-md border border-border text-xs">
              {history.map((delivery) => (
                <div key={delivery.id} className="flex items-start gap-3 px-3 py-2">
                  <Badge tone={statusTone(delivery.status)}>{delivery.status}</Badge>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-ink">{delivery.subject}</div>
                    <div className="text-ink-faint">
                      {delivery.destination} · {formatDateTime(delivery.createdAt)}
                      {delivery.attempts > 1 && ` · ${delivery.attempts} attempts`}
                      {delivery.error && (
                        <span className="text-danger"> · {delivery.error}</span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
