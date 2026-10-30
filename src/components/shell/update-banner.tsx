'use client';

/**
 * The strip under the top bar that tells an administrator a newer Helm is on
 * GitHub (src/lib/updates/check.ts).
 *
 * FETCHED AFTER PAINT, not read in the layout. The answer can take a request to
 * GitHub to produce, and no page should wait on that; a banner that arrives a
 * moment late costs nothing.
 *
 * "LATER" IS PER RELEASE. Dismissing remembers the commit that was offered, in
 * this browser, so the strip stays away until something newer lands — and then
 * comes back, because that is news again. The Updates page under
 * Administration always shows the full picture whatever was dismissed.
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowUpCircle, X } from 'lucide-react';
import { apiFetch } from '@/lib/ui/api';
import type { UpdateStatus } from '@/lib/updates/check';

const DISMISSED_KEY = 'helm.update.dismissed';

function readDismissed(): string | null {
  try {
    return window.localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

export function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    setDismissed(readDismissed());
    let cancelled = false;
    void apiFetch<{ status: UpdateStatus }>('/api/tenant/updates').then((result) => {
      if (!cancelled && result.ok) setStatus(result.value.status);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (status?.state !== 'available' || !status.latest) return null;
  if (dismissed === status.latest.commit) return null;

  const later = () => {
    const commit = status.latest!.commit;
    try {
      window.localStorage.setItem(DISMISSED_KEY, commit);
    } catch {
      // Private window: the strip simply comes back on the next page.
    }
    setDismissed(commit);
  };

  // Merged pull requests when the range has them, which is what the Updates
  // page lists; the raw commit count includes every fix-up inside them.
  const count = status.changes.length || status.behindBy;
  const changes = count === 1 ? '1 new change' : `${count} new changes`;

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-brand/40 bg-brand-tint px-4 py-2 text-sm text-ink"
    >
      <ArrowUpCircle className="size-4 shrink-0 text-brand" aria-hidden />
      <span>
        <span className="font-medium">A Helm update is available</span>
        <span className="text-ink-muted">
          {' '}· {changes} on GitHub
          {status.migrations > 0 && ` · includes ${status.migrations === 1 ? 'a database change' : `${status.migrations} database changes`}`}
        </span>
      </span>
      <Link href="/settings/updates" className="font-medium text-brand-strong underline-offset-4 hover:underline">
        See what’s new and how to update
      </Link>
      <button
        type="button"
        onClick={later}
        className="ml-auto inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs text-ink-muted hover:bg-surface-sunken hover:text-ink"
        title="Hide until a newer update is available"
      >
        <X className="size-3.5" aria-hidden /> Later
      </button>
    </div>
  );
}
