'use client';

import { useCallback, useRef, useState } from 'react';
import Link from 'next/link';
import { LogOut, UserCog } from 'lucide-react';
import { cn } from '@/lib/ui/cn';
import { Badge } from './ui/badge';
import { ThemeToggle } from './theme-toggle';
import { initials } from '@/lib/ui/format';
import { useDismissable } from '@/lib/ui/use-dismissable';

/**
 * The signed-in account, top right, where every other tool in an MSP's day puts
 * it.
 *
 * A dropdown that LINKS to a page rather than being the page. The menu holds
 * the two things wanted in one click — the theme, and signing out — and
 * everything with substance behind it lives at /account. The alternative,
 * cramming password changes and session management into a 240px popover, is how
 * an account menu becomes a place people cannot find anything.
 *
 * Closes on outside click and on Escape, and returns focus to the trigger —
 * useDismissable(), shared with the recently-viewed popover beside it. The
 * tenant switcher in the sidebar predates both and does neither; the hook is
 * the pattern to copy, not that one.
 */
export function AccountMenu({
  name,
  email,
  roleName,
  isClient,
}: {
  name: string;
  email: string;
  roleName: string;
  isClient: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [failed, setFailed] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useDismissable(open, useCallback(() => setOpen(false), []), container, trigger);

  /**
   * One button for both doors. Entra and local sign-in produce the same
   * auth_session row, so this ends either kind.
   *
   * A full page load rather than a router navigation: the session is gone
   * server-side, and a client-side transition would re-render pages from the
   * router cache as though it were not.
   *
   * On failure it says so and stays put. Redirecting anyway would show a signed
   * out screen to somebody whose session is still live.
   */
  async function signOut() {
    setSigningOut(true);
    setFailed(false);
    try {
      const response = await fetch('/api/auth/local/logout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      if (!response.ok) {
        setFailed(true);
        setSigningOut(false);
        return;
      }
      window.location.assign('/sign-in');
    } catch {
      setFailed(true);
      setSigningOut(false);
    }
  }

  return (
    <div className="relative" ref={container}>
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        /*
         * THE TRIGGER SITS ON THE DARK GLOBAL BAR, so its colours come from the
         * nav scale rather than the page scale. This used to be `text-ink` on
         * `hover:bg-surface-sunken`, which was correct when the bar was white and
         * became near-black-on-near-black the moment the bar went dark — the name
         * was still there and nobody could read it.
         *
         * The DROPDOWN below is unchanged: it is a panel floating over the page,
         * not part of the bar, so it keeps the page's own surface and ink.
         */
        className={cn(
          'flex max-w-56 items-center gap-2 rounded-md py-1 pl-1 pr-2 text-left',
          'hover:bg-white/10',
        )}
      >
        <span
          className="grid size-7 shrink-0 place-items-center rounded-full bg-white/15 text-xs font-medium text-nav-ink-active"
          aria-hidden
        >
          {initials(name)}
        </span>
        <span className="hidden min-w-0 sm:block">
          <span className="block truncate text-sm leading-tight text-nav-ink-active">{name}</span>
          <span className="block truncate text-xs leading-tight text-nav-ink">{roleName}</span>
        </span>
        <span className="sr-only">Your account</span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Your account"
          className="absolute right-0 z-30 mt-1 w-64 overflow-hidden rounded-md border border-border bg-surface-raised shadow-lg"
        >
          <div className="border-b border-border px-3 py-2.5">
            <div className="truncate text-sm font-medium text-ink">{name}</div>
            <div className="truncate text-xs text-ink-faint">{email}</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              <Badge tone="neutral">{roleName}</Badge>
              {isClient && (
                /* Said plainly. A co-managed customer looking at their own
                   documentation should know which view they are in. */
                <Badge tone="brand">Co-managed access</Badge>
              )}
            </div>
          </div>

          <Link
            href="/account"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 px-3 py-2 text-sm text-ink-muted hover:bg-surface-sunken hover:text-ink"
          >
            <UserCog className="size-4 shrink-0" aria-hidden />
            Account settings
          </Link>

          <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
            <span className="text-xs text-ink-faint">Theme</span>
            <ThemeToggle />
          </div>

          <div className="border-t border-border p-1">
            <button
              type="button"
              role="menuitem"
              onClick={signOut}
              disabled={signingOut}
              className="flex w-full items-center gap-2.5 rounded px-2 py-2 text-sm text-ink-muted hover:bg-surface-sunken hover:text-ink disabled:opacity-60"
            >
              <LogOut className="size-4 shrink-0" aria-hidden />
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
            {failed && (
              <p role="alert" className="px-2 pb-1 text-xs text-danger">
                Could not sign out. You are still signed in — try again.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
