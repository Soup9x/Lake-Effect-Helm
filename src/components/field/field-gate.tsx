'use client';

/**
 * Shown at /m to a session that is not (yet) a Field view session (1250).
 *
 * `?enter=1` is where a phone's single sign-on lands: the identity provider's
 * round trip cannot carry "make this read-only", so the page does it on
 * arrival, before anything else renders. Anyone else is asked — switching is
 * one-way without the password, so it should be a choice somebody makes.
 */
import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, Smartphone } from 'lucide-react';
import { Button } from '../ui/button';
import { apiFetch } from '@/lib/ui/api';

export function FieldGate() {
  const router = useRouter();
  const params = useSearchParams();
  const auto = params.get('enter') === '1';
  const [busy, setBusy] = useState(auto);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const enter = async () => {
    setBusy(true);
    setError(null);
    const result = await apiFetch('/api/auth/field/enter', { json: {} });
    if (!result.ok) {
      setError(result.message);
      setBusy(false);
      return;
    }
    router.replace('/m');
    router.refresh();
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, on arrival.
  useEffect(() => {
    if (auto && !started.current) {
      started.current = true;
      void enter();
    }
  }, []);

  return (
    <div className="grid min-h-screen place-items-center bg-surface px-6">
      <div className="w-full max-w-sm space-y-4 text-center">
        <Smartphone className="mx-auto size-10 text-brand" aria-hidden />
        <h1 className="text-lg font-semibold tracking-tight text-ink">Field view</h1>
        <p className="text-sm text-ink-muted">
          A simple, read-only view for looking up logins and client details on your phone. This
          session becomes read-only; going back to the full site asks for your password again.
        </p>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <Button variant="primary" className="w-full" onClick={enter} disabled={busy}>
          {busy && <Loader2 className="animate-spin" aria-hidden />}
          Switch to Field view
        </Button>
        <Button asChild variant="secondary" className="w-full">
          <a href="/dashboard">Stay on the full site</a>
        </Button>
      </div>
    </div>
  );
}
