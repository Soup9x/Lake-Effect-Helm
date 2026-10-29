'use client';

/**
 * The registry's other facts about a domain, each waiting for a person (1140).
 *
 * The domain checker reads registrar, dates, nameservers, transfer lock and
 * DNSSEC with the expiry, and none of it is written on its own: a row that
 * differs from what is recorded offers "Use registry" and "Keep mine". The
 * request names fields only; the server applies the values it stored, so what
 * is written is what this list showed.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, CircleAlert, Loader2 } from 'lucide-react';
import { Button } from './ui/button';
import { apiFetch } from '@/lib/ui/api';
import { formatDate } from '@/lib/ui/format';
import { needsReview, type RegistrySuggestion } from '@/lib/external/registry-suggestions';

function show(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return 'Not recorded';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.length === 0 ? 'Not recorded' : value.join(', ');
  if (key === 'registered_at' || key === 'expires_at') return formatDate(value as string);
  return String(value);
}

export function RegistryReview({ nodeId, suggestions, canWrite }: {
  nodeId: string;
  suggestions: RegistrySuggestion[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (suggestions.length === 0) return null;

  const pending = suggestions.filter(needsReview);

  async function send(body: { apply?: string[]; keep?: string[] }, marker: string) {
    setBusy(marker);
    setError(null);
    try {
      const result = await apiFetch(`/api/assets/${nodeId}/registry`, { json: body });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-faint">
          Registry details
          {pending.length > 0 && (
            <span className="ml-2 normal-case tracking-normal text-sev-warning">
              {pending.length} to verify
            </span>
          )}
        </p>
        {canWrite && pending.length > 1 && (
          <Button size="sm" variant="primary" disabled={busy !== null}
            onClick={() => send({ apply: pending.map((s) => s.key) }, 'all')}>
            {busy === 'all' && <Loader2 className="animate-spin" aria-hidden />}
            Use all {pending.length}
          </Button>
        )}
      </div>
      <ul className="divide-y divide-border">
        {suggestions.map((s) => (
          <li key={s.key} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1.5 py-2">
            <div className="min-w-0 flex-1">
              <p className="text-ink-muted">{s.label}</p>
              {s.state === 'matches' ? (
                <p className="flex items-center gap-1.5 break-words text-ink">
                  {show(s.key, s.registry)}
                  <Check className="size-3.5 shrink-0 text-ok" aria-label="matches what is recorded" />
                </p>
              ) : (
                <dl className="grid grid-cols-[auto_1fr] gap-x-2 text-sm">
                  <dt className="text-ink-faint">Registry</dt>
                  <dd className="min-w-0 break-words font-medium text-ink">{show(s.key, s.registry)}</dd>
                  <dt className="text-ink-faint">Recorded</dt>
                  <dd className="min-w-0 break-words text-ink-muted">{show(s.key, s.recorded)}</dd>
                </dl>
              )}
            </div>
            {s.state !== 'matches' && canWrite && (
              <div className="flex shrink-0 items-center gap-1">
                {s.state === 'kept' && <span className="mr-1 text-xs text-ink-faint">Kept yours</span>}
                <Button size="sm" variant={s.state === 'kept' ? 'ghost' : 'secondary'} disabled={busy !== null}
                  onClick={() => send({ apply: [s.key] }, `apply:${s.key}`)}>
                  {busy === `apply:${s.key}` && <Loader2 className="animate-spin" aria-hidden />}
                  Use registry
                </Button>
                {s.state !== 'kept' && (
                  <Button size="sm" variant="ghost" disabled={busy !== null}
                    onClick={() => send({ keep: [s.key] }, `keep:${s.key}`)}>
                    {busy === `keep:${s.key}` && <Loader2 className="animate-spin" aria-hidden />}
                    Keep mine
                  </Button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {error && (
        <p className="flex items-start gap-2 text-sm text-danger" role="alert">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {error}
        </p>
      )}
      <p className="text-xs text-ink-faint">
        Read from the registry with the expiry. Nothing is changed until somebody chooses
        “Use registry”, and expiry alerts follow the recorded date.
      </p>
    </div>
  );
}
