'use client';

/**
 * The pairing page's approval: what is being paired, its key fingerprint, and
 * one button. See src/lib/extension/pairing-protocol.ts for the whole exchange.
 *
 * THE FINGERPRINT is the point of the page. The extension's settings show the
 * same sixteen characters, computed from the same key; if they differ, the
 * link was not opened by your extension and Pair must not be pressed. A page
 * that only said "Pair this browser?" would approve whatever key a link
 * carried.
 *
 * NOTHING IS PAIRED BY OPENING THE PAGE. Approval is the button, in a tab
 * signed in to Helm, with the person's password typed again (and their
 * authenticator code, when they have one: the field appears when Helm asks
 * for it). The POST is refused to anything but a session, and the database
 * refuses a pairing without that fresh step-up (1121). The password is
 * cleared from state as soon as the request returns.
 *
 * THE TOKEN is posted to this page's own origin and nowhere else, then
 * dropped from state. The extension's listener in this tab picks it up and
 * closes the tab; if no extension is listening — the link came from somewhere
 * else — it goes nowhere, and the pairing is a row the person can remove
 * below, holding a key nobody has the private half of.
 */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Loader2, Puzzle, ShieldAlert } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { FieldHint, Input, Label } from './ui/field';
import { apiFetch } from '@/lib/ui/api';
import {
  PAIR_MESSAGE_TYPE,
  type PairMessage,
  type PairRequestParams,
} from '@/lib/extension/pairing-protocol';
import type { ExtensionPairing } from '@/lib/extension/types';

type State =
  | { status: 'reading' }
  | { status: 'invalid' }
  | { status: 'ready'; params: PairRequestParams; fingerprint: string }
  | { status: 'pairing'; params: PairRequestParams; fingerprint: string }
  | { status: 'paired'; label: string }
  | { status: 'error'; params: PairRequestParams; fingerprint: string; message: string };

