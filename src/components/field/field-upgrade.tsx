'use client';

/**
 * Leaving Field view (1250): the password again, and the authenticator code
 * when the account has one. The one way a phone session gets write access.
 *
 * Or, for an account linked to a sign-in provider (1270), that provider's
 * sign-in again: the only way at all for somebody with no Helm password.
 */
import { useState, type FormEvent } from 'react';
import { Loader2, Monitor } from 'lucide-react';
import { Button } from '../ui/button';
import { apiFetch } from '@/lib/ui/api';
import { ReauthFields, reauthCredentials, ticketSurvives, useReauthOptions } from '../sso-confirm';

export function FieldUpgradeForm() {
  const options = useReauthOptions(true);
  const [password, setPassword] = useState('');
  const [ticket, setTicket] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const askCode = needsCode || Boolean(ticket && options?.totp);

  const send = async (withTicket: string | null) => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<{ ok: boolean }>('/api/auth/field/upgrade', {
        json: reauthCredentials({ password, ticket: withTicket, code, askCode }),
      });
      if (!result.ok) {
        if (result.details?.secondFactor === 'totp') setNeedsCode(true);
        // A spent or expired confirmation cannot be retried as it is.
        if (withTicket && !ticketSurvives(result.details)) setTicket(null);
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

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void send(ticket);
  };

  const ready = ticket ? !askCode || code.trim() !== '' : password.length > 0;

  return (
    <form onSubmit={submit} className="space-y-3">
      <ReauthFields
        idPrefix="upgrade"
        options={options}
        password={password}
        onPassword={setPassword}
        ticket={ticket}
        onTicket={setTicket}
        askCode={askCode}
        code={code}
        onCode={setCode}
        onError={setError}
        onSsoConfirmed={(next) => {
          // Nothing else to ask for: go straight on.
          if (!options?.totp) void send(next);
        }}
        disabled={busy}
      />
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {(ticket || !options?.sso || password.length > 0) && (
        <Button type="submit" variant="primary" className="w-full" disabled={busy || !ready}>
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Monitor aria-hidden />}
          Open the full site
        </Button>
      )}
    </form>
  );
}
