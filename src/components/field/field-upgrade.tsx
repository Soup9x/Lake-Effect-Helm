'use client';

/**
 * Leaving Field view (1250): the password again, and the authenticator code
 * when the account has one. The one way a phone session gets write access.
 */
import { useState, type FormEvent } from 'react';
import { Loader2, Monitor } from 'lucide-react';
import { Button } from '../ui/button';
import { FieldHint, Input, Label } from '../ui/field';
import { apiFetch } from '@/lib/ui/api';

export function FieldUpgradeForm() {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch('/api/auth/field/upgrade', {
        json: { password, ...(needsCode && code ? { code } : {}) },
      });
      if (!result.ok) {
        if (result.details?.secondFactor === 'totp') setNeedsCode(true);
        setError(result.message);
        return;
      }
      setPassword('');
      // A full navigation, so nothing rendered for the read-only session is reused.
      window.location.assign('/dashboard');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="upgrade-password">Your password</Label>
        <Input
          id="upgrade-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      {needsCode && (
        <div className="space-y-1.5">
          <Label htmlFor="upgrade-code">Authenticator code</Label>
          <Input
            id="upgrade-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={11}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <FieldHint>A recovery code works here too.</FieldHint>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <Button type="submit" variant="primary" className="w-full" disabled={busy || password.length === 0}>
        {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Monitor aria-hidden />}
        Open the full site
      </Button>
    </form>
  );
}
