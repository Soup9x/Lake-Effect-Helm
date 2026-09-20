'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Copy, Fingerprint, Loader2, ShieldAlert, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { FieldHint, Input, Label } from './ui/field';
import { Badge } from './ui/badge';
import { formatDateTime } from '@/lib/ui/format';
import { copyUnaudited } from '@/lib/ui/clipboard';

export interface OidcSettings {
  configured: boolean;
  enabled: boolean;
  slug: string;
  displayName: string;
  issuer: string;
  clientId: string;
  scopes: string[];
  allowSignup: boolean;
  linkByEmail: boolean;
  secretSet: boolean;
  redirectUri: string;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  deadEnd: boolean;
}

const BLANK: OidcSettings = {
  configured: false,
  enabled: false,
  slug: '',
  displayName: '',
  issuer: '',
  clientId: '',
  scopes: ['openid', 'profile', 'email'],
  allowSignup: false,
  linkByEmail: false,
  secretSet: false,
  redirectUri: '',
  lastTestAt: null,
  lastTestOk: null,
  lastTestError: null,
  deadEnd: false,
};

interface Discovery {
  url?: string;
  issuer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  userinfoEndpoint?: string | null;
}

type Feedback = {
  ok: boolean;
  message: string;
  remedy?: string | null;
  stillUnproven?: string | null;
  warnings?: string[];
  discovery?: Discovery | null;
} | null;

/**
 * Generic OIDC provider configuration.
 *
 * NOTHING HERE NAMES A PRODUCT. The four fields are the ones the protocol
 * defines; every endpoint comes from the issuer's discovery document at
 * runtime. The placeholders mention Authentik and Keycloak because that is what
 * an MSP is most likely to be running, not because either is special.
 *
 * THE CLIENT SECRET IS WRITE-ONLY HERE, and that is a property of the server
 * rather than a choice this component makes: helm_app cannot read the column,
 * so there is nothing for the page to have sent. An empty box on a configured
 * provider means "leave it alone", which is why the placeholder says so instead
 * of looking like a field somebody forgot.
 *
 * The two switches at the bottom are security decisions rather than
 * preferences, so they are written out in full rather than labelled "advanced".
 */
