'use client';

/**
 * Administration → Browser extensions: require every paired browser to lock
 * the extension with a PIN or a password (1300).
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Lock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { apiFetch } from '@/lib/ui/api';
import { formatDateTime } from '@/lib/ui/format';

interface Policy {
  requireLock: boolean;
  updatedAt: string | Date | null;
}

export function ExtensionPolicyCard({ initial }: { initial: Policy }) {
  const router = useRouter();
  const [policy, setPolicy] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function change(requireLock: boolean) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await apiFetch<{ policy: Policy }>('/api/tenant/extension-policy', {
        method: 'PUT',
        json: { requireLock },
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setPolicy(result.value.policy);
      setNotice(
        result.value.policy.requireLock
          ? 'On. A browser without a lock is refused from its next request, and its extension says how to set one.'
          : 'Off. Locking the extension is each person’s choice again.',
      );
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Lock className="size-4 text-ink-faint" aria-hidden /> Lock
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <label className="flex items-start gap-2 text-sm text-ink">
          <input type="checkbox" checked={policy.requireLock} disabled={busy}
            onChange={(e) => void change(e.target.checked)}
            className="mt-0.5 size-4 rounded border-border-strong" />
          <span>
            Require a PIN or password lock on the extension
            <span className="block text-xs text-ink-muted">
              A locked extension keeps its pairing sealed, so it asks for the PIN or password after the
              browser restarts and after it sits unused. With this on, Helm refuses a paired browser
              that has no lock until its owner sets one in the extension’s settings. Extensions older
              than 0.7.0 cannot report a lock and are refused until they are updated.
            </span>
          </span>
        </label>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {notice && <p className="text-sm text-ok">{notice}</p>}
        {policy.updatedAt && (
          <p className="text-xs text-ink-faint">Last changed {formatDateTime(new Date(policy.updatedAt))}</p>
        )}
      </CardContent>
    </Card>
  );
}
