'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Star } from 'lucide-react';
import { cn } from '@/lib/ui/cn';

/**
 * Pin a client, or unpin it.
 *
 * Optimistic, then reconciled: the star fills immediately because a control
 * that waits for a round trip before acknowledging a click feels broken, and it
 * reverts if the write fails rather than leaving somebody believing a client is
 * pinned when it is not.
 *
 * router.refresh() afterwards so the pinned section at the top of the client
 * list — which is server-rendered — agrees with the star that was just clicked.
 */
export function FavoriteStar({
  organizationId,
  pinned: initial,
  label,
}: {
  organizationId: string;
  pinned: boolean;
  /** The client's name, for the accessible label. A bare "Pin" is unusable in a list. */
  label: string;
}) {
  const [pinned, setPinned] = useState(initial);
  const [failed, setFailed] = useState(false);
  const [, startTransition] = useTransition();
  const router = useRouter();

  async function toggle() {
    const next = !pinned;
    setPinned(next);
    setFailed(false);

    try {
      const response = await fetch('/api/workspace/favorites', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId, pinned: next }),
      });
      if (!response.ok) {
        setPinned(!next);
        setFailed(true);
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setPinned(!next);
      setFailed(true);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={pinned}
      title={failed ? 'Could not save — try again' : pinned ? `Unpin ${label}` : `Pin ${label}`}
      className={cn(
        'rounded p-1 hover:bg-surface-sunken',
        pinned ? 'text-sev-notice' : 'text-ink-faint hover:text-ink-muted',
        failed && 'text-danger',
      )}
    >
      <Star className={cn('size-4', pinned && 'fill-current')} aria-hidden />
      <span className="sr-only">{pinned ? `Unpin ${label}` : `Pin ${label}`}</span>
    </button>
  );
}