export function OidcSettingsCard({ initial }: { initial: OidcSettings | null }) {
  const router = useRouter();
  const [form, setForm] = useState<OidcSettings>(initial ?? BLANK);
  const [secret, setSecret] = useState('');
  const [scopeText, setScopeText] = useState((initial ?? BLANK).scopes.join(' '));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [copied, setCopied] = useState(false);

  const set = <K extends keyof OidcSettings>(key: K, value: OidcSettings[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFeedback(null);

    // Space or comma separated, because both are what people type. The API
    // validates each one; this only has to split them.
    const scopes = scopeText.split(/[\s,]+/).filter(Boolean);

    try {
      const response = await fetch('/api/auth/oidc', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          enabled: form.enabled,
          slug: form.slug,
          displayName: form.displayName,
          issuer: form.issuer.replace(/\/+$/, ''),
          clientId: form.clientId,
          scopes,
          allowSignup: form.allowSignup,
          linkByEmail: form.linkByEmail,
          ...(secret ? { clientSecret: secret } : {}),
        }),
      });

      const payload = (await response.json()) as {
        oidc?: OidcSettings;
        error?: { message?: string };
      };

      if (!response.ok) {
        setFeedback({ ok: false, message: payload.error?.message ?? `Save failed (${response.status}).` });
        return;
      }

      if (payload.oidc) {
        setForm(payload.oidc);
        setScopeText(payload.oidc.scopes.join(' '));
      }
      setSecret('');
      setFeedback({ ok: true, message: 'Saved. Run the connection test before relying on it.' });
      router.refresh();
    } catch {
      setFeedback({ ok: false, message: 'Could not reach the server.' });
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setFeedback(null);
    try {
      const response = await fetch('/api/auth/oidc/test', { method: 'POST' });
      const payload = (await response.json()) as {
        ok?: boolean;
        message?: string;
        remedy?: string | null;
        stillUnproven?: string | null;
        warnings?: string[];
        discovery?: Discovery;
        error?: { message?: string };
      };

      if (!response.ok) {
        setFeedback({ ok: false, message: payload.error?.message ?? `Test failed (${response.status}).` });
        return;
      }

      setFeedback({
        ok: payload.ok === true,
        message: payload.message ?? '',
        remedy: payload.remedy ?? null,
        stillUnproven: payload.stillUnproven ?? null,
        warnings: payload.warnings ?? [],
        discovery: payload.discovery ?? null,
      });
      router.refresh();
    } catch {
      setFeedback({ ok: false, message: 'Could not reach the server.' });
    } finally {
      setTesting(false);
    }
  }

  async function forget() {
    setSaving(true);
    setFeedback(null);
    try {
      const response = await fetch('/api/auth/oidc', { method: 'DELETE' });
      if (!response.ok) {
        setFeedback({ ok: false, message: `Could not remove the provider (${response.status}).` });
        return;
      }
      setForm(BLANK);
      setSecret('');
      setScopeText(BLANK.scopes.join(' '));
      setFeedback({ ok: true, message: 'Provider removed, and its client secret with it.' });
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  async function copyRedirect() {
    // Through the shared guard rather than a bare writeText: a value that is
    // not a non-empty string is a failure, not something to stringify onto the
    // clipboard. The redirect URI is server-computed and always a string, so
    // this is the cheap half of not repeating the reveal button's defect.
    //
    // A refusal stays silent. Unlike a revealed credential the URI is on screen
    // and selectable, so there is nothing to recover from.
    if ((await copyUnaudited(form.redirectUri)) !== 'copied') return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Fingerprint className="size-4 text-ink-faint" aria-hidden /> OpenID Connect
          {form.configured && (
            <Badge tone={form.enabled ? 'ok' : 'neutral'}>{form.enabled ? 'Enabled' : 'Off'}</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="max-w-3xl text-sm text-ink-muted">
          Sign in against any identity provider that speaks OpenID Connect — Authentik,
          Keycloak, Okta, Zitadel or anything else that publishes a discovery document.
          Helm stores four things; every endpoint it needs is read from the provider at
          sign-in time, so nothing here is tied to one product.
        </p>

        <form onSubmit={save} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="oidc-display-name">Name on the button</Label>
              <Input
                id="oidc-display-name"
                value={form.displayName}
                onChange={(e) => set('displayName', e.target.value)}
                placeholder="Company SSO"
                required
                maxLength={60}
              />
              <FieldHint>
                The sign-in page shows &ldquo;Sign in with {form.displayName || 'Company SSO'}&rdquo;.
              </FieldHint>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="oidc-slug">Sign-in path</Label>
              <Input
                id="oidc-slug"
                value={form.slug}
                onChange={(e) => set('slug', e.target.value.toLowerCase())}
                placeholder="company-sso"
                required
                maxLength={32}
                readOnly={form.configured}
                disabled={form.configured}
              />
              <FieldHint>
                {form.configured
                  ? 'Fixed once set — the redirect URI below is registered at your provider. Remove the provider to change it.'
                  : 'Lowercase letters, digits and hyphens. It becomes part of the redirect URI, so pick it before registering Helm at your provider.'}
              </FieldHint>
            </div>

            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="oidc-issuer">Issuer URL</Label>
              <Input
                id="oidc-issuer"
                type="url"
                value={form.issuer}
                onChange={(e) => set('issuer', e.target.value)}
                placeholder="https://id.example.internal/application/o/helm"
                required
                maxLength={500}
              />
              <FieldHint>
                Exactly as your provider publishes it, https, with no trailing slash. Helm
                appends <code>/.well-known/openid-configuration</code> to this — including any
                path it already has, so a Keycloak realm ends{' '}
                <code>/realms/&lt;realm&gt;</code> and an Authentik provider ends{' '}
                <code>/application/o/&lt;slug&gt;</code>. Getting this wrong is the most common
                reason a setup fails.
              </FieldHint>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="oidc-client-id">Client ID</Label>
              <Input
                id="oidc-client-id"
                value={form.clientId}
                onChange={(e) => set('clientId', e.target.value)}
                placeholder="lake-effect-helm"
                required
                maxLength={255}
              />
              <FieldHint>From the application you registered at the provider.</FieldHint>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="oidc-client-secret">Client secret</Label>
              <Input
                id="oidc-client-secret"
                type="password"
                autoComplete="new-password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={form.secretSet ? 'Stored — leave blank to keep it' : 'From your provider'}
                maxLength={1024}
              />
              <FieldHint>
                Encrypted with this deployment&rsquo;s master key and readable only by the
                sign-in path — never by the rest of the application, and never sent back to
                this page.
              </FieldHint>
            </div>

            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="oidc-scopes">Scopes</Label>
              <Input
                id="oidc-scopes"
                value={scopeText}
                onChange={(e) => setScopeText(e.target.value)}
                placeholder="openid profile email"
                required
              />
              <FieldHint>
                Space separated. <code>openid</code> is required — it is what makes this OIDC
                rather than plain OAuth. Add more only if your provider gates a claim you need
                behind one.
              </FieldHint>
            </div>
          </div>

          {form.configured && form.redirectUri && (
            <div className="space-y-1.5 rounded-md border border-border bg-surface-sunken p-3">
              <Label>Redirect URI to register at your provider</Label>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-surface px-2 py-1.5 text-xs text-ink">
                  {form.redirectUri}
                </code>
                <Button type="button" variant="ghost" size="sm" onClick={copyRedirect}>
                  <Copy aria-hidden />
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <FieldHint>
                Must match exactly, including scheme and host. A mismatch fails at the
                provider, so the error appears there rather than in Helm.
              </FieldHint>
            </div>
          )}

          {/*
            The two security decisions. Written out rather than hidden behind an
            "advanced" disclosure, because both change who can get in.
          */}
          <div className="space-y-3 rounded-md border border-border p-3">
            <label className="flex items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={form.linkByEmail}
                onChange={(e) => set('linkByEmail', e.target.checked)}
              />
              <span>
                <span className="font-medium text-ink">
                  Attach to existing accounts with the same email address
                </span>
                <span className="mt-0.5 block text-xs text-ink-muted">
                  Needed for anyone who already has a Helm account — without it their
                  first sign-in is refused, because the identity has nothing to attach
                  to. It means trusting your provider&rsquo;s email claim: anyone who can
                  set a user&rsquo;s address there can take over the matching Helm account.
                  Reasonable for a directory you run; not for one you do not.
                </span>
              </span>
            </label>

            <label className="flex items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={form.allowSignup}
                onChange={(e) => set('allowSignup', e.target.checked)}
              />
              <span>
                <span className="font-medium text-ink">
                  Create an account for an address Helm has never seen
                </span>
                <span className="mt-0.5 block text-xs text-ink-muted">
                  A new account has no membership and can therefore see nothing at all
                  until somebody grants one — so this is the difference between an
                  unknown address being turned away and being given an empty account to
                  fill in. It is not the difference between locked and unlocked.
                </span>
              </span>
            </label>

            <label className="flex items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={form.enabled}
                onChange={(e) => set('enabled', e.target.checked)}
              />
              <span>
                <span className="font-medium text-ink">Show this on the sign-in page</span>
                <span className="mt-0.5 block text-xs text-ink-muted">
                  Leave off while you set it up. The connection test works either way.
                </span>
              </span>
            </label>
          </div>

          {form.deadEnd && (
            <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 p-2.5 text-xs text-warning">
              <ShieldAlert aria-hidden className="mt-px size-3.5 shrink-0" />
              <span>
                This provider is switched on but can neither create an account nor attach
                to one, so nobody new can sign in through it. Anyone who linked earlier
                still can — if that is what you intended, nothing is wrong.
              </span>
            </p>
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
              <span className="min-w-0">
                {feedback.message}
                {feedback.remedy && <span className="mt-1 block opacity-90">{feedback.remedy}</span>}
                {feedback.stillUnproven && (
                  <span className="mt-1 block opacity-90">{feedback.stillUnproven}</span>
                )}
                {feedback.warnings?.map((w) => (
                  <span key={w} className="mt-1 block opacity-90">
                    {w}
                  </span>
                ))}
                {feedback.discovery?.authorizationEndpoint && (
                  <span className="mt-1 block truncate opacity-75">
                    Authorization endpoint: {feedback.discovery.authorizationEndpoint}
                  </span>
                )}
              </span>
            </div>
          )}

          {!feedback && form.lastTestAt && (
            <p className="text-xs text-ink-faint">
              Last tested {formatDateTime(form.lastTestAt)} —{' '}
              {form.lastTestOk ? (
                <span className="text-ok">discovery succeeded</span>
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
              disabled={!form.configured || testing || saving}
              onClick={test}
            >
              {testing && <Loader2 aria-hidden className="animate-spin" />}
              Test connection
            </Button>

            {form.configured && (
              <Button
                type="button"
                variant="ghost"
                className="ml-auto text-danger"
                disabled={saving || testing}
                onClick={forget}
              >
                <Trash2 aria-hidden />
                Remove
              </Button>
            )}
          </div>

          <FieldHint>
            The test fetches the discovery document and checks that the provider really is
            an OpenID Connect issuer, that its certificate verifies from this server and
            that it offers the authorization code flow. It cannot check the client ID,
            the client secret or the redirect URI — only a real sign-in does that, so sign
            in once before relying on it.
          </FieldHint>
        </form>
      </CardContent>
    </Card>
  );
}
