'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCheck } from 'lucide-react';
import { apiFetch } from '@/lib/ui/api';

/** The bell's "mark all read", from the dashboard. Same endpoint, same meaning. */
export function MarkAllReadButton() {
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();
  const router = useRouter();

  async function markAll() {
    setBusy(true);
    const result = await apiFetch('/api/account/inbox', { method: 'PUT', json: {} });
    setBusy(false);
    if (result.ok) startTransition(() => router.refresh());
  }

  return (
    <button
      type="button"
      onClick={() => void markAll()}
      disabled={busy}
      className="inline-flex items-center gap-1 text-xs text-brand hover:underline disabled:opacity-50"
    >
      <CheckCheck className="size-3.5" aria-hidden /> Mark all read
    </button>
  );
}
