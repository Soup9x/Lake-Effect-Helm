'use client';

/**
 * The inbox's state and the four things that change it, shared by the bell and
 * the Personal page so the two cannot drift: one marks something read and the
 * other still shows the dot, or one dismisses and the other cannot.
 *
 * EVERY ACTION REFRESHES THE ROUTER. The shell's badge and the Personal page's
 * first render both came from the server, and are wrong the moment anything
 * here succeeds; refreshing is what keeps them right on the next render rather
 * than carrying a stale number until something else re-renders the layout.
 */
import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/ui/api';
import type { NotificationKind } from '@/lib/notifications/kinds';

export interface InboxItem {
  id: string;
  kind: NotificationKind;
  subject: string;
  href: string | null;
  organizationId: string | null;
  organizationName: string | null;
  occurredAt: string;
  read: boolean;
}

interface InboxState {
  items: InboxItem[] | null;
  /** Null until this component has a number of its own. */
  unread: number | null;
  more?: boolean;
}

export function useInbox(initial: InboxState) {
  const router = useRouter();
  const [items, setItems] = useState<InboxItem[] | null>(initial.items);
  const [unread, setUnread] = useState<number | null>(initial.unread);
  const [more, setMore] = useState(initial.more ?? false);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (limit: number): Promise<InboxItem[] | null> => {
    setFailed(null);
    const result = await apiFetch<
      { notifications?: InboxItem[]; unread?: number; more?: boolean } | undefined
    >(`/api/account/inbox?limit=${limit}`, { headers: { accept: 'application/json' } });
    if (!result.ok) {
      setFailed('Could not load your notifications.');
      return null;
    }
    const list = result.value?.notifications ?? [];
    setItems(list);
    setUnread(result.value?.unread ?? 0);
    setMore(result.value?.more ?? false);
    return list;
  }, []);

  /** `ids` absent marks everything read. */
  const markRead = useCallback(async (ids?: string[], quiet = false) => {
    if (!quiet) setBusy(true);
    const result = await apiFetch<{ unread?: number } | undefined>('/api/account/inbox', {
      method: 'PUT',
      json: ids === undefined ? {} : { ids },
    });
    if (!quiet) setBusy(false);
    if (!result.ok) {
      // Opening the bell marks what it shows read; a failure there is not
      // worth a message, because the next open tries again.
      if (!quiet) setFailed(result.message);
      return;
    }
    setUnread(result.value?.unread ?? 0);
    setItems((current) => current?.map(
      (item) => (ids === undefined || ids.includes(item.id) ? { ...item, read: true } : item),
    ) ?? null);
    router.refresh();
  }, [router]);

  /** `ids` absent clears every notification, read or not. */
  const dismiss = useCallback(async (ids?: string[]) => {
    setBusy(true);
    const result = await apiFetch<{ unread?: number } | undefined>('/api/account/inbox', {
      method: 'DELETE',
      json: ids === undefined ? { all: true } : { ids },
    });
    setBusy(false);
    if (!result.ok) {
      setFailed(result.message);
      return;
    }
    setUnread(result.value?.unread ?? 0);
    setItems((current) => (ids === undefined ? [] : current?.filter((item) => !ids.includes(item.id)) ?? null));
    if (ids === undefined) setMore(false);
    router.refresh();
  }, [router]);

  return { items, unread, more, failed, busy, load, markRead, dismiss };
}
