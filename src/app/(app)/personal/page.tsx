import Link from 'next/link';
import {
  Bell, CalendarClock, ClipboardList, KeyRound, Lock, Puzzle, UserCog,
} from 'lucide-react';
import { countVault } from '@/lib/personal/vault';
import { withTenant } from '@/lib/db/client';
import { actorOf, getServerIdentity } from '@/lib/auth/server-identity';
import { PageBody, PageHeader } from '@/components/app-shell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { countMyOpenTasks, listMyTasks } from '@/lib/sops/queries';
import { listInbox, unreadCount } from '@/lib/notifications/inbox';
import { formatDateTime } from '@/lib/ui/format';
import { NotificationCenter } from '@/components/notifications/notification-center';

export const dynamic = 'force-dynamic';

/**
 * Personal — the scope, and a real page rather than an alias.
 *
 * WHAT CHANGED. The Personal tab pointed at /account, which is one of its own
 * sub-pages: a scope whose tab opens a sub-page has no landing page, so there
 * was nowhere for the things it collects to appear together. That is why the
 * parity table recorded "aliases, not sections" while every ingredient existed.
 *
 * FOUR THINGS, AND THREE OF THEM WERE ALREADY BUILT. My Tasks is F2's, the
 * notification choices are K's, the profile and sessions are E's. This page is
 * assembly, which is exactly why the plan put group L last — building it
 * earlier would have meant shipping a page with one card on it and revisiting
 * it three times.
 *
 * MY PASSWORDS, the personal vault (1030). Decision 14 had dropped it for a
 * Bitwarden/Vaultwarden integration; it is native now, owner-only by RLS with
 * no administrator override — see the migration's header for the answers to
 * the three questions that decision recorded. A card here opens it; the list
 * and each entry have pages of their own, laid out as a client's credentials.
 *
 * ONE TRANSACTION. Four reads that all resolve the acting user from
 * helm.current_actor_id(), so they share a session context rather than opening
 * a connection each.
 */
export default async function PersonalPage() {
  const identity = await getServerIdentity();

  const { counts, tasks, notifications, unread, vault } = await withTenant(
    actorOf(identity),
    async (tx) => ({
      counts: await countMyOpenTasks(tx),
      // The same query My Tasks runs with its default filters, capped: this is
      // a signpost to that page, not a second copy of it.
      tasks: await listMyTasks(tx, { state: 'open', who: 'mine', limit: 5 }),
      // One past the first page, so the card knows whether to offer more.
      notifications: await listInbox(tx, 51),
      unread: await unreadCount(tx),
      // The owner policy counts this person's entries and nobody else's; an
      // API token or service account has none (actor_type is not 'user').
      vault: await countVault(tx),
    }),
  );

  return (
    <>
      <PageHeader
        title="Personal"
        description="Your work, what you have been told about, and your own account."
      />
      <PageBody>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ClipboardList className="size-4 text-ink-faint" aria-hidden /> My tasks
                {counts.open > 0 && (
                  <Badge tone={counts.overdue > 0 ? 'danger' : 'neutral'}>
                    {counts.open}
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {tasks.length === 0 ? (
                <p className="text-sm text-ink-muted">
                  Nothing assigned to you is outstanding.
                </p>
              ) : (
                <ul className="divide-y divide-border rounded-md border border-border">
                  {tasks.map((task) => (
                    <li key={task.stepId} className="px-3 py-2 text-sm">
                      <Link
                        href={`/runs/${task.runId}`}
                        className="text-ink underline-offset-2 hover:underline"
                      >
                        {task.title}
                      </Link>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-ink-faint">
                        <span>{task.organizationName}</span>
                        {task.dueAt && (
                          <span
                            className={task.overdue ? 'text-danger' : undefined}
                          >
                            <CalendarClock className="mr-1 inline size-3" aria-hidden />
                            {formatDateTime(task.dueAt)}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-ink-faint">
                {counts.overdue > 0 && (
                  <span className="text-danger">{counts.overdue} overdue. </span>
                )}
                <Link href="/tasks" className="underline-offset-2 hover:underline">
                  Every task, with filters
                </Link>
              </p>
            </CardContent>
          </Card>

          <Card id="notifications">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Bell className="size-4 text-ink-faint" aria-hidden /> Notifications
                {unread > 0 && <Badge tone="brand">{unread} unread</Badge>}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <NotificationCenter
                initial={notifications.slice(0, 50)}
                unread={unread}
                more={notifications.length > 50}
              />
              <p className="text-xs text-ink-faint">
                <Link href="/account" className="underline-offset-2 hover:underline">
                  Choose what appears here
                </Link>
              </p>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Lock className="size-4 text-ink-faint" aria-hidden /> My passwords
              {vault > 0 && <Badge tone="neutral">{vault}</Badge>}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <AccountLink
              href="/personal/passwords"
              icon={Lock}
              title={vault === 0 ? 'Open my passwords' : `Open my passwords (${vault} stored)`}
              detail="Your own logins, kept apart from every client. Only you can see or open them, an administrator included."
            />
          </CardContent>
        </Card>

        {identity.memberships.find((m) => m.tenantId === identity.tenantId)?.orgScopeAll && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Puzzle className="size-4 text-ink-faint" aria-hidden /> Browser extension
              </CardTitle>
            </CardHeader>
            <CardContent>
              <AccountLink
                href="/personal/browser-extension"
                icon={Puzzle}
                title="Download, set up, and your paired browsers"
                detail="Look up and copy credentials for the site you are on, from Chrome, Edge or Brave."
              />
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UserCog className="size-4 text-ink-faint" aria-hidden /> My account
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/*
              One signpost, because the Account page is one page. Three tiles
              that all opened it looked like three destinations and behaved
              like one. The subtext names what is there, because "Account" on
              its own does not tell somebody whether their password lives there.
            */}
            <AccountLink
              href="/account"
              icon={KeyRound}
              title="Security & notifications"
              detail="Email notifications, active sessions, personal API tokens, and the role and access you hold. Your profile and password are under your name in the top right."
            />
          </CardContent>
        </Card>
      </PageBody>
    </>
  );
}

function AccountLink({
  href,
  icon: Icon,
  title,
  detail,
}: {
  href: string;
  icon: typeof KeyRound | typeof Lock | typeof Puzzle;
  title: string;
  detail: string;
}) {
  return (
    <Link
      href={href}
      className="flex gap-2.5 rounded-md border border-border p-3 transition-colors hover:border-border-strong hover:bg-surface-sunken"
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-ink-faint" aria-hidden />
      <span>
        <span className="block text-sm font-medium text-ink">{title}</span>
        <span className="mt-0.5 block text-xs text-ink-muted">{detail}</span>
      </span>
    </Link>
  );
}