function readFragment(): PairRequestParams | null {
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const key = fragment.get('key') ?? '';
  const state = fragment.get('state') ?? '';
  if (!/^[A-Za-z0-9_-]{80,300}$/.test(key) || !/^[A-Za-z0-9_-]{16,128}$/.test(state)) return null;
  return {
    key,
    state,
    label: (fragment.get('label') ?? '').slice(0, 80),
    browser: (fragment.get('browser') ?? '').slice(0, 40),
    version: (fragment.get('version') ?? '').slice(0, 20),
  };
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The first 16 hex digits of the key's SHA-256, grouped in fours: what the extension shows. */
async function fingerprintOf(key: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', base64UrlToBytes(key)));
  const hex = Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
  return (hex.match(/.{4}/g) ?? []).join(' ').toUpperCase();
}

export function ExtensionPair({
  tenantName,
  personName,
  allowed,
}: {
  tenantName: string;
  personName: string;
  /** MSP-side: the only people the extension is for. */
  allowed: boolean;
}) {
  const [state, setState] = useState<State>({ status: 'reading' });
  const [label, setLabel] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [askCode, setAskCode] = useState(false);
  // Read once: the effect clears the fragment, and a second run (React's
  // development double-invoke) would otherwise find it gone.
  const fragment = useRef<PairRequestParams | null | undefined>(undefined);

  useEffect(() => {
    if (fragment.current === undefined) {
      fragment.current = readFragment();
      // The fragment has been read; it does not need to stay in the address
      // bar or the history.
      window.history.replaceState(null, '', window.location.pathname);
    }
    const params = fragment.current;
    if (!params) {
      setState({ status: 'invalid' });
      return;
    }
    setLabel(params.label || 'My browser');
    void fingerprintOf(params.key).then(
      (fingerprint) => setState({ status: 'ready', params, fingerprint }),
      () => setState({ status: 'invalid' }),
    );
  }, []);

  const approve = async () => {
    if (state.status !== 'ready' && state.status !== 'error') return;
    const { params, fingerprint } = state;
    setState({ status: 'pairing', params, fingerprint });
    const result = await apiFetch<ExtensionPairing>('/api/extension/installs', {
      json: {
        publicKey: params.key,
        label: label.trim() || 'My browser',
        browser: params.browser || null,
        extensionVersion: params.version || null,
        password,
        ...(askCode && code.trim() ? { code: code.trim() } : {}),
      },
    });
    setPassword('');
    setCode('');
    if (!result.ok) {
      if (result.details?.secondFactor === 'totp') setAskCode(true);
      setState({ status: 'error', params, fingerprint, message: result.message });
      return;
    }
    const message: PairMessage = {
      type: PAIR_MESSAGE_TYPE,
      state: params.state,
      installId: result.value.installId,
      token: result.value.token,
      expiresAt: result.value.expiresAt,
      tenantName: result.value.tenantName,
    };
    window.postMessage(message, window.location.origin);
    setState({ status: 'paired', label: label.trim() || 'My browser' });
  };

  if (!allowed) {
    return (
      <Card>
        <CardContent className="flex items-start gap-3 py-6 text-sm text-ink-muted">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-sev-warning" aria-hidden />
          The browser extension is for MSP staff. Your role in {tenantName} is a client-side one, so
          there is nothing here to pair.
        </CardContent>
      </Card>
    );
  }

  if (state.status === 'reading') {
    return <Loader2 className="size-5 animate-spin text-ink-faint" aria-label="Loading" />;
  }

  if (state.status === 'invalid') {
    return (
      <Card>
        <CardContent className="space-y-2 py-6 text-sm text-ink-muted">
          <p>This page is opened by the Helm browser extension, and this link did not come from it.</p>
          <p>
            To pair a browser, open the extension&rsquo;s settings and choose <strong>Pair with Helm</strong>.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (state.status === 'paired') {
    return (
      <Card>
        <CardContent className="space-y-2 py-6 text-sm">
          <p className="flex items-center gap-2 text-ink">
            <CheckCircle2 className="size-5 text-ok" aria-hidden /> Paired &ldquo;{state.label}&rdquo;.
          </p>
          <p className="text-ink-muted">
            The extension closes this tab once it has picked the pairing up. If the tab stays open,
            the extension did not open it: remove the pairing under{' '}
            <Link href="/personal/browser-extension" className="text-brand hover:underline">Personal → Browser extension</Link>.
          </p>
        </CardContent>
      </Card>
    );
  }

  const busy = state.status === 'pairing';
  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Puzzle className="size-4 text-ink-faint" aria-hidden /> Pair this browser
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-ink-muted">
          The extension will be able to look up the credentials {personName} can see in {tenantName},
          and copy standard passwords and one-time codes. Elevated and critical credentials stay in Helm.
          Every copy is in the audit log.
        </p>

        <div className="rounded-md border border-border bg-surface-sunken p-3">
          <div className="text-xs text-ink-muted">Key fingerprint</div>
          <div className="font-mono text-base tracking-wider text-ink">{state.fingerprint}</div>
          <FieldHint>
            Check that the extension shows the same fingerprint. If it does not, or you did not just
            start pairing from the extension, close this tab.
          </FieldHint>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="extension-label">Name this browser</Label>
          <Input
            id="extension-label"
            value={label}
            maxLength={80}
            onChange={(e) => setLabel(e.target.value)}
            disabled={busy}
          />
          {state.params.browser ? (
            <FieldHint>
              {state.params.browser}
              {state.params.version ? `, extension ${state.params.version}` : ''}
            </FieldHint>
          ) : null}
        </div>

        <form
          id="extension-pair-form"
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void approve();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="extension-password">Your Helm password</Label>
            <Input
              id="extension-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              required
            />
            <FieldHint>Pairing gives this browser access for 30 days, so Helm asks who you are again.</FieldHint>
          </div>
          {askCode ? (
            <div className="space-y-1.5">
              <Label htmlFor="extension-code">Authenticator code</Label>
              <Input
                id="extension-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                maxLength={32}
                onChange={(e) => setCode(e.target.value)}
                disabled={busy}
                required
              />
              <FieldHint>From your authenticator app, or one of your recovery codes.</FieldHint>
            </div>
          ) : null}
        </form>

        {state.status === 'error' ? <p className="text-danger">{state.message}</p> : null}

        <div className="flex gap-2">
          <Button
            variant="primary"
            type="submit"
            form="extension-pair-form"
            disabled={busy || label.trim() === '' || password === '' || (askCode && code.trim() === '')}
          >
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : null} Pair
          </Button>
          <Button variant="ghost" onClick={() => window.close()} disabled={busy}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
