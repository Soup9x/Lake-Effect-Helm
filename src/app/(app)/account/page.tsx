import { cookies } from 'next/headers';
import { KeyRound, Mail, MonitorSmartphone, ShieldCheck, UserCog } from 'lucide-react';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { sessionCookieName, sessionRef } from '@/lib/auth/session-cookie';
import { PageBody, PageHeader } from '@/components/app-shell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ChangePasswordCard } from '@/components/change-password-card';
import { ProfileForm } from '@/components/profile-form';
import { SessionList, type SessionRow } from '@/components/session-list';
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
 * Your account: the things that are yours rather than the tenant's.
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

  const { credential, sessions } = await withTenant(actorOf(identity), async (tx) => {
    const [credentialRows, sessionRows] = await Promise.all([
      // The view carries no hash — helm_app holds column grants that exclude
      // it. Its only job is to answer "do you have a local password, and did
      // somebody else choose it".
      tx<CredentialRow[]>`SELECT must_change, password_changed_at FROM v_my_local_credential`,
      // helm_app cannot read auth_session by any path (§21). This function is
      // SECURITY DEFINER, resolves the owner from the session context, and
      // returns a hash of each token rather than the token.
      tx<RawSession[]>`SELECT * FROM helm.my_sessions()`,
    ]);
    return { credential: credentialRows[0] ?? null, sessions: sessionRows };
  });

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
        title="Account"
        description="Your profile, your password, and every session signed in as you."
      />
      <PageBody>
        {/* First, because a must-change sign-in redirects straight here. */}
        <ChangePasswordCard
          mustChange={credential?.must_change ?? false}
          passwordChangedAt={credential ? credential.password_changed_at.toISOString() : null}
        />

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UserCog className="size-4 text-ink-faint" aria-hidden /> Profile
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <ProfileForm currentName={identity.name === identity.email ? null : identity.name} />

            <div className="border-t border-border pt-4">
              <div className="flex items-start gap-2">
                <Mail className="mt-0.5 size-4 shrink-0 text-ink-faint" aria-hidden />
                <div>
                  <div className="text-sm text-ink">{identity.email}</div>
                  <p className="mt-1 max-w-2xl text-xs text-ink-muted">
                    Your email address is not editable here, and the omission is
                    deliberate. It is the identity key three separate things match on:
                    your identity provider joins an SSO sign-in to this account by it,
                    RADIUS is asked about it as your username, and every audit row
                    resolves through it. Changing it has to be coordinated with the
                    directory it came from, so an administrator does it from the People
                    page.
                  </p>
                </div>
              </div>
            </div>
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
            <SessionList sessions={rows} />
          </CardContent>
        </Card>

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
