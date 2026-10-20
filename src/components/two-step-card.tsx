'use client';

/**
 * Two-step sign-in: an authenticator-app code after the local password (0960).
 *
 * Off: Set up shows a QR code to scan; the first code from it turns it on and
 * shows the recovery codes, once. On: new recovery codes for a current code,
 * or Turn off for the password. A person who signs in only through single
 * sign-on has nothing to protect here — their identity provider's own
 * two-step settings are what apply to them — and the card says so.
 */
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, ShieldCheck } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Badge } from './ui/badge';
import { FieldHint, Input, Label } from './ui/field';
import { QrCode } from './qr-code';
import { RecoveryCodes } from './recovery-codes';
import { apiFetch } from '@/lib/ui/api';

type Mode = 'idle' | 'enrolling' | 'reissuing' | 'disabling';

export function TwoStepCard({
  hasLocalPassword,
  enrolled,
  recoveryRemaining,
  required,
}: {
  hasLocalPassword: boolean;
  enrolled: boolean;
  recoveryRemaining: number;
  /** Policy requires a code for local sign-in (0960). */
  required: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('idle');
  const [enrolment, setEnrolment] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setMode('idle'); setCode(''); setPassword(''); setError(null); setEnrolment(null); };

  async function start() {
    setBusy(true);
    setError(null);
    const result = await apiFetch<{ enrolment: { secret: string; uri: string } }>('/api/account/totp', {
      method: 'POST', json: { action: 'start' },
    });
    setBusy(false);
    if (!result.ok) { setError(result.message); return; }
    setEnrolment(result.value.enrolment);
    setMode('enrolling');
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'disabling') {
        const result = await apiFetch('/api/account/totp', { method: 'DELETE', json: { password } });
        if (!result.ok) { setError(result.message); return; }
        reset();
        router.refresh();
        return;
      }
      const result = await apiFetch<{ recoveryCodes: string[] }>('/api/account/totp', {
        method: 'POST', json: { action: mode === 'enrolling' ? 'confirm' : 'recovery', code },
      });
      if (!result.ok) { setError(result.message); return; }
      setCodes(result.value.recoveryCodes);
      reset();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-ink-faint" aria-hidden /> Two-step sign-in
          {enrolled && <Badge tone="ok">On</Badge>}
          {!enrolled && required && hasLocalPassword && <Badge tone="warning">Required</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {!hasLocalPassword ? (
          <p className="text-ink-muted">
            You sign in through single sign-on, so two-step verification is set in your identity
            provider (Microsoft, Google and so on), not here.
          </p>
        ) : codes ? (
          <>
            <RecoveryCodes codes={codes} />
            <Button size="sm" variant="primary" onClick={() => setCodes(null)}>Done</Button>
          </>
        ) : mode === 'idle' ? (
          <>
            <p className="text-ink-muted">
              {enrolled
                ? `Signing in with your local password also asks for a code from your authenticator app. ${recoveryRemaining} recovery ${recoveryRemaining === 1 ? 'code' : 'codes'} left.`
                : required
                  ? 'Your administrator requires a code from an authenticator app when you sign in with your local password. Set it up now, or you will be asked to at your next sign-in.'
                  : 'Add a code from an authenticator app to your local password, so the password alone is not enough to sign in.'}
            </p>
            <div className="flex flex-wrap gap-2">
              {enrolled ? (
                <>
                  <Button size="sm" variant="secondary" onClick={() => setMode('reissuing')}>New recovery codes</Button>
                  <Button size="sm" variant="ghost" onClick={() => setMode('disabling')}>Turn off</Button>
                </>
              ) : (
                <Button size="sm" variant="primary" onClick={() => void start()} disabled={busy}>
                  {busy && <Loader2 className="animate-spin" />} Set up
                </Button>
              )}
            </div>
            {error && <p role="alert" className="text-danger">{error}</p>}
          </>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            {mode === 'enrolling' && enrolment && (
              <div className="flex flex-wrap items-start gap-4">
                <QrCode value={enrolment.uri} label="Authenticator setup code" />
                <div className="min-w-0 flex-1 space-y-2 text-ink-muted">
                  <p>Scan this with Microsoft Authenticator, Google Authenticator, 1Password or similar.</p>
                  <p>Or enter this key by hand:</p>
                  <code className="block break-all font-mono text-ink">{enrolment.secret}</code>
                </div>
              </div>
            )}
            {mode === 'disabling' ? (
              <div className="space-y-1.5">
                <Label htmlFor="totp-password">Your local password</Label>
                <Input id="totp-password" type="password" autoComplete="current-password" required autoFocus
                  value={password} onChange={(e) => setPassword(e.target.value)} />
                {required && (
                  <FieldHint>Your administrator requires it, so you will be asked to set it up again at your next sign-in.</FieldHint>
                )}
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="totp-code">
                  {mode === 'enrolling' ? 'The six digits it shows' : 'A current code from the app'}
                </Label>
                <Input id="totp-code" inputMode="numeric" autoComplete="one-time-code" required autoFocus maxLength={11}
                  value={code} onChange={(e) => setCode(e.target.value)} className="max-w-[12rem]" />
              </div>
            )}
            {error && <p role="alert" className="text-danger">{error}</p>}
            <div className="flex gap-2">
              <Button type="submit" size="sm" variant={mode === 'disabling' ? 'danger' : 'primary'} disabled={busy}>
                {busy && <Loader2 className="animate-spin" />}
                {mode === 'enrolling' ? 'Turn on' : mode === 'reissuing' ? 'Show new codes' : 'Turn off'}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={reset} disabled={busy}>Cancel</Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
