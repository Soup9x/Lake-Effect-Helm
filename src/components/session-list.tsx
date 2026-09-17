'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Monitor } from 'lucide-react';
import { Button } from './ui/button';
import { Badge, type BadgeTone } from './ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { formatDateTime } from '@/lib/ui/format';

export interface SessionRow {
  ref: string;
  createdAt: string;
  expires: string;
  method: 'sso' | 'password' | 'radius';
  ip: string | null;
  userAgent: string | null;
  /** True for the session rendering this page. */
  current: boolean;
}

const METHOD: Record<SessionRow['method'], { label: string; tone: BadgeTone }> = {
  sso: { label: 'Microsoft Entra', tone: 'brand' },
  radius: { label: 'RADIUS', tone: 'info' },
  password: { label: 'Local password', tone: 'neutral' },
};

/**
 * Where you are signed in, and how to stop being signed in there.
 *
 * The list is the answer to "did somebody else get my password", which is the
 * question people actually come to an account page with. Sessions are named by
 * a hash of their token rather than by the token: the page needs a handle to
 * revoke by, and a live bearer token in the HTML of a page is a session anybody
 * reading over a shoulder can take.
 *
 * The current session is marked and cannot be ended from here, because a button
 * that signs you out while pretending to be session management is just a
 * confusing sign-out button. There is one of those in the account menu.
 */
export function SessionList({ sessions }: { sessions: SessionRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const others = sessions.filter((s) => !s.current).length;

  async function end(body: Record<string, unknown>, key: string) {
    setBusy(key);
    setError(null);
    try {
      const response = await fetch('/api/account/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(payload?.error?.message ?? `Could not end that session (${response.status}).`);
        return;
      }
      router.refresh();
    } catch {
      setError('The request did not reach the server.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Signed in</TableHead>
            <TableHead>How</TableHead>
            <TableHead>From</TableHead>
            <TableHead>Expires</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {sessions.map((session) => (
            <TableRow key={session.ref}>
              <TableCell className="text-ink-muted">
                {formatDateTime(session.createdAt)}
                {session.current && (
                  <Badge tone="ok" className="ml-2">
                    This device
                  </Badge>
                )}
              </TableCell>
              <TableCell>
                <Badge tone={METHOD[session.method].tone} className="whitespace-nowrap">
                  {METHOD[session.method].label}
                </Badge>
              </TableCell>
              <TableCell className="text-xs text-ink-muted">
                <div className="font-mono">{session.ip ?? '—'}</div>
                {session.userAgent && (
                  <div className="max-w-xs truncate text-ink-faint" title={session.userAgent}>
                    {session.userAgent}
                  </div>
                )}
              </TableCell>
              <TableCell className="text-xs text-ink-muted">
                {formatDateTime(session.expires)}
              </TableCell>
              <TableCell className="text-right">
                {!session.current && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-danger"
                    disabled={busy !== null}
                    onClick={() => end({ ref: session.ref }, session.ref)}
                  >
                    {busy === session.ref && <Loader2 aria-hidden className="animate-spin" />}
                    End
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}

      {others > 0 && (
        <div className="flex items-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            disabled={busy !== null}
            onClick={() => end({ others: true }, 'others')}
          >
            {busy === 'others' && <Loader2 aria-hidden className="animate-spin" />}
            <Monitor aria-hidden />
            Sign out everywhere else
          </Button>
          <span className="text-xs text-ink-faint">
            Ends {others} other {others === 1 ? 'session' : 'sessions'}. This one stays.
          </span>
        </div>
      )}
    </div>
  );
}
