'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Loader2, RadioTower, ShieldAlert, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { FieldHint, Input, Label } from './ui/field';
import { Badge } from './ui/badge';
import { formatDateTime } from '@/lib/ui/format';

export interface RadiusSettings {
  configured: boolean;
  enabled: boolean;
  host: string;
  port: number;
  timeoutMs: number;
  retries: number;
  nasIdentifier: string;
  secretSet: boolean;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
}

const BLANK: RadiusSettings = {
  configured: false,
  enabled: false,
  host: '',
  port: 1812,
  timeoutMs: 5000,
  retries: 2,
  nasIdentifier: 'lake-effect-helm',
  secretSet: false,
  lastTestAt: null,
  lastTestOk: null,
  lastTestError: null,
};

type Feedback = { ok: boolean; message: string; detail?: string | null } | null;

/**
 * RADIUS configuration.
 *
 * THE SHARED SECRET IS WRITE-ONLY HERE, and that is a property of the server,
 * not a choice this component makes: helm_app cannot read the column, so there
 * is nothing for the page to have sent. An empty secret box on a configured
 * server means "leave it alone", which is what somebody adjusting a timeout
 * wants — and why the placeholder says so rather than looking like a field they
 * forgot to fill in.
 *
 * Two test buttons because there are two different failures. A connection test
 * proves a server is there and that both ends hold the same secret; only a real
 * authentication proves the server's policy actually lets Helm's users in.
 */
