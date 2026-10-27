import Link from 'next/link';
import { cookies } from 'next/headers';
import { Bell, KeyRound, MonitorSmartphone, Puzzle, ShieldCheck } from 'lucide-react';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { sessionCookieName, sessionRef } from '@/lib/auth/session-cookie';
import { PageBody, PageHeader } from '@/components/app-shell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { readMyPreferences } from '@/lib/ui/account-queries';
import { readMyNotificationKinds } from '@/lib/email/preferences';
import { NotificationPreferencesCard } from '@/components/notification-preferences';
import { SessionList, type SessionRow } from '@/components/session-list';
import { ApiTokensCard } from '@/components/api-tokens-card';
import { listMyTokens } from '@/lib/auth/api-tokens';
import { formatDateTime } from '@/lib/ui/format';

interface CredentialRow {
  must_change: boolean;
  password_changed_at: Date;
}

interface RawSession {
  session_ref: string;
  created_at: Date;
  expires: Date;
  auth_method: 'sso' | 'password' | 'radius';
  ip: string | null;
  user_agent: string | null;
}

/**
 * Security & notifications: the things that are yours rather than the
 * tenant's — email notifications, sessions, API tokens and your access.
 * Profile and password moved to /profile, opened from the menu under your
 * name; this page is reached from the Personal tab.
 *
 * Split out from Settings deliberately. Settings is about the deployment — key
 * custody, integrations, who the workers run as — and it is hidden from
 * client-side roles entirely. An account page is for everybody who can sign in,
 * including the co-managed client administrator that Settings will not show,
 * and "change my password" belonged on that page rather than behind an MSP-only
 * one.
 *
 * Read in the page rather than fetched from an API route, like every other page
 * here: one authorisation path, not two. The routes exist for the writes the
 * client components make.
 */
export default async function AccountPage() {
  const identity = await getServerIdentity();

  // The token for THIS request, so the list can mark which row is the browser
  // reading it. Hashed immediately; the value itself goes no further.
  const token = (await cookies()).get(sessionCookieName())?.value;
  const currentRef = token ? sessionRef(token) : null;

  const {
    credential, sessions, notifications, tokens, permissions,
  } = await withTenant(actorOf(identity), async (tx, session) => {
    const [credentialRows, sessionRows, notificationRow, tokenRows] = await Promise.all([
      // The view carries no hash — helm_app holds column grants that exclude
      // it. Its only job is to answer "do you have a local password, and did
      // somebody else choose it".
      tx<CredentialRow[]>`SELECT must_change, password_changed_at FROM v_my_local_credential`,
      // helm_app cannot read auth_session by any path (§21). This function is
      // SECURITY DEFINER, resolves the owner from the session context, and
      // returns a hash of each token rather than the token.
      tx<RawSession[]>`SELECT * FROM helm.my_sessions()`,
      // Which kinds I want, and whether the tenant can send at all. One read
      // answers both, because a toggle with no relay behind it has to say so.
      readMyNotificationKinds(tx),
      // Personal API tokens, through the SECURITY DEFINER reader: the table's
      // own policy is tenant-wide-only, and these rows are mine, not the
      // tenant's.
      listMyTokens(tx),
    ]);
    return {
      credential: credentialRows[0] ?? null,
      sessions: sessionRows,
      tokens: tokenRows,
      // What this session holds, as the DATABASE resolved it: the scope menu a
      // token may be narrowed to. Not the role's list — a token-authenticated
      // session is already narrowed, and a token must not widen past it.
      permissions: session.permissions,
      // In the same transaction as the rest, because it is the same actor's own
      // row: RLS is what scopes it, so there is no predicate here to get wrong.
      notifications: notificationRow,
    };
  });

  const preferences = await readMyPreferences(identity);

  const rows: SessionRow[] = sessions.map((s) => ({
    ref: s.session_ref,
    createdAt: s.created_at.toISOString(),
    expires: s.expires.toISOString(),
    method: s.auth_method,
    ip: s.ip,
    userAgent: s.user_agent,
    current: s.session_ref === currentRef,
  }));

  const current = rows.find((r) => r.current);
  const activeMembership = identity.memberships.find((m) => m.tenantId === identity.tenantId);

  return (
    <>
      <PageHeader
        title="Security & notifications"
        description="What you are emailed about, every session and API token signed in as you, and the access you hold. Your profile and password are under your name in the top right."
      />
      <PageBody>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bell className="size-4 text-ink-faint" aria-hidden /> Email notifications
            </CardTitle>
          </CardHeader>
          <CardContent>
            <NotificationPreferencesCard initial={notifications} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MonitorSmartphone className="size-4 text-ink-faint" aria-hidden /> Active sessions
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="max-w-3xl text-sm text-ink-muted">
              Every browser currently signed in as you. If one of these is not you, end
              it and change your password — in that order, so the session cannot outlive
              the password it was created with.
            </p>
            <SessionList sessions={rows} timezone={preferences.timezone} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="size-4 text-ink-faint" aria-hidden /> API tokens
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ApiTokensCard tokens={tokens} permissions={permissions} />
          </CardContent>
        </Card>

        {activeMembership?.orgScopeAll && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Puzzle className="size-4 text-ink-faint" aria-hidden /> Browser extension
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-ink-muted">
              Downloading the extension, setting it up, and the browsers you have paired are under{' '}
              <Link href="/personal/browser-extension" className="text-brand hover:underline">
                Personal → Browser extension
              </Link>
              .
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-ink-faint" aria-hidden /> Access
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <div className="text-ink-muted">Tenant</div>
              <div className="text-ink">{identity.tenantName}</div>
            </div>
            <div>
              <div className="text-ink-muted">Role</div>
              <div className="text-ink">{activeMembership?.roleName ?? identity.roleKey}</div>
              <div className="font-mono text-xs text-ink-faint">{identity.roleKey}</div>
            </div>
            <div>
              <div className="text-ink-muted">This session</div>
              <div className="mt-0.5">
                {current ? (
                  <Badge
                    tone={
                      current.method === 'radius'
                        ? 'info'
                        : current.method === 'sso'
                          ? 'brand'
                          : 'neutral'
                    }
                  >
                    {current.method === 'radius'
                      ? 'RADIUS'
                      : current.method === 'sso'
                        ? 'Microsoft Entra'
                        : 'Local password'}
                  </Badge>
                ) : (
                  <span className="text-xs text-ink-faint">API token</span>
                )}
              </div>
            </div>
            <div>
              <div className="text-ink-muted">Local password</div>
              <div className="text-ink">
                {credential ? (
                  <span className="text-xs">
                    set {formatDateTime(credential.password_changed_at)}
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 text-xs text-ink-faint">
                    <KeyRound className="size-3.5" aria-hidden />
                    none — directory only
                  </span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </PageBody>
    </>
  );
}

export const dynamic = 'force-dynamic';
