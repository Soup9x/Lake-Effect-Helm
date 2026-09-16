'use client';

import { useState } from 'react';
import { LogOut } from 'lucide-react';
import { Button } from './ui/button';

/**
 * Signing out.
 *
 * One button for both doors. Entra and local sign-in produce the same
 * `auth_session` row, so `POST /api/auth/local/logout` — which deletes that row
 * and then clears the cookie, in that order — ends either kind. There is
 * deliberately no separate "SSO sign out" control, because there is no separate
 * kind of session to end.
 *
 * `window.location.assign` rather than `router.push`: the session is gone
 * server-side, and a client-side navigation would re-render pages from the
 * router cache as though it were not. A full load throws that away and lets the
 * layout resolve identity again, which is what decides what you see.
 *
 * On failure it says so and stays put. Redirecting anyway would show a signed
 * out screen to somebody whose session is still live — a sign-out that did not
 * sign anything out, which is exactly what the route's own ordering exists to
 * prevent.
 */
export function SignOutButton() {
  const [state, setState] = useState<'idle' | 'working' | 'failed'>('idle');

  async function signOut() {
    setState('working');
    try {
      const response = await fetch('/api/auth/local/logout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      if (!response.ok) {
        setState('failed');
        return;
      }
      window.location.assign('/sign-in');
    } catch {
      setState('failed');
    }
  }

  return (
    <div className="mt-2">
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-start gap-2"
        onClick={signOut}
        disabled={state === 'working'}
      >
        <LogOut />
        {state === 'working' ? 'Signing out…' : 'Sign out'}
      </Button>
      {state === 'failed' && (
        <p role="alert" className="mt-1 px-3 text-xs text-danger">
          Could not sign out. You are still signed in — try again.
        </p>
      )}
    </div>
  );
}