export function RadiusSettingsCard({ initial }: { initial: RadiusSettings | null }) {
  const router = useRouter();
  const [form, setForm] = useState<RadiusSettings>(initial ?? BLANK);
  const [secret, setSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<'connection' | 'authentication' | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [probe, setProbe] = useState({ username: '', password: '' });
  const [showProbe, setShowProbe] = useState(false);

  const set = <K extends keyof RadiusSettings>(key: K, value: RadiusSettings[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFeedback(null);
    try {
      const response = await fetch('/api/auth/radius', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          enabled: form.enabled,
          host: form.host.trim(),
          port: form.port,
          timeoutMs: form.timeoutMs,
          retries: form.retries,
          nasIdentifier: form.nasIdentifier.trim(),
          ...(secret ? { secret } : {}),
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        radius?: RadiusSettings;
        error?: { message?: string };
      } | null;

      if (!response.ok) {
        setFeedback({ ok: false, message: payload?.error?.message ?? `Save failed (${response.status}).` });
        return;
      }

      setSecret('');
      if (payload?.radius) setForm(payload.radius);
      setFeedback({ ok: true, message: 'Saved.' });
      router.refresh();
    } catch {
      setFeedback({ ok: false, message: 'The request did not reach the server.' });
    } finally {
      setSaving(false);
    }
  }

  async function test(mode: 'connection' | 'authentication') {
    setTesting(mode);
    setFeedback(null);
    try {
      const response = await fetch('/api/auth/radius/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          mode === 'connection'
            ? { mode }
            : { mode, username: probe.username.trim(), password: probe.password },
        ),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        message?: string;
        replyMessage?: string | null;
        error?: { message?: string };
      } | null;

      if (!response.ok) {
        setFeedback({ ok: false, message: payload?.error?.message ?? `Test failed (${response.status}).` });
        return;
      }

      setFeedback({
        ok: payload?.ok ?? false,
        message: payload?.message ?? '',
        detail: payload?.replyMessage ?? null,
      });
      // The test result is stored, so the card shows it after a reload too.
      router.refresh();
    } catch {
      setFeedback({ ok: false, message: 'The request did not reach the server.' });
    } finally {
      setTesting(null);
      setProbe({ username: '', password: '' });
    }
  }

  async function forget() {
    setSaving(true);
    setFeedback(null);
    try {
      const response = await fetch('/api/auth/radius', { method: 'DELETE' });
      if (!response.ok) {
        setFeedback({ ok: false, message: `Could not remove the configuration (${response.status}).` });
        return;
      }
      setForm(BLANK);
      setSecret('');
      setFeedback({ ok: true, message: 'RADIUS configuration removed.' });
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <RadioTower className="size-4 text-ink-faint" aria-hidden /> RADIUS authentication
          {form.configured && (
            <Badge tone={form.enabled ? 'ok' : 'neutral'}>{form.enabled ? 'Enabled' : 'Off'}</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="max-w-3xl text-sm text-ink-muted">
          Sign in against the directory your technicians already use. When RADIUS
          accepts, Helm accepts. When it rejects, or when it cannot be reached at all,
          the attempt falls through to the local password — so a directory outage
          never locks anyone out of the vault they need during one.
        </p>

        <form onSubmit={save} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="radius-host">Server</Label>
              <Input
                id="radius-host"
                value={form.host}
                onChange={(e) => set('host', e.target.value)}
                placeholder="radius.example.internal"
                required
                maxLength={253}
              />
              <FieldHint>Hostname or IP address. Reached over UDP.</FieldHint>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="radius-port">Port</Label>
              <Input
                id="radius-port"
                type="number"
                min={1}
                max={65535}
                value={form.port}
                onChange={(e) => set('port', Number(e.target.value))}
                required
              />
              <FieldHint>1812 is the standard authentication port.</FieldHint>
            </div>

            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="radius-secret">Shared secret</Label>
              <Input
                id="radius-secret"
                type="password"
                autoComplete="new-password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={form.secretSet ? 'Stored — leave blank to keep it' : 'At least 16 characters'}
                maxLength={253}
              />
              <FieldHint>
                Encrypted with this deployment&rsquo;s master key and readable only by the
                sign-in path — never by the rest of the application, and never sent back
                to this page. At least 16 characters: it is the only thing proving to Helm
                that a reply really came from your server.
              </FieldHint>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="radius-timeout">Timeout (ms)</Label>
              <Input
                id="radius-timeout"
                type="number"
                min={500}
                max={30000}
                step={100}
                value={form.timeoutMs}
                onChange={(e) => set('timeoutMs', Number(e.target.value))}
                required
              />
              <FieldHint>How long one attempt waits. Somebody is watching a spinner.</FieldHint>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="radius-retries">Retries</Label>
              <Input
                id="radius-retries"
                type="number"
                min={0}
                max={5}
                value={form.retries}
                onChange={(e) => set('retries', Number(e.target.value))}
                required
              />
              <FieldHint>UDP drops datagrams silently, so one timeout is not an answer.</FieldHint>
            </div>

            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="radius-nas">NAS identifier</Label>
              <Input
                id="radius-nas"
                value={form.nasIdentifier}
                onChange={(e) => set('nasIdentifier', e.target.value)}
                required
                maxLength={63}
              />
              <FieldHint>
                What Helm calls itself in the request. Most servers key their client policy
                on this, so it has to match what you registered there.
              </FieldHint>
            </div>
          </div>

          <label className="flex items-start gap-2.5 text-sm">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => set('enabled', e.target.checked)}
              className="mt-0.5 size-4"
            />
            <span>
              <span className="text-ink">Use RADIUS for sign-in</span>
              <FieldHint>
                Test it before turning this on. Local passwords keep working either way.
              </FieldHint>
            </span>
          </label>

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
              <span>
                {feedback.message}
                {feedback.detail && (
                  <span className="mt-0.5 block opacity-80">
                    The server said: {feedback.detail}
                  </span>
                )}
              </span>
            </div>
          )}

          {!feedback && form.lastTestAt && (
            <p className="text-xs text-ink-faint">
              Last tested {formatDateTime(form.lastTestAt)} —{' '}
              {form.lastTestOk ? (
                <span className="text-ok">passed</span>
              ) : (
                <span className="text-danger">{form.lastTestError ?? 'failed'}</span>
              )}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" disabled={saving}>
              {saving && <Loader2 aria-hidden className="animate-spin" />}
              Save
            </Button>

            <Button
              type="button"
              variant="secondary"
              disabled={!form.configured || testing !== null || saving}
              onClick={() => test('connection')}
            >
              {testing === 'connection' && <Loader2 aria-hidden className="animate-spin" />}
              Test connection
            </Button>

            <Button
              type="button"
              variant="secondary"
              disabled={!form.configured || testing !== null || saving}
              onClick={() => setShowProbe((v) => !v)}
            >
              Test an account
            </Button>

            {form.configured && (
              <Button
                type="button"
                variant="ghost"
                className="ml-auto text-danger"
                disabled={saving || testing !== null}
                onClick={forget}
              >
                <Trash2 aria-hidden />
                Remove
              </Button>
            )}
          </div>

          <FieldHint>
            The connection test sends a request for an account that cannot exist. A
            rejection is the expected answer and is what proves both ends hold the same
            secret — so expect one failed authentication in your server&rsquo;s log.
          </FieldHint>
        </form>

        {showProbe && (
          <div className="space-y-3 rounded-md border border-border bg-surface-sunken p-3">
            <p className="text-sm text-ink-muted">
              Sign in as somebody, end to end. Credentials are used for this one request
              and never stored.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="probe-username">Username</Label>
                <Input
                  id="probe-username"
                  autoComplete="off"
                  value={probe.username}
                  onChange={(e) => setProbe((p) => ({ ...p, username: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="probe-password">Password</Label>
                <Input
                  id="probe-password"
                  type="password"
                  autoComplete="off"
                  value={probe.password}
                  onChange={(e) => setProbe((p) => ({ ...p, password: e.target.value }))}
                />
              </div>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={testing !== null || !probe.username || !probe.password}
              onClick={() => test('authentication')}
            >
              {testing === 'authentication' && <Loader2 aria-hidden className="animate-spin" />}
              Run the test
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
