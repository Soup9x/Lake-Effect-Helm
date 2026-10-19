import { Mail, UserCog } from 'lucide-react';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { PageBody, PageHeader } from '@/components/app-shell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ChangePasswordCard } from '@/components/change-password-card';
import { ProfileForm } from '@/components/profile-form';
import { readMyPreferences } from '@/lib/ui/account-queries';

interface CredentialRow {
  must_change: boolean;
  password_changed_at: Date;
}

/**
 * Profile & password: who you are in Helm, and how you sign in locally.
 *
 * Opened from the menu under your name in the top right. The rest of what is
 * yours — notifications, sessions, API tokens, your access — is on Security &
 * notifications (/account), reached from the Personal tab.
 *
 * A must-change sign-in lands here (?password=change), which is why the
 * password card comes first.
 */
export default async function ProfilePage() {
  const identity = await getServerIdentity();

  const { credential, timezones } = await withTenant(actorOf(identity), async (tx) => {
    const [credentialRows, timezoneRows] = await Promise.all([
      // The view carries no hash — helm_app holds column grants that exclude
      // it. Its only job is to answer "do you have a local password, and did
      // somebody else choose it".
      tx<CredentialRow[]>`SELECT must_change, password_changed_at FROM v_my_local_credential`,
      /*
       * The zone names this server knows, so the picker cannot offer one the
       * 0630 trigger would refuse — the database validates the value, and a
       * browser with newer tzdata would otherwise offer a zone it rejects.
       * Filtered to the Region/City shape: pg_timezone_names also carries
       * legacy aliases, POSIX strings and abbreviations nobody means.
       */
      tx<{ name: string }[]>`
        SELECT name FROM pg_timezone_names
        WHERE name LIKE '%/%' AND name NOT LIKE 'posix/%' AND name NOT LIKE 'right/%'
        ORDER BY name
      `,
    ]);
    return { credential: credentialRows[0] ?? null, timezones: timezoneRows.map((r) => r.name) };
  });

  const preferences = await readMyPreferences(identity);

  return (
    <>
      <PageHeader
        title="Profile & password"
        description="Your name, time zone and theme, and your local password."
      />
      <PageBody>
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
            {/*
              Read here rather than taken from `identity`: identity.name comes
              from the session and falls back to the email address, and this
              form needs the halves and the preferences too — which live only
              on the row.
            */}
            <ProfileForm preferences={preferences} timezones={timezones} />

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
      </PageBody>
    </>
  );
}

export const dynamic = 'force-dynamic';
